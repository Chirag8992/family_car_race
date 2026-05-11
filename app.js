'use strict';

/**
 * app.js
 *
 * Express application factory.
 * Configures middleware, mounts all routers, attaches Socket.IO.
 * Does NOT start the HTTP server — that is server.js's job.
 *
 * Receives redisClient as a parameter so routes and middleware that need
 * Redis access get the already-connected singleton, not a new client.
 *
 * @param {import('ioredis').Redis} redisClient — connected ioredis client
 * @returns {{ app: import('express').Application, server: import('http').Server, io: import('socket.io').Server }}
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');

const authenticate          = require('./middleware/auth');
const { admin, participant } = require('./middleware/role');
const ioSingleton            = require('./socket/io');

const authRoutes        = require('./routes/auth.routes');
const adminRoutes       = require('./routes/admin.routes');
const raceRoutes        = require('./routes/race.routes');
const pitRoutes         = require('./routes/pit.routes');
const leaderboardRoutes = require('./routes/leaderboard.routes');
const gameRoutes        = require('./routes/game.routes');

const db             = require('./config/mysql');
const socketHandlers = require('./socket/handlers');

function createApp(redisClient) {
  const app    = express();
  const server = http.createServer(app);

  // ── Socket.IO setup ────────────────────────────────────────────────────
  const io = new Server(server, {
    path      : '/v1/family-race/socket/',   
    cors      : { origin: '*' },   // tighten in production
    transports: ['websocket', 'polling'],
  });

  // Store io so workers can access it for broadcasting
  ioSingleton.set(io);

  // ── Global Express middleware ──────────────────────────────────────────
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // CORS — allow frontend dev server
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, ngrok-skip-browser-warning');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (_req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Basic request logger (dev only)
  if (process.env.NODE_ENV !== 'production') {
    app.use((req, _res, next) => {
      console.log(`[http] ${req.method} ${req.path}`);
      next();
    });
  }

  // ── Route prefix ──────────────────────────────────────────────────────
  const PREFIX = '/v1/family-race/api';

  // ── Health check (unauthenticated) ────────────────────────────────────
  app.get(`${PREFIX}/health`, (_req, res) => res.json({ status: 'ok' }));

  // ── Routes ────────────────────────────────────────────────────────────
  app.use(`${PREFIX}/auth`, authRoutes);

  // Public game page endpoints — NO auth required
  app.use(`${PREFIX}/game`, gameRoutes);

  // ── DEV/TEST: pit window opener (no auth) ─────────────────────────────
  // if (process.env.NODE_ENV !== 'production') {
  //   const pitService  = require('./services/pit.service');
  //   const GAME        = require('./constants/game');
  //   const keysUtil    = require('./utils/keys');

  //   app.post('/test/pit-window-open', async (req, res) => {
  //     const { raceId, dayNumber, windowKey, ttl } = req.body;
  //     if (!raceId || !dayNumber || !windowKey) {
  //       return res.status(400).json({ error: 'raceId, dayNumber, windowKey required' });
  //     }
  //     const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  //     const todayIST = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
  //     const duration = ttl || 60;

  //     await pitService.openPitWindow(redisClient, raceId, parseInt(dayNumber, 10), todayIST, windowKey);
  //     const pitKey = keysUtil.pitWindowOpen(raceId, dayNumber, todayIST, windowKey);
  //     await redisClient.expire(pitKey, duration);

  //     const closesAt = Date.now() + duration * 1000;
  //     const io = ioSingleton.get();
  //     if (io) {
  //       io.emit('pit_window_open', { raceId, dayNumber: parseInt(dayNumber, 10), windowKey, closes_at: closesAt });
  //     }
  //     console.log(`[test] Pit window opened: ${windowKey} for ${duration}s`);
  //     return res.json({ ok: true, broadcast: !!io, windowKey, ttl: duration, closes_at: closesAt });
  //   });

  //   // Reset all pit claims for a member (for re-testing)
  //   app.post('/test/pit-reset-claims', async (req, res) => {
  //     const { raceId, dayNumber, memberId } = req.body;
  //     if (!raceId || !dayNumber || !memberId) {
  //       return res.status(400).json({ error: 'raceId, dayNumber, memberId required' });
  //     }
  //     const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  //     const todayIST = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
  //     const deleted = [];
  //     for (const wk of ['morning', 'afternoon', 'evening']) {
  //       const k = keysUtil.memberPitClaimed(raceId, parseInt(dayNumber, 10), todayIST, memberId, wk);
  //       const d = await redisClient.del(k);
  //       if (d) deleted.push(wk);
  //     }
  //     console.log(`[test] Pit claims reset for member ${memberId}: ${deleted.join(', ') || 'none found'}`);
  //     return res.json({ ok: true, deleted });
  //   });
  // }

  // All routes below require a valid JWT
  app.use(`${PREFIX}/admin`,       authenticate, admin, adminRoutes);
  app.use(`${PREFIX}/race`,        authenticate, participant(redisClient), raceRoutes);
  app.use(`${PREFIX}/pit`,         authenticate, participant(redisClient), pitRoutes);
  app.use(`${PREFIX}/leaderboard`, authenticate, leaderboardRoutes);

  // ── GET /user/profile — returns current user's name, image, family info ──
  app.get(`${PREFIX}/user/profile`, authenticate, async (req, res) => {
    try {
      const userId = req.user.memberId || req.user.userID;
      const rows = await db.query(
        `SELECT u.id, u.name, u.image,
                gm.familyId,
                g.familyname AS familyName,
                g.image AS familyImage
           FROM users u
           LEFT JOIN groupsmembers gm ON gm.userId = u.id AND gm.memberStatus = '1'
           LEFT JOIN \`groups\` g ON g.id = gm.familyId
          WHERE u.id = ?
          LIMIT 1`,
        [userId]
      );
      const user = Array.isArray(rows) ? rows[0] : rows;
      if (!user) {
        return res.status(404).json({ error: 'user_not_found' });
      }
      return res.json({
        userId:      user.id,
        name:        user.name || '',
        image:       user.image || '',
        familyId:    user.familyId ? String(user.familyId) : null,
        familyName:  user.familyName || '',
        familyImage: user.familyImage || '',
      });
    } catch (err) {
      console.error('[GET /user/profile]', err.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // ── 404 handler ───────────────────────────────────────────────────────
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  // ── Global error handler ──────────────────────────────────────────────
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('[app] Unhandled error:', err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  });

  // ── Attach Socket.IO event handlers ───────────────────────────────────
  socketHandlers.attach(io);

  return { app, server, io };
}

module.exports = { createApp };
