'use strict';

/**
 * routes/admin.routes.js
 *
 * Mounted at /admin — admin-only. Auth + requireAdmin applied in app.js.
 *
 * POST /admin/game/create   → create a new game week
 * GET  /admin/game/:raceId  → get game details
 */

const { Router }  = require('express');
const gameService = require('../services/game.service');
const { redisClient } = require('../config/redis');
const db          = require('../config/mysql');

const router = Router();

router.post('/game/create', async (req, res) => {
  try {
    const result = await gameService.createGame(req.body, db, redisClient);
    return res.status(201).json(result);
  } catch (err) {
    const status = err.message.includes('must be') ? 400 : 500;
    return res.status(status).json({ error: err.message });
  }
});

router.get('/game/:raceId', async (req, res) => {
  try {
    const game = await gameService.getGame(req.params.raceId, db);
    if (!game) return res.status(404).json({ error: 'game_not_found' });

    const redisMeta = await redisClient.hgetall(
      require('../utils/keys').gameMeta(req.params.raceId)
    );
    return res.json({ ...game, redis_meta: redisMeta });
  } catch (err) {
    console.error('[admin] Get game error:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
