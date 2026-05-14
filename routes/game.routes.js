'use strict';

/**
 * routes/game.routes.js
 *
 * Public game endpoints — NO authentication required.
 *
 * Endpoints:
 *   GET /game/context              → Bootstrap: determine participant / spectator / non_race_week
 *   GET /game/leaderboard/history  → All completed race days (record button data)
 *   GET /game/spectate             → One-time snapshot for a spectator watching a family
 *   GET /game/week-leaderboard     → Top 20 families (non-race days)
 */

const express    = require('express');
const router     = express.Router();
const db         = require('../config/mysql');
const { redisClient: redis } = require('../config/redis');

const gameCtx    = require('../services/game-context.service');
const lbService  = require('../services/leaderboard.service');
const keysUtil   = require('../utils/keys');

// ─── GET /game/context ────────────────────────────────────────────────────
//
// The master bootstrap call. Frontend calls this once on page load.
// memberId is optional — omit it or pass empty to get spectator/non_race_week mode.
//
// Query params:
//   memberId  (optional)  — the user's memberId
//
// Response shapes:
//
//   Non-race week (Mon–Thu, no active game):
//   { mode: 'non_race_week', weekLeaderboard: [...top20] }
//
//   Spectator (active game, family not selected):
//   { mode: 'spectator', race: { raceId, status, dayNumber, day1, day2, day3, raceStartTime } }
//
//   Participant (active game, family selected):
//   { mode: 'participant', race: {...}, participant: { memberId, familyId, groupNumber, dayNumber } }

router.get('/context', async (req, res) => {
  try {
    const memberId = req.query.memberId || null;
    const context  = await gameCtx.resolveGameContext(memberId, db, redis);
    return res.json(context);
  } catch (err) {
    console.error('[GET /game/context]', err.message);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ─── GET /game/record-overview ────────────────────────────────────────────
//
// Returns the full record page data: groups + live leaderboard + status for each day.
// Combines dayGroups (Redis), family info (MySQL), live leaderboard (Redis),
// and historical results (MySQL).
//
// Query params:
//   raceId  (required)
//
// Response:
// {
//   raceId, status, currentDay,
//   days: [
//     {
//       dayNumber: 1,
//       status: 'running' | 'finished' | 'pending',
//       groups: [
//         {
//           groupNumber: 1,
//           status: 'running' | 'finished' | 'not_started',
//           families: [
//             { familyId, familyName, familyImage, ownerName, ownerImage, memberCount, car,
//               distance, speed, rank, isRunning }
//           ]
//         }
//       ]
//     }
//   ]
// }

router.get('/record-overview', async (req, res) => {
  try {
    const { raceId } = req.query;
    if (!raceId) return res.status(400).json({ error: 'raceId_required' });

    const gameMeta = await redis.hgetall(keysUtil.gameMeta(raceId));
    if (!gameMeta || !gameMeta.status) {
      return res.status(404).json({ error: 'game_not_found' });
    }

    const carColors = ['blue', 'green', 'red'];

    // gameMeta dates are already "YYYY-MM-DD" strings from Redis
    const todayStr = gameCtx.todayIST();
    let currentDay = null;
    if (todayStr === gameMeta.day1_date) currentDay = 1;
    else if (todayStr === gameMeta.day2_date) currentDay = 2;
    else if (todayStr === gameMeta.day3_date) currentDay = 3;

    const days = [];

    for (let dayNumber = 1; dayNumber <= 3; dayNumber++) {
      const dayGroupsRaw = await redis.hgetall(keysUtil.dayGroups(raceId, dayNumber));
      if (!dayGroupsRaw || !dayGroupsRaw.group_1) {
        // Groups not assigned for this day yet
        days.push({ dayNumber, status: 'pending', groups: [] });
        continue;
      }

       // Pre-fetch MySQL results for this day (fallback when Redis keys are cleaned up after race ends)
      const mysqlResults = await db.query(
        `SELECT group_number, family_id, rank_position, distance_km
           FROM family_car_race_result
          WHERE race_id = ? AND day_number = ?
          ORDER BY group_number ASC, rank_position ASC`,
        [raceId, dayNumber]
      );
      const mysqlResultsByGroup = {};
      for (const row of mysqlResults) {
        const gn = row.group_number;
        if (!mysqlResultsByGroup[gn]) mysqlResultsByGroup[gn] = [];
        mysqlResultsByGroup[gn].push({
          familyId: String(row.family_id),
          rank: row.rank_position,
          distance: row.distance_km,
        });
      }

      const groups = [];
      for (let g = 1; g <= 3; g++) {
        const familyIds = JSON.parse(dayGroupsRaw[`group_${g}`] || '[]').map(String);
        const raceMeta = await redis.hgetall(keysUtil.raceMeta(raceId, dayNumber, g));
        let groupStatus = raceMeta?.status || 'not_started';

        // Fallback: if Redis raceMeta was cleaned up but MySQL has results, mark as finished
        const mysqlGroupResults = mysqlResultsByGroup[g] || [];
        if (groupStatus === 'not_started' && mysqlGroupResults.length > 0) {
          groupStatus = 'finished';
        }

        // Get family info from MySQL
        let familyInfoMap = {};
        if (familyIds.length > 0) {
          const placeholders = familyIds.map(() => '?').join(',');
          const infoRows = await db.query(
            `SELECT g.id AS familyId, g.familyname AS familyName, g.image AS familyImage,
                    u.name AS ownerName, u.image AS ownerImage,
                    (SELECT COUNT(*) FROM users WHERE familyId = g.id) AS memberCount
               FROM \`groups\` g
               LEFT JOIN users u ON u.id = g.userId
              WHERE g.id IN (${placeholders})`,
            familyIds
          );
          for (const row of infoRows) {
            familyInfoMap[String(row.familyId)] = row;
          }
        }

        // Get live leaderboard if race is running or finished
        let leaderboard = [];
        if (groupStatus === 'running' || groupStatus === 'finished') {
          leaderboard = await lbService.getLiveLeaderboard(redis, raceId, dayNumber, g);
        }

        // Get family states from Redis
        const families = await Promise.all(familyIds.map(async (fid, idx) => {
          const info = familyInfoMap[fid] || {};
          const state = await redis.hgetall(keysUtil.familyState(raceId, dayNumber, g, fid));
          const lbEntry = leaderboard.find(e => String(e.familyId) === fid);

            // Fallback to MySQL results when Redis data is cleaned up
          const mysqlEntry = mysqlGroupResults.find(r => r.familyId === fid);

          return {
            familyId: fid,
            familyName: info.familyName || `Family ${fid}`,
            familyImage: info.familyImage || '',
            ownerName: info.ownerName || '',
            ownerImage: info.ownerImage || '',
            memberCount: info.memberCount || 0,
            car: carColors[idx] || 'blue',
            distance: Number(lbEntry?.distanceKm ?? state?.distance_traveled ??mysqlEntry?.distance ?? 0 ),
            speed: parseInt(state?.current_speed || '0', 10),
            rank: lbEntry ? lbEntry.rank : (mysqlEntry?.rank ?? null),
            isRunning: state?.is_running === '1',
          };
        }));

        groups.push({ groupNumber: g, status: groupStatus, families });
      }

      // Determine day status
      const anyRunning = groups.some(g => g.status === 'running');
      const anyFinished = groups.some(g => g.status === 'finished');
      const dayStatus = anyRunning ? 'running' : anyFinished ? 'finished' : 'pending';

      days.push({ dayNumber, status: dayStatus, groups });
    }

    return res.json({
      raceId,
      status: gameMeta.status,
      currentDay,
      days,
    });
  } catch (err) {
    console.error('[GET /game/record-overview]', err.message);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ─── GET /game/leaderboard/history ───────────────────────────────────────
//
// Returns all completed race days for the Record (leaderboard) modal.
// Available to EVERYONE — participants and spectators.
//
// Query params:
//   raceId  (required)
//
// Response:
//   { raceId, days: [ { dayNumber, race_date, groups: [ { groupNumber, results: [...] } ] } ] }

router.get('/leaderboard/history', async (req, res) => {
  try {
    const { raceId } = req.query;
    if (!raceId) {
      return res.status(400).json({ error: 'raceId_required' });
    }
    const result = await lbService.getHistoricalLeaderboard(db, raceId);
    return res.json(result);
  } catch (err) {
    console.error('[GET /game/leaderboard/history]', err.message);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ─── GET /game/leaderboard/history/day ───────────────────────────────────
//
// Same as above but filtered to a single day. Convenience endpoint.
//
// Query params:
//   raceId     (required)
//   dayNumber  (required, 1 | 2 | 3)

router.get('/leaderboard/history/day', async (req, res) => {
  try {
    const { raceId, dayNumber } = req.query;
    if (!raceId || !dayNumber) {
      return res.status(400).json({ error: 'raceId_and_dayNumber_required' });
    }
    const result = await lbService.getHistoricalDay(db, raceId, dayNumber);
    return res.json(result);
  } catch (err) {
    console.error('[GET /game/leaderboard/history/day]', err.message);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ─── GET /game/spectate ───────────────────────────────────────────────────
//
// Returns a one-time snapshot of a family's race so a spectator can
// see their current state when clicking a family in the Record modal.
//
// Only works when the race for that family is currently RUNNING.
// After this call, the spectator should also emit `spectate_room` over
// Socket.IO to receive ongoing `race:state_update` broadcasts.
//
// Query params:
//   raceId    (required)
//   familyId  (required)  — the family to watch
//   dayNumber (required)  — 1, 2, or 3
//
// Response:
//   { allowed: true,  groupNumber, familyState, leaderboard }
//   { allowed: false, reason: '...' }

router.get('/spectate', async (req, res) => {
  try {
    const { raceId, familyId, dayNumber } = req.query;
    if (!raceId || !familyId || !dayNumber) {
      return res.status(400).json({ error: 'raceId_familyId_dayNumber_required' });
    }
    const snapshot = await gameCtx.getSpectatorSnapshot(
      redis, raceId, familyId, parseInt(dayNumber, 10)
    );
    return res.json(snapshot);
  } catch (err) {
    console.error('[GET /game/spectate]', err.message);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ─── GET /game/week-leaderboard ───────────────────────────────────────────
//
// Returns top 20 families by silver coins for the current race's collection period.
// Uses race_week_start → (race_start_day - 1) from the latest family_car_race_schedule.
// Falls back to current week Monday–Thursday if no game exists.
//
// No params required — resolves dates from the latest game automatically.
//
// Response:
//   { weekStart, weekEnd, frozen, qualifyLimit, topFamilies: [ { rank, familyId, coins, familyName, familyImage, ownerName, ownerImage } ] }

router.get('/week-leaderboard', async (req, res) => {
  try {
    // Find the latest game to get its date range and status
    const [game] = await db.query(
      `SELECT race_week_start, race_start_day, status FROM family_car_race_schedule
       ORDER BY created_at DESC LIMIT 1`
    );

    let weekStart, weekEnd;
    // Ranking is frozen once grouping is done (status beyond 'scheduled')
    const frozen = game ? game.status !== 'scheduled' : false;
    const qualifyLimit = 9;

    if (game) {
      const helpers = require('../utils/helpers');
      weekStart = helpers.addDays(game.race_week_start, 0); // normalize Date obj
      weekEnd   = helpers.addDays(game.race_start_day, -1); // grouping day (day before race)
    } else {
      // No game scheduled — use last 7 days
      const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
      const nowIST = new Date(Date.now() + IST_OFFSET_MS);
      weekEnd   = nowIST.toISOString().slice(0, 10);
      const sevenAgo = new Date(nowIST);
      sevenAgo.setDate(sevenAgo.getDate() - 6);
      weekStart = sevenAgo.toISOString().slice(0, 10);
    }

    const topFamilies = await gameCtx.getWeekLeaderboard(db, weekStart, weekEnd);

    // Pad to 20 families so the frontend always shows 20 rows
    while (topFamilies.length < 20) {
      topFamilies.push({
        rank: topFamilies.length + 1,
        familyId: '',
        coins: 0,
        familyName: null,
        familyImage: null,
        ownerName: null,
        ownerImage: null,
      });
    }

    return res.json({ weekStart, weekEnd, frozen, qualifyLimit, topFamilies });
  } catch (err) {
    console.error('[GET /game/week-leaderboard]', err.message);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ─── GET /game/pre-race-lobby ─────────────────────────────────────────────
//
// Returns static pre-race data for a participant AFTER groups are assigned
// but BEFORE the race has started (status = day1/2/3_pending, race not yet running).
//
// Shows the participant their own family's projected base_speed (from pit boosts)
// plus the same data for the 2 opponent families in their group.
//
// Query params:
//   memberId   (required) — must be a participant
//   raceId     (required)
//   dayNumber  (required, 1 | 2 | 3)
//
// Response:
// {
//   raceId, dayNumber, groupNumber,
//   raceStartTime,           ← ISO string of when this day's race fires
//   ownFamily: {
//     familyId,
//     pitBoostClaims,        ← total units claimed (each = +10 speed)
//     projectedBaseSpeed,    ← 100 + (pitBoostClaims * 10)
//   },
//   opponents: [
//     { familyId, pitBoostClaims, projectedBaseSpeed },
//     { familyId, pitBoostClaims, projectedBaseSpeed },
//   ]
// }
//
// Errors:
//   400 missing_params
//   403 not_a_participant
//   404 groups_not_assigned     ← grouping worker hasn't run yet
//   409 race_already_started    ← use /race/state instead

router.get('/pre-race-lobby', async (req, res) => {
  try {
    const { memberId, raceId, dayNumber: dayStr } = req.query;

    if (!memberId || !raceId || !dayStr) {
      return res.status(400).json({ error: 'missing_params', required: ['memberId', 'raceId', 'dayNumber'] });
    }

    const dayNumber = parseInt(dayStr, 10);
    if (![1, 2, 3].includes(dayNumber)) {
      return res.status(400).json({ error: 'invalid_dayNumber', message: 'must be 1, 2, or 3' });
    }

    // ── 1. Confirm participant ──────────────────────────────────────────
    const isParticipant = await redis.sismember(
      require('../utils/keys').participants(raceId), memberId
    );
    if (!isParticipant) {
      return res.status(403).json({ error: 'not_a_participant' });
    }

    // ── 2. Check race isn't already running (wrong endpoint if so) ─────
    const activeDayGroups = await redis.smembers(
      require('../utils/keys').activeDayGroups(raceId, dayNumber)
    );
    if (activeDayGroups.length > 0) {
      return res.status(409).json({
        error: 'race_already_started',
        message: 'Race is live — use /race/state for live data',
      });
    }

    // ── 3. Resolve familyId + groupNumber from Redis ───────────────────
    const keys = require('../utils/keys');
    const familyId = await redis.hget(keys.memberFamilyInRace(raceId), memberId);
    if (!familyId) {
      return res.status(404).json({ error: 'family_not_found', message: 'Member-family mapping missing — grouping may not have run yet' });
    }

    const groupsHash = await redis.hgetall(keys.dayGroups(raceId, dayNumber));
    if (!groupsHash || !groupsHash.group_1) {
      return res.status(404).json({ error: 'groups_not_assigned', message: 'Groups for this day have not been computed yet' });
    }

    // Find which group this family is in
    let groupNumber = null;
    let allFamiliesInGroup = [];
    const fid = String(familyId);
    for (const [field, val] of Object.entries(groupsHash)) {
      const families = JSON.parse(val);
      if (families.some(id => String(id) === fid)) {
        groupNumber = parseInt(field.replace('group_', ''), 10);
        allFamiliesInGroup = families.map(String);
        break;
      }
    }
    if (groupNumber === null) {
      return res.status(404).json({ error: 'family_not_in_any_group' });
    }

    // ── 4. Read game meta to get the date string for pit boost keys ────
    const gameMeta = await redis.hgetall(keys.gameMeta(raceId));
    const raceDate = gameMeta ? gameMeta[`day${dayNumber}_date`] : null;
    if (!raceDate) {
      return res.status(404).json({ error: 'game_meta_missing' });
    }

    // Race start datetime string for the client countdown
    const raceStartTime = gameMeta.race_start_time || null;
    const raceStartISO  = raceDate && raceStartTime
      ? `${raceDate}T${raceStartTime}+05:30`
      : null;

    // ── 5. Read pit boost for all families in the group in parallel ────
    const boostPipeline = redis.pipeline();
    for (const fid of allFamiliesInGroup) {
      boostPipeline.get(keys.familyBoost(raceId, dayNumber, raceDate, fid));
    }
    const boostResults = await boostPipeline.exec();

    const familyData = allFamiliesInGroup.map((fid, i) => {
      const [, val]        = boostResults[i];
      const pitBoostClaims = parseInt(val || '0', 10);
      return {
        familyId:            fid,
        pitBoostClaims,
        projectedBaseSpeed:  100 + (pitBoostClaims * GAME.PIT_BOOST_PER_UNIT),
      };
    });

    // ── 6. Split own family vs opponents ──────────────────────────────
    const ownFamily = familyData.find(f => f.familyId === familyId);
    const opponents = familyData.filter(f => f.familyId !== familyId);

    return res.json({
      raceId,
      dayNumber,
      groupNumber,
      raceStartISO,       // ISO-8601 string — client uses this for countdown timer
      ownFamily,
      opponents,
    });

  } catch (err) {
    console.error('[GET /game/pre-race-lobby]', err.message);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ─── GET /game/groups/:dayNumber ──────────────────────────────────────────
//
// Returns all 3 groups for a race day with full family info (name, image, owner).
// Used by the Record page to display group cards with real data.
//
// Query params:
//   raceId     (required)
//
// Response:
// {
//   raceId, dayNumber,
//   groups: [
//     {
//       groupNumber: 1,
//       families: [
//         { familyId, familyName, familyImage, ownerName, ownerImage },
//         ...
//       ]
//     },
//     ...
//   ]
// }

router.get('/groups/:dayNumber', async (req, res) => {
  try {
    const { raceId } = req.query;
    const dayNumber = parseInt(req.params.dayNumber, 10);

    if (!raceId || ![1, 2, 3].includes(dayNumber)) {
      return res.status(400).json({ error: 'missing_params', required: ['raceId', 'dayNumber(1-3)'] });
    }

    const keysUtil = require('../utils/keys');
    const groupsHash = await redis.hgetall(keysUtil.dayGroups(raceId, dayNumber));
    if (!groupsHash || !groupsHash.group_1) {
      return res.status(404).json({ error: 'groups_not_assigned' });
    }

    // Collect all unique familyIds across all groups
    const allFamilyIds = [];
    const groupEntries = [];
    for (let g = 1; g <= 3; g++) {
      const raw = groupsHash[`group_${g}`];
      if (!raw) continue;
      const familyIds = JSON.parse(raw);
      groupEntries.push({ groupNumber: g, familyIds });
      allFamilyIds.push(...familyIds);
    }

    // Fetch family info from MySQL: familyname, image, owner user info
    let familyInfoMap = {};
    if (allFamilyIds.length > 0) {
      const placeholders = allFamilyIds.map(() => '?').join(',');
      const rows = await db.query(
        `SELECT g.id AS familyId, g.familyname, g.image AS familyImage,
                u.id AS ownerId, u.name AS ownerName, u.image AS ownerImage,
                (SELECT COUNT(*) FROM groupsmembers gm WHERE gm.familyId = g.id AND gm.memberStatus = '1') AS memberCount
           FROM \`groups\` g
           LEFT JOIN users u ON u.id = g.userId
          WHERE g.id IN (${placeholders})`,
        allFamilyIds
      );
      for (const row of rows) {
        familyInfoMap[String(row.familyId)] = {
          familyId:    String(row.familyId),
          familyName:  row.familyname || '',
          familyImage: row.familyImage || '',
          ownerName:   row.ownerName || '',
          ownerImage:  row.ownerImage || '',
          memberCount: parseInt(row.memberCount, 10) || 0,
        };
      }
    }

    // Build response
    const groups = groupEntries.map(({ groupNumber, familyIds }) => ({
      groupNumber,
      families: familyIds.map(fid => familyInfoMap[String(fid)] || {
        familyId: String(fid),
        familyName: '',
        familyImage: '',
        ownerName: '',
        ownerImage: '',
        memberCount: 0,
      }),
    }));

    return res.json({ raceId, dayNumber, groups });

  } catch (err) {
    console.error('[GET /game/groups/:dayNumber]', err.message);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

module.exports = router;
