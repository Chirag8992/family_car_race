'use strict';

/**
 * src/middleware/rateLimit.js
 *
 * Per-member rate limiting using Redis INCR + EXPIRE.
 *
 * Why Redis instead of in-memory?
 *   This is a single-process app but rate limit state must survive
 *   hot-reloads in dev and be ready to scale if needed.
 *
 * Strategy:
 *   Each request increments a counter key scoped to memberId + endpoint.
 *   Key TTL is set on first increment. After TTL expires, counter resets.
 *   If counter exceeds limit, respond 429.
 *
 * Usage:
 *   router.post('/race/egg/throw', authenticate, rateLimit(redis, 5, 1), handler);
 *   // max 5 requests per member per 1 second on this endpoint
 */

/**
 * Creates a rate-limit middleware for a specific endpoint.
 *
 * @param {import('ioredis').Redis} redis
 * @param {number} maxRequests   — max allowed requests in the window
 * @param {number} windowSeconds — sliding window duration in seconds
 * @param {string} [prefix]      — optional key prefix to namespace by route
 * @returns {import('express').RequestHandler}
 */
function rateLimit(redis, maxRequests, windowSeconds, prefix = 'rl') {
  return async function rateLimitMiddleware(req, res, next) {
    // Rate limiting only applies to authenticated requests.
    if (!req.user) return next();

    const memberId = req.user.memberId;
    const key      = `${prefix}:${memberId}:${req.path}`;

    try {
      // INCR returns new count after increment.
      const count = await redis.incr(key);

      // On first request in window, set the expiry.
      if (count === 1) {
        await redis.expire(key, windowSeconds);
      }

      if (count > maxRequests) {
        // Include retry-after header for client guidance.
        const ttl = await redis.ttl(key);
        res.set('Retry-After', String(ttl));
        return res.status(429).json({
          error:        'rate_limit_exceeded',
          retry_after:  ttl,
          limit:        maxRequests,
          window_sec:   windowSeconds,
        });
      }

      next();
    } catch (err) {
      // Don't block the request if Redis is unavailable — fail open.
      console.error('[rateLimit] Redis error, skipping check:', err.message);
      next();
    }
  };
}

/**
 * Pre-configured factory for general API endpoints.
 * 30 requests per 60 seconds per member.
 * @param {import('ioredis').Redis} redis
 * @returns {import('express').RequestHandler}
 */
function apiLimiter(redis) {
  return rateLimit(redis, 30, 60, 'api');
}

/**
 * Pre-configured factory for sensitive/strict endpoints.
 * 5 requests per 10 seconds per member.
 * @param {import('ioredis').Redis} redis
 * @returns {import('express').RequestHandler}
 */
function strictLimiter(redis) {
  return rateLimit(redis, 5, 10, 'strict');
}

module.exports = { rateLimit, apiLimiter, strictLimiter };
