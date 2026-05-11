# Quick Test Reference — Phase 1

## One-Line Quick Tests

```bash
# 1. Quick sanity check (all critical components)
node quick-test.js

# 2. Run full test suite
npm test

# 3. Start server and check startup logs
npm run dev

# 4. Test Redis connection
redis-cli ping

# 5. Test MySQL connection
mysql -h localhost -u root -proot -e "SELECT 1;"

# 6. Test API (in separate terminal, with server running)
curl -X POST http://localhost:3000/auth/login ^
  -H "Content-Type: application/json" ^
  -d "{\"memberId\":\"test\",\"password\":\"test\"}"
```

---

## Test Checklist

### Before You Start
- [ ] Redis is running (`redis-cli ping` returns PONG)
- [ ] MySQL is running (can connect with credentials in .env)
- [ ] Node.js v20+ installed (`node --version`)
- [ ] npm packages installed (`npm install`)

### Phase 1 Verification
```bash
# Terminal 1 — Run quick sanity check
node quick-test.js
# Should show: ✓ 25 passed, 0 failed

# Terminal 1 — Run full tests
npm test
# Should show: Tests: 25 passed, 25 total

# Terminal 2 — Start the server
npm run dev
# Should show: [server] Listening on port 3000
```

### API Testing (with server running)
```bash
# Terminal 3 — Test auth endpoint
curl -X POST http://localhost:3000/auth/login ^
  -H "Content-Type: application/json" ^
  -d "{\"memberId\":\"user1\",\"password\":\"pass\"}"

# Expected response: 200 OK with JWT token
```

### Redis Testing
```bash
# Terminal 3 — Test Redis directly
redis-cli
> SET test:phase1 "hello"
OK
> GET test:phase1
"hello"
> DEL test:phase1
(integer) 1
> exit
```

---

## Status Indicators

### ✓ Everything Works
```
[server] Listening on port 3000 (development)
[Redis] connected
[RedisSub] connected
[DB] MySQL connection pool ready
✓ All 25 tests passed
```

### ⚠ Common Issues & Fixes

| Issue | Fix |
|-------|-----|
| Port 3000 already in use | `lsof -i :3000` then `kill -9 <PID>` |
| Redis connection refused | Start Redis: `redis-server` |
| MySQL connection failed | Check credentials in .env, start MySQL |
| Missing .env file | Copy from .env.example: `copy .env.example .env` |
| Tests fail with timeout | Check Redis/MySQL are actually running |

---

## Expected Test Output

### `node quick-test.js`
```
✓ 1.1 .env file exists
✓ 1.2 Environment variables load
✓ 1.3 Required env vars populated
✓ 2.1 Redis config loadable
✓ 2.2 Redis client can PING
✓ 3.1 MySQL config loadable
✓ 3.2 MySQL pool ready
✓ 4.1 Game constants loadable
✓ 4.2 Constants have required values
✓ 5.1 Lua scripts loadable
✓ 5.2 All required Lua scripts present
✓ 6.1 Keys builder loadable
✓ 6.2 Helpers loadable
✓ 7.1 Auth middleware loadable
✓ 7.2 Role middleware loadable
✓ 8.1 App factory loadable
✓ 8.2 App factory creates app, server, io
✓ 9.1 All routes loadable

Results: 18 passed, 0 failed
✓ All sanity checks passed! Phase 1 is ready.
```

### `npm test`
```
PASS  tests/setup.test.js
  Phase 1 — Setup Tests
    1. Environment Variables (3 tests)
    2. Redis Connectivity (4 tests)
    3. MySQL Connectivity (3 tests)
    4. Lua Scripts (2 tests)
    5. Game Constants (2 tests)
    6. Utilities & Helpers (4 tests)
    7. Middleware (3 tests)
    8. Express App Factory (2 tests)
    9. Routes (1 test)

Tests: 25 passed, 25 total
```

### `npm run dev`
```
[nodemon] starting `node server.js`
[config] Environment variables loaded and validated
[Redis] connected
[RedisSub] connected
[Redis] notify-keyspace-events set to Egx$
[Redis] Subscriptions applied successfully
[DB] MySQL connection pool ready
[Lua] All 6 scripts loaded successfully
[server] Starting family-car-race…
[server] Listening on port 3000 (development)
```

---

## Complete Testing Flow

### Step 1: Verify Dependencies (2 min)
```bash
cd c:\wamp64\www\rox-family-car-race
npm install --verbose
```

### Step 2: Quick Sanity Check (1 min)
```bash
node quick-test.js
```

### Step 3: Run Full Tests (2 min)
```bash
npm test
```

### Step 4: Start Server (ongoing)
```bash
npm run dev
```
**Keep this terminal open for the next test**

### Step 5: Test API Endpoint (1 min)
**In a new terminal:**
```bash
curl -X POST http://localhost:3000/auth/login ^
  -H "Content-Type: application/json" ^
  -d "{\"memberId\":\"member_001\",\"password\":\"test123\"}"
```

### Step 6: Verify Redis
**In another new terminal:**
```bash
redis-cli
> PING
PONG
> exit
```

---

## Files Created for Testing

| File | Purpose |
|------|---------|
| `tests/setup.test.js` | Jest test suite (25 tests) |
| `quick-test.js` | Quick sanity check script |
| `TESTING.md` | Complete testing guide |

---

## Time to Complete

| Step | Time |
|------|------|
| Setup (npm install) | 2-3 min |
| Quick test | 1 min |
| Full tests | 2 min |
| Server startup | <5 sec |
| API test | 1 min |
| **Total** | **~10 minutes** |

---

## Next: Phase 2

Once all Phase 1 tests pass:

```bash
# Phase 2 tasks:
- Implement MySQL schema
- Implement services (race, fuel, crystal, etc.)
- Implement workers (distance tick, fuel window, etc.)
- Implement route handlers
- Add more tests for business logic
```

See: **TODO-PHASE2.md** (coming soon)

---

**Ready to test? Start with:**
```bash
node quick-test.js
```
