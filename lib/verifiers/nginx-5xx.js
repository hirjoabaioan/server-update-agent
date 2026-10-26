'use strict';
// Counts status>=500 in the nginx JSON access logs (<profile.nginxJsonLogDir>/<domain>.json.log;
// fields: time, status, upstream_time, uri, host ...) for entries newer than the apply timestamp
// (ctx.baselineAt, taken just before apply). After an apply (ctx.watch) it first waits the watch
// window: entry option watchMinutes = { prod: 15, test: 3 } (or a number). Fails when
// count > maxAbsolute (default 5) OR count/total*100 > maxPercent (default 0.5).
// Standalone with a fresh baseline: the window is the last `lookbackMinutes` (default = watch window).
const fs = require('fs');
const path = require('path');
const { entriesFor, fail } = require('./_util');

const MAX_BYTES = 64 * 1024 * 1024;

function readTail(file, maxBytes) {
  const st = fs.statSync(file);
  const len = Math.min(st.size, maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(len);
    fs.readSync(fd, b, 0, len, st.size - len);
    return b.toString('utf8');
  } finally { fs.closeSync(fd); }
}

// pure: log text -> { total, errors, samples } for entries with time >= sinceMs
function count(text, sinceMs) {
  let total = 0;
  let errors = 0;
  const samples = [];
  for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const t = Date.parse(j.time);
    if (!(t >= sinceMs)) continue;
    total++;
    if (Number(j.status) >= 500) {
      errors++;
      if (samples.length < 5) samples.push(`${j.status} ${j.method || ''} ${String(j.uri || '').slice(0, 120)} upstream=${j.upstream_time}`);
    }
  }
  return { total, errors, samples };
}

module.exports = {
  name: 'nginx-5xx',
  count,
  async verify(ctx) {
    const e = entriesFor(ctx, 'nginx-5xx')[0];
    const dir = ctx.profile && ctx.profile.nginxJsonLogDir;
    if (!e || !dir) return { ok: true, skipped: true, checks: [] };
    const win = e.watchMinutes && typeof e.watchMinutes === 'object' ? e.watchMinutes[ctx.env] : e.watchMinutes;
    const watchMin = win === undefined ? (ctx.env === 'prod' ? 15 : 3) : win;
    if (ctx.watch && !ctx.dryRun && watchMin > 0) {
      ctx.log.info(`watching nginx 5xx for ${watchMin} min`);
      await (ctx.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))))(watchMin * 60000);
    }
    const since = e.sinceMs || (ctx.baselineAt && !ctx.baselineCreated ? Date.parse(ctx.baselineAt) : Date.now() - (e.lookbackMinutes || watchMin || 3) * 60000);
    const domains = e.domains || (ctx.profile.webRoots || []).filter((w) => w.env === ctx.env).map((w) => w.domain);
    const maxAbs = e.maxAbsolute === undefined ? 5 : e.maxAbsolute;
    const maxPct = e.maxPercent === undefined ? 0.5 : e.maxPercent;
    const checks = [];
    for (const d of domains) {
      const file = path.join(dir, `${d}.json.log`);
      let r;
      try { r = count(readTail(file, e.maxBytes || MAX_BYTES), since); } catch (err) {
        checks.push({ id: `5xx ${d}`, ok: true, level: 'warn', detail: `cannot read ${file}: ${err.code || err.message}` });
        continue;
      }
      const pct = r.total ? (r.errors / r.total) * 100 : 0;
      const bad = r.errors > maxAbs || pct > maxPct;
      checks.push({ id: `5xx ${d}`, ok: !bad, total: r.total, errors: r.errors, percent: +pct.toFixed(3), samples: r.samples,
        detail: `${r.errors} x 5xx of ${r.total} requests (${pct.toFixed(2)}%) since ${new Date(since).toISOString()}; limit >${maxAbs} or >${maxPct}%${r.samples.length ? ` e.g. ${r.samples.join(' | ')}` : ''}` });
    }
    return checks.every((c) => c.ok) ? { ok: true, checks } : fail('nginx-5xx', checks);
  },
};
