'use strict';

/**
 * config/env.js
 *
 * Loads .env via dotenv, validates all required variables, and exports
 * a frozen config object. Every other module imports from here — never
 * from process.env directly. Throws on startup if any required key is
 * missing so the process fails fast instead of silently using undefined.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// ─── Required Variables ────────────────────────────────────────────────────
const REQUIRED = [
  ['PORT',          'HTTP server port'],
  ['DB_HOST',       'MySQL host'],
  ['DB_PORT',       'MySQL port'],
  ['DB_USERNAME',   'MySQL user'],
  ['DB_DATABASE',   'MySQL database name'],
  ['REDIS_HOST',    'Redis host'],
  ['REDIS_PORT',    'Redis port'],
  ['JWT_API_KEY',   'JWT signing secret'],
  ['BULLMQ_PREFIX', 'BullMQ Redis key prefix'],
];

function validate() {
  const missing = [];
  for (const [key] of REQUIRED) {
    if (!process.env[key]) missing.push(key);
  }
  if (missing.length > 0) {
    throw new Error(
      `[env] Missing required environment variables:\n  ${missing.join('\n  ')}\n` +
      `Copy .env.example to .env and fill in all values.`
    );
  }
}

function load() {
  validate();

  const env = {
    PORT:          parseInt(process.env.PORT, 10),
    NODE_ENV:      process.env.NODE_ENV || 'development',

    // Database
    DB_HOST:       process.env.DB_HOST,
    DB_PORT:       parseInt(process.env.DB_PORT, 10),
    DB_USERNAME:   process.env.DB_USERNAME,
    DB_PASSWORD:   process.env.DB_PASSWORD || '',
    DB_DATABASE:   process.env.DB_DATABASE,
    DB_POOL_LIMIT: parseInt(process.env.DB_POOL_LIMIT || '80', 10),

    // Redis
    REDIS_HOST:    process.env.REDIS_HOST,
    REDIS_PORT:    parseInt(process.env.REDIS_PORT, 10),

    // Auth
    JWT_API_KEY:   process.env.JWT_API_KEY,

    // Admin user IDs — comma-separated in env, stored as a Set for O(1) lookup.
    // Example: ADMIN_USER_IDS=1,42,100
    ADMIN_USER_IDS: new Set(
      (process.env.ADMIN_USER_IDS || '')
        .split(',')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => !isNaN(n))
    ),

    // BullMQ
    BULLMQ_PREFIX: process.env.BULLMQ_PREFIX,

    // Notifications
    NOTIFY_BASE_URL: process.env.NOTIFY_BASE_URL || '',
    NOTIFY_TOKEN:    process.env.NOTIFY_TOKEN    || '',

    isProduction:  process.env.NODE_ENV === 'production',
    isDevelopment: process.env.NODE_ENV !== 'production',
  };

  return Object.freeze(env);
}

module.exports = load();
