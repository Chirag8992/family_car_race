'use strict';

/**
 * routes/pit.routes.js
 *
 * Mounted at /pit — participant-only. Auth + requireParticipant applied in app.js.
 *
 * POST /pit/claim   → claim pit stop for current window
 * GET  /pit/status  → window open status + already claimed flag
 *
 * All time and date values now use IST (UTC+05:30) to match
 * pitCron.worker.js which creates window keys using IST hour and IST date.
 * Using UTC hour caused `window_closed` at 8AM IST (= 2:30 UTC) because
 * pitWindowKeyFromHour only maps 8, 14, 19 — not 2.
 * Using UTC date caused key mismatch for 5.5h/day (midnight UTC to 05:30 IST).
 */

const { Router } = require('express');
const pitService    = require('../services/pit.service');
const reportService = require('../services/report.service');
const helpers       = require('../utils/helpers');
const { redisClient } = require('../config/redis');
const db              = require('../config/mysql');
const ioSingleton     = require('../socket/io');
const keys            = require('../utils/keys');
const GAME            = require('../constants/game');
const moment          = require('moment-timezone');

const router = Router();

// Returns the current hour in IST (0-23).
// Must match pitCron.worker.js which opens windows at 8, 14, 19 IST.
function currentISTHour() {
  return moment().tz('Asia/Kolkata').hour();
}

// Derives the current pit window key ('morning' | 'afternoon' | 'evening' | null)
// from the IST hour, matching pitCron.worker.js exactly.
function currentWindowKey() {
  return helpers.pitWindowKeyFromHour(currentISTHour());
}

// Returns today's date as 'YYYY-MM-DD' in IST.
// Pit window keys are created by pitCron.worker.js using the IST date.
function todayIST() {
  return moment().tz('Asia/Kolkata').format('YYYY-MM-DD');
}

router.post('/claim', async (req, res) => {
  const { raceId, dayNumber, groupNumber } = req.body || {};
  const { memberId } = req.user;

  // Resolve familyId from Redis — authoritative source from grouping time
  const familyId = await redisClient.hget(keys.memberFamilyInRace(raceId), String(memberId));

  if (!familyId) {
    return res.status(400).json({ error: 'family_not_found' });
  }

  // Try clock-based key first; fall back to scanning which key is actually open
  let windowKey = currentWindowKey();
  const today = todayIST();

  if (!windowKey) {
    // No window expected by clock — check if any window key is live in Redis
    // (supports test/dev scenarios where windows are opened manually)
    const keysModule = require('../utils/keys');
    for (const wk of ['morning', 'afternoon', 'evening']) {
      const exists = await redisClient.exists(keysModule.pitWindowOpen(raceId, parseInt(dayNumber, 10), today, wk));
      if (exists) { windowKey = wk; break; }
    }
  }

  if (!windowKey) {
    return res.status(400).json({ error: 'window_closed' });
  }

  try {
    const result = await pitService.claimPitStop(
      redisClient, raceId, parseInt(dayNumber, 10), today,
      memberId, familyId, windowKey, groupNumber ? parseInt(groupNumber, 10) : null
    );

    // Broadcast updated family boost to all users in the group room (realtime)
    const io = ioSingleton.get();
    if (io && groupNumber) {
      const room = `${raceId}:d${dayNumber}:g${groupNumber}`;

      // Fetch updated member list for the claiming family so open dialogs refresh
      let pitMembers = [];
      let contributedCount = 0;
      try {
        pitMembers = await reportService.getPitMemberList(
          redisClient, db, raceId, parseInt(dayNumber, 10),
          parseInt(groupNumber, 10), familyId, today
        );
        contributedCount = pitMembers.filter(m => m.total_claims > 0).length;
      } catch (e) {
        console.warn('[pit] member list fetch for broadcast failed:', e.message);
      }

      io.to(room).emit('pit_boost_updated', {
        familyId,
        familyTotalBoost: result.familyTotalBoost,
        projectedBaseSpeed: 100 + result.familyTotalBoost,
        contributedCount,
        totalMembers: pitMembers.length,
        members: pitMembers,
      });
    }

    return res.json(result);
  } catch (err) {
    if (err.code === 'window_closed')  return res.status(400).json({ error: 'window_closed' });
    if (err.code === 'already_claimed') return res.status(400).json({ error: 'already_claimed' });
    console.error('[pit] claim error:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/status', async (req, res) => {
  const { raceId, dayNumber } = req.query || {};
  const { memberId } = req.user;

  let windowKey = currentWindowKey();
  const today   = todayIST();

  // Fall back: check which window key is actually open in Redis
  if (!windowKey) {
    const keysModule = require('../utils/keys');
    for (const wk of ['morning', 'afternoon', 'evening']) {
      const exists = await redisClient.exists(keysModule.pitWindowOpen(raceId, parseInt(dayNumber, 10), today, wk));
      if (exists) { windowKey = wk; break; }
    }
  }
  if (!windowKey) windowKey = 'none';

  try {
    const status = await pitService.getPitStatus(
      redisClient, raceId, parseInt(dayNumber, 10), today, memberId, windowKey
    );

    // Resolve familyId to include family total boost
    const familyId = await redisClient.hget(
      require('../utils/keys').memberFamilyInRace(raceId), String(memberId)
    );
    let familyTotalBoost = 0;
    if (familyId) {
      const units = await pitService.getFamilyTotalBoost(
        redisClient, raceId, parseInt(dayNumber, 10), today, familyId
      );
      familyTotalBoost = units * require('../constants/game').PIT_BOOST_PER_UNIT;
    }

    return res.json({
      ...status,
      familyTotalBoost,
      boost_per_unit: require('../constants/game').PIT_BOOST_PER_UNIT,
    });
  } catch (err) {
    console.error('[pit] status error:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ─── GET pit member list ──────────────────────────────────────────────────────

/**
 * GET /pit/members
 *
 * Returns a sorted list of family members who either collected a pit stop
 * or visited the race page (appeared in connected_members) on the given day.
 *
 * Query params: raceId, dayNumber, groupNumber
 * Auth: participant only (enforced in app.js)
 *
 * Response: [{ member_id, total_claims, visited_only }] — descending by total_claims
 */
router.get('/members', async (req, res) => {
  const { raceId, dayNumber, groupNumber } = req.query || {};
  const { memberId } = req.user;

  if (!raceId || !dayNumber || !groupNumber) {
    return res.status(400).json({ error: 'missing_params' });
  }

  console.log(1)
  const today = todayIST();
  try {
    // Resolve the familyId for this member in this race
    const familyId = await redisClient.hget(
      require('../utils/keys').memberFamilyInRace(raceId), String(memberId)
    );
    if (!familyId) {
      return res.status(403).json({ error: 'not_a_participant' });
    }

    console.log(2)
    const list = await reportService.getPitMemberList(
      redisClient, db,
      raceId,
      parseInt(dayNumber, 10),
      parseInt(groupNumber, 10),
      familyId,
      today
    );

    return res.json({ family_id: familyId, date: today, members: list });
  } catch (err) {
    console.error('[pit] members error:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
