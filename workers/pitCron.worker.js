'use strict';

/**
 * workers/pitCron.worker.js
 *
 * BullMQ Worker: processes pit window cron jobs at 8AM, 2PM, 7PM every day.
 * Only opens pit windows on actual race days (Friday/Saturday/Sunday).
 * Broadcasts pit_window_open to all connected Socket.IO clients.
 */

const { Worker } = require('bullmq');
const env         = require('../config/env');
const GAME        = require('../constants/game');
const helpers     = require('../utils/helpers');
const pitService  = require('../services/pit.service');
const gameService = require('../services/game.service');
const { redisClient } = require('../config/redis');
const db          = require('../config/mysql');
const ioSingleton = require('../socket/io');
const keys        = require('../utils/keys');

const connection = { host: env.REDIS_PARTYROOM_URL, port: env.REDIS_PORT };

/**
 * Returns the current hour in IST (UTC+05:30).
 * Fix #15: use IST for pit window resolution to match the IST-based cron schedule.
 */
function currentISTHour() {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // +05:30
  return new Date(Date.now() + IST_OFFSET_MS).getUTCHours();
}

/**
 * Fix #15: Map IST hour to pit window key.
 * Cron fires at 8:00, 14:00, 19:00 IST.
 */
function pitWindowKeyFromISTHour(istHour) {
  const map = { 8: 'morning', 10: 'afternoon', 15: 'evening' };
  return map[istHour] ?? null;
}

async function getActiveGroupNumbers(redis, raceId, dayNumber) {
  const activeGroups = await redis.smembers(keys.activeDayGroups(raceId, dayNumber));
  if (activeGroups.length > 0) return activeGroups;

  // Race hasn't started yet (pit window opens before race start) —
  // derive group numbers from the dayGroups hash instead.
  const groupsHash = await redis.hgetall(keys.dayGroups(raceId, dayNumber));
  if (!groupsHash || !groupsHash.group_1) return [];

  // Return whichever group keys exist ('1', '2', '3')
  return Object.keys(groupsHash)
    .filter(k => k.startsWith('group_'))
    .map(k => k.replace('group_', ''));
}

const worker = new Worker(
  GAME.QUEUE_NAMES.PIT,
  async (job) => {
    if (job.name !== GAME.JOB_NAMES.PIT_WINDOW_OPEN) return;
    console.log(`[pitCron] Worker started, waiting for cron jobs...`);

    const istHour   = currentISTHour(); // Fix #15: IST hour
    const windowKey = pitWindowKeyFromISTHour(istHour);

    if (!windowKey) {
      console.warn(`[pitCron] Unknown pit cron IST hour: ${istHour} (UTC: ${new Date().getUTCHours()})`);
      return;
    }

    // today as a YYYY-MM-DD string � using IST date to match race schedule dates
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const todayIST = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);

    const games = await db.query(
      `SELECT id, race_start_day FROM family_car_race_schedule
        WHERE status IN ('day1_pending','day2_pending','day3_pending')`
    );

    const redis = redisClient;
    const io    = ioSingleton.get();

    for (const game of games) {
      const { id: raceId, race_start_day } = game;

      const day1 = helpers.addDays(race_start_day, 0);  // normalize Date obj → string
      const day2 = helpers.addDays(race_start_day, 1);
      const day3 = helpers.addDays(race_start_day, 2);

      let dayNumber = null;
      if (todayIST === day1) dayNumber = 1;
      else if (todayIST === day2) dayNumber = 2;
      else if (todayIST === day3) dayNumber = 3;

      if (!dayNumber) continue;

      await pitService.openPitWindow(redis, raceId, dayNumber, todayIST, windowKey);

      const closesAt = Date.now() + GAME.PIT_WINDOW_DURATION_SEC * 1000;
      if (io) {
      	 const groupNumbers = await getActiveGroupNumbers(redis, raceId, dayNumber);

        if (groupNumbers.length === 0) {
          // Grouping hasn't run yet or all races already finished.
          // Nothing to broadcast — clients will poll /pit/status on connect.
          console.warn(`[pitCron] No group rooms found for ${raceId} day${dayNumber} — skipping broadcast`);
        } else {
          for (const gNum of groupNumbers) {
            const room = `${raceId}:d${dayNumber}:g${gNum}`;
            io.to(room).emit('pit_window_open', {
              raceId,
              dayNumber,
              windowKey,
              closes_at: closesAt,
            });
          }
        }
      }

      console.log(`[pitCron] Pit window opened: ${raceId} day${dayNumber} ${windowKey} (IST hour: ${istHour})`);
    }
  },
  { connection }
);

worker.on('error',  (err) => console.error('[pitCron] Worker error:', err.message));
worker.on('failed', (job, err) => console.error(`[pitCron] Job failed: ${err.message}`));

module.exports = {};
