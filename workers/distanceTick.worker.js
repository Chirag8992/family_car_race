'use strict';

/**
 * workers/distanceTick.worker.js
 *
 * BullMQ Worker: processes repeating 'distance-tick' jobs every 1 second.
 * For each running family: adds distance, updates leaderboard, broadcasts update.
 */

const { Worker } = require('bullmq');
const env         = require('../config/env');
const GAME        = require('../constants/game');
const keys        = require('../utils/keys');
const { redisClient } = require('../config/redis');
const ioSingleton = require('../socket/io');

const connection = { host: env.REDIS_HOST, port: env.REDIS_PORT };

// Fix #18: round to 6 decimal places to eliminate IEEE 754 accumulation drift.
function roundDistance(value) {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Acquires a short-lived per-group mutex so overlapping ticks don't collide.
 * Returns true if the lock was acquired, false if another tick is still running.
 */
async function acquireTickLock(redis, raceId, dayNumber, groupNumber) {
  const lockKey = `lock:tick:${raceId}:d${dayNumber}:g${groupNumber}`;
  // SET NX EX 3 — auto-expires after 3s as a safety net
  const result = await redis.set(lockKey, '1', 'EX', 3, 'NX');
  return result === 'OK';
}

/**
 * Releases the per-group tick lock.
 */
async function releaseTickLock(redis, raceId, dayNumber, groupNumber) {
  const lockKey = `lock:tick:${raceId}:d${dayNumber}:g${groupNumber}`;
  await redis.del(lockKey);
}

const worker = new Worker(
  GAME.QUEUE_NAMES.RACE,
  async (job) => {
    if (!job.name.startsWith(GAME.JOB_NAMES.DISTANCE_TICK)) return;

    const { raceId, dayNumber, groupNumber } = job.data;
    const redis = redisClient;

    // acquire per-group mutex before doing any Redis reads/writes.
    // If the previous tick for this group is still running (e.g. Redis was
    // slow), skip this tick entirely rather than overwriting with a stale value.
    const lockAcquired = await acquireTickLock(redis, raceId, dayNumber, groupNumber);
    if (!lockAcquired) {
      // Previous tick still in progress — this tick is a no-op.
      // The repeating job scheduler will fire again in ~1s as normal.
      console.warn(`[distanceTick] Skipped overlapping tick: ${raceId} d${dayNumber} g${groupNumber}`);
      return;
    }

    try {
      // Read families for this group
      const rawFamilies = await redis.hget(
        keys.raceMeta(raceId, dayNumber, groupNumber), 'families'
      );
      if (!rawFamilies) return; // race already ended — raceEnd worker cleaned up

      const families = JSON.parse(rawFamilies);
      const pipeline = redis.pipeline();

      for (const familyId of families) {
        pipeline.hmget(
          keys.familyState(raceId, dayNumber, groupNumber, familyId),
          'is_running', 'distance_traveled', 'current_speed', 'fuel_status', 'max_speed'
        );
      }
      const stateResults = await pipeline.exec();

      // Update distances
      const updatePipeline = redis.pipeline();
      const familyData = {};

      for (let i = 0; i < families.length; i++) {
        const [err, vals] = stateResults[i];
        if (err || !vals) continue;

        const [isRunning, distStr, speedStr, fuelStatus, maxSpeedStr] = vals;
        const distanceTraveled = parseFloat(distStr || '0');
        const currentSpeed     = parseInt(speedStr || '0', 10);

        // Compute new distance (speed km/hr ÷ 3600 = km/s)
        const newDistance = isRunning === '1'
          ? roundDistance(distanceTraveled + (currentSpeed / 3600))
          : distanceTraveled;

        if (isRunning === '1') {
          updatePipeline.hset(
            keys.familyState(raceId, dayNumber, groupNumber, families[i]),
            'distance_traveled', String(newDistance)
          );
          updatePipeline.zadd(
            keys.leaderboard(raceId, dayNumber, groupNumber),
            newDistance, families[i]
          );
        }

        familyData[families[i]] = {
          current_speed:     currentSpeed,
          max_speed:         parseInt(maxSpeedStr || '100', 10),
          distance_traveled: newDistance,
          is_running:        isRunning,
          fuel_status:       fuelStatus || '',
        };
      }
      await updatePipeline.exec();

      // Build leaderboard for broadcast
      const lbRaw = await redis.zrevrange(
        keys.leaderboard(raceId, dayNumber, groupNumber), 0, -1, 'WITHSCORES'
      );
      const leaderboard = [];
      for (let i = 0; i < lbRaw.length; i += 2) {
        leaderboard.push({ rank: (i / 2) + 1, familyId: lbRaw[i], distanceKm: parseFloat(lbRaw[i + 1]) });
      }

      // Broadcast to Socket.IO room
      const io = ioSingleton.get();
      if (io) {
        const room = `${raceId}:d${dayNumber}:g${groupNumber}`;
        io.to(room).emit('race:state_update', { leaderboard, families: familyData });
      }
    } finally {
     
      await releaseTickLock(redis, raceId, dayNumber, groupNumber);
    }
  },
  {
    connection,
    concurrency: 5,
  }
);

worker.on('error',  (err) => console.error('[distanceTick] Worker error:', err.message));
worker.on('failed', (job, err) => console.error(`[distanceTick] Job failed: ${err.message}`));

module.exports = {};
