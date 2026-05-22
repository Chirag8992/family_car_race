'use strict';

/**
 * routes/race.routes.js
 *
 * Mounted at /race — participant-only. Auth + requireParticipant applied in app.js.
 *
 * POST /race/crystal/collect   → collect 1 crystal
 * POST /race/egg/throw         → throw egg (costs 1 crystal directly)
 * POST /race/wiper/use         → use wiper (costs 1 crystal directly)
 * POST /race/fuel/submit       → submit fuel (window or car restart)
 * GET  /race/inventory         → get member crystal count
 * GET  /race/leaderboard       → live leaderboard from Redis
 * GET  /race/state             → own family state
 */

const { Router }      = require('express');
const crystalService  = require('../services/crystal.service');
const combatService   = require('../services/combat.service');
const fuelService     = require('../services/fuel.service');
const lbService       = require('../services/leaderboard.service');
const raceService     = require('../services/race.service');
const reportService   = require('../services/report.service');
const keys            = require('../utils/keys');
const luaSHA          = require('../scripts/lua');
const { redisClient } = require('../config/redis');
const ioSingleton     = require('../socket/io');
const handlers        = require('../socket/handlers');
const db              = require('../config/mysql');
const cacheManager    = require('../utils/Cache_manager');

const router = Router();

/**
 * Validate raceId, dayNumber, groupNumber are present and sane.
 * Returns false and writes a 400 response if anything is wrong.
 */
function validateRaceParams(res, raceId, dayNumber, groupNumber) {
  if (raceId == null || raceId === '' || raceId === 'undefined' || raceId === 'null') {
    res.status(400).json({ error: 'invalid_param', param: 'raceId' });
    return false;
  }
  const day = parseInt(dayNumber, 10);
  if (!dayNumber || isNaN(day) || day < 1 || day > 3) {
    res.status(400).json({ error: 'invalid_param', param: 'dayNumber' });
    return false;
  }
  const grp = parseInt(groupNumber, 10);
  if (!groupNumber || isNaN(grp) || grp < 1 || grp > 3) {
    res.status(400).json({ error: 'invalid_param', param: 'groupNumber' });
    return false;
  }
  return true;
}

/**
 * Resolve the familyId that is actually registered in this race for the
 * given memberId. Only uses the authoritative Redis hash set at grouping time.
 * Returns null if the member has no race family assignment (should not happen
 * if requireParticipant middleware passed).
 */
async function resolveFamily(raceId, memberId, _jwtFamilyId) {
  const id = await redisClient.hget(keys.memberFamilyInRace(raceId), memberId);
  return id || null;
}

/**
 * Verify the member's family actually belongs to the groupNumber they sent.
 * Prevents a member from acting on a different group's race.
 * Returns false and writes a 403 response if the family is not in that group.
 * Returns true (allow) if groups haven't been assigned yet (dev/test fallback).
 */
async function verifyMemberGroup(res, raceId, dayNumber, groupNumber, familyId) {
  const groupRaw = await redisClient.hget(
    keys.dayGroups(raceId, dayNumber), `group_${groupNumber}`
  );
  if (!groupRaw) return true; // groups not yet assigned — allow in dev/test
  const families = JSON.parse(groupRaw).map(String);
  if (!families.includes(String(familyId))) {
    res.status(403).json({ error: 'wrong_group' });
    return false;
  }
  return true;
}

// ─── Crystal collect ──────────────────────────────────────────────────────────

router.post('/crystal/collect', async (req, res) => {
  const { raceId, dayNumber, groupNumber } = req.body || {};
  if (!validateRaceParams(res, raceId, dayNumber, groupNumber)) return;

  const { memberId } = req.user;
  const familyId = await resolveFamily(raceId, memberId, req.user.familyId);
  if (!await verifyMemberGroup(res, raceId, dayNumber, groupNumber, familyId)) return;

  try {
    const result = await crystalService.collectCrystal(
      redisClient, luaSHA, raceId, dayNumber, groupNumber, memberId
    );

    await redisClient.sadd(keys.activeMembers(raceId, dayNumber, groupNumber, familyId), memberId);

    const io = ioSingleton.get();
    if (io) {
      handlers.broadcastActiveCounts(io, redisClient, raceId, dayNumber, groupNumber);
      handlers.emitToMember(io, memberId, 'crystal_earned', {
        memberId,
        crystals: result.crystals,
      });
    }

    return res.json({ crystals: result.crystals, cooldown_seconds: 30 });
  } catch (err) {
    if (err.message === 'cooldown_active') return res.status(400).json({ error: 'cooldown_active' });
    if (err.message === 'not_ready')       return res.status(400).json({ error: 'not_ready' });
    console.error('[race] collect error:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ─── Egg throw ─────────────────────────────────────────────────────────────────

router.post('/egg/throw', async (req, res) => {
  const { raceId, dayNumber, groupNumber, targetFamilyId, amount: rawAmount } = req.body || {};
  if (!validateRaceParams(res, raceId, dayNumber, groupNumber)) return;

  const amount = Math.max(1, Math.min(10, parseInt(rawAmount, 10) || 1));
  const { memberId } = req.user;
  const familyId = await resolveFamily(raceId, memberId, req.user.familyId);
  if (!await verifyMemberGroup(res, raceId, dayNumber, groupNumber, familyId)) return;

  if (!targetFamilyId || targetFamilyId === familyId) {
    return res.status(400).json({ error: 'invalid_target' });
  }

  // Fix #13: verify targetFamilyId is actually in this group's race
  const groupFamiliesRaw = await redisClient.hget(
    keys.raceMeta(raceId, dayNumber, groupNumber), 'families'
  );
  if (groupFamiliesRaw) {
    const groupFamilies = JSON.parse(groupFamiliesRaw).map(String);
    if (!groupFamilies.includes(String(targetFamilyId))) {
      return res.status(400).json({ error: 'invalid_target' });
    }
  }

  try {
    const { wasted, newSpeed } = await combatService.throwEgg(
      redisClient, luaSHA, raceId, dayNumber, groupNumber, memberId, familyId, targetFamilyId, amount
    );

    const remainingCrystals = parseInt(
      await redisClient.hget(keys.memberInventory(raceId, dayNumber, groupNumber, memberId), 'crystals') || '0', 10
    );

    await redisClient.sadd(keys.activeMembers(raceId, dayNumber, groupNumber, familyId), memberId);

    const io = ioSingleton.get();
    if (io) {
      handlers.broadcastActiveCounts(io, redisClient, raceId, dayNumber, groupNumber);
      const room = `${raceId}:d${dayNumber}:g${groupNumber}`;
      let attackerName = '';
      let attackerImage = '';
      try {
        const userData = await cacheManager.getOrCache('user', memberId);
        if (userData) { attackerName = userData.username || userData.name || ''; attackerImage = userData.image || ''; }      } catch (_) {}
      io.to(room).emit('egg_hit', {
        targetFamilyId,
        new_speed: newSpeed,
        wasted,
        attackerFamilyId: familyId,
        attackerName,
        attackerImage,
        amount,
      });
    }

    return res.json({ wasted, targetFamilyId, new_speed: newSpeed, crystals: remainingCrystals });
  } catch (err) {
    if (err.message === 'no_crystals') return res.status(400).json({ error: 'no_crystals' });
    console.error('[race] egg throw error:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ─── Wiper use ─────────────────────────────────────────────────────────────────

router.post('/wiper/use', async (req, res) => {
  const { raceId, dayNumber, groupNumber, amount: rawAmount } = req.body || {};
  if (!validateRaceParams(res, raceId, dayNumber, groupNumber)) return;

  const amount = Math.max(1, Math.min(10, parseInt(rawAmount, 10) || 1));
  const { memberId } = req.user;
  const familyId = await resolveFamily(raceId, memberId, req.user.familyId);
  if (!await verifyMemberGroup(res, raceId, dayNumber, groupNumber, familyId)) return;

  try {
    const { newSpeed } = await combatService.useWiper(
      redisClient, luaSHA, raceId, dayNumber, groupNumber, memberId, familyId, amount
    );

    const remainingCrystals = parseInt(
      await redisClient.hget(keys.memberInventory(raceId, dayNumber, groupNumber, memberId), 'crystals') || '0', 10
    );

    await redisClient.sadd(keys.activeMembers(raceId, dayNumber, groupNumber, familyId), memberId);

    const io = ioSingleton.get();
    if (io) {
      handlers.broadcastActiveCounts(io, redisClient, raceId, dayNumber, groupNumber);
      const room = `${raceId}:d${dayNumber}:g${groupNumber}`;
      let memberName = '';
      let memberImage = '';
      try {
        const userData = await cacheManager.getOrCache('user', memberId);
        if (userData) { memberName = userData.username || userData.name || ''; memberImage = userData.image || ''; }
      } catch (_) {}
      io.to(room).emit('wiper_used', { familyId, new_speed: newSpeed, memberName, memberImage, amount });
    }

    return res.json({ current_speed: newSpeed, crystals: remainingCrystals });
  } catch (err) {
    if (err.message === 'no_crystals') return res.status(400).json({ error: 'no_crystals' });
    console.error('[race] wiper error:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ─── Fuel submit (window or restart) ─────────────────────────────────────────

router.post('/fuel/submit', async (req, res) => {
  const { raceId, dayNumber, groupNumber, windowIndex = 0 } = req.body || {};
  if (!validateRaceParams(res, raceId, dayNumber, groupNumber)) return;

  const { memberId } = req.user;
  const familyId = await resolveFamily(raceId, memberId, req.user.familyId);
  if (!await verifyMemberGroup(res, raceId, dayNumber, groupNumber, familyId)) return;

  const io   = ioSingleton.get();
  const room = `${raceId}:d${dayNumber}:g${groupNumber}`;

  try {
    await redisClient.sadd(keys.activeMembers(raceId, dayNumber, groupNumber, familyId), memberId);

    if (io) {
      handlers.broadcastActiveCounts(io, redisClient, raceId, dayNumber, groupNumber);
    }

    if (parseInt(windowIndex, 10) === 0) {
      // Car restart (outside window)
      await fuelService.submitFuelRestart(redisClient, luaSHA, raceId, dayNumber, groupNumber, memberId, familyId);
      const state = await raceService.getFamilyState(redisClient, raceId, dayNumber, groupNumber, familyId);
      if (io) {
        io.to(room).emit('car_resumed', {
          familyId,
          current_speed: parseInt(state?.current_speed || '0', 10),
        });
      }
      return res.json({ in_window: false, restarted: true });
    } else {
      // Fuel window submit
      const { newSpeed, newMaxSpeed } = await fuelService.submitFuelWindow(
        redisClient, luaSHA, raceId, dayNumber, groupNumber, memberId, familyId, parseInt(windowIndex, 10)
      );
      if (io) {
        io.to(room).emit('fuel_submitted', {
          familyId, new_speed: newSpeed, new_max_speed: newMaxSpeed, memberId,
        });
      }
      return res.json({ in_window: true, new_speed: newSpeed, new_max_speed: newMaxSpeed, restarted: false });
    }
  } catch (err) {
    const known = ['window_closed', 'already_fueled', 'already_restarted', 'car_not_stopped'];
    if (known.includes(err.message)) return res.status(400).json({ error: err.message });
    console.error('[race] fuel submit error:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ─── GET family inventory details ─────────────────────────────────────────────

/**
 * GET /race/family-inventory
 *
 * Returns per-member egg/wiper usage for the calling member's family
 * in the given group race.
 *
 * Active members (green dot) are listed first, sorted descending by
 * total_actions (eggs_used + wipers_used).  Inactive members follow,
 * also sorted descending by total_actions.
 *
 * Query params: raceId, dayNumber, groupNumber
 * Auth: participant only (enforced in app.js)
 *
 * Response:
 * {
 *   family_id: string,
 *   members: [
 *     { member_id, eggs_used, wipers_used, total_actions, is_active },
 *     ...
 *   ]
 * }
 */
router.get('/family-inventory', async (req, res) => {
  const { raceId, dayNumber, groupNumber, familyId: queryFamilyId } = req.query || {};
  if (!validateRaceParams(res, raceId, dayNumber, groupNumber)) return;

  const { memberId } = req.user;

  try {
    // If familyId provided in query, use it (for viewing any family); otherwise resolve from user
    const familyId = queryFamilyId || await resolveFamily(raceId, memberId, req.user.familyId);
    if (!await verifyMemberGroup(res, raceId, dayNumber, groupNumber, familyId)) return;

    const members = await reportService.getFamilyInventory(
      redisClient, db,
      raceId,
      parseInt(dayNumber, 10),
      parseInt(groupNumber, 10),
      familyId
    );

    return res.json({ family_id: familyId, members });
  } catch (err) {
    console.error('[race] family-inventory error:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
