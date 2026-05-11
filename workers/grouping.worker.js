'use strict';

/**
 * workers/grouping.worker.js
 *
 * BullMQ Worker: processes daily midnight (12 AM IST) cron job.
 *
 * Handles 3 scenarios:
 *   1. Today = race_start_day (Day 1) for a 'scheduled' game:
 *      - Computes Day 1 groups from silver coin ranking (top 9)
 *      - Computes Day 2 groups using fixed manual mapping of original ranks:
 *        Group 1 = Rank 1, 2, 5 | Group 2 = Rank 4, 8, 7 | Group 3 = Rank 3, 6, 9
 *      - Writes both day 1 and day 2 groups to Redis
 *      - Populates participants set
 *      - Updates status to 'day1_pending'
 *
 *   2. Today = race_start_day + 2 (Day 3) for a 'day2_done' game:
 *      - Computes Day 3 groups from Day 2 race results
 *        (1st-place from each group together, 2nd-place, 3rd-place)
 *      - Writes day 3 groups to Redis
 *      - Refreshes participants set
 *      - Updates status to 'day3_pending'
 *
 *   3. No match → skip.
 */

const { Worker } = require('bullmq');
const env         = require('../config/env');
const GAME        = require('../constants/game');
const helpers     = require('../utils/helpers');
const keys        = require('../utils/keys');
const groupService = require('../services/group.service');
const gameService  = require('../services/game.service');
const { redisClient } = require('../config/redis');
const db           = require('../config/mysql');

const connection = { host: env.REDIS_HOST, port: env.REDIS_PORT };

/**
 * Day 2 manual grouping based on original Day 1 ranking positions.
 * The 9 families are ordered by their qualification rank (index 0 = rank 1).
 * Manual assignment: Group 1 = {Rank1, Rank2, Rank5}, Group 2 = {Rank4, Rank8, Rank7}, Group 3 = {Rank3, Rank6, Rank9}
 */
function computeDay2ManualGroups(rankedFamilyIds) {
  // rankedFamilyIds[0] = Rank 1, [1] = Rank 2, ..., [8] = Rank 9
  return {
    group_1: [rankedFamilyIds[0], rankedFamilyIds[1], rankedFamilyIds[4]], // Rank 1, 2, 5
    group_2: [rankedFamilyIds[3], rankedFamilyIds[7], rankedFamilyIds[6]], // Rank 4, 8, 7
    group_3: [rankedFamilyIds[2], rankedFamilyIds[5], rankedFamilyIds[8]], // Rank 3, 6, 9
  };
}

const worker = new Worker(
  GAME.QUEUE_NAMES.GROUPING,
  async (job) => {
    if (job.name !== GAME.JOB_NAMES.THURSDAY_GROUPING) return;

    const today = helpers.todayISTString();
    console.log(`[grouping] Cron fired for ${today} (IST)`);
    const redis = redisClient;

    // ── Scenario 1: Day 1 grouping (today = race_start_day, status = 'scheduled') ──
    const scheduledGames = await db.query(
      `SELECT id, race_week_start, race_start_day FROM family_car_race_schedule WHERE status = 'scheduled'`
    );

    for (const game of scheduledGames) {
      const raceStartDate = helpers.addDays(game.race_start_day, 0);
      if (raceStartDate !== today) continue;

      const raceId = game.id;
      const groupingDate = helpers.addDays(game.race_start_day, -1);

      // Compute Day 1 groups from silver coin rankings
      const day1Groups = await groupService.computeDay1Groups(raceId, game.race_week_start, groupingDate, db, redis);
      const allFamilies = [...day1Groups.group_1, ...day1Groups.group_2, ...day1Groups.group_3];

      // Write Day 1 groups to Redis
      await groupService.writeGroupsToRedis(raceId, 1, day1Groups, redis);

      // Compute Day 2 groups using manual mapping of original rank order
      // The original rank order is: day1Groups.group_1[0..2] = ranks 1-3,
      // day1Groups.group_2[0..2] = ranks 4-6, day1Groups.group_3[0..2] = ranks 7-9
      const rankedFamilies = [...day1Groups.group_1, ...day1Groups.group_2, ...day1Groups.group_3];
      const day2Groups = computeDay2ManualGroups(rankedFamilies);

      // Write Day 2 groups to Redis
      await groupService.writeGroupsToRedis(raceId, 2, day2Groups, redis);

      // Populate participants set
      await groupService.populateParticipantsSet(raceId, allFamilies, db, redis);

      // Update status
      await gameService.updateGameStatus(raceId, 'day1_pending', db, redis);

      console.log(`[grouping] Day 1 + Day 2 groups set for ${raceId}. Families: ${allFamilies.join(', ')}`);
      console.log(`[grouping]   Day 2 manual: G1=[${day2Groups.group_1}] G2=[${day2Groups.group_2}] G3=[${day2Groups.group_3}]`);
      return; // Only process one game per cron fire
    }

    // ── Scenario 2: Day 3 grouping (today = race_start_day + 2, status = 'day2_done') ──
    const day2DoneGames = await db.query(
      `SELECT id, race_start_day FROM family_car_race_schedule WHERE status = 'day2_done'`
    );

    for (const game of day2DoneGames) {
      const day3Date = helpers.addDays(game.race_start_day, 2);
      if (day3Date !== today) continue;

      const raceId = game.id;

      // Compute Day 3 groups from Day 2 race results (1st together, 2nd together, 3rd together)
      const day3Groups = await groupService.computeNextDayGroups(raceId, 2, db);
      const allFamilies = [...day3Groups.group_1, ...day3Groups.group_2, ...day3Groups.group_3];

      // Write Day 3 groups to Redis
      await groupService.writeGroupsToRedis(raceId, 3, day3Groups, redis);

      // Refresh participants set
      await groupService.populateParticipantsSet(raceId, allFamilies, db, redis);

      // Update status
      await gameService.updateGameStatus(raceId, 'day3_pending', db, redis);

      console.log(`[grouping] Day 3 groups set for ${raceId} (from Day 2 results). Families: ${allFamilies.join(', ')}`);
      return;
    }

    console.log('[grouping] No game matched today — skipping.');
  },
  { connection }
);

worker.on('error',  (err) => console.error('[grouping] Worker error:', err.message));
worker.on('failed', (job, err) => console.error(`[grouping] Job failed: ${err.message}`));

module.exports = {};
