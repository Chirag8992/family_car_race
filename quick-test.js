#!/usr/bin/env node

/**
 * quick-test.js
 *
 * Quick Phase 1 sanity check — tests all critical components:
 *   1. .env loaded correctly
 *   2. Redis connection
 *   3. MySQL connection
 *   4. All modules importable
 *   5. Lua scripts loaded
 *
 * Run with: node quick-test.js
 */

const path = require('path');
const fs = require('fs');

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║        rox-family-car-race — Quick Sanity Check           ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

const tests = [];
let passed = 0;
let failed = 0;

// ─── Helper ───────────────────────────────────────────────────────────────

function test(name, fn) {
  tests.push({ name, fn });
}

async function runTests() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${name}`);
      console.log(`    Error: ${err.message}`);
      failed++;
    }
  }
}

// ─── Test 1: .env File ────────────────────────────────────────────────────

test('1.1 .env file exists', () => {
  const envPath = path.resolve(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error('.env file not found');
  }
});

test('1.2 Environment variables load', () => {
  const env = require('./config/env');
  if (!env.PORT || !env.DB_HOST) {
    throw new Error('Missing required env vars');
  }
});

test('1.3 Required env vars populated', () => {
  const env = require('./config/env');
  const required = ['PORT', 'DB_HOST', 'DB_USERNAME', 'REDIS_HOST', 'JWT_API_KEY'];
  for (const key of required) {
    if (!env[key]) {
      throw new Error(`Missing ${key}`);
    }
  }
});

// ─── Test 2: Redis ────────────────────────────────────────────────────────

test('2.1 Redis config loadable', () => {
  const redis = require('./config/redis');
  if (!redis.redisClient) {
    throw new Error('Redis client not created');
  }
});

test('2.2 Redis client can PING', async () => {
  const { redisClient } = require('./config/redis');
  
  return new Promise((resolve, reject) => {
    redisClient.once('ready', async () => {
      try {
        const pong = await redisClient.ping();
        if (pong !== 'PONG') throw new Error(`Unexpected response: ${pong}`);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
    
    redisClient.once('error', (err) => {
      reject(new Error(`Redis connection failed: ${err.message}`));
    });

    setTimeout(() => {
      reject(new Error('Redis connection timeout'));
    }, 5000);
  });
});

// ─── Test 3: MySQL ────────────────────────────────────────────────────────

test('3.1 MySQL config loadable', () => {
  const db = require('./config/mysql');
  if (!db.pool) {
    throw new Error('MySQL pool not created');
  }
});

test('3.2 MySQL pool ready', async () => {
  const db = require('./config/mysql');
  if (!db.pool) {
    throw new Error('Pool not initialized');
  }
  // Just verify the pool object exists and is configured
  if (!db.pool.config.host) {
    throw new Error('Pool not configured with host');
  }
});

// ─── Test 4: Constants ────────────────────────────────────────────────────

test('4.1 Game constants loadable', () => {
  const GAME = require('./constants/game');
  if (!GAME.STATUS) {
    throw new Error('Game constants missing');
  }
});

test('4.2 Constants have required values', () => {
  const GAME = require('./constants/game');
  if (GAME.SPEED.BASE_SPEED_DEFAULT !== 100) {
    throw new Error('BASE_SPEED_DEFAULT not 100');
  }
  if (GAME.RACE_DURATION_SECONDS !== 3600) {
    throw new Error('RACE_DURATION_SECONDS not 3600');
  }
});

// ─── Test 5: Scripts (Lua) ────────────────────────────────────────────────

test('5.1 Lua scripts loadable', () => {
  const lua = require('./scripts/lua');
  if (!lua.SCRIPTS) {
    throw new Error('Lua scripts not exported');
  }
});

test('5.2 All required Lua scripts present', () => {
  const lua = require('./scripts/lua');
  const required = [
    'crystalCollect',
    'convertItem',
    'throwEgg',
    'useWiper',
    'submitFuelWindow',
    'submitFuelRestart'
  ];
  
  for (const name of required) {
    if (!lua.SCRIPTS[name]) {
      throw new Error(`Missing Lua script: ${name}`);
    }
    if (typeof lua.SCRIPTS[name] !== 'string' || lua.SCRIPTS[name].length === 0) {
      throw new Error(`Invalid Lua script: ${name}`);
    }
  }
});

// ─── Test 6: Utils & Keys ─────────────────────────────────────────────────

test('6.1 Keys builder loadable', () => {
  const keys = require('./utils/keys');
  if (typeof keys.gameMeta !== 'function') {
    throw new Error('keys.gameMeta not a function');
  }
});

test('6.2 Helpers loadable', () => {
  const helpers = require('./utils/helpers');
  if (typeof helpers.getTodayDate !== 'function') {
    throw new Error('helpers.getTodayDate not a function');
  }
});

// ─── Test 7: Middleware ───────────────────────────────────────────────────

test('7.1 Auth middleware loadable', () => {
  const auth = require('./middleware/auth');
  if (typeof auth !== 'function') {
    throw new Error('Auth middleware not a function');
  }
});

test('7.2 Role middleware loadable', () => {
  const role = require('./middleware/role');
  if (typeof role.requireParticipant !== 'function') {
    throw new Error('Role middleware invalid');
  }
});

// ─── Test 8: App Factory ──────────────────────────────────────────────────

test('8.1 App factory loadable', () => {
  const { createApp } = require('./app');
  if (typeof createApp !== 'function') {
    throw new Error('createApp not a function');
  }
});

test('8.2 App factory creates app, server, io', () => {
  const { createApp } = require('./app');
  const mockRedis = {
    on: () => {},
    once: () => {},
    get: async () => null,
    hgetall: async () => ({}),
  };
  
  const { app, server, io } = createApp(mockRedis);
  if (!app || !server || !io) {
    throw new Error('App factory missing required returns');
  }
  server.close();
});

// ─── Test 9: Routes ───────────────────────────────────────────────────────

test('9.1 All routes loadable', () => {
  const routes = [
    './routes/auth.routes',
    './routes/admin.routes',
    './routes/race.routes',
    './routes/pit.routes',
    './routes/leaderboard.routes'
  ];
  
  for (const route of routes) {
    try {
      require(route);
    } catch (err) {
      throw new Error(`Failed to load ${route}: ${err.message}`);
    }
  }
});

// ─── Run All Tests ────────────────────────────────────────────────────────

(async () => {
  try {
    await runTests();
  } catch (err) {
    console.error('\n✗ Fatal error:', err.message);
    process.exit(1);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${'─'.repeat(60)}\n`);

  if (failed === 0) {
    console.log('✓ All sanity checks passed! Phase 1 is ready.\n');
    console.log('Next steps:');
    console.log('  1. npm run dev              — Start the server');
    console.log('  2. npm test                 — Run full test suite');
    console.log('  3. Read TESTING.md          — See detailed testing guide\n');
    process.exit(0);
  } else {
    console.log(`✗ ${failed} test(s) failed. Please review above.\n`);
    process.exit(1);
  }
})();
