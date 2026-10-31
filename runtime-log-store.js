/**
 * Worker-only log store; no chrome, DOM, network or storage globals.
 * create({ read, write, authorize, now }) -> { handle(message, sender) }.
 * read/write/authorize must settle within the host's deadline (background chromeCall: 5s).
 * Every instance owns its queue. Production creates exactly one instance per worker.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OmitoneRuntimeLogStore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var MAX_LOGS = 200;
  var QUEUE_WAIT_MS = 15000;

  function failure(code) { return { success: false, code: code, error: code }; }
  function cleanLogMeta(value, depth) {
    if (value == null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') return value.slice(0, 2000);
    if (depth >= 4) return '[truncated]';
    if (Array.isArray(value)) return value.slice(0, 30).map(function (item) { return cleanLogMeta(item, depth + 1); });
    if (typeof value !== 'object') return null;
    var result = Object.create(null);
    Object.keys(value).slice(0, 30).forEach(function (key) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
      result[key.slice(0, 100)] = /api.?key|token|authorization|password|secret|cookie/i.test(key)
        ? '[redacted]' : cleanLogMeta(value[key], depth + 1);
    });
    return result;
  }

  function normalizeLogEntry(payload, now) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).some(function (key) { return ['time', 'level', 'message', 'meta'].indexOf(key) === -1; })
      || typeof payload.message !== 'string' || payload.message.length > 2000
      || ['info', 'warn', 'error', 'debug'].indexOf(payload.level || 'info') === -1) return null;
    var meta;
    try {
      meta = cleanLogMeta(payload.meta == null ? null : payload.meta, 0);
      if (JSON.stringify(meta).length > 8000) meta = { note: 'log metadata too large' };
    } catch (e) { meta = { note: 'log metadata unavailable' }; }
    return { time: typeof payload.time === 'number' && Number.isFinite(payload.time) && payload.time > 0 ? payload.time : now(),
      level: payload.level || 'info', message: payload.message, meta: meta };
  }

  function create(dependencies) {
    if (!dependencies || ['read', 'write', 'authorize', 'now'].some(function (key) {
      return typeof dependencies[key] !== 'function';
    })) throw new TypeError('Log store requires read, write, authorize and now functions');
    // Capture the host capabilities once; callers cannot replace an existing store's authority.
    var read = dependencies.read, write = dependencies.write;
    var authorize = dependencies.authorize, now = dependencies.now;
    var logQueue = Promise.resolve();
    var logPending = 0;

    function handle(message, sender) {
      if (!message || (message.type !== 'runtime_log_append' && message.type !== 'runtime_log_clear')) {
        return Promise.resolve(failure('unknown_message'));
      }
      var clear = message.type === 'runtime_log_clear';
      var item = clear ? null : normalizeLogEntry(message.payload, now);
      if ((!clear && !item) || (clear && message.payload != null)) return Promise.resolve(failure('invalid_log'));
      if (logPending >= MAX_LOGS) return Promise.resolve(failure('log_queue_full'));
      logPending++;
      var expiresAt = now() + QUEUE_WAIT_MS;
      var task = logQueue.then(function () {
        if (now() > expiresAt) return failure('log_queue_expired');
        return Promise.resolve(authorize(sender, clear)).then(function (allowed) {
          if (allowed !== true) return failure('forbidden_sender');
          if (clear) return Promise.resolve(write([])).then(function () { return { success: true }; });
          return Promise.resolve(read()).then(function (stored) {
            var logs = Array.isArray(stored) ? stored : [];
            logs.push(item);
            var nextLogs = logs.slice(-MAX_LOGS);
            return Promise.resolve(write(nextLogs)).then(function () { return { success: true }; });
          });
        });
      }).catch(function () { return failure('log_storage_failed'); }).finally(function () { logPending--; });
      logQueue = task.catch(function () {});
      return task;
    }
    return Object.freeze({ handle: handle });
  }
  return Object.freeze({ create: create });
});