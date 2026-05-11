# Testing Guide — Phase 1 Setup

This guide covers how to test the rox-family-car-race Phase 1 setup using multiple approaches:
1. **Automated Tests** — Jest test suite
2. **Manual Tests** — CLI commands
3. **Integration Tests** — Postman/Bruno API requests

---

## Quick Start

```bash
cd c:\wamp64\www\rox-family-car-race

# Install dependencies (if not done)
npm install

# Run all automated tests
npm test

# Start development server
npm run dev

# The app should be running on http://localhost:3000
```

---

## 1. Automated Tests (Jest)

### Run All Tests
```bash
npm test
```

**Expected Output:**
```
 PASS  tests/setup.test.js
  Phase 1 — Setup Tests
    1. Environment Variables
      ✓ loads .env without errors
      ✓ config/env.js validates all required keys
      ✓ env object is frozen (immutable)
    2. Redis Connectivity
      ✓ Redis client connects without errors
      ✓ can PING Redis
      ✓ can SET and GET a key
      ✓ keyspace notifications are enabled
    3. MySQL Connectivity
      ✓ MySQL connection pool created
      ✓ can execute a test query
      ✓ pool has correct configuration
    4. Lua Scripts
      ✓ lua.js exports script definitions
      ✓ all required Lua scripts are defined
    5. Game Constants
      ✓ constants/game.js exports all required constants
      ✓ game constants have expected values
    6. Utilities & Helpers
      ✓ keys.js exports all key builders
      ✓ key builders generate correct format
      ✓ helpers.js exports utility functions
      ✓ date helper functions work
    7. Middleware
      ✓ auth middleware is loadable
      ✓ role middleware exports access control functions
      ✓ rateLimit middleware is configured
    8. Express App Factory
      ✓ app.js exports createApp function
      ✓ createApp returns app, server, and io
    9. Routes
      ✓ all route modules are loadable

Tests: 25 passed, 25 total
```

### Run Tests with Coverage
```bash
npm run test:coverage
```

### Watch Mode (Re-run on file changes)
```bash
npm run test:watch
```

---

## 2. Manual Tests — Environment & Connectivity

### Test 2.1: Verify `.env` File
```bash
# Windows PowerShell
cat .env

# or check specific values
(Select-String "DB_DATABASE|REDIS_HOST|JWT_API_KEY" .env).Line
```

**Expected:**
```
DB_DATABASE=family_car_race
REDIS_HOST=localhost
REDIS_PORT=6379
JWT_API_KEY=your_jwt_secret_key_here
BULLMQ_PREFIX=family-car-race
```

---

### Test 2.2: Verify Node.js & npm
```bash
node --version
# Expected: v20.x or higher

npm --version
# Expected: v10.x or higher

npm list express socket.io ioredis mysql2 bullmq
# Should show all packages installed
```

---

### Test 2.3: Test Redis Connection
```bash
# Connect to Redis CLI
redis-cli

# In Redis CLI:
ping
# Expected: PONG

set test:key "hello"
# Expected: OK

get test:key
# Expected: "hello"

del test:key
# Expected: (integer) 1

exit
```

---

### Test 2.4: Test MySQL Connection
```bash
# Windows CMD / PowerShell
mysql -h localhost -u root -proot -e "SELECT 1 as test;"
# Expected: 
# +------+
# | test |
# +------+
# |    1 |
# +------+

# Check if database exists
mysql -h localhost -u root -proot -e "SHOW DATABASES LIKE 'family_car_race';"
# Expected: family_car_race (if created, or empty if not yet created)
```

---

## 3. Manual Tests — Application Startup

### Test 3.1: Start Development Server
```bash
npm run dev
```

**Expected console output:**
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

**Keep this terminal open for the next tests.**

---

## 4. Integration Tests — API Endpoints

### Test 4.1: Health Check (No Auth Required)

**Terminal 2:**
```bash
# Simple HTTP GET to check server is running
curl http://localhost:3000/

# Expected response:
# 404 or similar (endpoint not yet implemented, but server responds)
```

### Test 4.2: Test Auth Endpoint (POST /auth/login)

**Using PowerShell:**
```powershell
$body = @{
    memberId = "member_001"
    password = "test123"
} | ConvertTo-Json

Invoke-WebRequest -Uri "http://localhost:3000/auth/login" `
  -Method POST `
  -Headers @{"Content-Type"="application/json"} `
  -Body $body

# Expected: 
# 200 OK with JWT token in response
```

**Or using curl (CMD):**
```bash
curl -X POST http://localhost:3000/auth/login ^
  -H "Content-Type: application/json" ^
  -d "{\"memberId\":\"member_001\",\"password\":\"test123\"}"

# Expected response (similar to):
# {
#   "success":true,
#   "token":"eyJhbGciOiJIUzI1NiIs...",
#   "member":{
#     "memberId":"member_001",
#     "familyId":"family_123",
#     "role":"participant"
#   }
# }
```

---

### Test 4.3: Test Redis Operations via CLI

**In a new terminal:**
```bash
redis-cli

# Test SET/GET
SET test:phase1 "hello"
GET test:phase1
# Expected: "hello"

# Test EXPIRE (keyspace notification test)
SET expiry:test "value" EX 2
GET expiry:test
# Wait 3 seconds...
GET expiry:test
# Expected: nil (expired)

# Check Redis memory
INFO memory
# Shows Redis memory usage

exit
```

---

## 5. Integration Tests — Using Postman/Bruno

### Test 5.1: Create a Postman Collection

**Step 1: Import Environment Variables**

Create a Postman environment:
```json
{
  "name": "rox-family-car-race",
  "values": [
    {
      "key": "base_url",
      "value": "http://localhost:3000",
      "enabled": true
    },
    {
      "key": "jwt_token",
      "value": "",
      "enabled": true
    }
  ]
}
```

**Step 2: Create Requests**

**Request 1: Login (POST)**
```
URL: {{base_url}}/auth/login
Method: POST
Headers:
  Content-Type: application/json
Body (JSON):
{
  "memberId": "member_001",
  "password": "test123"
}
```

**In Postman Tests tab (save JWT):**
```javascript
if (pm.response.code === 200) {
  var data = pm.response.json();
  pm.environment.set("jwt_token", data.token);
}
```

---

**Request 2: Get Admin Game (GET)**
```
URL: {{base_url}}/admin/game/abc-123
Method: GET
Headers:
  Authorization: Bearer {{jwt_token}}
```

---

**Request 3: Create Game (POST)**
```
URL: {{base_url}}/admin/game/create
Method: POST
Headers:
  Content-Type: application/json
  Authorization: Bearer {{jwt_token}}
Body (JSON):
{
  "race_week_start": "2026-04-27",
  "race_start_day": "2026-05-01",
  "race_end_day": "2026-05-03",
  "race_start_time": "18:00:00"
}
```

**Expected response:**
```json
{
  "success": true,
  "message": "Game created successfully",
  "raceId": "uuid-string",
  "race_week_start": "2026-04-27",
  "day1_date": "2026-05-01",
  "day2_date": "2026-05-02",
  "day3_date": "2026-05-03"
}
```

---

## 6. Integration Tests — Socket.IO

### Test 6.1: Test Socket.IO Connection

**Terminal 3 — Create test file `test-socket.js`:**

```javascript
const io = require('socket.io-client');

const socket = io('http://localhost:3000', {
  transports: ['websocket', 'polling'],
  reconnection: true
});

socket.on('connect', () => {
  console.log('✓ Socket.IO connected, ID:', socket.id);
  
  // Test join_room event
  socket.emit('join_room', {
    raceId: 'test-race-123',
    dayNumber: 1,
    groupNumber: 1,
    memberId: 'member_001',
    token: 'fake-token-for-testing'
  });
});

socket.on('error', (err) => {
  console.error('✗ Socket error:', err);
});

socket.on('join_success', (data) => {
  console.log('✓ Join room successful:', data);
  socket.disconnect();
});

socket.on('connect_error', (err) => {
  console.error('✗ Connection error:', err);
  process.exit(1);
});

setTimeout(() => {
  console.error('✗ Socket test timeout');
  process.exit(1);
}, 5000);
```

**Run it:**
```bash
node test-socket.js
```

**Expected output:**
```
✓ Socket.IO connected, ID: abc123xyz
✓ Join room successful: { roomName: 'test-race-123:d1:g1', message: 'Joined race room' }
```

---

## 7. Debugging Tests

### Enable Verbose Logging

**Create `.env.test`:**
```
DEBUG=*
LOG_LEVEL=debug
```

**Or use Node.js debug:**
```bash
DEBUG=* npm run dev
```

---

### Check Redis Connections

**In Redis CLI:**
```bash
redis-cli

# See all connected clients
CLIENT LIST

# See subscriptions
PUBSUB CHANNELS

# See pattern subscriptions
PUBSUB NUMPAT

exit
```

---

### Check MySQL Connection Pool

**In running app (add log):**

The pool logs to console every 5 seconds if there are warnings:
```
[DB POOL WARNING] total=5, free=3, queued=0
```

This means 5 total connections, 3 free, 0 waiting. Normal.

---

## 8. Troubleshooting

### Issue: Port 3000 Already in Use
```bash
# Kill the process using port 3000
netstat -ano | findstr :3000
taskkill /PID <PID> /F
```

---

### Issue: Redis Connection Refused
```bash
# Check if Redis is running
redis-cli ping
# If error: "Connection refused"
# Start Redis first (if using WSL):
# wsl redis-server
```

---

### Issue: MySQL Connection Failed
```bash
# Check MySQL is running
mysql -u root -proot -e "SELECT 1;"

# If fails, start MySQL:
# (Windows) net start MySQL80
# (WSL) wsl sudo service mysql start
```

---

### Issue: .env Validation Failed
```bash
# Check .env file has all required keys
cat .env | findstr "PORT DB_HOST REDIS_HOST JWT_API_KEY BULLMQ_PREFIX"

# If missing, copy from .env.example and fill in
copy .env.example .env
```

---

## 9. Final Checklist

- [ ] npm install completes without errors
- [ ] npm test passes all 25+ tests
- [ ] npm run dev starts without errors
- [ ] Redis PING responds with PONG
- [ ] MySQL SELECT 1 works
- [ ] POST /auth/login returns JWT token
- [ ] Socket.IO connects successfully
- [ ] Console shows no error messages during startup

---

## 10. Next Steps (Phase 2)

Once Phase 1 tests pass, you're ready for Phase 2:
- [ ] Implement service layer (race.service, fuel.service, etc.)
- [ ] Implement workers (distanceTick, fuelWindow, etc.)
- [ ] Create MySQL schema (game_schedule, race_results tables)
- [ ] Implement route handlers
- [ ] Add unit tests for services
- [ ] Add integration tests for race flow

---

**Status: Phase 1 Ready ✓**
