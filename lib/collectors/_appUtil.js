'use strict';
// Shared helpers for application-level collectors (composer / npm / frontend).
// Files starting with "_" are not loaded as plugins.
// Everything that touches the host goes through ctx.exec / ctx.fetchJson when provided,
// so tests can inject fixtures; the defaults below are read-only (execFile, GET).
const { execFile } = require('child_process');
const fs = require('fs');

function defaultExec(cmd, args, opts = {}) {
  const timeout = opts.timeout || 15000;
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(cmd, args, {
      timeout,
      maxBuffer: 256 * 1024 * 1024,
      env: Object.assign({}, process.env, opts.env || {}),
      cwd: opts.cwd || undefined,
    }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        timedOut: !!(err && err.killed && Date.now() - started >= timeout - 50),
        error: err && typeof err.code !== 'number' ? String(err.message || err) : null,
        ms: Date.now() - started,
      });
    });
  });
}

async function defaultFetchJson(url, opts = {}) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(opts.timeout || 15000),
    headers: { accept: 'application/json', 'user-agent': 'stack-updater/1 (read-only collector)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

const getExec = (ctx) => (ctx && typeof ctx.exec === 'function' ? ctx.exec : defaultExec);
const getFetch = (ctx) => (ctx && typeof ctx.fetchJson === 'function' ? ctx.fetchJson : defaultFetchJson);

// npm publish date (YYYY-MM-DD) of name@version from the FULL registry document (`time` map;
// the abbreviated install-v1 doc has none). The whole `time` map is cached per package in `cache`
// (a per-run Map) so each package is fetched once. 404/timeout -> null + one log line, never throws.
async function npmReleaseDate(ctx, cache, name, version, log) {
  if (!name || !version) return null;
  if (!cache.has(name)) {
    // cache the promise so concurrent callers for the same package share one fetch
    cache.set(name, (async () => {
      try {
        const data = await getFetch(ctx)(`https://registry.npmjs.org/${encodeURIComponent(name).replace(/^%40/, '@')}`, { timeout: 20000 });
        return data && data.time && typeof data.time === 'object' ? data.time : null;
      } catch (e) {
        if (log && typeof log.warn === 'function') log.warn(`npm release date lookup failed for ${name}: ${String(e.message || e)}`);
        return null;
      }
    })());
  }
  const t = await cache.get(name);
  const iso = t && t[String(version).replace(/^v/, '')];
  return iso ? String(iso).slice(0, 10) : null;
}

function logger(ctx) {
  const l = (ctx && ctx.log) || {};
  const noop = () => {};
  const bind = (k) => (typeof l[k] === 'function' ? l[k].bind(l) : noop);
  return { info: bind('info'), warn: bind('warn'), error: bind('error'), debug: bind('debug') };
}

// Parse JSON that may be preceded/followed by noise (tool warnings on stdout).
function parseJsonLoose(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* fall through */ }
  const open = s.search(/[{[]/);
  if (open < 0) return null;
  const close = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (close <= open) return null;
  try { return JSON.parse(s.slice(open, close + 1)); } catch { return null; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function mtimeIso(file) {
  try { return fs.statSync(file).mtime.toISOString(); } catch { return null; }
}

// Up to three candidates from versions newer than `installed`: best patch in the same minor,
// best minor in the same major, best major overall.
function pickCandidates(semver, installed, versions) {
  const ins = semver.parse(installed);
  const newer = [...new Set(versions)].filter((v) => semver.parse(v) && semver.gt(v, installed));
  const best = (list) => list.reduce((b, v) => (b === null || semver.gt(v, b) ? v : b), null);
  if (!ins) return newer.length ? [{ version: best(newer), type: 'unknown' }] : [];
  const pv = (v) => semver.parse(v);
  const out = [];
  const patch = best(newer.filter((v) => pv(v).major === ins.major && pv(v).minor === ins.minor));
  const minor = best(newer.filter((v) => pv(v).major === ins.major && pv(v).minor !== ins.minor));
  const major = best(newer.filter((v) => pv(v).major !== ins.major));
  if (patch) out.push({ version: patch, type: 'patch' });
  if (minor) out.push({ version: minor, type: 'minor' });
  if (major) out.push({ version: major, type: 'major' });
  return out;
}

// Does `version` satisfy a composer-style constraint such as ">=1.0,<1.2|>=2.0,<2.3"?
function inRange(semver, version, range) {
  if (!range) return false;
  return String(range).split(/\s*\|\|?\s*/).some((group) => group.split(/[\s,]+/).filter(Boolean).every((part) => {
    const m = part.match(/^(>=|<=|>|<|==|=)?\s*v?(.+)$/);
    if (!m) return false;
    const c = semver.compare(version, m[2]);
    switch (m[1]) {
      case '>=': return c >= 0;
      case '<=': return c <= 0;
      case '>': return c > 0;
      case '<': return c < 0;
      default: return c === 0;
    }
  }));
}

const SEV_ORDER = ['low', 'moderate', 'medium', 'high', 'critical'];
const maxSeverity = (list) => list.reduce((b, s) => (SEV_ORDER.indexOf(String(s).toLowerCase()) > SEV_ORDER.indexOf(b) ? String(s).toLowerCase() : b), 'low');

module.exports = { defaultExec, defaultFetchJson, getExec, getFetch, npmReleaseDate, logger, parseJsonLoose, readJson, mtimeIso, pickCandidates, inRange, maxSeverity };
