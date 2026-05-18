'use strict';

/**
 * jobs/queue.js
 *
 * BullMQ Queue definitions, job-enqueue helpers, and cron schedule setup.
 *
 * Race queues (one per worker type — prevents job-stealing between workers):
 *   race-queue      → distance-tick repeat jobs only
 *   race-fuel-queue → fuel-window-open and fuel-window-check jobs
 *   race-end-queue  → race-end jobs
 * Shared queues:
 *   pit-queue       → pit window cron (8AM, 2PM, 7PM IST daily)
 *   grouping-queue  → midnight IST auto-grouping cron
 *
 * Cron jobs are upserted (idempotent) so server restarts don't duplicate them.
 */

const { Queue }  = require('bullmq');
const env        = require('../config/env');
const GAME       = require('../constants/game');

// BullMQ uses its own ioredis connection — separate from the app's redisClient.
const connection = {
  host: env.REDIS_PARTYROOM_URL,
  port: env.REDIS_PORT,
};

const raceQueue     = new Queue(GAME.QUEUE_NAMES.RACE,      { connection });
const raceFuelQueue = new Queue(GAME.QUEUE_NAMES.RACE_FUEL, { connection });
const raceEndQueue  = new Queue(GAME.QUEUE_NAMES.RACE_END,  { connection });
const pitQueue      = new Queue(GAME.QUEUE_NAMES.PIT,       { connection });
const groupingQueue = new Queue(GAME.QUEUE_NAMES.GROUPING,  { connection });

// ─── Race job enqueue ─────────────────────────────────────────────────────

/**
 * Enqueues all 6 BullMQ jobs for one group race.
 * Called by gameStart worker for each of the 3 groups.
 *
 * Jobs:
 *   distance-tick:{raceId}:d{n}:g{g}  → repeat every 1000ms
 *   fuel-window-open-1                 → delay: T+14min
 *   fuel-window-check-1                → delay: T+14min 59s
 *   fuel-window-open-2                 → delay: T+44min
 *   fuel-window-check-2                → delay: T+44min 59s
 *   race-end                           → delay: T+60min
 *
 * @param {string} raceId
 * @param {number} dayNumber
 * @param {number} groupNumber
 */
async function enqueueRaceJobs(raceId, dayNumber, groupNumber) {
  const base    = { raceId, dayNumber, groupNumber };
  const tickName = `${GAME.JOB_NAMES.DISTANCE_TICK}:${raceId}:d${dayNumber}:g${groupNumber}`;

  const fw1OpenDelay  = GAME.FUEL_WINDOW_1_MINUTE * 60 * 1000;
  const fw1CheckDelay = (GAME.FUEL_WINDOW_1_MINUTE * 60 + GAME.FUEL_WINDOW_DURATION_SEC) * 1000;
  const fw2OpenDelay  = GAME.FUEL_WINDOW_2_MINUTE * 60 * 1000;
  const fw2CheckDelay = (GAME.FUEL_WINDOW_2_MINUTE * 60 + GAME.FUEL_WINDOW_DURATION_SEC) * 1000;
  const raceEndDelay  = GAME.RACE_DURATION_MS;

  await Promise.all([
    // Tick jobs → race-queue (dedicated, distanceTick worker only)
    raceQueue.add(tickName, base, { repeat: { every: 1000 } }),

    // Fuel window jobs → race-fuel-queue (fuelWindow worker only)
    raceFuelQueue.add(GAME.JOB_NAMES.FUEL_WINDOW_OPEN_1,
      { ...base, windowIndex: 1 }, { delay: fw1OpenDelay }),

    raceFuelQueue.add(GAME.JOB_NAMES.FUEL_WINDOW_CHECK_1,
      { ...base, windowIndex: 1 }, { delay: fw1CheckDelay }),

    raceFuelQueue.add(GAME.JOB_NAMES.FUEL_WINDOW_OPEN_2,
      { ...base, windowIndex: 2 }, { delay: fw2OpenDelay }),

    raceFuelQueue.add(GAME.JOB_NAMES.FUEL_WINDOW_CHECK_2,
      { ...base, windowIndex: 2 }, { delay: fw2CheckDelay }),

    // Race end → race-end-queue (raceEnd worker only)
    raceEndQueue.add(GAME.JOB_NAMES.RACE_END, base, { delay: raceEndDelay }),
  ]);

  console.log(`[queue] Race jobs enqueued — ${raceId} day${dayNumber} group${groupNumber}`);
}

/**
 * Removes the repeating distance-tick job for a specific group race.
 * Called at race end.
 *
 * @param {string} raceId
 * @param {number} dayNumber
 * @param {number} groupNumber
 */
async function removeTickJob(raceId, dayNumber, groupNumber) {
  const tickName = `${GAME.JOB_NAMES.DISTANCE_TICK}:${raceId}:d${dayNumber}:g${groupNumber}`;
  try {
    await raceQueue.removeRepeatable(tickName, { every: 1000 });
    console.log(`[queue] Tick job removed — ${tickName}`);
  } catch (err) {
    console.warn(`[queue] Could not remove tick job ${tickName}:`, err.message);
  }
}

// ─── Cron job setup ───────────────────────────────────────────────────────

/**
 * Registers persistent cron jobs (idempotent — safe to call on every restart).
 * Must be awaited once during server startup.
 *
 * Cron patterns are IST-based (UTC+05:30) to align with
 *   helpers.secondsUntil() which parses race_start_time as IST.
 *   - Pit windows fire at 08:00, 14:00, 19:00 IST
 *     → UTC: 02:30, 08:30, 13:30  → pattern '30 2,8,13 * * *'
 *   - Grouping fires at 12:00 IST
 *     → UTC: 06:30                → pattern '30 6 * * *'
 *
 * { updateData: true } ensures the job definition is refreshed on
 *   restart even if BullMQ already has a job with the same jobId. This is
 *   the idempotent "upsert" behaviour — without it BullMQ silently ignores
 *   the add() call if the jobId already exists, which can leave a stale
 *   cron pattern running after a schedule change.
 */
async function setupCronJobs() {
  // 8AM IST, 2PM IST, 7PM IST — explicit Asia/Kolkata timezone
  await pitQueue.add(
    GAME.JOB_NAMES.PIT_WINDOW_OPEN,
    {},
    {
      repeat:       { pattern: '45 11,13,19* * *', tz: 'Asia/Kolkata' },
      jobId:        'pit-window-cron',
      updateData:   true,
    }
  );

  // Grouping at 12:00 AM (midnight) IST — one day before race_start_day
  await groupingQueue.add(
    GAME.JOB_NAMES.THURSDAY_GROUPING,
    {},
    {
      repeat:       { pattern: '30 11 * * *', tz: 'Asia/Kolkata' },
      jobId:        'thursday-grouping-cron',
      updateData:   true,
    }
  );

  console.log('[queue] Cron jobs registered (IST-based schedules)');
}

module.exports = {
  queues: { raceQueue, raceFuelQueue, raceEndQueue, pitQueue, groupingQueue },
  enqueueRaceJobs,
  removeTickJob,
  setupCronJobs,
};
