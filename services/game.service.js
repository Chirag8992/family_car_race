'use strict';

/**
 * services/game.service.js
 *
 * Game creation, retrieval, and status management.
 * Writes to both MySQL (family_car_race_schedule) and Redis (meta hash + TTL trigger keys).
 */

const keys          = require('../utils/keys');
const helpers       = require('../utils/helpers');

// ─── Input validation ─────────────────────────────────────────────────────

function validateCreateInput({ race_week_start, race_start_day, race_end_day, race_start_time }) {
  if (!helpers.isValidDateString(race_week_start)) throw new Error('race_week_start must be YYYY-MM-DD');
  if (!helpers.isValidDateString(race_start_day))  throw new Error('race_start_day must be YYYY-MM-DD');
  if (!helpers.isValidDateString(race_end_day))     throw new Error('race_end_day must be YYYY-MM-DD');
  if (!helpers.isValidTimeString(race_start_time))  throw new Error('race_start_time must be HH:MM:SS');

  // race_week_start must be exactly 4 days before race_start_day
  // const expectedWeekStart = helpers.addDays(race_start_day, -4);
  // if (race_week_start !== expectedWeekStart)
  //   throw new Error(`race_week_start must be 4 days before race_start_day (expected ${expectedWeekStart})`);

  // race_week_start must be before race_start_day
  if (race_week_start >= race_start_day)
    throw new Error('race_week_start must be before race_start_day');

  // race_end_day must be exactly 2 days after race_start_day (3-day race)
  const expectedEnd = helpers.addDays(race_start_day, 2);
  if (race_end_day !== expectedEnd)
    throw new Error(`race_end_day must be race_start_day + 2 days (expected ${expectedEnd})`);
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Creates a new game week.
 * Inserts into family_car_race_schedule, writes Redis meta hash, creates 3 TTL trigger keys.
 *
 * @param {{ race_week_start, race_start_day, race_end_day, race_start_time }} body
 * @param {object}               db    - config/mysql module
 * @param {import('ioredis').Redis} redis
 * @returns {{ raceId, grouping_date, day1_date, day2_date, day3_date }}
 */
async function createGame(body, db, redis) {
  validateCreateInput(body);

  const { race_week_start, race_start_day, race_end_day, race_start_time } = body;
  // grouping_date = one day before race start (no longer fixed to Thursday)
  const grouping_date = helpers.addDays(race_start_day, -1);
  const day1_date     = race_start_day;
  const day2_date     = helpers.addDays(race_start_day, 1);
  const day3_date     = helpers.addDays(race_start_day, 2);

  // MySQL — id is AUTO_INCREMENT, get insertId
  const result = await db.query(
    `INSERT INTO family_car_race_schedule
       (race_week_start, race_start_day, race_end_day, race_start_time, status, created_at)
     VALUES (?, ?, ?, ?, 'scheduled', NOW())`,
    [race_week_start, race_start_day, race_end_day, race_start_time]
  );
  const raceId = result.insertId;

  // Redis meta hash
  await redis.hset(keys.gameMeta(raceId), {
    race_id:         raceId,
    race_week_start,
    race_start_day,
    race_end_day,
    race_start_time,
    grouping_date,
    day1_date,
    day2_date,
    day3_date,
    status:          'scheduled',
    current_day:     '0',
  });

  // 3 TTL trigger keys
  const dayDates = [day1_date, day2_date, day3_date];
  for (let i = 0; i < 3; i++) {
    const dayNumber = i + 1;
    const ttl = helpers.secondsUntil(dayDates[i], race_start_time);
    if (ttl > 0) {
      await redis.set(keys.gameStartTrigger(raceId, dayNumber), '1', 'EX', ttl);
      console.log(`[game] Trigger key set: day${dayNumber} TTL=${ttl}s`);
    } else {
      console.warn(`[game] Day ${dayNumber} start time already passed — trigger not set`);
    }
  }

  return { raceId, grouping_date, day1_date, day2_date, day3_date };
}

/**
 * Returns a family_car_race_schedule row from MySQL, or null if not found.
 */
async function getGame(raceId, db) {
  const rows = await db.query('SELECT * FROM family_car_race_schedule WHERE id = ?', [raceId]);
  return rows[0] || null;
}

/**
 * Updates game status in both MySQL and the Redis meta hash.
 */
async function updateGameStatus(raceId, status, db, redis) {
  await db.query('UPDATE family_car_race_schedule SET status = ? WHERE id = ?', [status, raceId]);
  await redis.hset(keys.gameMeta(raceId), 'status', status);
}

module.exports = { createGame, getGame, updateGameStatus };
