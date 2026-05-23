'use strict';

/**
 * socket/handlers.js
 *
 * Socket.IO event handlers.
 *
 * Events handled:
 *   join_room   → verify JWT, check participant, join room, send FULL current state
 *   leave_room  → leave room, remove from connected_members
 *   disconnect  → cleanup connected_members
 *
 * Late-joiner hydration (join_room sends everything needed to reconstruct UI):
 *   - All 3 family states (speed, distance, is_running, fuel_status, etc.)
 *   - Live leaderboard
 *   - Member's own inventory (crystals)
 *   - crystal_ready: can the member tap Collect right now?
 *   - crystal_cooldown_remaining: seconds left on cooldown (if in cooldown)
 *   - active_fuel_window: which window is open right now (1, 2, or null)
 *   - fuel_window_seconds_remaining: TTL of the open window (if any)
 *   - race_elapsed_ms: how long the race has been running
 *   - race_status: 'not_started' | 'running' | 'finished'
 *   - own_fueled_window_1, own_fueled_window_2: has this member already fueled each window?
 *   - restart_already_used: has the stopped car already been restarted?
 */

const jwt             = require('jsonwebtoken');
const keys            = require('../utils/keys');
const GAME            = require('../constants/game');
const raceService     = require('../services/race.service');
const crystalService  = require('../services/crystal.service');
const lbService       = require('../services/leaderboard.service');
const { redisClient } = require('../config/redis');
const db              = require('../config/mysql');
const cacheManager    = require('../utils/Cache_manager');
const env             = require('../config/env');

// In-memory map: memberId → socketId (for personal events)
const memberSockets = new Map();

/**
 * Broadcasts active member counts per family to all users in the room.
 * Called on join/leave/disconnect to keep everyone's UI in sync.
 */
async function broadcastActiveCounts(io, redis, raceId, dayNumber, groupNumber) {
  try {
    const room = `${raceId}:d${dayNumber}:g${groupNumber}`;

    // Get all currently connected members in this room
    const connectedMembers = await redis.smembers(keys.connectedMembers(raceId, dayNumber, groupNumber));
    if (!connectedMembers.length) return;

    // Look up each connected member's family from the memberFamilyInRace hash
    const pipeline = redis.pipeline();
    for (const mid of connectedMembers) {
      pipeline.hget(keys.memberFamilyInRace(raceId), mid);
    }
    const results = await pipeline.exec();

    // Count connected members per family
    const activeCounts = {};
    for (let i = 0; i < connectedMembers.length; i++) {
      const [err, familyId] = results[i];
      if (err || !familyId) continue;
      const fid = String(familyId);
      activeCounts[fid] = (activeCounts[fid] || 0) + 1;
    }

    io.to(room).emit('active_counts_update', { activeCounts });
  } catch (err) {
    console.warn('[socket] broadcastActiveCounts error:', err.message);
  }
}

// ─── Attach handlers to io ────────────────────────────────────────────────

function attach(io) {
  io.on('connection', (socket) => {
    let memberContext = null; // { memberId, familyId, raceId, dayNumber, groupNumber }

    // ─── join_room ────────────────────────────────────────────────────────
    socket.on('join_room', async (data) => {
      try {
        const { raceId, dayNumber, groupNumber, memberId, token } = data || {};

        // ── 1. Verify JWT ──────────────────────────────────────────────
        let decoded;
        try {
          decoded = jwt.verify(token, process.env.JWT_API_KEY);
        } catch {
          socket.emit('error', { message: 'Invalid token' });
          return;
        }

        const redis    = redisClient;
        const familyId = await redis.hget(keys.memberFamilyInRace(raceId), memberId);

        // ── 2. Participant check ────────────────────────────────────────
        // Must be in both participants set AND memberFamilyInRace hash.
        // This prevents users who joined a race family after grouping,
        // or switched families, from participating.
        const isParticipant = await redis.sismember(keys.participants(raceId), memberId);
        if (!isParticipant || !familyId) {
          socket.emit('error', { message: 'Not a participant' });
          return;
        }

        // ── 3. Fix #14: validate dayNumber & groupNumber vs Redis assignment ─
        const parsedDay   = parseInt(dayNumber, 10);
        const parsedGroup = parseInt(groupNumber, 10);

        if (!parsedDay || parsedDay < 1 || parsedDay > 3 ||
            !parsedGroup || parsedGroup < 1 || parsedGroup > 3) {
          socket.emit('error', { message: 'Invalid day or group number' });
          return;
        }

        // Look up which group this family actually belongs to today
        const dayGroupsRaw = await redis.hgetall(keys.dayGroups(raceId, parsedDay));
        if (dayGroupsRaw && Object.keys(dayGroupsRaw).length > 0) {
          // dayGroupsRaw = { group_1: '[...]', group_2: '[...]', group_3: '[...]' }
          const fid = String(familyId);
          const assignedGroupKey = Object.entries(dayGroupsRaw).find(([, raw]) => {
            try {
              const families = JSON.parse(raw);
              return Array.isArray(families) && families.some(id => String(id) === fid);
            } catch {
              return false;
            }
          });

          if (!assignedGroupKey) {
            socket.emit('error', { message: 'Family not assigned to any group for this day' });
            return;
          }

          // assignedGroupKey[0] = 'group_1' | 'group_2' | 'group_3'
          const assignedGroupNumber = parseInt(assignedGroupKey[0].replace('group_', ''), 10);
          if (assignedGroupNumber !== parsedGroup) {
            socket.emit('error', {
              message: `Group mismatch: you are in group ${assignedGroupNumber}, not ${parsedGroup}`,
            });
            return;
          }
        }
        // If dayGroupsRaw is empty the grouping worker hasn't run yet (dev/test) — allow join.

        // ── 4. Join Socket.IO room ──────────────────────────────────────
        const room = `${raceId}:d${dayNumber}:g${groupNumber}`;
        socket.join(room);

        // ── 5. Track connections + activity ────────────────────────────
        await redis.sadd(keys.connectedMembers(raceId, dayNumber, groupNumber), memberId);
        // await redis.sadd(keys.activeMembers(raceId, dayNumber, groupNumber, familyId), memberId);

        memberContext = {
          memberId,
          familyId,
          raceId,
          dayNumber:   parsedDay,
          groupNumber: parsedGroup,
        };
        memberSockets.set(memberId, socket.id);

        // ── 6. Determine race status ────────────────────────────────────
        const [isActiveGroup, raceMeta] = await Promise.all([
          redis.sismember(keys.activeDayGroups(raceId, dayNumber), String(groupNumber)),
          redis.hgetall(keys.raceMeta(raceId, dayNumber, groupNumber)),
        ]);

        const raceStatus = !raceMeta || !raceMeta.status
          ? 'not_started'
          : raceMeta.status === 'finished'
            ? 'finished'
            : isActiveGroup
              ? 'running'
              : 'not_started';

        // ── 7. Init late-joiner inventory & crystal_ready (race running) ─
        if (raceStatus === 'running') {
          // Init inventory if this member missed the gameStart worker init
          const alreadyHasInventory = await redis.hexists(
            keys.memberInventory(raceId, dayNumber, groupNumber, memberId), 'crystals'
          );
          if (!alreadyHasInventory) {
            await crystalService.initMemberInventory(redis, raceId, dayNumber, groupNumber, memberId);
          }

          // Set crystal_ready only if member has neither a cooldown NOR a ready key yet.
          // Late joiners get crystal_ready directly (no 30s wait — they just arrived).
          const [hasCooldown, hasReady] = await Promise.all([
            redis.exists(keys.crystalCooldown(raceId, dayNumber, groupNumber, memberId)),
            redis.exists(keys.crystalReady(raceId, dayNumber, groupNumber, memberId)),
          ]);
          if (!hasCooldown && !hasReady) {
            await redis.set(keys.crystalReady(raceId, dayNumber, groupNumber, memberId), '1');
          }
        }

        // ── 8. Build full snapshot for the joining member ───────────────
        const snapshot = await buildJoinSnapshot(
          redis, raceId, dayNumber, groupNumber, memberId, familyId, raceStatus, raceMeta || {}
        );

        socket.emit('joined', snapshot);

        // If the member's car is already stopped (missed the original car_stopped event
        // or joined late), send a personal car_stopped so the client enables the restart button.
        if (snapshot.family_states?.[familyId]?.is_running === '0' && !snapshot.restart_already_used) {
          socket.emit('car_stopped', { familyId });
        }

        // Broadcast updated active counts to all users in the room
        await broadcastActiveCounts(io, redisClient, raceId, parsedDay, parsedGroup);

      } catch (err) {
        console.error('[socket] join_room error:',  err.message);
        socket.emit('error', { message: 'Failed to join room' });
      }
    });

    // ─── spectate_room ────────────────────────────────────────────────────
    // Non-participants (spectators) join a race room in read-only mode.
    // They receive all race:state_update broadcasts but cannot emit actions.
    // Participants are NOT allowed to spectate — they must play their own race.
    //
    // Payload: { raceId, dayNumber, groupNumber, memberId? }
    socket.on('spectate_room', async (data) => {
      try {
        const { raceId, dayNumber, groupNumber, memberId } = data || {};
        if (!raceId || !dayNumber || !groupNumber) {
          socket.emit('error', { message: 'raceId, dayNumber, groupNumber required' });
          return;
        }

        // Block participants from spectating other groups
        if (memberId) {
          const isParticipant = await redisClient.sismember(keys.participants(raceId), String(memberId));
          if (isParticipant) {
            socket.emit('spectate_error', { reason: 'participant_cannot_spectate' });
            return;
          }
        }

        // Validate the race exists and is running
        const raceMeta = await redisClient.hgetall(
          keys.raceMeta(raceId, dayNumber, groupNumber)
        );
        if (!raceMeta || raceMeta.status !== 'running') {
          socket.emit('spectate_error', { reason: 'race_not_running' });
          return;
        }

        // Join the room — socket will now receive all broadcasts
        // but we deliberately do NOT add to connectedMembers or activeMembers
        const room = `${raceId}:d${dayNumber}:g${groupNumber}`;
        socket.join(room);

        // Send a lightweight snapshot so the spectator UI can render immediately
        const lbRaw = await redisClient.zrevrange(
          keys.leaderboard(raceId, dayNumber, groupNumber), 0, -1, 'WITHSCORES'
        );
        const leaderboard = [];
        for (let i = 0; i < lbRaw.length; i += 2) {
          leaderboard.push({
            rank:       (i / 2) + 1,
            familyId:   lbRaw[i],
            distanceKm: parseFloat(lbRaw[i + 1]),
          });
        }

        const familiesRaw = raceMeta.families ? JSON.parse(raceMeta.families) : [];
        const statePipeline = redisClient.pipeline();
        for (const fid of familiesRaw) {
          statePipeline.hgetall(keys.familyState(raceId, dayNumber, groupNumber, fid));
        }
        const stateResults = await statePipeline.exec();
        const familyStates = {};
        for (let i = 0; i < familiesRaw.length; i++) {
          const [, state] = stateResults[i];
          familyStates[familiesRaw[i]] = state && Object.keys(state).length ? state : null;
        }

        const startedAt = raceMeta.started_at ? parseInt(raceMeta.started_at, 10) : null;

        // Fetch family names for spectator display
        let spectatorFamilyInfo = {};
        if (familiesRaw.length > 0) {
          try {
            const families = Object.values(await cacheManager.getMultipleOrCache('family', familiesRaw));
            const memberCountRows = await db.query(
              `SELECT familyId, COUNT(*) AS cnt FROM groupsmembers WHERE familyId IN (${familiesRaw.map(() => '?').join(',')}) AND memberStatus = '1' GROUP BY familyId`,
              familiesRaw
            );
            const memberCountMap = {};
            for (const row of memberCountRows) memberCountMap[String(row.familyId)] = parseInt(row.cnt, 10) || 0;

            for (const f of families) {
              if (f) {
                spectatorFamilyInfo[String(f.id)] = {
                  familyName:  f.familyname || '',
                  familyImage: f.image || '',
                  memberCount: memberCountMap[String(f.id)] || 0,
                };
              }
            }
          } catch (err) {
            console.warn('[socket] spectator family info lookup failed:', err.message);
          }
        }

        // Build active member counts per family for the spectator snapshot
        let activeCounts = {};
        try {
          const connectedMembers = await redisClient.smembers(keys.connectedMembers(raceId, dayNumber, groupNumber));
          if (connectedMembers.length) {
            const pipeline = redisClient.pipeline();
            for (const mid of connectedMembers) {
              pipeline.hget(keys.memberFamilyInRace(raceId), mid);
            }
            const results = await pipeline.exec();
            for (let i = 0; i < connectedMembers.length; i++) {
              const [err, familyId] = results[i];
              if (err || !familyId) continue;
              const fid = String(familyId);
              activeCounts[fid] = (activeCounts[fid] || 0) + 1;
            }
          }
        } catch (err) {
          console.warn('[socket] spectator activeCounts lookup failed:', err.message);
        }

        socket.emit('spectating', {
          raceId,
          dayNumber:   parseInt(dayNumber, 10),
          groupNumber: parseInt(groupNumber, 10),
          families:    familiesRaw,
          family_states: familyStates,
          family_info: spectatorFamilyInfo,
          leaderboard,
          activeCounts,
          race_elapsed_ms: startedAt ? Math.max(0, Date.now() - startedAt) : 0,
          race_duration_ms: GAME.RACE_DURATION_MS,
          started_at: startedAt,
        });

      } catch (err) {
        console.error('[socket] spectate_room error:', err.message);
        socket.emit('error', { message: 'Failed to join spectator room' });
      }
    });

    // ─── leave_room ───────────────────────────────────────────────────────
    socket.on('leave_room', async (data) => {
      try {
        const { raceId, dayNumber, groupNumber, memberId } = data || {};
        const room = `${raceId}:d${dayNumber}:g${groupNumber}`;
        socket.leave(room);
        await redisClient.srem(keys.connectedMembers(raceId, dayNumber, groupNumber), memberId);
        memberSockets.delete(memberId);

        // Broadcast updated active counts after member leaves
        await broadcastActiveCounts(io, redisClient, raceId, dayNumber, groupNumber);

        memberContext = null;
      } catch (err) {
        console.error('[socket] leave_room error:', err.message);
      }
    });

    // ─── disconnect ───────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      try {
        if (memberContext) {
          const { memberId, raceId, dayNumber, groupNumber } = memberContext;
          await redisClient.srem(
            keys.connectedMembers(raceId, dayNumber, groupNumber), memberId
          );
          memberSockets.delete(memberId);

          // Broadcast updated active counts after disconnect
          await broadcastActiveCounts(io, redisClient, raceId, dayNumber, groupNumber);

          memberContext = null;
        }
      } catch (err) {
        console.error('[socket] disconnect error:', err.message);
      }
    });
  });
}

// ─── Full snapshot builder for late joiners ───────────────────────────────

/**
 * Builds the complete state snapshot sent to a member on join_room.
 * Covers everything the client needs to reconstruct the full UI,
 * regardless of how late they joined.
 *
 * @param {import('ioredis').Redis} redis
 * @param {string}        raceId
 * @param {number|string} dayNumber
 * @param {number|string} groupNumber
 * @param {string}        memberId   - the joining member
 * @param {string}        familyId   - the joining member's own family
 * @param {string}        raceStatus - 'not_started' | 'running' | 'finished'
 * @param {Object}        raceMeta   - raw Redis hash (may be empty if not started)
 */
async function buildJoinSnapshot(redis, raceId, dayNumber, groupNumber, memberId, familyId, raceStatus, raceMeta) {
  // Base snapshot — always returned
  const snapshot = {
    race_status: raceStatus,
    raceId,
    dayNumber:   parseInt(dayNumber, 10),
    groupNumber: parseInt(groupNumber, 10),
  };

  // ── Resolve families for this group (needed for both not_started + running) ──
  let familiesRaw = raceMeta.families ? JSON.parse(raceMeta.families) : [];

  // Fallback: if raceMeta doesn't have families yet (race not started),
  // look them up from the dayGroups key set by the grouping worker
  if (familiesRaw.length === 0) {
    try {
      const groupData = await redis.hget(keys.dayGroups(raceId, dayNumber), `group_${groupNumber}`);
      if (groupData) {
        familiesRaw = JSON.parse(groupData).map(String);
      }
    } catch (err) {
      console.warn('[socket] dayGroups fallback failed:', err.message);
    }
  }

  // Fetch family names + member counts from MySQL (for all families in group)
  let familyInfoMap = {};
  if (familiesRaw.length > 0) {
    try {
      const families = Object.values(await cacheManager.getMultipleOrCache('family', familiesRaw));
      const memberCountRows = await db.query(
        `SELECT familyId, COUNT(*) AS cnt FROM groupsmembers WHERE familyId IN (${familiesRaw.map(() => '?').join(',')}) AND memberStatus = '1' GROUP BY familyId`,
        familiesRaw
      );
      const memberCountMap = {};
      for (const row of memberCountRows) memberCountMap[String(row.familyId)] = parseInt(row.cnt, 10) || 0;

      for (const f of families) {
        if (f) {
          familyInfoMap[String(f.id)] = {
            familyName:  f.familyname || '',
            familyImage: f.image || '',
            memberCount: memberCountMap[String(f.id)] || 0,
          };
        }
      }
    } catch (err) {
      console.warn('[socket] family info lookup failed:', err.message);
    }
  }

  // Attach family_info to snapshot (available in both not_started and running states)
  snapshot.families    = familiesRaw;
  snapshot.family_info = familyInfoMap;

  if (raceStatus === 'not_started') {
    // Read authoritative countdown from Redis start_trigger TTL
    const ttl = await redis.ttl(keys.gameStartTrigger(raceId, dayNumber));
    snapshot.seconds_until_start = ttl > 0 ? ttl : 0;

    // Include pit boost data for all families so opponent boosts are visible on refresh
    const gm = await redis.hgetall(keys.gameMeta(raceId));
    const raceDate = gm ? gm[`day${dayNumber}_date`] : null;
    if (raceDate && familiesRaw.length > 0) {
      const boostPipeline = redis.pipeline();
      for (const fid of familiesRaw) {
        boostPipeline.get(keys.familyBoost(raceId, dayNumber, raceDate, fid));
      }
      const boostResults = await boostPipeline.exec();
      const pitBoosts = {};
      familiesRaw.forEach((fid, i) => {
        const [, val] = boostResults[i];
        const claims = parseInt(val || '0', 10);
        pitBoosts[fid] = {
          pitBoostClaims: claims,
          projectedBaseSpeed: 100 + (claims * GAME.PIT_BOOST_PER_UNIT),
        };
      });
      snapshot.pit_boosts = pitBoosts;
    }

    return snapshot;
  }

  // ── Race is running or finished: fetch all state in parallel ────────────

  // Fire all independent reads simultaneously
  const [inventory, liveBoard, crystalReadyExists, cooldownTtl, fuelTtl1, fuelTtl2,
         memberFueled1, memberFueled2] = await Promise.all([
    crystalService.getMemberInventory(redis, raceId, dayNumber, groupNumber, memberId),
    lbService.getLiveLeaderboard(redis, raceId, dayNumber, groupNumber),
    // Crystal collect button state
    redis.exists(keys.crystalReady(raceId, dayNumber, groupNumber, memberId)),
    // Cooldown TTL: >0 = seconds remaining, -2 = key missing, -1 = no expiry
    redis.ttl(keys.crystalCooldown(raceId, dayNumber, groupNumber, memberId)),
    // Fuel window TTLs: >0 = window open with that many seconds left
    redis.ttl(keys.fuelWindowOpen(raceId, dayNumber, groupNumber, 1)),
    redis.ttl(keys.fuelWindowOpen(raceId, dayNumber, groupNumber, 2)),
    // Has this member already submitted fuel in each window?
    redis.exists(keys.memberFueledWindow(raceId, dayNumber, groupNumber, memberId, 1)),
    redis.exists(keys.memberFueledWindow(raceId, dayNumber, groupNumber, memberId, 2)),
  ]);

  // ── All 3 family states ─────────────────────────────────────────────────
  const allFamilyStates = {};
  if (familiesRaw.length) {
    const statePipeline = redis.pipeline();
    for (const fid of familiesRaw) {
      statePipeline.hgetall(keys.familyState(raceId, dayNumber, groupNumber, fid));
    }
    const stateResults = await statePipeline.exec();
    for (let i = 0; i < familiesRaw.length; i++) {
      const [, state] = stateResults[i];
      allFamilyStates[familiesRaw[i]] = state && Object.keys(state).length ? state : null;
    }
  }

  // ── Crystal state ───────────────────────────────────────────────────────
  const crystalReady             = crystalReadyExists === 1;
  const crystalCooldownRemaining = cooldownTtl > 0 ? cooldownTtl : 0;

  // ── Active fuel window ──────────────────────────────────────────────────
  let activeFuelWindow           = null;
  let fuelWindowSecondsRemaining = 0;
  if (fuelTtl1 > 0) {
    activeFuelWindow           = 1;
    fuelWindowSecondsRemaining = fuelTtl1;
  } else if (fuelTtl2 > 0) {
    activeFuelWindow           = 2;
    fuelWindowSecondsRemaining = fuelTtl2;
  }

  // ── Restart button state for own stopped car ────────────────────────────
  const ownState = allFamilyStates[familyId];
  let restartAlreadyUsed = false;
  if (ownState && ownState.is_running === '0') {
    const restartExists = await redis.exists(
      keys.familyRestartFueled(raceId, dayNumber, groupNumber, familyId)
    );
    restartAlreadyUsed = restartExists === 1;
  }

  // ── Race timing ─────────────────────────────────────────────────────────
  const startedAt     = raceMeta.started_at ? parseInt(raceMeta.started_at, 10) : null;
  const raceElapsedMs = startedAt ? Math.max(0, Date.now() - startedAt) : 0;

  return {
    ...snapshot,
    family_states:                 allFamilyStates,
    leaderboard:                   liveBoard,
    inventory,
    crystal_ready:                 crystalReady,
    crystal_cooldown_remaining:    crystalCooldownRemaining,
    active_fuel_window:            activeFuelWindow,
    fuel_window_seconds_remaining: fuelWindowSecondsRemaining,
    own_fueled_window_1:           memberFueled1 === 1,
    own_fueled_window_2:           memberFueled2 === 1,
    restart_already_used:          restartAlreadyUsed,
    race_elapsed_ms:               raceElapsedMs,
    race_duration_ms:              GAME.RACE_DURATION_MS,
    started_at:                    startedAt,
  };
}

// ─── Personal event emitter ───────────────────────────────────────────────

/**
 * Sends an event to a specific member's socket by memberId.
 * Used by crystalExpiry worker and route handlers for personal notifications.
 *
 * @param {import('socket.io').Server} io
 * @param {string} memberId
 * @param {string} event
 * @param {*}      data
 */
function emitToMember(io, memberId, event, data) {
  const socketId = memberSockets.get(String(memberId));
  if (socketId) {
    io.to(socketId).emit(event, data);
  }
}

module.exports = { attach, emitToMember, broadcastActiveCounts };

