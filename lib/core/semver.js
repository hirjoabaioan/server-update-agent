'use strict';
// Tiny, dependency-free version helpers. Loose parsing: accepts "v1.2.3", "8.3",
// "1.2.3-rc.0+build", distro strings like "8.3.12-1+ubuntu24.04.1+deb.sury.org+1"
// (the numeric x.y.z prefix is the version; a distro suffix is NOT a prerelease
// unless it matches the prerelease regex).

const DEFAULT_PRERELEASE_RE = /(alpha|beta|rc|dev|nightly|preview|snapshot)/i;

function parse(input) {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim();
  const m = raw.match(/^[vV=]?\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.\-~+]+?))?(?:\+([0-9A-Za-z.\-~+]+))?$/)
    || raw.match(/^[vV=]?\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?()(.*)$/);
  if (!m) return null;
  const rest = m[5] || '';
  const pre = rest && DEFAULT_PRERELEASE_RE.test(rest)
    ? rest.replace(/^[-.~]/, '').split(/[.\-~]/).filter(Boolean)
    : [];
  return {
    raw,
    major: Number(m[1]),
    minor: m[2] !== undefined ? Number(m[2]) : 0,
    patch: m[3] !== undefined ? Number(m[3]) : 0,
    pre,
    suffix: rest,
  };
}

function cmpIdent(a, b) {
  const an = /^\d+$/.test(a), bn = /^\d+$/.test(b);
  if (an && bn) return Math.sign(Number(a) - Number(b));
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// Returns -1 | 0 | 1. Unparseable versions sort before parseable ones.
function compare(a, b) {
  const pa = typeof a === 'object' && a ? a : parse(a);
  const pb = typeof b === 'object' && b ? b : parse(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  if (!pa.pre.length && pb.pre.length) return 1;
  if (pa.pre.length && !pb.pre.length) return -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    if (pa.pre[i] === undefined) return -1;
    if (pb.pre[i] === undefined) return 1;
    const c = cmpIdent(pa.pre[i], pb.pre[i]);
    if (c) return c;
  }
  return 0;
}

const gt = (a, b) => compare(a, b) > 0;
const lt = (a, b) => compare(a, b) < 0;
const eq = (a, b) => compare(a, b) === 0;

function isPrerelease(version, re) {
  const rx = re instanceof RegExp ? re : re ? new RegExp(re, 'i') : DEFAULT_PRERELEASE_RE;
  return rx.test(String(version));
}

// 'none' | 'downgrade' | 'patch' | 'minor' | 'major' | 'prerelease' | 'unknown'
function diffType(from, to) {
  const a = parse(from), b = parse(to);
  if (!a || !b) return 'unknown';
  const c = compare(a, b);
  if (c === 0) return 'none';
  if (c > 0) return 'downgrade';
  if (a.major !== b.major) return 'major';
  if (a.minor !== b.minor) return 'minor';
  if (a.patch !== b.patch) return 'patch';
  return 'prerelease';
}

function sameMinor(a, b) {
  const pa = parse(a), pb = parse(b);
  return !!(pa && pb && pa.major === pb.major && pa.minor === pb.minor);
}

function maxVersion(list) {
  return (list || []).reduce((best, v) => (best === null || gt(v, best) ? v : best), null);
}

module.exports = { parse, compare, gt, lt, eq, isPrerelease, diffType, sameMinor, maxVersion, DEFAULT_PRERELEASE_RE };
