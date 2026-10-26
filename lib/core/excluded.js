'use strict';
// Generic exclude list. Profile contract: profile.excluded = [{ domain, path?, reason }].
// Deprecated alias: profile.composerExcluded (folded in when `excluded` is missing).
const path = require('path');

function excludedOf(profile) {
  if (!profile) return [];
  if (Array.isArray(profile.excluded)) return profile.excluded;
  return Array.isArray(profile.composerExcluded) ? profile.composerExcluded : [];
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

// target: { domain?, path?, host?, url? } — true if any field matches an excluded entry
// (path also matches when it lies inside an excluded path).
function isExcluded(profile, target = {}) {
  const host = target.domain || target.host || (target.url ? hostOf(target.url) : null);
  const p = target.path ? path.resolve(target.path) : null;
  for (const ex of excludedOf(profile)) {
    if (host && ex.domain && ex.domain === host) return true;
    if (p && ex.path) {
      const exp = path.resolve(ex.path);
      if (p === exp || p.startsWith(exp + path.sep)) return true;
    }
  }
  return false;
}

module.exports = { excludedOf, isExcluded, hostOf };
