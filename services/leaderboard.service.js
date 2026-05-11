'use strict';

/**
 * services/leaderboard.service.js
 *
 * Live leaderboard (Redis sorted set) and historical leaderboard (MySQL).
 */

const keys = require('../utils/keys');

/**
 * Returns live leaderboard from Redis sorted set (rank 1 first).
 * Used during an active race.
 *
 * @returns {{ rank: number, familyId: string, distanceKm: number }[]}
 */
async function getLiveLeaderboard(redis, raceId, dayNumber, groupNumber) {
  const raw = await redis.zrevrange(
    keys.leaderboard(raceId, dayNumber, groupNumber), 0, -1, 'WITHSCORES'
  );
  const result = [];
  for (let i = 0; i < raw.length; i += 2) {
    result.push({
      rank:       (i / 2) + 1,
      familyId:   raw[i],
      distanceKm: parseFloat(raw[i + 1]),
    });
  }
  return result;
}

/**
 * Returns all completed race results for a game from MySQL,
 * formatted as nested days → groups → results.
 */
async function getHistoricalLeaderboard(db, raceId) {
  const rows = await db.query(
    `SELECT day_number, group_number, family_id, rank_position, distance_km, race_date
       FROM race_results
      WHERE race_id = ?
      ORDER BY day_number ASC, group_number ASC, rank_position ASC`,
    [raceId]
  );
  return formatLeaderboard(raceId, rows);
}

/**
 * Same as getHistoricalLeaderboard but filtered to a single day.
 */
async function getHistoricalDay(db, raceId, dayNumber) {
  const rows = await db.query(
    `SELECT day_number, group_number, family_id, rank_position, distance_km, race_date
       FROM race_results
      WHERE race_id = ? AND day_number = ?
      ORDER BY group_number ASC, rank_position ASC`,
    [raceId, parseInt(dayNumber, 10)]
  );
  return formatLeaderboard(raceId, rows);
}

// ─── Internal helper ──────────────────────────────────────────────────────

function formatLeaderboard(raceId, rows) {
  const daysMap = new Map();

  for (const row of rows) {
    if (!daysMap.has(row.day_number)) {
      daysMap.set(row.day_number, {
        day_number: row.day_number,
        race_date:  row.race_date,
        groups:     new Map(),
      });
    }
    const day = daysMap.get(row.day_number);
    if (!day.groups.has(row.group_number)) {
      day.groups.set(row.group_number, { group_number: row.group_number, results: [] });
    }
    day.groups.get(row.group_number).results.push({
      rank:       row.rank_position,
      family_id:  row.family_id,
      distance_km: parseFloat(row.distance_km),
      won:        row.rank_position === 1,
    });
  }

  return {
    race_id: raceId,
    days: [...daysMap.values()].map(d => ({
      day_number: d.day_number,
      race_date:  d.race_date,
      groups:     [...d.groups.values()],
    })),
  };
}

module.exports = { getLiveLeaderboard, getHistoricalLeaderboard, getHistoricalDay };
