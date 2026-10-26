'use strict';
// Run lock + deploy-lock guard.
//  - run lock: flock(2) on <stateDir>/run.lock. Node has no flock binding, so we open the
//    file and let the util-linux `flock` binary lock the inherited fd (fd 3 in the child).
//    flock locks belong to the open file description, so the lock stays held by this
//    process after the child exits, until we close the fd or the process dies.
//  - deploy locks: if any path in profile.deployLocks exists and is younger than
//    maxAgeMs (default 2h) another deploy is in progress -> skip this run.
//    Older lock files are considered stale: reported, not a reason to skip.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_DEPLOY_LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;

function acquireRunLock(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'run.lock');
  const fd = fs.openSync(file, 'a');
  const r = spawnSync('flock', ['-n', '-E', '75', '3'], { stdio: ['ignore', 'ignore', 'pipe', fd] });
  if (r.error) {
    fs.closeSync(fd);
    throw new Error(`flock unavailable: ${r.error.message}`);
  }
  if (r.status !== 0) {
    fs.closeSync(fd);
    return { ok: false, file, reason: 'another stack-updater run holds the lock' };
  }
  try {
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
  } catch { /* informational only */ }
  let released = false;
  return {
    ok: true,
    file,
    release() {
      if (released) return;
      released = true;
      try { fs.closeSync(fd); } catch { /* already closed */ }
    },
  };
}

function checkDeployLocks(paths, { maxAgeMs = DEFAULT_DEPLOY_LOCK_MAX_AGE_MS, now = Date.now() } = {}) {
  const active = [];
  const stale = [];
  for (const p of paths || []) {
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    const ageMs = now - st.mtimeMs;
    (ageMs < maxAgeMs ? active : stale).push({ path: p, ageMs, mtime: new Date(st.mtimeMs).toISOString() });
  }
  return { busy: active.length > 0, active, stale };
}

module.exports = { acquireRunLock, checkDeployLocks, DEFAULT_DEPLOY_LOCK_MAX_AGE_MS };
