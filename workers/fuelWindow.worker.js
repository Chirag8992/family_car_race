'use strict';

/**
 * workers/fuelWindow.worker.js
 *
 * BullMQ Worker: handles fuel window open and check jobs.
 *   fuel-window-open-{1|2}  → SET window key EX 59, broadcast fuel_window_open
 *   fuel-window-check-{1|2} → check family compliance, stop non-fuelers, broadcast
 */

const { Worker } = require('bullmq');
const env        = require('../config/env');
const GAME       = require('../constants/game');
const keys       = require('../utils/keys');
const fuelService = require('../services/fuel.service');
const raceService = require('../services/race.service');
const { redisClient } = require('../config/redis');
const ioSingleton = require('../socket/io');

const connection = { host: env.REDIS_PARTYROOM_URL, port: env.REDIS_PORT };

// Job names that this worker handles
const OPEN_JOBS  = new Set([GAME.JOB_NAMES.FUEL_WINDOW_OPEN_1,  GAME.JOB_NAMES.FUEL_WINDOW_OPEN_2]);
const CHECK_JOBS = new Set([GAME.JOB_NAMES.FUEL_WINDOW_CHECK_1, GAME.JOB_NAMES.FUEL_WINDOW_CHECK_2]);

const worker = new Worker(
  GAME.QUEUE_NAMES.RACE_FUEL,
  async (job) => {
    if (!OPEN_JOBS.has(job.name) && !CHECK_JOBS.has(job.name)) return;

    const { raceId, dayNumber, groupNumber, windowIndex } = job.data;
    const redis    = redisClient;
    const io       = ioSingleton.get();
    const room     = `${raceId}:d${dayNumber}:g${groupNumber}`;
    const families = await raceService.getFamiliesForGroup(redis, raceId, dayNumber, groupNumber);

    if (!families.length) {
      console.warn(`[fuelWindow] No families found for ${raceId} day${dayNumber} group${groupNumber}`);
      return;
    }

    if (OPEN_JOBS.has(job.name)) {
      // Open fuel window
      await fuelService.openFuelWindow(redis, raceId, dayNumber, groupNumber, windowIndex, families);
      if (io) {
        io.to(room).emit('fuel_window_open', {
          windowIndex,
          seconds_remaining: GAME.FUEL_WINDOW_DURATION_SEC,
        });
      }
    } else {
      // Check fuel window compliance
      const stopped = await fuelService.checkFuelWindow(
        redis, raceId, dayNumber, groupNumber, windowIndex, families
      );

      if (io) {
        for (const familyId of stopped) {
          io.to(room).emit('car_stopped', { familyId });
        }
        io.to(room).emit('fuel_window_close', { windowIndex });
      }
    }
  },
  { connection, concurrency: 3 }
);

worker.on('error',  (err) => console.error('[fuelWindow] Worker error:', err.message));
worker.on('failed', (job, err) => console.error(`[fuelWindow] Job ${job?.name} failed: ${err.message}`));

module.exports = {};
