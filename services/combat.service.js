'use strict';

/**
 * services/combat.service.js
 *
 * Egg throwing and wiper use — both go through Lua for atomicity.
 * Crystals are deducted directly at the point of use (no pre-conversion step).
 */

const keys = require('../utils/keys');

/**
 * Atomically throws N eggs at a target family (Lua: throwEgg).
 * Deducts N crystals directly from the thrower's inventory.
 * Returns { wasted: boolean, newSpeed: number }.
 * Throws ReplyError('no_crystals') if thrower has insufficient crystals.
 */
async function throwEgg(redis, luaSHA, raceId, dayNumber, groupNumber, memberId, familyId, targetFamilyId, amount = 1) {
  const sha = luaSHA.get('throwEgg');
  const result = await redis.evalsha(
    sha, 2,
    keys.familyState(raceId, dayNumber, groupNumber, targetFamilyId),
    keys.memberInventory(raceId, dayNumber, groupNumber, memberId),
    amount
  );
  const newSpeed = parseInt(
    await redis.hget(keys.familyState(raceId, dayNumber, groupNumber, targetFamilyId), 'current_speed') || '0',
    10
  );
  // Track eggs_used count for inventory reporting
  await redis.hincrby(keys.memberInventory(raceId, dayNumber, groupNumber, memberId), 'eggs_used', amount);
  return { wasted: result === 1, newSpeed };
}

/**
 * Atomically uses N wipers to restore own family speed (Lua: useWiper).
 * Deducts N crystals directly from the member's inventory.
 * Returns { newSpeed: number }.
 * Throws ReplyError('no_crystals') if member has insufficient crystals.
 */
async function useWiper(redis, luaSHA, raceId, dayNumber, groupNumber, memberId, familyId, amount = 1) {
  const sha = luaSHA.get('useWiper');
  const newSpeed = await redis.evalsha(
    sha, 2,
    keys.familyState(raceId, dayNumber, groupNumber, familyId),
    keys.memberInventory(raceId, dayNumber, groupNumber, memberId),
    amount
  );
  // Track wipers_used count for inventory reporting
  await redis.hincrby(keys.memberInventory(raceId, dayNumber, groupNumber, memberId), 'wipers_used', amount);
  return { newSpeed: parseInt(newSpeed, 10) };
}

module.exports = { throwEgg, useWiper };
