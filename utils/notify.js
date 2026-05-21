'use strict';

/**
 * utils/notify.js
 *
 * Sends a TEXT message to each family member's Single chat (from sender 595)
 * and pushes a notification — same pattern as shareBulkMessages.js.
 */

const http   = require('http');
const https  = require('https');
const env    = require('../config/env');
const db     = require('../config/mysql');

// ─── Configurable ───────────────────────────────────────────────────────────
const SENDER_ID    = 595;                          // ← change sender here
const SENDER_NAME  = 'Announcements';              // ← push notification chat name
const SENDER_IMAGE = 'https://rockstat-bucket.s3.ap-south-1.amazonaws.com/users_profile/1768488777-CROP_20260115202253488.jpg';
// ─────────────────────────────────────────────────────────────────────────────

// ─── WebView URL ────────────────────────────────────────────────────────────
const WEBVIEW_BASE   = 'https://family-clash-dash.lovable.app';
const APP_ENV        = env.isProduction ? 'production' : 'development';
const WEBVIEW_URL    = `${WEBVIEW_BASE}/${APP_ENV}`;
// ─────────────────────────────────────────────────────────────────────────────

// ─── Generic messages (change text here) ────────────────────────────────────
const MESSAGES = {
  GAME_START: '🏁 Family Car Race is starting in 5 minutes! Tap to join the race!',
  PIT_WINDOW: '⛽ Pit Stop window is now OPEN! Tap to boost your family car.',
};

// Event card config per message type (used in EVENTTEXTMESSAGE other_details)
const EVENT_CONFIG = {
  GAME_START: {
    headerText: '🏁 Family Car Race',
    textMessage: 'Race is starting in 5 minutes! Join now to compete with your family.',
    urlText: 'Join Race >',
    image: 'https://rockstat-bucket.s3.ap-south-1.amazonaws.com/rockstar-leaderboard/badges/1.webp',
    footerText: 'Good luck to your family! 🚗💨',
  },
  PIT_WINDOW: {
    headerText: '⛽ Pit Stop Open',
    textMessage: 'Pit Stop window is OPEN! Claim your boost to speed up your family car.',
    urlText: 'Boost Now >',
    image: 'https://rockstat-bucket.s3.ap-south-1.amazonaws.com/rockstar-leaderboard/badges/2.webp',
    footerText: 'Pit window closes soon — claim before it expires!',
  },
};
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find or create a Single chat between sender and receiver.
 */
async function getOrCreateSingleChat(senderId, receiverId) {
  const existing = await db.query(
    `SELECT id FROM chat
     WHERE type = 'Single'
       AND FIND_IN_SET(?, chat_participants)
       AND FIND_IN_SET(?, chat_participants)
     LIMIT 1`,
    [senderId, receiverId]
  );

  if (existing.length) return existing[0].id;

  const participants = `${senderId},${receiverId}`;
  const insert = await db.query(
    `INSERT INTO chat (chat_participants, chat_name, type, created_at, updated_at)
     VALUES (?, '', 'Single', NOW(), NOW())`,
    [participants]
  );

  return insert.insertId;
}

/**
 * Insert a TEXT message into a chat and update last_message.
 */
async function insertTextMessage(chatId, senderId, text) {
  const result = await db.query(
    `INSERT INTO chat_message
       (text, sender_id, chat_id, media, msg_type, deleted_for_user, other_details, created_at, updated_at)
     VALUES (?, ?, ?, '', 'TEXT', '[]', NULL, NOW(), NOW())`,
    [text, senderId, chatId]
  );

  await db.query(
    `UPDATE chat SET last_message_id = ?, last_message_at = NOW() WHERE id = ?`,
    [result.insertId, chatId]
  );

  return result.insertId;
}

/**
 * Insert an EVENTTEXTMESSAGE into a chat.
 * The event JSON is stored in the other_details column; Android renders it as a card with button.
 */
async function insertEventMessage(chatId, senderId, text, eventJson) {
  const otherDetails = JSON.stringify(eventJson);
  const result = await db.query(
    `INSERT INTO chat_message
       (text, sender_id, chat_id, media, msg_type, deleted_for_user, other_details, created_at, updated_at)
     VALUES (?, ?, ?, '', 'EVENTTEXTMESSAGE', '[]', ?, NOW(), NOW())`,
    [text, senderId, chatId, otherDetails]
  );

  await db.query(
    `UPDATE chat SET last_message_id = ?, last_message_at = NOW() WHERE id = ?`,
    [result.insertId, chatId]
  );

  return result.insertId;
}

/**
 * Send push notification to a single user via notification microservice.
 */
async function sendPushNotification(userId, title, message, chatId) {
  if (!env.NOTIFY_BASE_URL || !env.NOTIFY_TOKEN) return;

  const url = `${env.NOTIFY_BASE_URL}/notifications/devices/send`;
  const body = JSON.stringify({
    userId,
    title,
    chatId,
    body: {
      type: 'chat_message',
      user_id: String(userId),
      message,
      title,
      chat_data: {
        roomId: Number(chatId),
        type: 'Single',
        familyId: 0,
        description: null,
        profile: SENDER_IMAGE,
        chat_name: SENDER_NAME,
        profile_id: String(SENDER_ID),
        is_admin: 0,
      },
    },
  });

  return new Promise((resolve) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;

    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.NOTIFY_TOKEN}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, data }));
      }
    );

    req.on('error', (err) => {
      console.error(`[notify] Push failed for user ${userId}:`, err.message);
      resolve({ status: 0, error: err.message });
    });

    req.write(body);
    req.end();
  });
}

/**
 * Get all active member IDs for a family.
 */
async function getActiveFamilyMembers(familyId) {
  const rows = await db.query(
    `SELECT userId FROM groupsmembers WHERE familyId = ? AND memberStatus = '1'`,
    [familyId]
  );
  return rows.map((r) => r.userId);
}

/**
 * Send EVENTTEXTMESSAGE + push notification to every active member of a family.
 *
 * @param {number|string} familyId
 * @param {string} messageType - Key from EVENT_CONFIG (e.g., 'GAME_START', 'PIT_WINDOW')
 */
async function notifyFamilyMembers(familyId, messageType) {
  try {
    const memberIds = await getActiveFamilyMembers(familyId);
    if (memberIds.length === 0) return;

    const eventCfg = EVENT_CONFIG[messageType];
    const pushText = MESSAGES[messageType] || messageType;

    for (const memberId of memberIds) {
      try {
        // Skip sending to the sender itself
        if (Number(memberId) === SENDER_ID) continue;

        // Build event card JSON for other_details
        const eventJson = {
          headerText: eventCfg ? eventCfg.headerText : 'Family Car Race',
          eventList: [
            {
              textMessage: eventCfg ? eventCfg.textMessage : pushText,
              urlText: eventCfg ? eventCfg.urlText : 'Open ',
              baseUrl: WEBVIEW_URL,
              image: eventCfg ? eventCfg.image : '',
            },
          ],
          footerText: eventCfg ? eventCfg.footerText : '',
        };

        const chatId = await getOrCreateSingleChat(SENDER_ID, memberId);
        await insertEventMessage(chatId, SENDER_ID, pushText, eventJson);
        await sendPushNotification(memberId, 'Family Car Race', pushText, chatId);
      } catch (err) {
        console.error(`[notify] Failed for member ${memberId} in family ${familyId}:`, err.message);
      }
    }

    console.log(`[notify] Sent to family ${familyId}, ${memberIds.length} members`);
  } catch (err) {
    console.error(`[notify] Error notifying family ${familyId}:`, err.message);
  }
}

/**
 * Notify all families (send EVENTTEXTMESSAGE + push to every member of each family).
 *
 * @param {Array<number|string>} familyIds
 * @param {string} messageType - Key from EVENT_CONFIG (e.g., 'GAME_START', 'PIT_WINDOW')
 */
async function notifyAllFamilies(familyIds, messageType) {
  for (const familyId of familyIds) {
    await notifyFamilyMembers(familyId, messageType);
  }
  console.log(`[notify] Finished notifying ${familyIds.length} families`);
}

module.exports = {
  notifyFamilyMembers,
  notifyAllFamilies,
  getOrCreateSingleChat,
  insertTextMessage,
  insertEventMessage,
  sendPushNotification,
  getActiveFamilyMembers,
  MESSAGES,
  EVENT_CONFIG,
  SENDER_ID,
};
