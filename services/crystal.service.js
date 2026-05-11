'use strict';

/**
 * services/crystal.service.js
 *
 * Crystal collection and inventory management.
 * Crystals are the single currency — deducted directly when throwing eggs or using wipers.
 * No separate conversion step.
 */

const keys = require('../utils/keys');

/**
 * Atomically collects 1 crystal (Lua: crystalCollect).
 * Returns updated crystal count on success.
 * Throws ReplyError with message 'cooldown_active' or 'not_ready' on failure.
 */
async function collectCrystal(redis, luaSHA, raceId, dayNumber, groupNumber, memberId) {
  const sha = luaSHA.get('crystalCollect');
  await redis.evalsha(
    sha, 3,
    keys.crystalCooldown(raceId, dayNumber, groupNumber, memberId),
    keys.crystalReady(raceId, dayNumber, groupNumber, memberId),
    keys.memberInventory(raceId, dayNumber, groupNumber, memberId)
  );
  const crystals = parseInt(
    await redis.hget(keys.memberInventory(raceId, dayNumber, groupNumber, memberId), 'crystals') || '0', 10
  );
  return { crystals };
}

/**
 * Sets the crystal_ready key for a member (enables collect button).
 */
async function setInitialCrystalReady(redis, raceId, dayNumber, groupNumber, memberId) {
  // await redis.set(keys.crystalReady(raceId, dayNumber, groupNumber, memberId), '1');
  await redis.set(
    keys.crystalCooldown(raceId, dayNumber, groupNumber, memberId),
    '1',
    'EX', 30
  );
}

/**
 * Initialises member inventory hash with crystals=0.
 * No eggs or wipers fields — crystals are spent directly.
 */
async function initMemberInventory(redis, raceId, dayNumber, groupNumber, memberId) {
  await redis.hset(
    keys.memberInventory(raceId, dayNumber, groupNumber, memberId),
    { crystals: '0' }
  );
}

/**
 * Returns member crystal count.
 */
async function getMemberInventory(redis, raceId, dayNumber, groupNumber, memberId) {
  const crystals = await redis.hget(
    keys.memberInventory(raceId, dayNumber, groupNumber, memberId), 'crystals'
  );
  return { crystals: parseInt(crystals || '0', 10) };
}

module.exports = {
  collectCrystal,
  setInitialCrystalReady,
  initMemberInventory,
  getMemberInventory,
};
