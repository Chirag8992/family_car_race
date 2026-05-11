'use strict';

/**
 * socket/io.js
 *
 * Singleton holder for the Socket.IO Server instance.
 * Set once in app.js after Server creation so workers can
 * broadcast without circular-dependency or prop-drilling issues.
 */

let _io = null;

module.exports = {
  set(io)  { _io = io; },
  get()    { return _io; },
};
