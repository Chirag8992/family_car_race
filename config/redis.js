'use strict';

/**
 * config/redis.js
 *
 * Creates and exports three ioredis clients:
 *
 *   redisClient        — General-purpose read/write client used by all
 *                        services, workers, and Lua script execution.
 *
 *   redisSub           — Dedicated subscriber for keyspace expiry events
 *                        (__keyevent@0__:expired). A client in subscribe
 *                        mode can only run subscribe/unsubscribe commands,
 *                        so it must be a separate connection.
 *
 *   redisNotification  — Dedicated subscriber for the global notifications
 *                        pub/sub channel (global_notifications_channel).
 *
 * High-level unified events are emitted on redisClient so the rest of
 * the app only needs to listen on one object:
 *
 *   redisClient.on('keyExpired',        ({ pattern, channel, message }) => {})
 *   redisClient.on('globalNotification',({ channel, message }) => {})
 *
 * Keyspace notification config (notify-keyspace-events Egx$) is applied
 * once when redisClient fires its 'ready' event.
 */

const Redis  = require('ioredis');
const dotenv = require('dotenv');

dotenv.config();

// ─── Shared connection config ──────────────────────────────────────────────
const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT, 10) || 6379,
  maxRetriesPerRequest: 3,
  commandTimeout: 5000,
  retryStrategy(times) {
    return Math.min(times * 50, 2000);
  },
};

// ─── Clients ───────────────────────────────────────────────────────────────
const redisClient       = new Redis(redisConfig);
const redisSub          = redisClient.duplicate();
const redisNotification = redisClient.duplicate();

// ─── Main client events ────────────────────────────────────────────────────
redisClient.on('connect', () => console.log('[Redis] connected'));
redisClient.on('reconnecting', () => console.log('[Redis] reconnecting...'));
redisClient.on('error', (err) => console.error('[Redis] Error:', err));

redisClient.on('ready', async () => {
  try {
    await redisClient.config('SET', 'notify-keyspace-events', 'Egx$');
    console.log('[Redis] notify-keyspace-events set to Egx$');
  } catch (err) {
    console.error('[Redis] Failed to set notify-keyspace-events:', err);
  }
});

// ─── Subscription setup ────────────────────────────────────────────────────
async function setupSubscriptions() {
  try {
    await redisSub.psubscribe('__keyevent@0__:expired');
    await redisNotification.subscribe('global_notifications_channel');
    console.log('[Redis] Subscriptions applied successfully');
  } catch (err) {
    console.error('[Redis] Failed to set subscriptions:', err);
  }
}

// Set up subscriptions when redisSub is ready (also covers reconnects)
redisSub.on('ready', setupSubscriptions);
redisSub.on('connect',     () => console.log('[RedisSub] connected'));
redisSub.on('reconnecting',() => console.log('[RedisSub] reconnecting...'));
redisSub.on('error', (err) => console.error('[RedisSub] Error:', err));

redisNotification.on('connect',     () => console.log('[RedisNotification] connected'));
redisNotification.on('reconnecting',() => console.log('[RedisNotification] reconnecting...'));
redisNotification.on('error', (err) => console.error('[RedisNotification] Error:', err));

// ─── Unified high-level event emitters ────────────────────────────────────

// Key expiry events → forward as 'keyExpired' on redisClient
redisSub.on('pmessage', (pattern, channel, message) => {
  redisClient.emit('keyExpired', { pattern, channel, message });
});

// Global notifications → forward as 'globalNotification' on redisClient
redisNotification.on('message', (channel, message) => {
  redisClient.emit('globalNotification', { channel, message });
});

// ─── Exports ───────────────────────────────────────────────────────────────
module.exports = {
  redisClient,
  redisSub,
  redisNotification,
  closeConnections: async () => {
    await redisClient.quit();
    await redisSub.quit();
    await redisNotification.quit();
    console.log('[Redis] All connections closed');
  },
};
