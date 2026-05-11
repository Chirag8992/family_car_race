'use strict';

/**
 * services/pit.service.js
 *
 * Pit stop window management and member claim handling.
 */

const keys = require('../utils/keys');
const GAME = require('../constants/game');

/**
 * Opens a pit stop window by setting the pit window key (TTL = 1 hour).
 */
async function openPitWindow(redis, raceId, dayNumber, date, windowKey) {
  const k = keys.pitWindowOpen(raceId, dayNumber, date, windowKey);
  await redis.set(k, '1', 'EX', GAME.PIT_WINDOW_DURATION_SEC);
  console.log(`[pit] Window opened: ${k}`);
}

/**
 * Claims a pit stop for a member.
 * Validates window is open and member hasn't claimed this window yet.
 * Increments family boost counter.
 *
 * @returns {{ boost: number, familyTotalBoost: number }}
 * @throws {{ code: 'window_closed' | 'already_claimed' }}
 */
async function claimPitStop(redis, raceId, dayNumber, date, memberId, familyId, windowKey, groupNumber) {
  const windowOpen = await redis.exists(keys.pitWindowOpen(raceId, dayNumber, date, windowKey));
  console.log(`[pit] claimPitStop: windowOpen=${windowOpen}, key=${keys.pitWindowOpen(raceId, dayNumber, date, windowKey)}`);
  if (!windowOpen) {
    const err = new Error('window_closed');
    err.code = 'window_closed';
    throw err;
  }

  const claimedKey = keys.memberPitClaimed(raceId, dayNumber, date, memberId, windowKey);
  const claimed = await redis.exists(claimedKey);
  if (claimed) {
    const err = new Error('already_claimed');
    err.code = 'already_claimed';
    throw err;
  }

  await redis.set(claimedKey, '1', 'EX', 86400);

  const boostKey = keys.familyBoost(raceId, dayNumber, date, familyId);
  const newTotal = await redis.incr(boostKey);
  await redis.expire(boostKey, 86400);

  // Track activity
  if (groupNumber) {
    await redis.sadd(keys.activeMembers(raceId, dayNumber, groupNumber, familyId), memberId);
  }

  return {
    boost:            GAME.PIT_BOOST_PER_UNIT,
    familyTotalBoost: newTotal * GAME.PIT_BOOST_PER_UNIT,
  };
}

/**
 * Returns the total boost units accumulated by a family on a race day.
 */
async function getFamilyTotalBoost(redis, raceId, dayNumber, date, familyId) {
  const val = await redis.get(keys.familyBoost(raceId, dayNumber, date, familyId));
  return parseInt(val || '0', 10);
}

/**
 * Returns current pit window status for a member.
 */
async function getPitStatus(redis, raceId, dayNumber, date, memberId, windowKey) {
  const [windowOpen, claimed] = await Promise.all([
    redis.exists(keys.pitWindowOpen(raceId, dayNumber, date, windowKey)),
    redis.exists(keys.memberPitClaimed(raceId, dayNumber, date, memberId, windowKey)),
  ]);
  return {
    window_open:     windowOpen === 1,
    windowKey,
    already_claimed: claimed === 1,
  };
}

module.exports = { openPitWindow, claimPitStop, getFamilyTotalBoost, getPitStatus };
