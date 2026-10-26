'use strict';
// GET every profile.smokeUrls entry ({ url, env?, expect?: 200 | [200,302], timeoutMs?, label? }).
// Records status + TTFB. Redirects are NOT followed (a 302 must be listed in `expect`).
const http = require('http');
const https = require('https');
const { fail } = require('./_util');
const { isExcluded } = require('../core/excluded');

function get(url, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve({ ms: Date.now() - t0, ...r }); } };
    let u;
    try { u = new URL(url); } catch (e) { return finish({ error: `bad url: ${e.message}` }); }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(u, { headers: { 'user-agent': 'stack-updater-smoke/1', accept: '*/*' } }, (res) => {
      const ttfb = Date.now() - t0;
      res.resume();
      res.on('end', () => finish({ status: res.statusCode, ttfb }));
      res.on('error', (e) => finish({ status: res.statusCode, ttfb, error: e.message }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); finish({ error: `timeout after ${timeoutMs}ms` }); });
    req.on('error', (e) => finish({ error: e.message }));
  });
}

module.exports = {
  name: 'http-smoke',
  async verify(ctx) {
    const urls = ((ctx.profile && ctx.profile.smokeUrls) || []).filter((u) => (!u.env || u.env === ctx.env) && !isExcluded(ctx.profile, { url: u.url }));
    if (!urls.length) return { ok: true, skipped: true, checks: [] };
    const checks = [];
    for (const u of urls) {
      const want = [].concat(u.expect === undefined ? 200 : u.expect);
      const timeoutMs = u.timeoutMs || 10000;
      let r = await get(u.url, timeoutMs);
      if (r.error && !r.status) r = await get(u.url, timeoutMs); // one retry on network error only
      const ok = !r.error && want.includes(r.status);
      checks.push({ id: `GET ${u.url}`, ok, status: r.status || null, ttfbMs: r.ttfb || null, expect: want,
        detail: r.error ? r.error : `${r.status} (expect ${want.join('|')}) ttfb ${r.ttfb}ms total ${r.ms}ms` });
    }
    return checks.every((c) => c.ok) ? { ok: true, checks } : fail('http-smoke', checks);
  },
};
