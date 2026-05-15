'use strict';

/**
 * services/group.service.js
 *
 * Group assignment logic:
 *   - Day 1: top 9 families by silver coins split into 3 groups of 3
 *   - Day 2+: winners re-grouped by rank (1st-place together, 2nd-place, 3rd-place)
 *
 * Fix #16: computeDay1Groups now validates exactly 9 families are returned.
 *          Throws loudly if fewer than 9 families have silver coin data.
 * Fix #17: populateParticipantsSet clears the participants set and
 *          memberFamilyInRace hash before re-populating on day re-grouping,
 *          preventing stale entries from accumulating.
 */

const keys = require('../utils/keys');

/**
 * Queries groups_daily_exp for top 9 families by total silverExp
 * accumulated from race_week_start up to and including grouping_date
 * (one day before race_start_day).
 * Group 1 = rank 1-3, Group 2 = rank 4-6, Group 3 = rank 7-9.
 *
 * @param {string} raceId
 * @param {string} raceWeekStart  - start date 'YYYY-MM-DD' (4 days before race start)
 * @param {string} groupingDate   - end date 'YYYY-MM-DD' (1 day before race start)
 * @param {object} db
 * @param {object} redis
 * @returns {{ group_1: string[], group_2: string[], group_3: string[] }}
 */
async function computeDay1Groups(raceId, raceWeekStart, groupingDate, db, redis) {
  const rows = await db.query(
    `SELECT familyId, SUM(silverExp) AS coins
       FROM groups_daily_exp
      WHERE date >= ? AND date <= ?
      GROUP BY familyId
      ORDER BY coins DESC
      LIMIT 9`,
    [raceWeekStart, groupingDate]
  );
  // Fix #16: Fail loudly if there aren't exactly 9 qualifying families.
  if (!rows || rows.length < 9) {
    throw new Error(
      `[group] computeDay1Groups: expected 9 families but got ${rows ? rows.length : 0}. ` +
      `Cannot start race with fewer than 9 families (raceId: ${raceId}).`
    );
  }

  const ids = rows.map(r => r.familyId);
  return {
    group_1: ids.slice(0, 3),
    group_2: ids.slice(3, 6),
    group_3: ids.slice(6, 9),
  };
}

/**
 * Re-groups families after a race day ends.
 * New Group 1 = rank-1 family from each of the 3 groups (best performers together).
 * New Group 2 = rank-2 from each group.
 * New Group 3 = rank-3 from each group.
 *
 * @param {string} raceId
 * @param {number} dayNumber - the day that just completed (1 or 2)
 * @param {object} db
 * @returns {{ group_1: string[], group_2: string[], group_3: string[] }}
 */
async function computeNextDayGroups(raceId, dayNumber, db) {
  const rows = await db.query(
    `SELECT family_id, rank_position, group_number
       FROM family_car_race_result
      WHERE race_id = ? AND day_number = ?
      ORDER BY group_number ASC, rank_position ASC`,
    [raceId, dayNumber]
  );

  const byRank = { 1: [], 2: [], 3: [] };
  for (const row of rows) {
    byRank[row.rank_position].push(row.family_id);
  }

  // Fix #16: Validate each rank bucket has exactly 3 families.
  for (const rank of [1, 2, 3]) {
    if (byRank[rank].length !== 3) {
      throw new Error(
        `[group] computeNextDayGroups: rank ${rank} has ${byRank[rank].length} families (expected 3). ` +
        `raceId: ${raceId}, dayNumber: ${dayNumber}`
      );
    }
  }

  return { group_1: byRank[1], group_2: byRank[2], group_3: byRank[3] };
}

/**
 * Writes group assignment hash to Redis for one race day.
 */
async function writeGroupsToRedis(raceId, dayNumber, groups, redis) {
  await redis.hset(keys.dayGroups(raceId, dayNumber), {
    group_1: JSON.stringify(groups.group_1),
    group_2: JSON.stringify(groups.group_2),
    group_3: JSON.stringify(groups.group_3),
  });
  console.log(`[group] Groups written to Redis: ${raceId} day${dayNumber}`);
}

/**
 * Populates the participants set with all memberIds from the 9 selected families.
 * Queries the `members` table for members by familyId.
 *
 * @param {string}   raceId
 * @param {string[]} familyIds - 9 family IDs
 * @param {object}   db
 * @param {import('ioredis').Redis} redis
 */
async function populateParticipantsSet(raceId, familyIds, db, redis) {
  const participantsKey = keys.participants(raceId);
  const memberFamilyKey = keys.memberFamilyInRace(raceId);

  // Fix #17: Clear stale entries before repopulating.
  //   DEL the set and hash then rebuild fresh from the current familyIds.
  await redis.del(participantsKey);
  await redis.del(memberFamilyKey);

  for (const familyId of familyIds) {
    // Only active members (memberStatus = '1') can participate in race tasks
    const members = await db.query(
      `SELECT userId FROM groupsmembers WHERE familyId = ? AND memberStatus = '1'`,
      [familyId]
    );
    for (const m of members) {
      await redis.sadd(participantsKey, m.userId);
      // Store the reverse lookup so routes can find the correct family
      // even when a user is a member of multiple families.
      await redis.hset(memberFamilyKey, m.userId, familyId);
    }
  }
  console.log(`[group] Participants set populated (fresh): ${raceId} (${familyIds.length} families)`);
}

module.exports = {
  computeDay1Groups,
  computeNextDayGroups,
  writeGroupsToRedis,
  populateParticipantsSet,
};
