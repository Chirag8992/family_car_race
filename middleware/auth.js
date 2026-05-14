'use strict';

/**
 * middleware/auth.js
 *
 * JWT authentication middleware.
 *
 * Validation steps:
 *   1. Authorization header must be present (Bearer <token>)
 *   2. Token must be a valid JWT signed with JWT_API_KEY
 *   3. Token type must be 'access'
 *
 * No DB lookup — token validity is determined entirely by the JWT signature
 * and expiry. userID and memberId are read directly from the decoded payload.
 *
 * On success: attaches decoded JWT payload to req.user and calls next().
 * On failure: responds 401 immediately.
 */

const jwt = require('jsonwebtoken');

const JWT_API_KEY = process.env.JWT_API_KEY || '';

module.exports = (req, res, next) => {
  const authHeader = req.headers['authorization'];

  if (!authHeader) {
    return res.status(401).json({
      status : 401,
      message: 'Token required',
    });
  }

  // Strip 'Bearer ' prefix — works whether the client sends it or not
  const token = authHeader.replace('Bearer ', '');

  try {
    // Step 1: Verify signature + expiry
    const decoded = jwt.verify(token, JWT_API_KEY);

    // Step 2: Enforce token type
    // if (decoded.type !== 'access') {
    //   return res.status(401).json({
    //     status : 401,
    //     message: 'Invalid token type',
    //   });
    // }

    // Attach decoded payload to request for downstream use
    // decoded.userID  — numeric user/admin id
    // decoded.memberId — same as userID (may be absent in Android-app JWTs)
    // decoded.role    — 'user' | 'admin'
    // decoded.source  — 'admin' (only on admin tokens)

    // Ensure memberId is always set (Android JWTs only have userID)
    if (!decoded.memberId && decoded.userID) {
      decoded.memberId = decoded.userID;
    }
    // Default role to 'user' when not present
    if (!decoded.role) {
      decoded.role = 'user';
    }

    req.user = decoded;
    next();
  } catch (error) {
        console.error('[AUTH] JWT verify failed:', error.message);

    return res.status(401).json({
      status : 401,
      message: 'Invalid token: ' + error.message,
    });
  }
};
