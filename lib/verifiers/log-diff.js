'use strict';
// PHP error-log diff. baseline() (taken BEFORE apply) records, per log file, size + line count +
// sha1 of the last 4 KiB. verify() reads only what was appended since:
//   new "PHP Fatal" / "Parse error" lines  => FAIL
//   new "Warning" / "Deprecated" / "Notice" => WARN (ok, unique messages listed)
// Logs: profile.phpErrorLogs[env] + error_log paths parsed from profile.phpErrorLogs.poolConfDir/*.conf
// that live under one of this env's webRoots. If the file rotated/truncated, the new file counts as new.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fail } = require('./_util');

const TAIL = 4096;
const MAX_READ = 8 * 1024 * 1024;
const sha = (b) => crypto.createHash('sha1').update(b).digest('hex');
const FATAL = /PHP (Fatal error|Parse error)|\b(Fatal error|Parse error)\b/;
const WARN = /\b(Warning|Deprecated|Notice)\b/;
const POOL_RE = /^\s*php_(?:admin_)?value\[error_log\]\s*=\s*(\S+)/;

function poolLogs(dir) {
  const out = [];
  if (!dir) return out;
  try {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.conf'))) {
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        const m = POOL_RE.exec(line);
        if (m) out.push(m[1]);
      }
    }
  } catch { /* no pool dir */ }
  return out;
}

function logPaths(ctx) {
  const pel = (ctx.profile && ctx.profile.phpErrorLogs) || {};
  const roots = ((ctx.profile && ctx.profile.webRoots) || []).filter((w) => w.env === ctx.env).map((w) => w.path);
  const set = new Set();
  if (pel[ctx.env]) set.add(pel[ctx.env]);
  for (const p of poolLogs(pel.poolConfDir)) if (roots.some((r) => p.startsWith(`${r}/`))) set.add(p);
  return [...set];
}

function snapshot(file) {
  let st;
  try { st = fs.statSync(file); } catch { return { path: file, exists: false, size: 0, lines: 0, tailSha: null, tailLen: 0 }; }
  const fd = fs.openSync(file, 'r');
  try {
    const n = Math.min(TAIL, st.size);
    const buf = Buffer.alloc(n);
    if (n) fs.readSync(fd, buf, 0, n, st.size - n);
    let lines = 0;
    const chunk = Buffer.alloc(1 << 20);
    for (let pos = 0; pos < st.size;) {
      const r = fs.readSync(fd, chunk, 0, chunk.length, pos);
      if (r <= 0) break;
      for (let i = 0; i < r; i++) if (chunk[i] === 10) lines++;
      pos += r;
    }
    return { path: file, exists: true, size: st.size, lines, tailSha: n ? sha(buf) : null, tailLen: n };
  } finally { fs.closeSync(fd); }
}

// Text appended since `base` (or the whole, capped, file if it rotated/shrank).
function appended(file, base) {
  let st;
  try { st = fs.statSync(file); } catch { return { text: '', rotated: false }; }
  const fd = fs.openSync(file, 'r');
  try {
    let start = 0;
    let rotated = true;
    if (base && !base.exists) {
      rotated = false;
    } else if (base && st.size >= base.size) {
      const n = base.tailLen || 0;
      const buf = Buffer.alloc(n);
      if (n) fs.readSync(fd, buf, 0, n, base.size - n);
      if (!n || sha(buf) === base.tailSha) { start = base.size; rotated = false; }
    }
    const len = Math.min(st.size - start, MAX_READ);
    const out = Buffer.alloc(len);
    if (len) fs.readSync(fd, out, 0, len, st.size - len);
    return { text: out.toString('utf8'), rotated, truncated: st.size - start > MAX_READ };
  } finally { fs.closeSync(fd); }
}

// Strip the leading "[date time]" so repeated messages dedupe.
const normalize = (l) => l.replace(/^\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim();

function classify(text) {
  const fatal = new Map();
  const warn = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const n = normalize(line);
    if (FATAL.test(line)) fatal.set(n, (fatal.get(n) || 0) + 1);
    else if (WARN.test(line)) warn.set(n, (warn.get(n) || 0) + 1);
  }
  const list = (m) => [...m.entries()].slice(0, 20).map(([msg, count]) => ({ msg: msg.slice(0, 400), count }));
  const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
  return { fatal: list(fatal), warn: list(warn), fatalTotal: sum(fatal), warnTotal: sum(warn) };
}

module.exports = {
  name: 'log-diff',
  logPaths,
  snapshot,
  classify,
  appended,
  async baseline(ctx) {
    return { takenAt: new Date().toISOString(), logs: logPaths(ctx).map(snapshot) };
  },
  async verify(ctx) {
    const paths = logPaths(ctx);
    if (!paths.length) return { ok: true, skipped: true, checks: [] };
    const checks = [];
    for (const p of paths) {
      const base = ctx.baseline && ctx.baseline.logs ? ctx.baseline.logs.find((b) => b.path === p) : null;
      if (ctx.baselineCreated || !base) {
        const s = base || snapshot(p);
        checks.push({ id: `log ${p}`, ok: true, detail: `baseline created: ${s.lines} lines, ${s.size} bytes (nothing to compare yet)` });
        continue;
      }
      const { text, rotated, truncated } = appended(p, base);
      const c = classify(text);
      const note = `${rotated ? 'log rotated/truncated, whole file counted; ' : ''}${truncated ? 'read capped; ' : ''}`;
      if (c.fatalTotal) checks.push({ id: `log ${p}`, ok: false, level: 'fail', fatal: c.fatal, warn: c.warn, detail: `${note}${c.fatalTotal} new fatal/parse error(s): ${c.fatal.map((x) => x.msg).slice(0, 5).join(' | ')}` });
      else if (c.warnTotal) checks.push({ id: `log ${p}`, ok: true, level: 'warn', warn: c.warn, detail: `${note}WARN ${c.warnTotal} new warning/deprecated line(s), ${c.warn.length} unique: ${c.warn.map((x) => x.msg).slice(0, 10).join(' | ')}` });
      else checks.push({ id: `log ${p}`, ok: true, detail: `${note}no new fatal/warning lines` });
    }
    return checks.every((c) => c.ok) ? { ok: true, checks } : fail('log-diff', checks);
  },
};
