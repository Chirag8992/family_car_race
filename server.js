'use strict';

/**
 * server.js
 *
 * Application entry point. Performs all startup steps in order:
 *
 *   1.  Load and validate environment variables (throws fast if .env is wrong)
 *   2.  Connect Redis (redisClient + redisSub + redisNotification)
 *   3.  Connect MySQL (test connection to verify pool works)
 *   4.  Load all Lua scripts into Redis via SCRIPT LOAD
 *   5.  Create Express app + Socket.IO (via app.js factory)
 *   6.  Register all BullMQ workers
 *   7.  Start HTTP server on configured port
 *
 * Startup is sequential — any step failing will reject the promise
 * and crash the process (let the process manager restart it).
 */

// Step 1 — load + validate env first (throws if anything missing)
const env = require('./config/env');

const { redisClient, redisSub, redisNotification, closeConnections } = require('./config/redis');
const db       = require('./config/mysql');
const luaSHA   = require('./scripts/lua');
const helpers  = require('./utils/helpers');
const { createApp } = require('./app');
const { setupCronJobs } = require('./jobs/queue');

// Workers (imported here so BullMQ processor functions register)
require('./workers/distanceTick.worker');
require('./workers/fuelWindow.worker');
require('./workers/raceEnd.worker');
require('./workers/gameStart.worker');
require('./workers/grouping.worker');
require('./workers/pitCron.worker');
require('./workers/crystalExpiry.worker');

// BullMQ queue / scheduler setup (cron jobs set up in start())
const { queues } = require('./jobs/queue');

async function start() {
  console.log('[server] Starting family-car-race…');

  // ── Step 3: MySQL ─────────────────────────────────────────────────────
  await db.testConnection();

  // ── Step 4: Lua scripts ───────────────────────────────────────────────
  await luaSHA.load(redisClient);

  // ── Step 4b: BullMQ cron jobs ─────────────────────────────────────────
  await setupCronJobs();

  // ── Key expiry handler ────────────────────────────────────────────────
  // redisSub automatically subscribes to __keyevent@0__:expired on 'ready'
  // and emits 'keyExpired' on redisClient via the unified event bridge in
  // config/redis.js. We just register the listener here.
  redisClient.on('keyExpired', ({ message: key }) => {
    // ── Pattern 1: Game start trigger ────────────────────────────────
    // game:{raceId}:day:{dayNumber}:start_trigger
    const startTrigger = helpers.parseStartTriggerKey(key);
    if (startTrigger) {
      const gameStartWorker = require('./workers/gameStart.worker');
      if (typeof gameStartWorker.onStartTrigger === 'function') {
        gameStartWorker.onStartTrigger(startTrigger).catch((err) => {
          console.error('[server] gameStart.onStartTrigger failed:', err.message);
        });
      }
      return;
    }

    // ── Pattern 2: Notify trigger (5 min before game start) ──────────────
    // game:{raceId}:day:{dayNumber}:notify_trigger
    const notifyTrigger = helpers.parseNotifyTriggerKey(key);
    if (notifyTrigger) {
      const { onNotifyTrigger } = require('./workers/gameStart.worker');
      if (typeof onNotifyTrigger === 'function') {
        onNotifyTrigger(notifyTrigger).catch((err) => {
          console.error('[server] gameStart.onNotifyTrigger failed:', err.message);
        });
      }
      return;
    }

    // ── Pattern 3: Crystal cooldown expiry ───────────────────────────────
    // race:{raceId}:day:{dayNumber}:group:{groupNumber}:member:{memberId}:crystal_cooldown
    const cooldown = helpers.parseCrystalCooldownKey(key);
    if (cooldown) {
      const crystalExpiryWorker = require('./workers/crystalExpiry.worker');
      if (typeof crystalExpiryWorker.onCooldownExpired === 'function') {
        crystalExpiryWorker.onCooldownExpired(cooldown).catch((err) => {
          console.error('[server] crystalExpiry.onCooldownExpired failed:', err.message);
        });
      }
      return;
    }
  });

  // ── Global notification handler ───────────────────────────────────────
  redisClient.on('globalNotification', ({ channel, message }) => {
    console.log(`[server] Global notification on ${channel}:`, message);
    // TODO: forward to Socket.IO or handle as needed
  });

  // ── Step 5: Express + Socket.IO ───────────────────────────────────────
  const { server } = createApp(redisClient);

  // ── Step 6: BullMQ workers already registered by require() above ─────

  // ── Step 7: Listen ────────────────────────────────────────────────────
  server.listen(env.PORT, () => {
    console.log(`[server] Listening on port ${env.PORT} (${env.NODE_ENV})`);
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────
  async function shutdown(signal) {
    console.log(`[server] ${signal} received — shutting down gracefully`);
    server.close(async () => {
      try {
        await closeConnections();
      } catch (_) { /* ignore */ }
      process.exit(0);
    });

    // Force exit after 10s if server.close() hangs (open socket connections)
    setTimeout(() => {
      console.error('[server] Forced exit after 10s');
      process.exit(1);
    }, 10_000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    console.error('[server] Unhandled rejection:', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[server] Uncaught exception:', err);
    process.exit(1);
  });
}

start().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
