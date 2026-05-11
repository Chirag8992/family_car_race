'use strict';

/**
 * routes/leaderboard.routes.js
 *
 * Mounted at /leaderboard — all authenticated users (no participant check).
 *
 * GET /leaderboard/:raceId           → all days results from MySQL
 * GET /leaderboard/:raceId/day/:day  → single day results
 */

const { Router } = require('express');
const lbService  = require('../services/leaderboard.service');
const db         = require('../config/mysql');

const router = Router();

router.get('/:raceId', async (req, res) => {
  try {
    const result = await lbService.getHistoricalLeaderboard(db, req.params.raceId);
    return res.json(result);
  } catch (err) {
    console.error('[leaderboard] error:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/:raceId/day/:dayNumber', async (req, res) => {
  try {
    const { raceId, dayNumber } = req.params;
    const result = await lbService.getHistoricalDay(db, raceId, parseInt(dayNumber, 10));
    return res.json(result);
  } catch (err) {
    console.error('[leaderboard] error:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
