'use strict';

/**
 * config/mysql.js
 *
 * Creates and exports a mysql2 connection pool with monitoring.
 *
 * All queries are handled through the exported `query()` helper which
 * acquires a connection, runs the query, and releases it — callers never
 * manage connections directly. Use `getConnection()` only when you need
 * explicit transaction control.
 *
 * Pool size is controlled by DB_POOL_LIMIT in .env (default 80).
 *
 * Usage anywhere in the codebase:
 *   const db = require('../config/mysql');
 *   const rows = await db.query('SELECT ...', [params]);
 */

require('dotenv').config();

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host             : process.env.DB_HOST,
  port             : process.env.DB_PORT,
  user             : process.env.DB_USERNAME,
  password         : process.env.DB_PASSWORD,
  database         : process.env.DB_DATABASE,
  connectTimeout   : 15000,
  waitForConnections: true,
  connectionLimit  : parseInt(process.env.DB_POOL_LIMIT, 10) || 80,
  queueLimit       : 200,
  charset          : 'utf8mb4',
  timezone         : 'local',
  enableKeepAlive  : true,
  keepAliveInitialDelay: 300000,
});

// Pool monitoring — warn when the pool is under pressure
setInterval(() => {
  const info = {
    totalConnections : pool.pool._allConnections?.length  || 0,
    freeConnections  : pool.pool._freeConnections?.length || 0,
    queuedRequests   : pool.pool._connectionQueue?.length || 0,
  };
  if (info.queuedRequests > 0 || info.freeConnections === 0) {
    console.warn(
      `[DB POOL WARNING] total=${info.totalConnections}, ` +
      `free=${info.freeConnections}, queued=${info.queuedRequests}`
    );
  }
}, 5000);

module.exports = {
  pool,
  /**
   * Acquire a raw connection from the pool (for transactions).
   * Caller is responsible for calling connection.release().
   */
  async getConnection() {
    return pool.getConnection();
  },

  /**
   * Run a single SQL query and return the result rows.
   * Connection is automatically acquired and released.
   *
   * @param {string}  sql    — parameterised SQL string
   * @param {Array}   params — bound parameters
   * @returns {Promise<any[]>}
   */
  async query(sql, params) {
    const connection = await pool.getConnection();
    try {
      const [results] = await connection.query(sql, params);
      return results;
    } catch (err) {
      console.error('[DB] Query error:', err);
      throw err;
    } finally {
      connection.release();
    }
  },

  /**
   * Test the pool by running a trivial query.
   * Called during startup to fail fast if the DB is unreachable.
   */
  async testConnection() {
    const connection = await pool.getConnection();
    try {
      await connection.query('SELECT 1');
      console.log('[DB] MySQL connection pool ready');
    } finally {
      connection.release();
    }
  },

  pool,
};
