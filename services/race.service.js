'use strict';

/**
 * services/race.service.js
 *
 * Redis read/write helpers for race state:
 *   - Family state hash (speed, distance, fuel_status, etc.)
 *   - Leaderboard sorted set
 *   - Race meta hash
 *   - Pit boost calculation
 */

const keys = require('../utils/keys');
const GAME = require('../constants/game');

/**
 * Writes the initial state hash for one family at race start.
 */
async function initFamilyState(redis, raceId, dayNumber, groupNumber, familyId, baseSpeed, startedAt) {
  await redis.hset(keys.familyState(raceId, dayNumber, groupNumber, familyId), {
    base_speed:        String(baseSpeed),
    current_speed:     String(baseSpeed),
    max_speed:         String(baseSpeed),
    distance_traveled: '0',
    egg_penalty:       '0',
    is_running:        '1',
    fuel_status:       'ok',
    race_start_ts:     String(startedAt),
    race_id:           raceId,
    day_number:        String(dayNumber),
    group_number:      String(groupNumber),
    family_id:         familyId,
  });
}

/**
 * Reads and returns the full family state hash.
 * Returns null if the key doesn't exist.
 */
async function getFamilyState(redis, raceId, dayNumber, groupNumber, familyId) {
  const state = await redis.hgetall(keys.familyState(raceId, dayNumber, groupNumber, familyId));
  return Object.keys(state).length ? state : null;
}

/**
 * Reads total pit boost units for a family on a race day and returns base_speed.
 * base_speed = 100 + (total_boost_units * PIT_BOOST_PER_UNIT)
 */
async function computeBaseSpeed(redis, raceId, dayNumber, date, familyId) {
  const val = await redis.get(keys.familyBoost(raceId, dayNumber, date, familyId));
  const totalBoost = parseInt(val || '0', 10);
  return 100 + (totalBoost * GAME.PIT_BOOST_PER_UNIT);
}

/**
 * Writes race meta hash for one group race.
 */
async function initRaceMeta(redis, raceId, dayNumber, groupNumber, families, startedAt) {
  await redis.hset(keys.raceMeta(raceId, dayNumber, groupNumber), {
    race_id:      raceId,
    day_number:   String(dayNumber),
    group_number: String(groupNumber),
    families:     JSON.stringify(families),
    status:       'running',
    started_at:   String(startedAt),
  });
}

/**
 * Reads families array from a group race meta hash.
 * Returns parsed array of familyIds.
 */
async function getFamiliesForGroup(redis, raceId, dayNumber, groupNumber) {
  const raw = await redis.hget(keys.raceMeta(raceId, dayNumber, groupNumber), 'families');
  return raw ? JSON.parse(raw) : [];
}

module.exports = {
  initFamilyState,
  getFamilyState,
  computeBaseSpeed,
  initRaceMeta,
  getFamiliesForGroup,
};
