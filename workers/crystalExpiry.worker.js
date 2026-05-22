'use strict';

/**
 * workers/crystalExpiry.worker.js
 *
 * Handles Redis keyspace expiry events for crystal cooldown keys.
 * Called from server.js when key pattern matches:
 *   race:{raceId}:day:{dayNumber}:group:{groupNumber}:member:{memberId}:crystal_cooldown
 *
 * On expiry:
 *   1. SET crystal_ready key for this member
 *   2. Emit 'crystal_ready' event to the member's socket
 */

const { redisClient } = require('../config/redis');
const keys            = require('../utils/keys');
const ioSingleton     = require('../socket/io');
const handlers        = require('../socket/handlers');

/**
 * Fired when a crystal cooldown key expires.
 *
 * @param {{ raceId: string, dayNumber: number, groupNumber: number, memberId: string }} param
 */
async function onCooldownExpired({ raceId, dayNumber, groupNumber, memberId }) {
  const redis = redisClient;

  // Guard: if a new cooldown was already set (e.g. by a successful collect
  // that happened in the gap), don't set crystal_ready — the new cooldown's
  // expiry will handle it.
  const cooldownExists = await redis.exists(keys.crystalCooldown(raceId, dayNumber, groupNumber, memberId));
  if (cooldownExists) return;

  // Re-enable collect button
  await redis.set(keys.crystalReady(raceId, dayNumber, groupNumber, memberId), '1');

  // Notify member via Socket.IO
  const io = ioSingleton.get();
  if (io) {
    handlers.emitToMember(io, memberId, 'crystal_ready', { memberId });
  }
}

module.exports = { onCooldownExpired };
