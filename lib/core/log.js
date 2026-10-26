'use strict';
// JSONL logger: one line per event in <runDir>/run.jsonl, mirrored to stderr
// (human-readable) unless quiet. Never log secrets: plugins pass ids, not tokens.
const fs = require('fs');
const path = require('path');

function createLogger(runDir, { quiet = false, file = 'run.jsonl' } = {}) {
  let fd = null;
  if (runDir) {
    fs.mkdirSync(runDir, { recursive: true });
    fd = fs.openSync(path.join(runDir, file), 'a');
  }
  function write(level, stage, msg, data) {
    const rec = { ts: new Date().toISOString(), level, stage: stage || null, msg };
    if (data !== undefined) rec.data = data;
    if (fd !== null) fs.writeSync(fd, JSON.stringify(rec) + '\n');
    if (!quiet || level === 'error') process.stderr.write(`[${rec.ts}] ${level.toUpperCase()} ${stage ? stage + ': ' : ''}${msg}\n`);
    return rec;
  }
  const api = {
    info: (stage, msg, data) => write('info', stage, msg, data),
    warn: (stage, msg, data) => write('warn', stage, msg, data),
    error: (stage, msg, data) => write('error', stage, msg, data),
    debug: (stage, msg, data) => (process.env.STACK_UPDATER_DEBUG ? write('debug', stage, msg, data) : null),
    child: (stage) => ({
      info: (msg, data) => api.info(stage, msg, data),
      warn: (msg, data) => api.warn(stage, msg, data),
      error: (msg, data) => api.error(stage, msg, data),
      debug: (msg, data) => api.debug(stage, msg, data),
    }),
    close() {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } fd = null; }
    },
  };
  return api;
}

module.exports = { createLogger };
