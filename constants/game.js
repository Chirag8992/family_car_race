'use strict';

/**
 * src/constants/game.js
 *
 * Single source of truth for all game rule constants.
 * Every service, worker, and Lua script uses values derived from here.
 * Change a constant here — it propagates everywhere automatically.
 *
 * Never hardcode these numbers anywhere else in the codebase.
 */

module.exports = Object.freeze({

  // ─── Race Timing ─────────────────────────────────────────────────────────

  /** Total race duration in milliseconds (60 minutes). */
  RACE_DURATION_MS: 60 * 60 * 1000,

  /** Distance-tick interval: how often car positions are updated. */
  TICK_INTERVAL_MS: 1000,

  /** Minute mark at which fuel window 1 opens (T=14:00). */
  FUEL_WINDOW_1_MINUTE: 14,

  /** Minute mark at which fuel window 2 opens (T=44:00). */
  FUEL_WINDOW_2_MINUTE: 44,

  /** How long each fuel window stays open in seconds. */
  FUEL_WINDOW_DURATION_SEC: 59,

  // ─── Speed ───────────────────────────────────────────────────────────────

  /** Starting speed for a family with no pit boosts (km/hr). */
  BASE_SPEED_DEFAULT: 100,

  /** Speed bonus per pit stop claim unit (km/hr). */
  PIT_BOOST_PER_UNIT: 10,

  /** Speed reduction per egg hit (km/hr). */
  EGG_SPEED_PENALTY: 5,

  /** Speed recovery per wiper use (km/hr). */
  WIPER_SPEED_RECOVERY: 5,

  /** Speed bonus per fuel submission during an open window (km/hr). */
  FUEL_SPEED_BONUS: 5,

  /** Minimum possible speed — car can't go negative. */
  SPEED_MIN: 0,

  // ─── Crystal / Inventory ─────────────────────────────────────────────────

  /** Cooldown in seconds before a member can collect another crystal. */
  CRYSTAL_COOLDOWN_SEC: 30,

  /** Crystals earned per successful collect tap. */
  CRYSTAL_PER_COLLECT: 1,

  /** Crystals required to convert into one egg. */
  CRYSTAL_PER_EGG: 1,

  /** Crystals required to convert into one wiper. */
  CRYSTAL_PER_WIPER: 1,

  // ─── Groups & Families ───────────────────────────────────────────────────

  /** Total families selected per game week (top N by silver coins). */
  TOTAL_FAMILIES_PER_GAME: 9,

  /** Number of competing groups per race day. */
  GROUPS_PER_DAY: 3,

  /** Number of families per group (one race room). */
  FAMILIES_PER_GROUP: 3,

  /** Number of race days per game week. */
  RACE_DAYS: 3,

  // ─── Pit Stops ───────────────────────────────────────────────────────────

  /** How long each pit stop window stays open in seconds (1 hour). */
  PIT_WINDOW_DURATION_SEC: 3600,

  /** Pit window keys — match cron times exactly. */
  PIT_WINDOWS: Object.freeze(['morning', 'afternoon', 'evening']),

  /** Cron hours for pit windows (8AM, 2PM, 7PM). */
  PIT_WINDOW_HOURS: Object.freeze([8, 14, 19]),

  // ─── Game Day Offsets ─────────────────────────────────────────────────────

  /** Days from race_start_day to grouping day (always the day before). */
  GROUPING_OFFSET_DAYS: -1,

  /** Days from race_week_start to race_start_day (Day 1). Always 4. */
  DAY1_OFFSET_DAYS: 4,

  /** Days from race_start_day to Day 2. */
  DAY2_OFFSET_DAYS: 1,

  /** Days from race_start_day to Day 3 (race_end_day). */
  DAY3_OFFSET_DAYS: 2,

  // ─── Game Statuses ───────────────────────────────────────────────────────

  GAME_STATUS: Object.freeze({
    SCHEDULED:    'scheduled',
    DAY1_PENDING: 'day1_pending',
    DAY1_DONE:    'day1_done',
    DAY2_PENDING: 'day2_pending',
    DAY2_DONE:    'day2_done',
    DAY3_PENDING: 'day3_pending',
    DAY3_DONE:    'day3_done',
    COMPLETED:    'completed',
  }),

  // ─── Race Statuses ───────────────────────────────────────────────────────

  RACE_STATUS: Object.freeze({
    RUNNING:  'running',
    FINISHED: 'finished',
  }),

  // ─── Fuel Statuses (family car state) ────────────────────────────────────

  FUEL_STATUS: Object.freeze({
    OK:          'ok',
    WINDOW_OPEN: 'window_open',
    STOPPED:     'stopped',
  }),

  // ─── Roles ───────────────────────────────────────────────────────────────

  ROLES: Object.freeze({
    ADMIN:           'admin',
    PARTICIPANT:     'participant',
    NON_PARTICIPANT: 'non_participant',
  }),

  // ─── Item types ──────────────────────────────────────────────────────────

  ITEM_TYPES: Object.freeze({
    EGGS:   'eggs',
    WIPERS: 'wipers',
  }),

  // ─── Socket Events ───────────────────────────────────────────────────────

  SOCKET_EVENTS: Object.freeze({
    // Server → Client
    RACE_STARTED:       'race_started',
    RACE_STATE_UPDATE:  'race:state_update',
    FUEL_WINDOW_OPEN:   'fuel_window_open',
    FUEL_WINDOW_CLOSE:  'fuel_window_close',
    FUEL_SUBMITTED:     'fuel_submitted',
    CAR_STOPPED:        'car_stopped',
    CAR_RESUMED:        'car_resumed',
    EGG_HIT:            'egg_hit',
    WIPER_USED:         'wiper_used',
    CRYSTAL_READY:      'crystal_ready',
    CRYSTAL_EARNED:     'crystal_earned',
    RACE_FINISHED:      'race_finished',
    PIT_WINDOW_OPEN:    'pit_window_open',

    // Client → Server
    JOIN_ROOM:          'join_room',
    LEAVE_ROOM:         'leave_room',
  }),

  // ─── BullMQ Job Names ────────────────────────────────────────────────────

  JOB_NAMES: Object.freeze({
    DISTANCE_TICK:       'distance-tick',
    FUEL_WINDOW_OPEN_1:  'fuel-window-open-1',
    FUEL_WINDOW_CHECK_1: 'fuel-window-check-1',
    FUEL_WINDOW_OPEN_2:  'fuel-window-open-2',
    FUEL_WINDOW_CHECK_2: 'fuel-window-check-2',
    RACE_END:            'race-end',
    PIT_WINDOW_OPEN:     'pit-window-open',
    THURSDAY_GROUPING:   'thursday-grouping',
  }),

  // ─── BullMQ Queue Names ──────────────────────────────────────────────────

  QUEUE_NAMES: Object.freeze({
    RACE:      'race-queue',       // distance-tick jobs only
    RACE_FUEL: 'race-fuel-queue',  // fuel-window-open/check jobs
    RACE_END:  'race-end-queue',   // race-end jobs
    PIT:       'pit-queue',
    GROUPING:  'grouping-queue',
  }),

  // ─── Grouped aliases (used by tests & services) ──────────────────────────

  STATUS: Object.freeze({
    SCHEDULED:    'scheduled',
    DAY1_PENDING: 'day1_pending',
    DAY1_DONE:    'day1_done',
    DAY2_PENDING: 'day2_pending',
    DAY2_DONE:    'day2_done',
    DAY3_PENDING: 'day3_pending',
    DAY3_DONE:    'day3_done',
    COMPLETED:    'completed',
    RUNNING:      'running',
    FINISHED:     'finished',
  }),

  SPEED: Object.freeze({
    BASE_SPEED_DEFAULT:    100,
    PIT_BOOST_PER_UNIT:    10,
    EGG_SPEED_PENALTY:     5,
    WIPER_SPEED_RECOVERY:  5,
    FUEL_SPEED_BONUS:      5,
    SPEED_MIN:             0,
  }),

  ROLE: Object.freeze({
    ADMIN:           'admin',
    PARTICIPANT:     'participant',
    NON_PARTICIPANT: 'non_participant',
  }),

  ERROR: Object.freeze({
    COOLDOWN_ACTIVE:       'cooldown_active',
    NOT_READY:             'not_ready',
    INVALID_ITEM:          'invalid_item',
    INSUFFICIENT_CRYSTALS: 'insufficient_crystals',
    NO_EGGS:               'no_eggs',
    NO_WIPERS:             'no_wipers',
    WINDOW_CLOSED:         'window_closed',
    ALREADY_FUELED:        'already_fueled',
    ALREADY_RESTARTED:     'already_restarted',
    CAR_NOT_STOPPED:       'car_not_stopped',
  }),

  FUEL_WINDOW: Object.freeze({
    FUEL_WINDOW_1_MINUTE:     14,
    FUEL_WINDOW_2_MINUTE:     44,
    FUEL_WINDOW_DURATION_SEC: 59,
  }),

  /** Total race duration in seconds (60 minutes). */
  RACE_DURATION_SECONDS: 3600,

});
