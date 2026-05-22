'use strict';

/**
 * services/reward.service.js
 *
 * Handles reward status checks, daily/streak claims, and distribution
 * to active contributing members of winning families.
 *
 * Endpoints served:
 *   GET  /reward/status       → getRewardStatus
 *   POST /reward/claim-daily  → claimDailyReward
 *   POST /reward/claim-streak → claimStreakReward
 */

const moment          = require('moment-timezone');
const keys            = require('../utils/keys');
const { redisClient } = require('../config/redis');
const db              = require('../config/mysql');

// ─── Get Reward Status ─────────────────────────────────────────────────────

/**
 * Returns per-day win/claim status, streak eligibility, and reward item details.
 * Claim status is per-member — each member sees their own claimed state.
 */
async function getRewardStatus(raceId, familyId, memberId) {
  // 1. Which days did this family win (rank 1)?
  const results = await db.query(
    `SELECT day_number, group_number
       FROM family_car_race_result
      WHERE race_id = ? AND family_id = ? AND rank_position = 1
      ORDER BY day_number ASC`,
    [raceId, String(familyId)]
  );

  const winsMap = {};
  for (const r of results) {
    winsMap[r.day_number] = { groupNumber: r.group_number };
  }

  // 2. Which claim_types has THIS member already claimed?
  const claims = await db.query(
    `SELECT claim_type
       FROM family_car_race_reward_claim
      WHERE race_id = ? AND family_id = ? AND claimed_by = ?`,
    [raceId, familyId, memberId]
  );

  const claimedSet = new Set();
  for (const c of claims) {
    claimedSet.add(c.claim_type);
  }

  // 3. Build day status
  const days = [1, 2, 3].map(d => ({
    dayNumber: d,
    won: !!winsMap[d],
    claimed: claimedSet.has(`day${d}`),
    groupNumber: winsMap[d]?.groupNumber || null,
  }));

  const wonAll3 = !!(winsMap[1] && winsMap[2] && winsMap[3]);

  // 4. Fetch reward details per claim_type with item info from frames/entry_effect/livegift
  const rewardQuery = `
    SELECT r.claim_type, r.reward_type, r.type_id, r.count, r.expiry_days,
       f.title AS frame_title, f.image AS frame_image, f.isAnimated AS frame_animated, f.thumbnail AS frame_thumbnail,
       e.title AS effect_title, e.thumbnail AS effect_thumbnail, e.videoPath AS effect_video,
       lg.title AS gift_title, lg.image AS gift_image, lg.coins AS gift_coins, lg.videoPath AS gift_video,
       prlg.title AS pr_title, prlg.image AS pr_image, prlg.videoPath AS pr_video
    FROM family_car_race_reward r
    LEFT JOIN frames f ON r.reward_type = 'frame' AND f.id = r.type_id
    LEFT JOIN entry_effect e ON r.reward_type = 'entry_effect' AND e.id = r.type_id
    LEFT JOIN livegift lg ON r.reward_type = 'baggage' AND lg.id = r.type_id
    LEFT JOIN livegift prlg ON r.reward_type = 'partyroom_exp' AND prlg.id = r.type_id
  ORDER BY r.id ASC`;

  const allRewards = await db.query(rewardQuery);

  // Group rewards by claim_type
  const rewardsByDay = { day1: [], day2: [], day3: [], streak: [] };
  for (const r of allRewards) {
    if (rewardsByDay[r.claim_type]) {
      rewardsByDay[r.claim_type].push(r);
    }
  }

  return {
    days,
    streakEligible: wonAll3,
    streakClaimed: claimedSet.has('streak'),
    rewards: {
      day1: formatRewards(rewardsByDay.day1),
      day2: formatRewards(rewardsByDay.day2),
      day3: formatRewards(rewardsByDay.day3),
      streak: formatRewards(rewardsByDay.streak),
    },
  };
}

/**
 * Formats raw DB rows into clean reward objects for frontend display.
 */
function formatRewards(rows) {
  return rows.map(r => {
    const base = {
      rewardType: r.reward_type,
      typeId: r.type_id,
      count: r.count,
      expiryDays: r.expiry_days,
    };

    if (r.reward_type === 'frame') {
      base.title = r.frame_title || '';
      base.image = r.frame_image || '';
      base.thumbnail = r.frame_thumbnail || '';
      base.isAnimated = !!r.frame_animated;
    } else if (r.reward_type === 'entry_effect') {
      base.title = r.effect_title || '';
      base.thumbnail = r.effect_thumbnail || '';
      base.videoPath = r.effect_video || '';
    } else if (r.reward_type === 'baggage') {
      base.title = r.gift_title || 'Gift';
      base.image = r.gift_image || '';
      base.coins = r.gift_coins || 0;
      base.videoPath = r.gift_video || '';
    } else if (r.reward_type === 'partyroom_exp') {
      base.title = r.pr_title || 'Party Room EXP';
      base.image = r.pr_image || '';
      base.videoPath = r.pr_video || '';
      base.value = r.count;
    } else if (r.reward_type === 'family_exp') {
      base.title = 'Family EXP';
      base.value = r.count;
    }

    return base;
  });
}

// ─── Claim Daily Reward ────────────────────────────────────────────────────

/**
 * Claims daily winner reward for the calling member.
 * Only contributing members (in activeMembers set) can claim.
 */
async function claimDailyReward(raceId, familyId, dayNumber, memberId) {
  if (![1, 2, 3].includes(dayNumber)) throw new Error('invalid_day');

  const claimType = `day${dayNumber}`;

  // 1. Verify family won this day
  const winRows = await db.query(
    `SELECT group_number FROM family_car_race_result
      WHERE race_id = ? AND family_id = ? AND day_number = ? AND rank_position = 1`,
    [raceId, String(familyId), dayNumber]
  );
  if (!winRows.length) throw new Error('not_winner');
  const groupNumber = winRows[0].group_number;

  // 2. Ensure the claimer actually contributed (check BEFORE already_claimed)
  const activeMembers = await redisClient.smembers(
    keys.activeMembers(raceId, dayNumber, groupNumber, familyId)
  );
  if (!activeMembers.includes(String(memberId))) throw new Error('not_contributed');

  // 3. Check this member hasn't already claimed
  const existing = await db.query(
    `SELECT id FROM family_car_race_reward_claim
      WHERE race_id = ? AND family_id = ? AND claim_type = ? AND claimed_by = ?`,
    [raceId, familyId, claimType, memberId]
  );
  if (existing.length) throw new Error('already_claimed');

  // 4. Get reward config for this specific day
  const rewards = await db.query(
    `SELECT reward_type, type_id, count, expiry_days
       FROM family_car_race_reward WHERE claim_type = ?`,
    [claimType]
  );

  // 5. Distribute rewards to THIS member only
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    for (const reward of rewards) {
      if (reward.reward_type === 'family_exp') continue;
      await distributeReward(connection, memberId, reward.reward_type, reward.type_id, reward.count, reward.expiry_days);
    }

    // Record the claim for this member
    const now = moment().tz('Asia/Kolkata').format('YYYY-MM-DD HH:mm:ss');
    await connection.query(
      `INSERT INTO family_car_race_reward_claim
        (race_id, family_id, claim_type, claimed_by, claimed_at)
       VALUES (?, ?, ?, ?, ?)`,
      [raceId, familyId, claimType, memberId, now]
    );

    await connection.commit();
    return { success: true, membersRewarded: 1 };
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

// ─── Claim Streak Reward ───────────────────────────────────────────────────

/**
 * Claims 3-day consecutive win bonus for the calling member.
 * Only available if family won all 3 race days and member contributed in at least one.
 */
async function claimStreakReward(raceId, familyId, memberId) {
  // 1. Verify family won all 3 days
  const winRows = await db.query(
    `SELECT day_number, group_number FROM family_car_race_result
      WHERE race_id = ? AND family_id = ? AND rank_position = 1 ORDER BY day_number`,
    [raceId, String(familyId)]
  );
  if (winRows.length < 3) throw new Error('not_eligible');

  // 2. Ensure the claimer contributed in at least one day (check BEFORE already_claimed)
  const allMembers = new Set();
  for (const row of winRows) {
    const members = await redisClient.smembers(
      keys.activeMembers(raceId, row.day_number, row.group_number, familyId)
    );
    for (const m of members) allMembers.add(m);
  }
  if (!allMembers.has(String(memberId))) throw new Error('not_contributed');

  // 3. Check this member hasn't already claimed streak
  const existing = await db.query(
    `SELECT id FROM family_car_race_reward_claim
      WHERE race_id = ? AND family_id = ? AND claim_type = 'streak' AND claimed_by = ?`,
    [raceId, familyId, memberId]
  );
  if (existing.length) throw new Error('already_claimed');

  // 4. Get streak reward config
  const rewards = await db.query(
    `SELECT reward_type, type_id, count, expiry_days
       FROM family_car_race_reward WHERE claim_type = 'streak'`
  );

  // 5. Distribute to THIS member only
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    for (const reward of rewards) {
      if (reward.reward_type === 'family_exp') continue;
      await distributeReward(connection, memberId, reward.reward_type, reward.type_id, reward.count, reward.expiry_days);
    }

    // Record claim for this member
    const now = moment().tz('Asia/Kolkata').format('YYYY-MM-DD HH:mm:ss');
    await connection.query(
      `INSERT INTO family_car_race_reward_claim
        (race_id, family_id, claim_type, claimed_by, claimed_at)
       VALUES (?, ?, 'streak', ?, ?)`,
      [raceId, familyId, memberId, now]
    );

    await connection.commit();
    return { success: true, membersRewarded: 1 };
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

// ─── Distribute Reward to Individual User ──────────────────────────────────

/**
 * Inserts reward into user_tool (frame/entry_effect) or user_baggage (baggage/partyroom_exp).
 * Follows the same pattern as distributeHoliReward in the main platform.
 */
async function distributeReward(connection, userId, rewardType, typeId, count, expiryDays) {
  const now = moment().tz('Asia/Kolkata').format('YYYY-MM-DD HH:mm:ss');
  const expiry = moment().tz('Asia/Kolkata').add(expiryDays, 'days').format('YYYY-MM-DD HH:mm:ss');

  if (rewardType === 'frame') {
    // If user has an active VIP item, new frame stays inactive
    const [vipActive] = await connection.query(
      `SELECT id FROM user_tool WHERE userId = ? AND vipStatus = 1 AND expiredAt > NOW() LIMIT 1`,
      [userId]
    );
    let isActive = vipActive.length ? 0 : 1;

    if (isActive === 1) {
      // Deactivate existing non-VIP frames so only one is active
      await connection.query(
        `UPDATE user_tool SET isActive = 0 WHERE userId = ? AND entityType = 'frame'`,
        [userId]
      );
    }

    await connection.query(
      `INSERT INTO user_tool (userId, entityId, entityType, createdAt, expiredAt, isActive, givenBy, vipStatus)
       VALUES (?, ?, 'frame', ?, ?, ?, NULL, 0)`,
      [userId, typeId, now, expiry, isActive]
    );

    // Clear user cache so new frame shows immediately
    await redisClient.del(`user:${userId}`);

  } else if (rewardType === 'entry_effect') {
    const [vipActive] = await connection.query(
      `SELECT id FROM user_tool WHERE userId = ? AND vipStatus = 1 AND expiredAt > NOW() LIMIT 1`,
      [userId]
    );
    let isActive = vipActive.length ? 0 : 1;

    if (isActive === 1) {
      await connection.query(
        `UPDATE user_tool SET isActive = 0 WHERE userId = ? AND entityType = 'entryEffect'`,
        [userId]
      );
    }

    await connection.query(
      `INSERT INTO user_tool (userId, entityId, entityType, createdAt, expiredAt, isActive, givenBy, vipStatus)
       VALUES (?, ?, 'entryEffect', ?, ?, ?, NULL, 0)`,
      [userId, typeId, now, expiry, isActive]
    );

  } else if (rewardType === 'baggage') {
    // Look up gift coin value from livegift table
    const [gift] = await connection.query(`SELECT coins FROM livegift WHERE id = ?`, [typeId]);
    const totalCoins = gift.length ? gift[0].coins * count : 0;

    await connection.query(
      `INSERT INTO user_baggage
        (user_id, baggage_id, total_gift, used_gift, total_coin, gifttype, type, is_used, is_claim, created, expire_date)
       VALUES (?, ?, ?, 0, ?, 'baggage', 'other', 0, 1, ?, ?)`,
      [userId, typeId, count, totalCoins, now, expiry]
    );

  } else if (rewardType === 'partyroom_exp') {
    await connection.query(
      `INSERT INTO user_baggage
        (user_id, baggage_id, total_gift, used_gift, total_coin, gifttype, type, is_used, expValue, created, expire_date)
       VALUES (?, 0, 1, 0, 0, 'partyroomExp', 'other', 0, ?, ?, ?)`,
      [userId, count, now, expiry]
    );
  }
}

// ─── Add Family EXP + Level Check ─────────────────────────────────────────

/**
 * Adds EXP to the family's groups table and checks for level-up.
 * Logic matches the platform's claim-holi-event-received-rewards pattern:
 *   1. UPDATE groups SET familyExp = familyExp + ?
 *   2. Get updated familyExp and current familyLevel
 *   3. Query family_level_details for highest level whose exp_to <= currentExp
 *   4. newLevel = result.level + 1 → if > currentLevel, update familyLevel
 *   5. Clear Redis family cache
 */
async function addFamilyExp(connection, familyId, expAmount) {
  const conn = connection || db;

  // 1. Add exp
  await conn.query(
    `UPDATE \`groups\` SET exp = exp + ? WHERE id = ?`,
    [expAmount, familyId]
  );

  // 2. Get updated values
  const rows = await conn.query(
    `SELECT exp, familyLevel FROM \`groups\` WHERE id = ?`,
    [familyId]
  );
  if (!rows.length) return;

  const currentExp = rows[0].exp;
  const currentLevel = rows[0].familyLevel;

  // 3. Check level threshold from family_level_details
  const levelRows = await conn.query(
    `SELECT level FROM family_level_details WHERE exp_to <= ? ORDER BY level DESC LIMIT 1`,
    [currentExp]
  );

  if (levelRows.length) {
    const newLevel = levelRows[0].level + 1;
    // 4. Level up if exceeded current level (never levels down)
    if (newLevel > currentLevel) {
      await conn.query(
        `UPDATE \`groups\` SET familyLevel = ? WHERE id = ?`,
        [newLevel, familyId]
      );
    }
  }

  // 5. Clear family cache so updated level/exp is visible immediately
  await redisClient.del(`family:${familyId}`);
}

module.exports = { getRewardStatus, claimDailyReward, claimStreakReward, addFamilyExp };
