'use strict';

/**
 * workers/raceEnd.worker.js
 *
 * BullMQ Worker: handles 'race-end' jobs at T=60:00 for each group race.
 *
 * Responsibilities:
 *   1. Stop distance-tick repeating job
 *   2. Read final leaderboard and family states
 *   3. INSERT 3 rows into race_results MySQL
 *   4. Update game_schedule status
 *   5. Compute Day N+1 groups (if not Day 3)
 *   6. Broadcast race_finished
 *   7. Cleanup all Redis keys for this group race
 *   8. Full game cleanup if Day 3 is done
 */

const { Worker } = require('bullmq');
const { v4: uuid } = require('uuid');
const env        = require('../config/env');
const GAME       = require('../constants/game');
const keys       = require('../utils/keys');
const helpers    = require('../utils/helpers');
const { removeTickJob } = require('../jobs/queue');
const gameService   = require('../services/game.service');
const raceService   = require('../services/race.service');
const { redisClient } = require('../config/redis');
const db            = require('../config/mysql');
const ioSingleton   = require('../socket/io');

const connection = { host: env.REDIS_HOST, port: env.REDIS_PORT };

const worker = new Worker(
  GAME.QUEUE_NAMES.RACE_END,
  async (job) => {
    if (job.name !== GAME.JOB_NAMES.RACE_END) return;

    const { raceId, dayNumber, groupNumber } = job.data;
    const redis = redisClient;
    const io    = ioSingleton.get();
    const room  = `${raceId}:d${dayNumber}:g${groupNumber}`;

    console.log(`[raceEnd] Race ending: ${raceId} day${dayNumber} group${groupNumber}`);

    // Read the authoritative race date from game meta instead of
    // todayUTCString(). The date stored in gameMeta is IST-derived (set at
    // game creation) and is consistent with how gameStart.worker reads pit boosts.
    // todayUTCString() would write the wrong date if race ends after IST midnight.
    const gameMeta = await redis.hgetall(keys.gameMeta(raceId));
    const today = gameMeta ? gameMeta[`day${dayNumber}_date`] : null;
    if (!today) {
      console.error(`[raceEnd] gameMeta missing race date for ${raceId} day${dayNumber} — falling back to UTC date`);
    }
    const raceDate = today || helpers.todayUTCString();

    // 1. Stop distance-tick

    // 2. Get final standings
    const lbRaw = await redis.zrevrange(
      keys.leaderboard(raceId, dayNumber, groupNumber), 0, -1, 'WITHSCORES'
    );
    const leaderboard = [];
    for (let i = 0; i < lbRaw.length; i += 2) {
      leaderboard.push({ rank: (i / 2) + 1, familyId: lbRaw[i], distanceKm: parseFloat(lbRaw[i + 1]) });
    }

    // 3. Get final state for each family
    const families = await raceService.getFamiliesForGroup(redis, raceId, dayNumber, groupNumber);
    const stateMap = {};
    for (const familyId of families) {
      const state = await raceService.getFamilyState(redis, raceId, dayNumber, groupNumber, familyId);
      stateMap[familyId] = state || {};
    }

    // 4. Write race_results to MySQL
    await removeTickJob(raceId, dayNumber, groupNumber);
    const insertValues = [];
    for (const entry of leaderboard) {
      const state = stateMap[entry.familyId] || {};
      insertValues.push([
        uuid(),
        raceId,
        dayNumber,
        groupNumber,
        raceDate,
        entry.familyId,
        entry.rank,
        entry.distanceKm,
        parseInt(state.base_speed || '100', 10),
        parseInt(state.current_speed || '100', 10),
        state.is_running === '0' ? 1 : 0,
      ]);
    }
    if (insertValues.length) {
      await db.query(
        `INSERT INTO race_results
           (id, race_id, day_number, group_number, race_date, family_id,
            rank_position, distance_km, base_speed, final_speed, car_stopped, created_at)
         VALUES ?`,
        [insertValues.map(r => [...r, new Date()])]
      );
    }

    // 5. Broadcast race_finished for this group's room
    if (io) {
      io.to(room).emit('race_finished', { leaderboard });
    }

    // 6. Cleanup Redis keys specific to this group race
    await cleanupGroupRaceKeys(redis, raceId, dayNumber, groupNumber, families);

    // 7. Remove this group from the active set
    await redis.srem(keys.activeDayGroups(raceId, dayNumber), String(groupNumber));

    // 8. Check if ALL groups for this day are now done.
    //    Day-level work (status update, next-day grouping, game cleanup) only runs
    //    once — when the last group finishes. This prevents:
    //      - computeNextDayGroups running before all groups' DB rows are inserted
    //      - updateGameStatus being written multiple times (once per group)
    const remaining = await redis.scard(keys.activeDayGroups(raceId, dayNumber));
    if (remaining === 0) {
      if (dayNumber < 3) {
        // All 3 groups' race_results are now in MySQL — mark day as done.
        // Next day's grouping is handled by the midnight cron (grouping.worker.js).
        await gameService.updateGameStatus(raceId, `day${dayNumber}_done`, db, redis);
        console.log(`[raceEnd] Day ${dayNumber} complete — waiting for midnight cron to set day${dayNumber + 1} groups`);
      } else {
        // Day 3 — game is fully over
        await cleanupGameKeys(redis, raceId);
        await gameService.updateGameStatus(raceId, 'completed', db, redis);
        console.log(`[raceEnd] Game ${raceId} completed and fully cleaned up`);
      }
    }

    console.log(`[raceEnd] Done: ${raceId} day${dayNumber} group${groupNumber}`);
  },
  { connection }
);

worker.on('error',  (err) => console.error('[raceEnd] Worker error:', err.message));
worker.on('failed', (job, err) => console.error(`[raceEnd] Job failed: ${err.message}`));

// ─── Cleanup helpers ─────────────────────────────────────────────────────

async function cleanupGroupRaceKeys(redis, raceId, dayNumber, groupNumber, families) {
  // Collect all memberIds from every family's active_members set BEFORE deleting any keys.
  // We need these to delete per-member Redis keys (inventory, crystal_ready/cooldown, fueled flags).
  const allMemberIds = new Set();

  const memberPipeline = redis.pipeline();
  for (const familyId of families) {
    memberPipeline.smembers(keys.activeMembers(raceId, dayNumber, groupNumber, familyId));
  }
  const memberResults = await memberPipeline.exec();
  for (const [err, members] of memberResults) {
    if (!err && Array.isArray(members)) {
      for (const m of members) allMemberIds.add(m);
    }
  }

  // Also grab connected_members — catches any member who joined but never did an action
  const connectedNow = await redis.smembers(keys.connectedMembers(raceId, dayNumber, groupNumber));
  for (const m of connectedNow) allMemberIds.add(m);

  const pipeline = redis.pipeline();

  // Group / race-level keys
  pipeline.del(keys.raceMeta(raceId, dayNumber, groupNumber));
  pipeline.del(keys.leaderboard(raceId, dayNumber, groupNumber));
  pipeline.del(keys.connectedMembers(raceId, dayNumber, groupNumber));
  pipeline.del(keys.fuelWindowOpen(raceId, dayNumber, groupNumber, 1));
  pipeline.del(keys.fuelWindowOpen(raceId, dayNumber, groupNumber, 2));

  // Family-level keys
  for (const familyId of families) {
    pipeline.del(keys.familyState(raceId, dayNumber, groupNumber, familyId));
    pipeline.del(keys.familyFueled(raceId, dayNumber, groupNumber, familyId, 1));
    pipeline.del(keys.familyFueled(raceId, dayNumber, groupNumber, familyId, 2));
    pipeline.del(keys.familyRestartFueled(raceId, dayNumber, groupNumber, familyId));
    pipeline.del(keys.activeMembers(raceId, dayNumber, groupNumber, familyId));
  }

  // Member-level keys — deleted here for every member who participated
  for (const memberId of allMemberIds) {
    pipeline.del(keys.memberInventory(raceId, dayNumber, groupNumber, memberId));
    pipeline.del(keys.crystalReady(raceId, dayNumber, groupNumber, memberId));
    pipeline.del(keys.crystalCooldown(raceId, dayNumber, groupNumber, memberId));
    pipeline.del(keys.memberFueledWindow(raceId, dayNumber, groupNumber, memberId, 1));
    pipeline.del(keys.memberFueledWindow(raceId, dayNumber, groupNumber, memberId, 2));
  }

  await pipeline.exec();
  console.log(`[raceEnd] Redis cleanup done: day${dayNumber} group${groupNumber} (${allMemberIds.size} members cleaned)`);
}

async function cleanupGameKeys(redis, raceId) {
  const pipeline = redis.pipeline();
  pipeline.del(keys.gameMeta(raceId));
  pipeline.del(keys.participants(raceId));
  pipeline.del(keys.memberFamilyInRace(raceId));   // fix: was never deleted
  pipeline.del(keys.dayGroups(raceId, 1));
  pipeline.del(keys.dayGroups(raceId, 2));
  pipeline.del(keys.dayGroups(raceId, 3));
  await pipeline.exec();
  console.log(`[raceEnd] Game-level Redis cleanup done: ${raceId}`);
}

module.exports = {};
