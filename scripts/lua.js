'use strict';

/**
 * src/scripts/lua.js
 *
 * Loads all Lua scripts into Redis via SCRIPT LOAD at server startup.
 * Returns SHA hashes stored in a frozen object.
 *
 * Usage:
 *   const luaSHA = require('./scripts/lua');
 *   await luaSHA.load(redis);       // call once at startup
 *   await redis.evalsha(luaSHA.crystalCollect, numkeys, ...keys, ...args);
 *
 * Why SCRIPT LOAD instead of EVAL?
 *   EVALSHA sends only the SHA hash on each call instead of the full
 *   script text, reducing network payload. Scripts are cached in Redis
 *   memory. On Redis restart the cache is lost, so we reload on startup.
 */

// ─── Raw Lua script strings ───────────────────────────────────────────────

const SCRIPTS = {

  /**
   * crystalCollect
   * Atomically collects 1 crystal for a member.
   * KEYS[1] = crystal_cooldown, KEYS[2] = crystal_ready, KEYS[3] = inventory hash
   */
  crystalCollect: `
    if redis.call('EXISTS', KEYS[1]) == 1 then
      return redis.error_reply('cooldown_active')
    end
    if redis.call('EXISTS', KEYS[2]) == 0 then
      return redis.error_reply('not_ready')
    end
    redis.call('DEL', KEYS[2])
    redis.call('SET', KEYS[1], '1', 'EX', 30)
    redis.call('HINCRBY', KEYS[3], 'crystals', 1)
    return 'ok'
  `,

  /**
   * convertItem
   * Converts crystals into eggs or wipers (1:1). Fuel no longer purchasable.
   * KEYS[1] = inventory hash
   * ARGV[1] = item field ("eggs" | "wipers"), ARGV[2] = quantity
   */
  convertItem: `
    local item = ARGV[1]
    if item ~= 'eggs' and item ~= 'wipers' then
      return redis.error_reply('invalid_item')
    end
    local crystals = tonumber(redis.call('HGET', KEYS[1], 'crystals'))
    local qty = tonumber(ARGV[2])
    if crystals == nil or crystals < qty then
      return redis.error_reply('insufficient_crystals')
    end
    redis.call('HINCRBY', KEYS[1], 'crystals', -qty)
    redis.call('HINCRBY', KEYS[1], item, qty)
    return 'ok'
  `,

  /**
   * throwEgg
   * Atomically throws 1 egg at a target family.
   * Directly deducts 1 crystal from the thrower — no separate conversion step.
   * KEYS[1] = target family state hash, KEYS[2] = thrower inventory hash
   * Returns: 0 = hit reduced speed, 1 = wasted (target already at 0)
   */
  throwEgg: `
    local crystals = tonumber(redis.call('HGET', KEYS[2], 'crystals'))
    if crystals == nil or crystals < 1 then
      return redis.error_reply('no_crystals')
    end
    local speed = tonumber(redis.call('HGET', KEYS[1], 'current_speed'))
    local wasted = 0
    if speed <= 0 then
      wasted = 1
    else
      local new_speed = math.max(0, speed - 5)
      redis.call('HSET', KEYS[1], 'current_speed', tostring(new_speed))
      redis.call('HINCRBY', KEYS[1], 'egg_penalty', 1)
    end
    redis.call('HINCRBY', KEYS[2], 'crystals', -1)
    return wasted
  `,

  /**
   * useWiper
   * Atomically uses 1 wiper to recover own family speed (+5, capped at max_speed).
   * Directly deducts 1 crystal from the member — no separate conversion step.
   * KEYS[1] = family state hash, KEYS[2] = member inventory hash
   * Returns: new current_speed integer
   */
  useWiper: `
    local crystals = tonumber(redis.call('HGET', KEYS[2], 'crystals'))
    if crystals == nil or crystals < 1 then
      return redis.error_reply('no_crystals')
    end
    local speed     = tonumber(redis.call('HGET', KEYS[1], 'current_speed'))
    local max_speed = tonumber(redis.call('HGET', KEYS[1], 'max_speed'))
    local new_speed = math.min(max_speed, speed + 5)
    redis.call('HSET', KEYS[1], 'current_speed', tostring(new_speed))
    redis.call('HINCRBY', KEYS[2], 'crystals', -1)
    return new_speed
  `,

  /**
   * submitFuelWindow
   * Submits fuel during an open window. Free — no inventory cost.
   * Adds +5 speed; if new speed > max_speed, raises max_speed too.
   * KEYS[1]=family state, KEYS[2]=fuel_window_open flag,
   * KEYS[3]=family fueled flag, KEYS[4]=member fueled flag
   * Returns: { new_speed, new_max_speed } table
   */
  submitFuelWindow: `
    if redis.call('EXISTS', KEYS[2]) == 0 then
      return redis.error_reply('window_closed')
    end
    if redis.call('EXISTS', KEYS[4]) == 1 then
      return redis.error_reply('already_fueled')
    end
    local current_speed = tonumber(redis.call('HGET', KEYS[1], 'current_speed'))
    local max_speed     = tonumber(redis.call('HGET', KEYS[1], 'max_speed'))
    local new_speed     = current_speed + 5
    local new_max_speed = max_speed
    if new_speed > max_speed then
      new_max_speed = new_speed
      redis.call('HSET', KEYS[1], 'max_speed', tostring(new_max_speed))
    end
    redis.call('HSET', KEYS[1], 'current_speed', tostring(new_speed))
    redis.call('HSET', KEYS[1], 'is_running', '1')
    redis.call('HSET', KEYS[1], 'fuel_status', 'ok')
    redis.call('SET', KEYS[3], '1')
    redis.call('SET', KEYS[4], '1')
    return { new_speed, new_max_speed }
  `,

  /**
   * submitFuelRestart
   * Restarts a stopped car. Only one member can restart — first wins.
   * KEYS[1] = family state hash, KEYS[2] = family restart_fueled flag
   * Returns: "ok"
   */
  submitFuelRestart: `
    local is_running = redis.call('HGET', KEYS[1], 'is_running')
    if is_running == '1' then
      return redis.error_reply('car_not_stopped')
    end
    if redis.call('EXISTS', KEYS[2]) == 1 then
      return redis.error_reply('already_restarted')
    end
    redis.call('SET', KEYS[2], '1')
    redis.call('HSET', KEYS[1], 'is_running', '1')
    redis.call('HSET', KEYS[1], 'fuel_status', 'ok')
    return 'ok'
  `,

};

// ─── SHA registry (populated after load()) ───────────────────────────────
const sha = {};

/**
 * Loads all scripts into Redis and populates the sha map.
 * Must be awaited once during server startup before any game action.
 *
 * @param {import('ioredis').Redis} redisClient
 */
async function load(redisClient) {
  for (const [name, script] of Object.entries(SCRIPTS)) {
    try {
      sha[name] = await redisClient.script('load', script);
      console.log(`[lua] Loaded "${name}" → ${sha[name]}`);
    } catch (err) {
      console.error(`[lua] Failed to load script "${name}":`, err.message);
      throw err;
    }
  }
  console.log('[lua] All scripts loaded');
}

/**
 * Returns the SHA hash for a named script.
 * Throws if the script hasn't been loaded yet (caller forgot to await load()).
 *
 * @param {string} name
 * @returns {string} SHA1 hash
 */
function get(name) {
  if (!sha[name]) {
    throw new Error(`[lua] Script "${name}" not loaded. Call luaSHA.load(redis) first.`);
  }
  return sha[name];
}

module.exports = { load, get, sha, SCRIPTS };
