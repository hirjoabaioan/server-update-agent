'use strict';
// Candidate filters (pure). Each rejected candidate is reported with a reason.
const semver = require('../../core/semver');

const RELEASE_TAG_RE = /^v?\d+(\.\d+){1,3}$/;

function productOf(it) {
  if (it.ecosystem === 'node-runtime' || it.name === 'nodejs') return 'node';
  if (it.ecosystem === 'mariadb' || /mariadb/i.test(it.name)) return 'mariadb';
  if (it.ecosystem === 'php-runtime' || /^php\d/.test(it.name)) return 'php';
  if (it.ecosystem === 'docker') return 'docker';
  return null;
}

function preRegex(policy) {
  return new RegExp(policy.forbidPrerelease || semver.DEFAULT_PRERELEASE_RE.source, 'i');
}

function pinAllows(policy, name, version) {
  const pin = policy.pins && policy.pins[name];
  return !!(pin && Array.isArray(pin.allow) && pin.allow.includes(String(version)));
}

// Returns a rejection reason string, or null when the candidate is acceptable.
function rejectReason(it, c, ctx) {
  const policy = ctx.policy;
  const v = String(c.tag || c.version);
  const ver = String(c.version);
  if (policy.forbidPrerelease !== false && semver.isPrerelease(ver, preRegex(policy)) && !pinAllows(policy, it.name, ver)) {
    return 'prerelease';
  }
  const product = productOf(it);
  if (product === 'docker' && (!RELEASE_TAG_RE.test(v) || (policy.dockerNeverLatest && /latest/i.test(v)))) {
    return 'not a release tag';
  }
  const p = semver.parse(ver);
  if (!p) return 'unparseable version';
  if (product === 'node' && policy.nodeLtsOnly !== false) {
    const lts = c.lts !== undefined ? c.lts : (it.meta && it.meta.lts);
    if (lts === false || lts === null || lts === undefined) return `Node ${p.major} is not an LTS line`;
    if (c.eol && Date.parse(c.eol) < ctx.now.getTime()) return `Node ${p.major} LTS is end-of-life`;
  }
  if (product === 'mariadb' && policy.mariadbLtsOnly !== false) {
    const series = (policy.mariadbLtsSeries || []).map(String);
    if (!series.includes(`${p.major}.${p.minor}`)) return `MariaDB ${p.major}.${p.minor} is not an LTS series`;
  }
  if (product === 'php') {
    const cyc = ctx.phpCycles.get(`${p.major}.${p.minor}`);
    if (cyc && cyc.eol && Date.parse(cyc.eol) < ctx.now.getTime()) return `PHP ${p.major}.${p.minor} is end-of-life`;
  }
  return null;
}

function filterPool(it, pool, ctx) {
  const kept = [];
  const rejected = [];
  for (const c of pool) {
    const why = rejectReason(it, c, ctx);
    if (why) rejected.push({ version: c.tag || c.version, why }); else kept.push(c);
  }
  return { kept, rejected };
}

module.exports = { productOf, filterPool, rejectReason, pinAllows, RELEASE_TAG_RE };
