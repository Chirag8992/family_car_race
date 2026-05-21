'use strict';

/**
 * routes/reward.routes.js
 *
 * Mounted at /reward — requires authentication (any family member can claim).
 *
 * GET  /reward/status       → reward status for caller's family in given race
 * POST /reward/claim-daily  → claim daily winner reward for a specific day
 * POST /reward/claim-streak → claim 3-day consecutive win bonus
 */

const { Router }      = require('express');
const rewardService   = require('../services/reward.service');
const { redisClient } = require('../config/redis');
const db              = require('../config/mysql');
const keys            = require('../utils/keys');

const router = Router();

/**
 * Resolve the familyId for the current user in this race.
 * Checks Redis first (available during/after active race with TTL),
 * falls back to DB results (after game completed and Redis cleaned).
 */
async function resolveFamilyId(raceId, memberId) {
  // Try Redis (memberFamilyInRace hash — available while game meta exists)
  const fromRedis = await redisClient.hget(keys.memberFamilyInRace(raceId), String(memberId));
  if (fromRedis) return fromRedis;

  // Fallback: look up from race results + groupsmembers
  const rows = await db.query(
    `SELECT DISTINCT r.family_id
       FROM family_car_race_result r
       INNER JOIN groupsmembers gm ON gm.familyId = r.family_id AND gm.userId = ? AND gm.memberStatus = '1'
      WHERE r.race_id = ?
      LIMIT 1`,
    [memberId, raceId]
  );
  if (rows.length) return String(rows[0].family_id);

  // Final fallback: non-race day / groups not decided yet — use current family
  const fam = await db.query(
    `SELECT familyId FROM groupsmembers WHERE userId = ? AND memberStatus = '1' LIMIT 1`,
    [memberId]
  );
  return fam.length ? String(fam[0].familyId) : null;
}

// ─── GET /reward/status ────────────────────────────────────────────────────

router.get('/status', async (req, res) => {
  try {
    const { raceId } = req.query;
    if (!raceId) {
      return res.status(400).json({ error: 'raceId required' });
    }

    const memberId = req.user.memberId;
    const familyId = await resolveFamilyId(raceId, memberId);
    if (!familyId) {
      return res.status(404).json({ error: 'family_not_found' });
    }

    const status = await rewardService.getRewardStatus(raceId, familyId);
    return res.json(status);
  } catch (err) {
    console.error('[reward] status error:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ─── POST /reward/claim-daily ──────────────────────────────────────────────

router.post('/claim-daily', async (req, res) => {
  try {
    const { raceId, dayNumber } = req.body || {};
    if (!raceId || !dayNumber) {
      return res.status(400).json({ error: 'raceId and dayNumber required' });
    }

    const memberId = req.user.memberId;
    const familyId = await resolveFamilyId(raceId, memberId);
    if (!familyId) {
      return res.status(404).json({ error: 'family_not_found' });
    }

    const result = await rewardService.claimDailyReward(
      raceId, familyId, parseInt(dayNumber, 10), memberId
    );
    return res.json(result);
  } catch (err) {
    if (['not_winner', 'already_claimed', 'no_active_members', 'invalid_day'].includes(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    console.error('[reward] claim-daily error:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ─── POST /reward/claim-streak ─────────────────────────────────────────────

router.post('/claim-streak', async (req, res) => {
  try {
    const { raceId } = req.body || {};
    if (!raceId) {
      return res.status(400).json({ error: 'raceId required' });
    }

    const memberId = req.user.memberId;
    const familyId = await resolveFamilyId(raceId, memberId);
    if (!familyId) {
      return res.status(404).json({ error: 'family_not_found' });
    }

    const result = await rewardService.claimStreakReward(raceId, familyId, memberId);
    return res.json(result);
  } catch (err) {
    if (['not_eligible', 'already_claimed', 'no_active_members'].includes(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    console.error('[reward] claim-streak error:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
