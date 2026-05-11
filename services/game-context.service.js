'use strict';

/**
 * services/game-context.service.js
 *
 * Resolves a caller's game context without authentication.
 * Used by GET /game/context to determine whether a user is:
 *   - a participant (family selected for the race)
 *   - a spectator   (family not selected)
 *   - non_race_week (no active game this week)
 *
 * Also provides helpers for the week leaderboard (non-race days).
 */

const keys    = require('../utils/keys');
const helpers = require('../utils/helpers');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Converts a MySQL DATE value (Date object or string) to "YYYY-MM-DD" in IST.
 * MySQL driver returns DATE '2026-05-10' as Date(2026-05-09T18:30:00Z)
 * because it interprets midnight local (IST). We must add the IST offset
 * before slicing to get the correct date string.
 */
function mysqlDateToIST(d) {
  if (d instanceof Date) {
    return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
  }
  return String(d).slice(0, 10);
}

// ─── IST date helpers ─────────────────────────────────────────────────────

/**
 * Returns today's date as "YYYY-MM-DD" in IST (UTC+05:30).
 */
function todayIST() {
  const now    = new Date();
  const offset = 5.5 * 60 * 60 * 1000; // IST = UTC+5:30
  return new Date(now.getTime() + offset).toISOString().slice(0, 10);
}

/**
 * Returns the Monday of the current IST week as "YYYY-MM-DD".
 */
function currentWeekMondayIST() {
  const today = new Date(todayIST() + 'T00:00:00Z');
  const dow   = today.getUTCDay(); // 0=Sun, 1=Mon … 6=Sat
  const diff  = dow === 0 ? -6 : 1 - dow;  // shift to Monday
  const mon   = new Date(today.getTime() + diff * 86400000);
  return mon.toISOString().slice(0, 10);
}

/**
 * Returns the Thursday of the current IST week (grouping day) as "YYYY-MM-DD".
 */
function currentWeekThursdayIST() {
  return helpers.addDays(currentWeekMondayIST(), 3);
}

// ─── Context resolution ───────────────────────────────────────────────────

/**
 * Queries MySQL for any currently active game schedule.
 * Returns the row or null.
 *
 * Active statuses mean the game week is underway (grouping done or race running).
 * We also include 'scheduled' so the context is visible before Thursday grouping.
 */
async function getActiveGame(db) {
  const rows = await db.query(
    `SELECT id, race_week_start, race_start_day, race_end_day, race_start_time, status
       FROM family_car_race_schedule
      WHERE status NOT IN ('completed')
      ORDER BY created_at DESC
      LIMIT 1`
  );
  return rows.length ? rows[0] : null;
}

/**
 * Given a game row, determines which dayNumber is currently active.
 * Returns 1, 2, 3, or null if today is not a race day.
 */
function currentDayNumber(game) {
  const today = todayIST();
  const d1    = mysqlDateToIST(game.race_start_day);

  const d2 = helpers.addDays(d1, 1);
  const d3 = helpers.addDays(d1, 2);

  if (today === d1) return 1;
  if (today === d2) return 2;
  if (today === d3) return 3;
  return null;
}

/**
 * Resolves the group number of the given family for the given race day
 * by reading the dayGroups Redis hash.
 *
 * @returns {number|null}
 */
async function resolveFamilyGroup(redis, raceId, dayNumber, familyId) {
  if (!dayNumber) return null;
  const groupsHash = await redis.hgetall(keys.dayGroups(raceId, dayNumber));
  if (!groupsHash) return null;
  const fid = String(familyId);
  for (const [field, val] of Object.entries(groupsHash)) {
    const families = JSON.parse(val);
    if (families.some(id => String(id) === fid)) {
      return parseInt(field.replace('group_', ''), 10);
    }
  }
  return null;
}

/**
 * Determines the race status for a specific group:
 *   'not_started' | 'running' | 'finished'
 */
async function resolveRaceStatus(redis, raceId, dayNumber, groupNumber) {
  if (!dayNumber || !groupNumber) return 'not_started';
  const raceMeta = await redis.hgetall(keys.raceMeta(raceId, dayNumber, groupNumber));
  if (!raceMeta || !raceMeta.status) return 'not_started';
  return raceMeta.status; // 'running' | 'finished'
}

/**
 * Master context resolver — call once per /game/context request.
 *
 * @param {string|null} memberId  — from query param (may be missing)
 * @param {object}      db        — mysql module
 * @param {import('ioredis').Redis} redis
 * @returns {object}              — context payload for the client
 */
async function resolveGameContext(memberId, db, redis) {
  const game = await getActiveGame(db);

  // ── No active game → show week leaderboard ────────────────────────────
  if (!game) {
    // Try to get the latest game's date range for the leaderboard
    const [latestGame] = await db.query(
      `SELECT race_week_start, race_start_day FROM family_car_race_schedule ORDER BY created_at DESC LIMIT 1`
    );
    let weekStart, weekEnd;
    if (latestGame) {
      weekStart = helpers.addDays(latestGame.race_week_start, 0);
      weekEnd   = helpers.addDays(latestGame.race_start_day, -1);
    }
    const weekLeaderboard = await getWeekLeaderboard(db, weekStart, weekEnd);
    return { mode: 'non_race_week', weekLeaderboard };
  }

  // ── Build race info block ─────────────────────────────────────────────
  const d1 = mysqlDateToIST(game.race_start_day);

  const raceInfo = {
    raceId:        game.id,
    status:        game.status,
    raceStartDay:  d1,
    day1:          d1,
    day2:          helpers.addDays(d1, 1),
    day3:          helpers.addDays(d1, 2),
    raceStartTime: game.race_start_time,
  };

  const dayNumber = currentDayNumber(game);

  // ── No memberId supplied → spectator ─────────────────────────────────
  if (!memberId) {
    return { mode: 'spectator', race: { ...raceInfo, dayNumber } };
  }

  // ── Check participant membership ──────────────────────────────────────
  const isParticipant = await redis.sismember(keys.participants(game.id), memberId);

  let familyId = null;
  let groupNumber = null;

  if (isParticipant) {
    familyId = await redis.hget(keys.memberFamilyInRace(game.id), memberId);
  }

  // Fallback: if not in participants set, try to find via family membership in groups.
  // This handles manual grouping or cases where participants set wasn't populated.
  if (!familyId && dayNumber) {
    const memberFamilyRows = await db.query(
      `SELECT familyId FROM groupsmembers WHERE userId = ? AND memberStatus = '1' LIMIT 1`,
      [memberId]
    );
    if (memberFamilyRows.length > 0) {
      const candidateFamilyId = String(memberFamilyRows[0].familyId);
      const foundGroup = await resolveFamilyGroup(redis, game.id, dayNumber, candidateFamilyId);
      if (foundGroup) {
        familyId = candidateFamilyId;
        groupNumber = foundGroup;
      }
    }
  }

  if (!familyId) {
    return { mode: 'spectator', race: { ...raceInfo, dayNumber } };
  }

  // ── Participant: resolve groupNumber + raceStatus ─────────────────────
  if (!groupNumber) {
    groupNumber = await resolveFamilyGroup(redis, game.id, dayNumber, familyId);
  }
  const raceStatus  = await resolveRaceStatus(redis, game.id, dayNumber, groupNumber);

  return {
    mode: 'participant',
    race: {
      ...raceInfo,
      dayNumber,
      raceStatus,        // 'not_started' | 'running' | 'finished'
    },
    participant: {
      memberId,
      familyId,
      groupNumber,
      dayNumber,
    },
  };
}

// ─── Week leaderboard ─────────────────────────────────────────────────────

/**
 * Returns top 20 families ranked by silver coins for the given date range.
 * Uses the game's race_week_start → race_start_day (grouping day - 1 day before race).
 *
 * @param {object} db
 * @param {string} weekStart — "YYYY-MM-DD" (race_week_start)
 * @param {string} weekEnd   — "YYYY-MM-DD" (race_start_day - 1, i.e. grouping day)
 */
async function getWeekLeaderboard(db, weekStart, weekEnd) {
  // Fallback to current week Monday–Thursday if not provided
  if (!weekStart) weekStart = currentWeekMondayIST();
  if (!weekEnd) weekEnd = currentWeekThursdayIST();

  try {
    const rows = await db.query(
      `SELECT gde.familyId,
              SUM(gde.silverExp) AS total_coins,
              g.familyname,
              g.image AS familyImage,
              u.name  AS ownerName,
              u.image AS ownerImage
         FROM groups_daily_exp gde
         LEFT JOIN \`groups\` g ON g.id = gde.familyId
         LEFT JOIN users u ON u.id = g.userId
        WHERE gde.date >= ? AND gde.date <= ?
        GROUP BY gde.familyId, g.familyname, g.image, u.name, u.image
        ORDER BY total_coins DESC
        LIMIT 20`,
      [weekStart, weekEnd]
    );

    return rows.map((r, i) => ({
      rank:       i + 1,
      familyId:   String(r.familyId),
      coins:      parseInt(r.total_coins, 10),
      familyName: r.familyname || null,
      familyImage: r.familyImage || null,
      ownerName:  r.ownerName || null,
      ownerImage: r.ownerImage || null,
    }));
  } catch (err) {
    // Table may not exist yet in dev — return empty gracefully
    console.warn('[game-context] week leaderboard query failed:', err.message);
    return [];
  }
}

// ─── Spectator snapshot ───────────────────────────────────────────────────

/**
 * Returns a one-time snapshot of a family's race state for spectators.
 * No Socket.IO join here — the client does a separate spectate_room event.
 *
 * @returns {{ allowed, groupNumber, familyState, leaderboard } | { allowed: false }}
 */
async function getSpectatorSnapshot(redis, raceId, familyId, dayNumber) {
  const groupNumber = await resolveFamilyGroup(redis, raceId, dayNumber, familyId);
  if (groupNumber === null) {
    return { allowed: false, reason: 'family_not_found_in_groups' };
  }

  const raceMeta = await redis.hgetall(keys.raceMeta(raceId, dayNumber, groupNumber));
  if (!raceMeta || !raceMeta.status) {
    return { allowed: false, reason: 'race_not_started' };
  }
  if (raceMeta.status !== 'running') {
    return { allowed: false, reason: 'race_not_running' };
  }

  const [rawState, lbRaw] = await Promise.all([
    redis.hgetall(keys.familyState(raceId, dayNumber, groupNumber, familyId)),
    redis.zrevrange(keys.leaderboard(raceId, dayNumber, groupNumber), 0, -1, 'WITHSCORES'),
  ]);

  const familyState = rawState ? {
    current_speed:      parseInt(rawState.current_speed, 10),
    max_speed:          parseInt(rawState.max_speed, 10),
    distance_traveled:  parseFloat(rawState.distance_traveled),
    is_running:         rawState.is_running === '1',
    fuel_status:        rawState.fuel_status,
  } : null;

  const leaderboard = [];
  for (let i = 0; i < lbRaw.length; i += 2) {
    leaderboard.push({
      rank:       (i / 2) + 1,
      familyId:   lbRaw[i],
      distanceKm: parseFloat(lbRaw[i + 1]),
    });
  }

  return { allowed: true, groupNumber, familyState, leaderboard };
}

module.exports = {
  resolveGameContext,
  getWeekLeaderboard,
  getSpectatorSnapshot,
  currentDayNumber,
  todayIST,
  currentWeekMondayIST,
  currentWeekThursdayIST,
};
