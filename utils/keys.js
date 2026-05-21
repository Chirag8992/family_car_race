'use strict';

/**
 * src/utils/keys.js
 *
 * Single source of truth for all Redis key names.
 * Every service, worker, and Lua script caller imports this.
 * No raw key strings anywhere else in the codebase.
 *
 * Key naming convention:
 *   {namespace}:{raceId}:day:{dayNumber}:group:{groupNumber}:...:{leaf}
 *
 * Namespace prefixes:
 *   game:  — game-level keys (schedule, groups, participants)
 *   race:  — race-level keys (family state, leaderboard, members)
 *   pit:   — pit-stop keys (windows, claims, boosts)
 */

const keys = {

  // ─── GAME LEVEL ──────────────────────────────────────────────────────────

  /**
   * Auto-start TTL trigger key (one per race day).
   * When this key expires → gameStart worker fires for that day.
   */
  gameStartTrigger: (raceId, dayNumber) =>
    `game:${raceId}:day:${dayNumber}:start_trigger`,

  /**
   * Notification trigger key (expires 5 min before game start).
   * When this key expires → send notifications to all participating families.
   */
  gameNotifyTrigger: (raceId, dayNumber) =>
    `game:${raceId}:day:${dayNumber}:notify_trigger`,

  /**
   * Game configuration hash (mirrors family_car_race_schedule MySQL row).
   * Written at game creation. Read by workers instead of MySQL.
   */
  gameMeta: (raceId) =>
    `game:${raceId}:meta`,

  /**
   * Group assignments for one race day.
   * Hash fields: group_1, group_2, group_3 → JSON arrays of familyIds.
   */
  dayGroups: (raceId, dayNumber) =>
    `game:${raceId}:day:${dayNumber}:groups`,

  /**
   * All memberIds of the top 9 families for participant access control.
   * Used by role middleware: SISMEMBER this set → participant or not.
   */
  participants: (raceId) =>
    `game:${raceId}:participants`,

  /**
   * Reverse lookup: memberId → familyId for this race.
   * Hash written alongside the participants set during grouping.
   * Lets route handlers find the correct family even when a user belongs
   * to multiple families in groupsmembers.
   */
  memberFamilyInRace: (raceId) =>
    `game:${raceId}:member_family`,


  // ─── RACE (GROUP) LEVEL ──────────────────────────────────────────────────

  /**
   * Which group numbers are currently racing on a given day.
   * Sorted set member removed when race ends. Empty set = day done.
   */
  activeDayGroups: (raceId, dayNumber) =>
    `race:${raceId}:day:${dayNumber}:active_groups`,

  /**
   * Configuration and status of one group's race.
   * Contains: race_id, day_number, group_number, families JSON, status, started_at.
   */
  raceMeta: (raceId, dayNumber, groupNumber) =>
    `race:${raceId}:day:${dayNumber}:group:${groupNumber}:meta`,

  /**
   * Real-time leaderboard for one group race (Sorted Set).
   * Score = distance_traveled. ZREVRANGE gives rank 1 first.
   */
  leaderboard: (raceId, dayNumber, groupNumber) =>
    `race:${raceId}:day:${dayNumber}:group:${groupNumber}:leaderboard`,

  /**
   * Members currently connected via Socket.IO to this race room.
   * Used at race start to initialize crystal_ready for connected members.
   */
  connectedMembers: (raceId, dayNumber, groupNumber) =>
    `race:${raceId}:day:${dayNumber}:group:${groupNumber}:connected_members`,

  /**
   * Fuel window open flag (TTL = FUEL_WINDOW_DURATION_SEC).
   * EXISTS = window open. Missing (expired) = window closed.
   * windowIndex: 1 or 2.
   */
  fuelWindowOpen: (raceId, dayNumber, groupNumber, windowIndex) =>
    `race:${raceId}:day:${dayNumber}:group:${groupNumber}:fuel_window:${windowIndex}:open`,

  // ─── FAMILY LEVEL ────────────────────────────────────────────────────────

  /**
   * Complete real-time car state for one family in one race.
   * Most frequently read/written key. Updated every tick + every action.
   */
  familyState: (raceId, dayNumber, groupNumber, familyId) =>
    `race:${raceId}:day:${dayNumber}:group:${groupNumber}:family:${familyId}:state`,

  /**
   * Confirms at least one member of this family submitted fuel in window n.
   * Checked at fuel-window-close time. Missing → car stops.
   */
  familyFueled: (raceId, dayNumber, groupNumber, familyId, windowIndex) =>
    `race:${raceId}:day:${dayNumber}:group:${groupNumber}:family:${familyId}:fueled_window_${windowIndex}`,

  /**
   * Flag that the stopped car has been restarted by one member's fuel submit.
   * Prevents more than one member from restarting the same stopped car.
   */
  familyRestartFueled: (raceId, dayNumber, groupNumber, familyId) =>
    `race:${raceId}:day:${dayNumber}:group:${groupNumber}:family:${familyId}:restart_fueled`,

  /**
   * Members who did any activity during this race (gift eligibility).
   * Added on: socket join, crystal collect, convert, egg throw, wiper, fuel, pit claim.
   */
  activeMembers: (raceId, dayNumber, groupNumber, familyId) =>
    `race:${raceId}:day:${dayNumber}:group:${groupNumber}:family:${familyId}:active_members`,


  // ─── MEMBER LEVEL ────────────────────────────────────────────────────────

  /**
   * Item inventory for one member: crystals, eggs, wipers.
   * All mutations are atomic via Lua scripts.
   */
  memberInventory: (raceId, dayNumber, groupNumber, memberId) =>
    `race:${raceId}:day:${dayNumber}:group:${groupNumber}:member:${memberId}:inventory`,

  /**
   * Crystal collect button active flag.
   * EXISTS = member can collect. Missing = button disabled.
   * No TTL on this key — it waits until member taps.
   */
  crystalReady: (raceId, dayNumber, groupNumber, memberId) =>
    `race:${raceId}:day:${dayNumber}:group:${groupNumber}:member:${memberId}:crystal_ready`,

  /**
   * Personal 30-second cooldown after crystal collect.
   * EXISTS = in cooldown. Expiry fires keyspace event → re-set crystal_ready.
   */
  crystalCooldown: (raceId, dayNumber, groupNumber, memberId) =>
    `race:${raceId}:day:${dayNumber}:group:${groupNumber}:member:${memberId}:crystal_cooldown`,

  /**
   * Per-member flag: this member already submitted fuel in window n.
   * Prevents double submit in the same window.
   */
  memberFueledWindow: (raceId, dayNumber, groupNumber, memberId, windowIndex) =>
    `race:${raceId}:day:${dayNumber}:group:${groupNumber}:member:${memberId}:fueled_window_${windowIndex}`,


  // ─── PIT STOP LEVEL ──────────────────────────────────────────────────────

  /**
   * Pit stop window open flag. TTL = PIT_WINDOW_DURATION_SEC (1 hour).
   * Only set on race days — pit cron worker checks before opening.
   * date format: "YYYY-MM-DD". windowKey: "morning" | "afternoon" | "evening".
   */
  pitWindowOpen: (raceId, dayNumber, date, windowKey) =>
    `pit:${raceId}:day:${dayNumber}:${date}:${windowKey}:open`,

  /**
   * Per-member per-window dedup flag.
   * EXISTS = already claimed this window. TTL = 86400s (24h).
   */
  memberPitClaimed: (raceId, dayNumber, date, memberId, windowKey) =>
    `pit:${raceId}:day:${dayNumber}:${date}:member:${memberId}:window:${windowKey}:claimed`,

  /**
   * Family's running total of pit claim units for one race day.
   * Each valid member claim = INCR by 1.
   * At race start: base_speed = 100 + (total_boost * PIT_BOOST_PER_UNIT).
   * TTL = 86400s (24h).
   */
  familyBoost: (raceId, dayNumber, date, familyId) =>
    `pit:${raceId}:day:${dayNumber}:${date}:family:${familyId}:total_boost`,

};

module.exports = keys;
