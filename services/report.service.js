'use strict';

/**
 * services/report.service.js
 *
 * Two reporting endpoints:
 *
 *  1. getPitMemberList  — per-family pit collection summary for a race day.
 *     Returns every member who either collected a pit stop OR visited the race
 *     (i.e. joined the socket room and appears in connected_members).
 *     Sorted descending by total_claims.
 *
 *  2. getFamilyInventory — per-member egg/wiper usage for a group race.
 *     Active members (in activeMembers Redis set) shown first with a green-dot
 *     flag, sorted descending by total_actions.  Inactive members follow,
 *     also sorted descending by total_actions.
 */

const keys         = require('../utils/keys');
const GAME         = require('../constants/game');
const cacheManager = require('../utils/Cache_manager');

// ─── Requirement 1 ────────────────────────────────────────────────────────────

/**
 * Returns the pit-collection list for one family on one race day.
 *
 * Inclusion rules:
 *   - Member has ≥ 1 pit claim  → always included
 *   - Member has 0 claims BUT is in connected_members set → included as visited_only
 *   - Member has 0 claims AND not in connected_members    → excluded
 *
 * Sorting: descending by total_claims (visitors with 0 claims sort last).
 *
 * @param {import('ioredis').Redis} redis
 * @param {object} db           - config/mysql module
 * @param {string} raceId
 * @param {number} dayNumber    - 1 | 2 | 3
 * @param {number} groupNumber  - 1 | 2 | 3
 * @param {string} familyId
 * @param {string} date         - 'YYYY-MM-DD' (today's race date)
 * @returns {Promise<Array>}
 */
async function getPitMemberList(redis, db, raceId, dayNumber, groupNumber, familyId, date) {
  // 1. All members of this family from MySQL
  const members = await db.query(
    `SELECT userId, memberStatus FROM groupsmembers WHERE familyId = ? AND memberStatus = '1'`,
    [familyId]
  );
  if (!members.length) return [];

  const memberIds = members.map(m => String(m.userId));

  // Fetch user info from cache
  const users = Object.values(await cacheManager.getMultipleOrCache('user', memberIds));

  // const memberIds = members.map(m => String(m.userId));

  // 2. Who has visited (joined socket room) — connected_members is a Set
  const connectedKey = keys.connectedMembers(raceId, dayNumber, groupNumber);
  const connectedSet = new Set(await redis.smembers(connectedKey));

  // 3. Count pit claims per member across all windows (morning/afternoon/evening)
  //    Use a pipeline for efficiency — 3 EXISTS checks per member
  const windows = GAME.PIT_WINDOWS; // ['morning', 'afternoon', 'evening']
  const pipeline = redis.pipeline();
  for (const memberId of memberIds) {
    for (const win of windows) {
      pipeline.exists(keys.memberPitClaimed(raceId, dayNumber, date, memberId, win));
    }
  }
  const results = await pipeline.exec();

  // 4. Map results back — results come in the same order as commands
  const claimMap = {}; // memberId → total_claims
  memberIds.forEach((memberId, i) => {
    let total = 0;
    for (let w = 0; w < windows.length; w++) {
      const [err, val] = results[i * windows.length + w];
      if (!err) total += val; // EXISTS returns 1 or 0
    }
    claimMap[memberId] = total;
  });

  // 5. Build response — include only members with claims OR who visited
  const memberInfoMap = {};
  for (const u of users) {
    if (u) {
      memberInfoMap[String(u.user_id)] = {
        name:  u.username || '',
        image: u.image || '',
      };
    }
  }

  const list = [];
  for (const memberId of memberIds) {
    const total_claims = claimMap[memberId];
    const visited      = connectedSet.has(memberId);

    if (total_claims === 0 && !visited) continue; // excluded

    const info = memberInfoMap[memberId] || {};
    list.push({
      member_id:    memberId,
      name:         info.name || '',
      image:        info.image || '',
      total_claims,
      visited_only: total_claims === 0 && visited,
    });
  }

  // 6. Sort descending by total_claims
  list.sort((a, b) => b.total_claims - a.total_claims);

  return list;
}

// ─── Requirement 2 ────────────────────────────────────────────────────────────

/**
 * Returns per-member inventory usage (eggs thrown, wipers used) for all
 * members of a family in one group race.
 *
 * Active members (present in activeMembers Redis set) are returned first,
 * sorted descending by total_actions (eggs_used + wipers_used).
 * Inactive members follow, also sorted descending by total_actions.
 *
 * Each entry carries an `is_active` boolean (true = green dot in UI).
 *
 * @param {import('ioredis').Redis} redis
 * @param {object} db
 * @param {string} raceId
 * @param {number} dayNumber
 * @param {number} groupNumber
 * @param {string} familyId
 * @returns {Promise<Array>}
 */
async function getFamilyInventory(redis, db, raceId, dayNumber, groupNumber, familyId) {
  // 1. All members of this family
  const members = await db.query(
    `SELECT userId, memberStatus FROM groupsmembers WHERE familyId = ? AND memberStatus = '1'`,
    [familyId]
  );
  if (!members.length) return [];

  const memberIds = members.map(m => String(m.userId));

  // Build name/image lookup from cache
  const users = Object.values(await cacheManager.getMultipleOrCache('user', memberIds));
  const memberInfoMap = {};
  for (const u of users) {
    if (u) memberInfoMap[String(u.user_id)] = { name: u.username || '', image: u.image || '' };
  }

  // 2. Who is currently connected to the socket room (live online status)
  const connectedKey = keys.connectedMembers(raceId, dayNumber, groupNumber);
  const connectedSet = new Set(await redis.smembers(connectedKey));

  // Also check activeMembers for fallback (has done any action this session)
  // const activeMembersKey = keys.activeMembers(raceId, dayNumber, groupNumber, familyId);
  // const activeSet = new Set(await redis.smembers(activeMembersKey));

  // 3. Fetch inventory for all members via pipeline
  const pipeline = redis.pipeline();
  for (const memberId of memberIds) {
    pipeline.hmget(
      keys.memberInventory(raceId, dayNumber, groupNumber, memberId),
      'eggs_used', 'wipers_used'
    );
  }
  const invResults = await pipeline.exec();

  // 4. Build entries
  const active   = [];
  const inactive = [];

  memberIds.forEach((memberId, i) => {
    const [err, fields] = invResults[i];
    const eggs_used   = err ? 0 : parseInt(fields[0] || '0', 10);
    const wipers_used = err ? 0 : parseInt(fields[1] || '0', 10);
    const total_actions = eggs_used + wipers_used;
    const is_active   = connectedSet.has(memberId);
    const info = memberInfoMap[memberId] || {};

    const entry = {
      member_id:    memberId,
      name:         info.name,
      image:        info.image,
      eggs_used,
      wipers_used,
      total_actions,
      is_active,
    };

    if (is_active) {
      active.push(entry);
    } else {
      inactive.push(entry);
    }
  });

  // 5. Sort each group descending by total_actions
  const desc = (a, b) => b.total_actions - a.total_actions;
  active.sort(desc);
  inactive.sort(desc);

  // 6. Active first, then inactive
  return [...active, ...inactive];
}

module.exports = { getPitMemberList, getFamilyInventory };
