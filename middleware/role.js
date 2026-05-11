'use strict';

/**
 * src/middleware/role.js
 *
 * Access control middleware.
 *
 * Access rules:
 *   /admin/*           → admin only  (userID must be in ADMIN_USER_IDS env list)
 *   /race/*            → participant only (Redis SISMEMBER on participants set)
 *   /pit/*             → participant only
 *   /leaderboard/*     → all authenticated users
 *   Socket.IO join_room → participant only (checked in socket handler)
 *
 * Admin check: no role column exists in the users table. Admins are
 * identified by their numeric user ID in the ADMIN_USER_IDS env variable
 * (comma-separated, e.g. "1,42,100").
 *
 * Participant check uses Redis SISMEMBER — the set is populated on Thursday
 * when the top-9 families are grouped. JWT familyId is stored for convenience
 * but the Redis set is the authoritative gate.
 */

const env = require('../config/env');

/**
 * Middleware: only allows requests whose JWT userID is listed in
 * the ADMIN_USER_IDS environment variable.
 */
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'unauthenticated' });
  }
  if (!env.ADMIN_USER_IDS.has(req.user.userID)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

/**
 * Middleware factory: verifies the member is in the Redis participants set
 * for the given raceId. raceId is read from req.body, req.query, or req.params.
 *
 * Attaches nothing extra to req — the Redis check is the gate.
 *
 * @param {import('ioredis').Redis} redis
 * @returns {import('express').RequestHandler}
 */
function requireParticipant(redis) {
  const keys = require('../utils/keys');

  return async function participantCheck(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'unauthenticated' });
    }

    const raceId   = req.body?.raceId || req.query?.raceId || req.params?.raceId;
    const memberId = req.user.memberId;

    if (!raceId) {
      return res.status(400).json({ error: 'missing_raceId' });
    }

    try {
      const isMember = await redis.sismember(keys.participants(raceId), memberId);
      if (!isMember) {
        return res.status(403).json({ error: 'not_a_participant' });
      }
      next();
    } catch (err) {
      console.error('[role] Redis check failed:', err.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  };
}

module.exports = {
  admin:              requireAdmin,
  requireAdmin:       requireAdmin,
  participant:        requireParticipant,
  requireParticipant: requireParticipant,
};
