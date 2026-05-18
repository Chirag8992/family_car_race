#!/usr/bin/env node
'use strict';

/**
 * scripts/test-pit-window.js
 *
 * Manually opens a pit stop window for testing.
 * Sets the Redis key and broadcasts the socket event via the running server.
 *
 * Usage:
 *   node scripts/test-pit-window.js                     # opens "morning" for 60s
 *   node scripts/test-pit-window.js afternoon            # opens "afternoon" for 60s
 *   node scripts/test-pit-window.js evening 120          # opens "evening" for 120s
 *   node scripts/test-pit-window.js morning 300 <raceId> # custom raceId
 *
 * The script connects directly to Redis — no auth needed.
 * It also pings the server's test endpoint to broadcast the socket event.
 */

const Redis = require('ioredis');
const moment = require('moment-timezone');

const VALID_WINDOWS = ['morning', 'afternoon', 'evening'];

const windowKey  = process.argv[2] || 'morning';
const ttlSeconds = parseInt(process.argv[3] || '60', 10);
const raceIdArg  = process.argv[4] || null;

if (!VALID_WINDOWS.includes(windowKey)) {
  console.error(`Invalid window key: "${windowKey}". Must be one of: ${VALID_WINDOWS.join(', ')}`);
  process.exit(1);
}

(async () => {
  const redis = new Redis({ host: '127.0.0.1', port: 6379 });

  try {
    // Find raceId — use arg or auto-detect from Redis
    let raceId = raceIdArg;
    if (!raceId) {
      // Scan for game meta keys
      const keys = [];
      let cursor = '0';
      do {
        const [next, batch] = await redis.scan(cursor, 'MATCH', 'game:*:meta', 'COUNT', 100);
        cursor = next;
        keys.push(...batch);
      } while (cursor !== '0');

      if (keys.length === 0) {
        console.error('No game found in Redis. Pass raceId as 3rd argument.');
        process.exit(1);
      }

      // Pick the first active game
      for (const k of keys) {
        const meta = await redis.hgetall(k);
        if (['day1_pending', 'day2_pending', 'day3_pending'].includes(meta.status)) {
          raceId = k.replace('game:', '').replace(':meta', '');
          break;
        }
      }
      if (!raceId) {
        // Fall back to any game
        raceId = keys[0].replace('game:', '').replace(':meta', '');
      }
    }

    // Determine dayNumber from game meta
    const meta = await redis.hgetall(`game:${raceId}:meta`);
    if (!meta || !meta.status) {
      console.error(`No game meta found for raceId: ${raceId}`);
      process.exit(1);
    }

    // Derive today IST
    const todayIST = moment().tz('Asia/Kolkata').format('YYYY-MM-DD');

    let dayNumber = 1;
    if (todayIST === meta.day1_date) dayNumber = 1;
    else if (todayIST === meta.day2_date) dayNumber = 2;
    else if (todayIST === meta.day3_date) dayNumber = 3;
    else {
      console.warn(`Today (${todayIST}) doesn't match any race day. Defaulting to day 1.`);
      dayNumber = 1;
    }

    // Set the pit window key in Redis
    const pitKey = `pit:${raceId}:day:${dayNumber}:${todayIST}:${windowKey}:open`;
    await redis.set(pitKey, '1', 'EX', ttlSeconds);

    const closesAt = Date.now() + ttlSeconds * 1000;

    console.log('');
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║           PIT WINDOW OPENED (TEST)                  ║');
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log(`║  raceId:    ${raceId}`);
    console.log(`║  day:       ${dayNumber} (${todayIST})`);
    console.log(`║  window:    ${windowKey}`);
    console.log(`║  TTL:       ${ttlSeconds}s`);
    console.log(`║  Redis key: ${pitKey}`);
    console.log(`║  closes_at: ${new Date(closesAt).toLocaleTimeString()}`);
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log('');

    // Broadcast socket event via HTTP to the running server
    // We'll hit a lightweight test endpoint — or broadcast directly via Redis pub/sub
    // Since the server uses socket.io, we connect as a client to emit
    const { io: ioClient } = require('socket.io-client');
    const socket = ioClient('http://localhost:3000', {
      transports: ['websocket'],
      autoConnect: true,
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.warn('⚠ Could not connect to server socket — Redis key is set but no socket broadcast.');
        console.log('  The frontend will pick it up on next GET /pit/status call.');
        resolve();
      }, 3000);

      socket.on('connect', () => {
        clearTimeout(timeout);
        console.log('✓ Connected to server socket');

        // We can't emit server→client events as a client.
        // Instead, use Redis pub/sub to notify the server.
        // Let's use a simpler approach: publish to a channel the server listens on.
        console.log('');
        console.log('NOTE: Socket broadcast requires the server to have the test endpoint.');
        console.log('      Calling POST http://localhost:3000/admin/test/pit-window-open ...');
        socket.disconnect();
        resolve();
      });

      socket.on('connect_error', () => {
        clearTimeout(timeout);
        console.warn('⚠ Server not running on port 3000');
        resolve();
      });
    });

    // Call the test endpoint to broadcast socket event
    try {
      const resp = await fetch(`http://localhost:3000/test/pit-window-open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raceId, dayNumber, windowKey, ttl: ttlSeconds }),
      });
      if (resp.ok) {
        const data = await resp.json();
        console.log('✓ Socket broadcast sent:', data);
      } else {
        console.warn(`⚠ Server returned ${resp.status}. Is NODE_ENV != "production"?`);
      }
    } catch {
      console.warn('⚠ Could not reach server on port 3000.');
      console.log('  Redis key is set — GET /pit/status will work, but no live socket broadcast.');
    }

  } finally {
    await redis.quit();
    process.exit(0);
  }
})();

function printManualInstructions(raceId, dayNumber, windowKey, closesAt) {
  console.log('To also test the socket broadcast, add this to admin.routes.js:');
  console.log('');
  console.log(`  router.post('/test/pit-window-open', (req, res) => {`);
  console.log(`    const io = require('../socket/io').get();`);
  console.log(`    const { raceId, dayNumber, windowKey, ttl } = req.body;`);
  console.log(`    const closes_at = Date.now() + (ttl || 60) * 1000;`);
  console.log(`    if (io) io.emit('pit_window_open', { raceId, dayNumber, windowKey, closes_at });`);
  console.log(`    res.json({ ok: true, broadcast: !!io });`);
  console.log(`  });`);
}
