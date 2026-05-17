'use strict';

/**
 * src/utils/helpers.js
 *
 * Shared utility functions used across services and workers.
 * Pure functions only — no side effects, no external dependencies
 * (except the Node.js standard library).
 */

const { v4: uuidv4 } = require('uuid');
const moment = require('moment-timezone');

/**
 * Generates a random UUID v4 string.
 * @returns {string}
 */
function generateUUID() {
  return uuidv4();
}

/**
 * Returns today's date as a "YYYY-MM-DD" string in UTC.
 * Workers use this when building pit-stop Redis keys.
 */
function todayUTCString() {
  return moment.utc().format('YYYY-MM-DD');
}

/**
 * Formats any Date (or timestamp ms) as "YYYY-MM-DD" in UTC.
 * @param {Date|number} date
 * @returns {string}
 */
function toDateString(date) {
  return moment(date).format('YYYY-MM-DD');
}

/**
 * Adds `days` calendar days to a date and returns "YYYY-MM-DD" string.
 * @param {string} dateStr  — "YYYY-MM-DD" base date
 * @param {number} days     — integer days to add (can be negative)
 * @returns {string}        — "YYYY-MM-DD"
 */
function addDays(dateStr, days) {
  // Handle MySQL Date objects: raw value is IST, just format directly
  if (dateStr instanceof Date) {
    dateStr = moment(dateStr).format('YYYY-MM-DD');
  }
  return moment(dateStr).add(days, 'days').format('YYYY-MM-DD');
}

/**
 * Computes the number of seconds from NOW until a target datetime.
 * Used to calculate TTL for game start trigger keys.
 *
 * @param {string} dateStr  — "YYYY-MM-DD"
 * @param {string} timeStr  — "HH:MM:SS"
 * @returns {number}        — seconds (always >= 0; returns 0 if already past)
 */
function secondsUntil(dateStr, timeStr) {
  // race_start_time is entered in IST (Asia/Kolkata)
  const target = moment.tz(`${dateStr} ${timeStr}`, 'YYYY-MM-DD HH:mm:ss', 'Asia/Kolkata');
  const delta  = Math.floor((target.valueOf() - Date.now()) / 1000);
  return Math.max(0, delta);
}

/**
 * Parses a raceId and dayNumber out of a game start trigger key.
 * Key format: game:{raceId}:day:{dayNumber}:start_trigger
 *
 * @param {string} key
 * @returns {{ raceId: string, dayNumber: number }|null}
 */
function parseStartTriggerKey(key) {
  // game:{raceId}:day:{dayNumber}:start_trigger
  const match = key.match(/^game:(.+):day:(\d+):start_trigger$/);
  if (!match) return null;
  return { raceId: match[1], dayNumber: parseInt(match[2], 10) };
}

/**
 * Parses all parts out of a crystal cooldown key.
 * Key format:
 *   race:{raceId}:day:{dayNumber}:group:{groupNumber}:member:{memberId}:crystal_cooldown
 *
 * @param {string} key
 * @returns {{ raceId, dayNumber, groupNumber, memberId }|null}
 */
function parseCrystalCooldownKey(key) {
  const match = key.match(
    /^race:(.+):day:(\d+):group:(\d+):member:(.+):crystal_cooldown$/
  );
  if (!match) return null;
  return {
    raceId:      match[1],
    dayNumber:   parseInt(match[2], 10),
    groupNumber: parseInt(match[3], 10),
    memberId:    match[4],
  };
}

/**
 * Builds the BullMQ jobId for the distance-tick repeating job of a group race.
 * Must be stable and unique per group race so the job can be removed at race end.
 *
 * @param {string} raceId
 * @param {number} dayNumber
 * @param {number} groupNumber
 * @returns {string}
 */
function tickJobId(raceId, dayNumber, groupNumber) {
  return `${raceId}:d${dayNumber}:g${groupNumber}:tick`;
}

/**
 * Builds the Socket.IO room name for one group race.
 * All members in the same group join this room.
 *
 * @param {string} raceId
 * @param {number} dayNumber
 * @param {number} groupNumber
 * @returns {string}
 */
function roomName(raceId, dayNumber, groupNumber) {
  return `${raceId}:d${dayNumber}:g${groupNumber}`;
}

/**
 * Maps a pit cron hour (8, 14, 19) to a window key string.
 * Returns null if the hour doesn't match a known window.
 *
 * @param {number} hour  — UTC hour (0–23)
 * @returns {string|null}
 */
function pitWindowKeyFromHour(hour) {
  const map = { 8: 'morning', 14: 'afternoon', 19: 'evening' };
  return map[hour] ?? null;
}

/**
 * Maps a dayNumber (1, 2, 3) to the next family_car_race_schedule status string.
 * Called at race end to advance status.
 *
 * @param {number} dayNumber
 * @param {'done'|'pending'} phase
 * @returns {string}
 */
function gameStatusForDay(dayNumber, phase) {
  return `day${dayNumber}_${phase}`;
}

/**
 * Calculates the distance increment for one tick at a given speed.
 * distance_per_second = speed_km_hr / 3600
 *
 * @param {number} speedKmHr
 * @param {number} tickIntervalMs
 * @returns {number} km traveled in this tick
 */
function distancePerTick(speedKmHr, tickIntervalMs = 1000) {
  return (speedKmHr / 3600) * (tickIntervalMs / 1000);
}

/**
 * Validates that a string is in "YYYY-MM-DD" format and is a valid date.
 * @param {string} str
 * @returns {boolean}
 */
function isValidDateString(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(str + 'T00:00:00Z');
  return !isNaN(d.getTime());
}

/**
 * Validates that a string is in "HH:MM:SS" format.
 * @param {string} str
 * @returns {boolean}
 */
function isValidTimeString(str) {
  return /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/.test(str);
}

/**
 * Returns the ISO day of week for a date string.
 * Monday=1, Tuesday=2, ..., Sunday=7.
 * @param {string} dateStr — "YYYY-MM-DD"
 * @returns {number}
 */
function isoWeekday(dateStr) {
  return moment(dateStr, 'YYYY-MM-DD').isoWeekday(); // Mon=1...Sun=7
}

module.exports = {
  generateUUID,
  getTodayDate: todayUTCString,
  todayUTCString,
  toDateString,
  addDays,
  secondsUntil,
  parseStartTriggerKey,
  parseCrystalCooldownKey,
  tickJobId,
  roomName,
  pitWindowKeyFromHour,
  gameStatusForDay,
  distancePerTick,
  isValidDateString,
  isValidTimeString,
  isoWeekday,
};

/**
 * Returns today's date as a "YYYY-MM-DD" string in IST (UTC+05:30).
 * Fix #15: Used by pitCron.worker to compute today's race-day date consistently
 * with the IST-based race_start_day values stored in family_car_race_schedule.
 * @returns {string}
 */
function todayISTString() {
  return moment().tz('Asia/Kolkata').format('YYYY-MM-DD');
}

module.exports = Object.assign(module.exports, { todayISTString });
