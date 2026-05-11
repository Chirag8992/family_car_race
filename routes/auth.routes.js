'use strict';

/**
 * routes/auth.routes.js
 *
 * POST /auth/login  → validate credentials, sign JWT, return token
 */

const { Router } = require('express');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const db         = require('../config/mysql');
const env        = require('../config/env');

// MD5 helper — matches passwords stored as MD5 hex strings (legacy PHP apps)
const md5 = (str) => crypto.createHash('md5').update(str).digest('hex');

const router = Router();

router.post('/login', async (req, res) => {
  const { memberId, adminId, password } = req.body || {};

  if (!password) {
    return res.status(400).json({ error: 'password required' });
  }

  try {
    // ── ADMIN LOGIN ──────────────────────────────────────────────
    if (adminId) {
      // adminId can be either the numeric id or email address
      const field = adminId.includes('@') ? 'email' : 'id';
      const rows = await db.query(
        `SELECT id, name, password FROM admin WHERE ${field} = ? LIMIT 1`,
        [adminId]
      );
      const admin = Array.isArray(rows) ? rows[0] : rows;

      if (!admin || admin.password !== md5(password)) {
        return res.status(401).json({ error: 'invalid_credentials' });
      }

      const payload = {
        userID:   admin.id,
        memberId: admin.id,
        name:     admin.name,
        familyId: null,
        role:     'admin',
        source:   'admin',
        type:     'access',
      };

      const token = jwt.sign(payload, env.JWT_API_KEY, { expiresIn: '24h' });
      // await db.query('UPDATE admin SET api_access_token = ? WHERE id = ?', [token, admin.id]);

      return res.json({ token });
    }

    // ── REGULAR USER LOGIN ───────────────────────────────────────
    if (!memberId) {
      return res.status(400).json({ error: 'memberId or adminId required' });
    }

    const rows = await db.query(
      `SELECT u.id, u.password, gm.familyId
         FROM users u
         LEFT JOIN groupsmembers gm
                ON gm.userId = u.id AND gm.memberStatus = '1'
        WHERE u.id = ?
        LIMIT 1`,
      [memberId]
    );

    const user = Array.isArray(rows) ? rows[0] : rows;

    if (!user || user.password !== md5(password)) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    const payload = {
      userID:   user.id,
      memberId: user.id,
      familyId: user.familyId || null,
      role:     'user',
      type:     'access',
    };

    const token = jwt.sign(payload, env.JWT_API_KEY, { expiresIn: '24h' });

    return res.json({ token });

  } catch (err) {
    console.error('[auth] Login error:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
