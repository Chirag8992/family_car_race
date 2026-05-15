'use strict';

/**
 * services/fuel.service.js
 *
 * Fuel window open/check/submit and car restart logic.
 */

const keys = require('../utils/keys');
const GAME = require('../constants/game');

/**
 * Opens a fuel window for a group race.
 * Sets fuel_window_{n}:open key (TTL=59s) and updates each family fuel_status.
 *
 * @param {import('ioredis').Redis} redis
 * @param {string}   raceId
 * @param {number}   dayNumber
 * @param {number}   groupNumber
 * @param {number}   windowIndex  1 or 2
 * @param {string[]} families     array of familyIds in this group
 */
async function openFuelWindow(redis, raceId, dayNumber, groupNumber, windowIndex, families) {
  await redis.set(
    keys.fuelWindowOpen(raceId, dayNumber, groupNumber, windowIndex),
    '1',
    'EX', GAME.FUEL_WINDOW_DURATION_SEC
  );

  const pipeline = redis.pipeline();
  for (const familyId of families) {
    pipeline.hset(keys.familyState(raceId, dayNumber, groupNumber, familyId), 'fuel_status', 'window_open');
  }
  await pipeline.exec();

  console.log(`[fuel] Window ${windowIndex} opened: ${raceId} day${dayNumber} group${groupNumber}`);
}

/**
 * Checks fuel window compliance at window close.
 * Fix #25: Only stops families that are currently running (is_running === '1').
 *          Families already stopped are skipped to avoid duplicate car_stopped events.
 *
 * @returns {string[]} familyIds that were newly stopped by this check
 */
async function checkFuelWindow(redis, raceId, dayNumber, groupNumber, windowIndex, families) {
  // Fix #25: read both fueled-flag AND current is_running state in one batch
  const batchPipeline = redis.pipeline();
  for (const familyId of families) {
    batchPipeline.exists(keys.familyFueled(raceId, dayNumber, groupNumber, familyId, windowIndex));
    batchPipeline.hget(keys.familyState(raceId, dayNumber, groupNumber, familyId), 'is_running');
  }
  const batchResults = await batchPipeline.exec();

  const stopped     = [];
  const statePipeline = redis.pipeline();

  for (let i = 0; i < families.length; i++) {
    const didFuel   = batchResults[i * 2][1] === 1;
    const isRunning = batchResults[i * 2 + 1][1]; // '0', '1', or null
    const stateKey  = keys.familyState(raceId, dayNumber, groupNumber, families[i]);

    if (!didFuel) {
      // Fix #25: skip the stop if the car is already stopped — no-op, no broadcast
      if (isRunning === '0') {
        statePipeline.hset(stateKey, 'fuel_status', 'stopped'); // keep fuel_status in sync
        continue;
      }
      statePipeline.hset(stateKey, 'is_running', '0', 'fuel_status', 'stopped');
      // Clear old restart flag so the family can restart again after this new stop
      statePipeline.del(keys.familyRestartFueled(raceId, dayNumber, groupNumber, families[i]));
      stopped.push(families[i]);
    } else {
      statePipeline.hset(stateKey, 'fuel_status', 'ok');
    }
  }
  await statePipeline.exec();

  if (stopped.length) {
    console.log(`[fuel] Window ${windowIndex} check — ${stopped.length} families newly stopped`);
  }
  return stopped;
}

/**
 * Submits fuel during an open window (Lua: submitFuelWindow).
 * Returns { newSpeed, newMaxSpeed }.
 * Throws ReplyError 'window_closed' or 'already_fueled' on failure.
 */
async function submitFuelWindow(redis, luaSHA, raceId, dayNumber, groupNumber, memberId, familyId, windowIndex) {
  const sha = luaSHA.get('submitFuelWindow');
  const result = await redis.evalsha(
    sha, 4,
    keys.familyState(raceId, dayNumber, groupNumber, familyId),
    keys.fuelWindowOpen(raceId, dayNumber, groupNumber, windowIndex),
    keys.familyFueled(raceId, dayNumber, groupNumber, familyId, windowIndex),
    keys.memberFueledWindow(raceId, dayNumber, groupNumber, memberId, windowIndex)
  );
  return { newSpeed: parseInt(result[0], 10), newMaxSpeed: parseInt(result[1], 10) };
}

/**
 * Restarts a stopped car via fuel submit (Lua: submitFuelRestart).
 * Returns 'ok'.
 * Throws ReplyError 'car_not_stopped' or 'already_restarted' on failure.
 */
async function submitFuelRestart(redis, luaSHA, raceId, dayNumber, groupNumber, memberId, familyId) {
  const sha = luaSHA.get('submitFuelRestart');
  return await redis.evalsha(
    sha, 2,
    keys.familyState(raceId, dayNumber, groupNumber, familyId),
    keys.familyRestartFueled(raceId, dayNumber, groupNumber, familyId)
  );
}

module.exports = { openFuelWindow, checkFuelWindow, submitFuelWindow, submitFuelRestart };
