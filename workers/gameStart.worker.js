'use strict';

/**
 * workers/gameStart.worker.js
 *
 * Handles Redis keyspace expiry events for game start trigger keys.
 * Called from server.js when key pattern matches:
 *   game:{raceId}:day:{dayNumber}:start_trigger
 *
 * Responsibilities:
 *   1. Read group assignments from Redis
 *   2. For each of the 3 groups:
 *      - compute base_speed (100 + pit_boosts * 10)
 *      - write race meta hash
 *      - write initial family state for 3 families
 *      - init leaderboard sorted set
 *      - set crystal_ready for all connected members
 *      - init member inventories
 *      - SADD to active_groups
 *   3. Enqueue BullMQ race jobs for each group
 *   4. Update family_car_race_schedule status in MySQL and Redis meta
 *   5. Broadcast race_started to all connected Socket.IO clients
 */

const { redisClient } = require('../config/redis');
const db              = require('../config/mysql');
const luaSHA          = require('../scripts/lua');
const keys            = require('../utils/keys');
const helpers         = require('../utils/helpers');
const raceService     = require('../services/race.service');
const crystalService  = require('../services/crystal.service');
const gameService     = require('../services/game.service');
const { enqueueRaceJobs } = require('../jobs/queue');
const ioSingleton     = require('../socket/io');

/**
 * Fired when a game start trigger key expires.
 * @param {{ raceId: string, dayNumber: number }} param
 */
async function onStartTrigger({ raceId, dayNumber }) {
  console.log(`[gameStart] Trigger fired: ${raceId} day${dayNumber}`);

  const redis = redisClient;

  // Read the authoritative race date for this dayNumber from the game meta hash
  // instead of helpers.todayUTCString(). todayUTCString() is UTC-based and the pit boost
  // keys are keyed on the IST-derived date stored at game creation time. Using the stored
  // date guarantees the boost lookup uses the exact same string the pitCron worker wrote.
  
  
  const gameMeta = await redis.hgetall(keys.gameMeta(raceId));
  if (!gameMeta || !gameMeta.day1_date) {
    console.error(`[gameStart] Game meta missing for ${raceId} — cannot start day${dayNumber}`);
    return;
  }
  
  const raceDateForDay = gameMeta[`day${dayNumber}_date`]; // e.g. gameMeta.day2_date for dayNumber=2

  // Read group assignments for this day
  const groupsRaw = await redis.hgetall(keys.dayGroups(raceId, dayNumber));
  if (!groupsRaw || !groupsRaw.group_1) {
    console.error(`[gameStart] No group assignments found for ${raceId} day${dayNumber}`);
    return;
  }

  const groups = {
    1: JSON.parse(groupsRaw.group_1),
    2: JSON.parse(groupsRaw.group_2),
    3: JSON.parse(groupsRaw.group_3),
  };

  const startedAt = Date.now();
  const baseSpeeds = {};  // { groupNumber: { familyId: speed } }

  // ─── Initialise each group race ───────────────────────────────────────
  for (const [groupNumStr, families] of Object.entries(groups)) {
    const groupNumber = parseInt(groupNumStr, 10);
    baseSpeeds[groupNumber] = {};

    // a. Compute base_speed for each family using the stored race date (not server's UTC today)
    for (const familyId of families) {
      const baseSpeed = await raceService.computeBaseSpeed(redis, raceId, dayNumber, raceDateForDay, familyId);
      baseSpeeds[groupNumber][familyId] = baseSpeed;
    }

    // b. Write race meta hash
    await raceService.initRaceMeta(redis, raceId, dayNumber, groupNumber, families, startedAt);

    // c. Write initial state for each family
    for (const familyId of families) {
      // Clear any stale restart flag from a previous run
      await redis.del(keys.familyRestartFueled(raceId, dayNumber, groupNumber, familyId));
      await raceService.initFamilyState(
        redis, raceId, dayNumber, groupNumber, familyId,
        baseSpeeds[groupNumber][familyId], startedAt
      );
    }

    // d. Init leaderboard
    const lbPipeline = redis.pipeline();
    for (const familyId of families) {
      lbPipeline.zadd(keys.leaderboard(raceId, dayNumber, groupNumber), 0, familyId);
    }
    await lbPipeline.exec();

    // e. Set crystal_ready + init inventories for connected members
    const connectedMembers = await redis.smembers(
      keys.connectedMembers(raceId, dayNumber, groupNumber)
    );
    for (const memberId of connectedMembers) {
      await crystalService.setInitialCrystalReady(redis, raceId, dayNumber, groupNumber, memberId);
      await crystalService.initMemberInventory(redis, raceId, dayNumber, groupNumber, memberId);
    }

    // f. Track active group
    await redis.sadd(keys.activeDayGroups(raceId, dayNumber), String(groupNumber));

    // g. Enqueue BullMQ race jobs
    await enqueueRaceJobs(raceId, dayNumber, groupNumber);

    console.log(`[gameStart] Group ${groupNumber} started: ${families.join(', ')}`);
  }

  // ─── Update game status ─────────────────────────────────────────────────
  const newStatus = `day${dayNumber}_pending`;
  await gameService.updateGameStatus(raceId, newStatus, db, redis);
  await redis.hset(keys.gameMeta(raceId), 'current_day', String(dayNumber));

  // ─── Broadcast race_started to each group's room only ────────────────
  // was io.emit() which broadcasts to ALL connected sockets.
  // Each group room only receives its own race_started event.
  const io = ioSingleton.get();
  if (io) {
    for (const [groupNumStr, families] of Object.entries(groups)) {
      const groupNumber = parseInt(groupNumStr, 10);
      const room = `${raceId}:d${dayNumber}:g${groupNumber}`;
      io.to(room).emit('race_started', {
        raceId,
        dayNumber,
        groupNumber,
        families,
        base_speeds: baseSpeeds[groupNumber],
      });
    }
  }

  console.log(`[gameStart] All 3 groups started for ${raceId} day${dayNumber}`);
}

module.exports = { onStartTrigger };
