'use strict';
// Run: node --test scripts/stack-updater/tests
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const httpSmoke = require('../lib/verifiers/http-smoke');
const logDiff = require('../lib/verifiers/log-diff');
const nginx5xx = require('../lib/verifiers/nginx-5xx');
const command = require('../lib/verifiers/command');
const hook = require('../lib/verifiers/external-hook');

const log = { info() {}, warn() {}, error() {}, debug() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'su-ver-'));
const mkctx = (profile, extra = {}) => ({ profile, env: 'test', log, dryRun: false, ...extra });

test('http-smoke: expected status, unexpected status, timeout, env filter', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/slow') return; // never answers
    res.statusCode = req.url === '/nf' ? 404 : req.url === '/boom' ? 500 : 200;
    res.end('x');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${srv.address().port}`;
  try {
    let r = await httpSmoke.verify(mkctx({ smokeUrls: [{ url: `${b}/`, env: 'test' }, { url: `${b}/nf`, env: 'test', expect: 404 }, { url: `${b}/boom`, env: 'prod' }] }));
    assert.equal(r.ok, true);
    assert.equal(r.checks.length, 2); // prod entry filtered out
    assert.ok(r.checks[0].ttfbMs >= 0);
    r = await httpSmoke.verify(mkctx({ smokeUrls: [{ url: `${b}/boom` }] }));
    assert.equal(r.ok, false);
    assert.equal(r.component, 'http-smoke');
    assert.match(r.details, /500/);
    r = await httpSmoke.verify(mkctx({ smokeUrls: [{ url: `${b}/slow`, timeoutMs: 150 }] }));
    assert.equal(r.ok, false);
    assert.match(r.details, /timeout/);
    r = await httpSmoke.verify(mkctx({ smokeUrls: [] }));
    assert.equal(r.skipped, true);
  } finally { srv.closeAllConnections(); srv.close(); }
});

test('http-smoke: skips smokeUrls whose host is excluded', async () => {
  const hits = [];
  const srv = http.createServer((req, res) => { hits.push(req.headers.host); res.end('x'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const r = await httpSmoke.verify(mkctx({
      excluded: [{ domain: 'localhost', reason: 't' }],
      smokeUrls: [{ url: `http://localhost:${port}/` }, { url: `http://127.0.0.1:${port}/` }],
    }));
    assert.equal(r.ok, true);
    assert.equal(r.checks.length, 1);
    assert.equal(hits.length, 1);
    assert.match(r.checks[0].id, /127\.0\.0\.1/);
  } finally { srv.close(); }
});

test('frontend webRootsOf drops excluded roots', () => {
  const { _internals } = require('../lib/collectors/frontend');
  assert.ok(_internals && _internals.webRootsOf, 'webRootsOf exported via _internals');
  const profile = { excluded: [{ domain: 'x.example', reason: 'r' }, { path: '/srv/y', reason: 'r' }],
    webRoots: [{ domain: 'x.example', env: 'prod', path: '/srv/x' }, { domain: 'y.example', env: 'prod', path: '/srv/y' }, { domain: 'ok.example', env: 'prod', path: '/srv/ok' }] };
  assert.deepEqual(_internals.webRootsOf({ profile }, 'prod').map((r) => r.domain), ['ok.example']);
});

test('log-diff: fatal => FAIL, warnings => WARN with unique messages, rotation, pool parsing', async () => {
  const d = tmp();
  const root = path.join(d, 'web', 't.example');
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  const logf = path.join(root, 'logs', 'php_error.log');
  fs.writeFileSync(logf, '[01-Jan-2026 10:00:00 UTC] PHP Warning:  old thing in /a.php on line 1\n');
  const pool = path.join(d, 'pool.d');
  fs.mkdirSync(pool);
  fs.writeFileSync(path.join(pool, 'a.conf'), `php_admin_value[error_log] = ${logf}\nphp_admin_value[error_log] = ${d}/web/other.example/logs/x.log\n`);
  const profile = { webRoots: [{ env: 'test', path: root }], phpErrorLogs: { test: logf, poolConfDir: pool } };
  assert.deepEqual(logDiff.logPaths(mkctx(profile)), [logf]); // pool path of another env ignored, no dupes

  const base = await logDiff.baseline(mkctx(profile));
  assert.equal(base.logs[0].lines, 1);
  const ctx = mkctx(profile, { baseline: base, baselineCreated: false });

  let r = await logDiff.verify(ctx);
  assert.equal(r.ok, true);
  assert.match(r.checks[0].detail, /no new/);

  fs.appendFileSync(logf, '[02-Jan-2026 10:00:00 UTC] PHP Warning:  undefined var $x in /b.php on line 5\n[02-Jan-2026 10:00:01 UTC] PHP Warning:  undefined var $x in /b.php on line 5\n[02-Jan-2026 10:00:02 UTC] PHP Deprecated:  foo() in /c.php on line 9\n');
  r = await logDiff.verify(ctx);
  assert.equal(r.ok, true);
  assert.equal(r.checks[0].level, 'warn');
  assert.equal(r.checks[0].warn.length, 2); // 2 unique messages
  assert.equal(r.checks[0].warn[0].count, 2); // timestamp stripped => deduped

  fs.appendFileSync(logf, '[02-Jan-2026 10:01:00 UTC] PHP Fatal error:  Uncaught Error in /d.php:3\n[02-Jan-2026 10:01:01 UTC] PHP Parse error:  syntax error in /e.php on line 2\n');
  r = await logDiff.verify(ctx);
  assert.equal(r.ok, false);
  assert.equal(r.component, 'log-diff');
  assert.match(r.details, /2 new fatal\/parse/);

  // rotation: file replaced by a smaller one => whole new file is "new"
  fs.writeFileSync(logf, 'PHP Fatal error:  after rotate\n');
  r = await logDiff.verify(ctx);
  assert.equal(r.ok, false);
  assert.match(r.checks[0].detail, /rotated/);

  // a freshly created baseline only reports
  r = await logDiff.verify(mkctx(profile, { baseline: base, baselineCreated: true }));
  assert.equal(r.ok, true);
  assert.match(r.checks[0].detail, /baseline created/);
});

const jl = (time, status, uri = '/x') => JSON.stringify({ time, request_id: 'r', host: 'h', method: 'GET', uri, status, bytes: 1, request_time: 0.1, upstream_time: '0.100', user_agent: 'ua' });

test('nginx-5xx: counts only newer entries, thresholds, domains, watch wait', async () => {
  const d = tmp();
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const lines = [];
  for (let i = 0; i < 4; i++) lines.push(jl(iso(now - 3600e3), 502)); // old 5xx must be ignored
  for (let i = 0; i < 200; i++) lines.push(jl(iso(now - 1000), 200));
  lines.push('not json at all');
  lines.push(jl(iso(now - 500), 503, '/api/boom'));
  fs.writeFileSync(path.join(d, 'a.example.json.log'), lines.join('\n') + '\n');

  const c = nginx5xx.count(lines.join('\n'), now - 60e3);
  assert.deepEqual([c.total, c.errors], [201, 1]);

  const profile = { nginxJsonLogDir: d, webRoots: [{ env: 'test', domain: 'a.example' }, { env: 'test', domain: 'missing.example' }, { env: 'prod', domain: 'p.example' }],
    verifiers: [{ name: 'nginx-5xx', envs: ['test'], maxAbsolute: 5, maxPercent: 0.5 }] };
  const base = { baselineAt: iso(now - 60e3), baselineCreated: false };
  let r = await nginx5xx.verify(mkctx(profile, base));
  assert.equal(r.ok, true); // 1/201 = 0.497% < 0.5% and 1 <= 5
});

test('nginx-5xx: pct vs absolute thresholds', async () => {
  const d = tmp();
  const now = Date.now();
  const mk = (ok, bad) => [...Array(ok).fill(jl(new Date(now - 500).toISOString(), 200)), ...Array(bad).fill(jl(new Date(now - 400).toISOString(), 500))].join('\n') + '\n';
  const profile = (e) => ({ nginxJsonLogDir: d, webRoots: [{ env: 'test', domain: 'a.example' }], verifiers: [{ name: 'nginx-5xx', envs: ['test'], ...e }] });
  const ctx = (p) => mkctx(p, { baselineAt: new Date(now - 60e3).toISOString(), baselineCreated: false });
  fs.writeFileSync(path.join(d, 'a.example.json.log'), mk(1000, 3)); // 0.3% & 3 abs => ok
  assert.equal((await nginx5xx.verify(ctx(profile({})))).ok, true);
  fs.writeFileSync(path.join(d, 'a.example.json.log'), mk(100, 1)); // 0.99% > 0.5% => fail
  const r = await nginx5xx.verify(ctx(profile({})));
  assert.equal(r.ok, false);
  assert.equal(r.component, 'nginx-5xx');
  fs.writeFileSync(path.join(d, 'a.example.json.log'), mk(10000, 6)); // 0.06% but 6 > 5 abs => fail
  assert.equal((await nginx5xx.verify(ctx(profile({})))).ok, false);
  assert.equal((await nginx5xx.verify(ctx(profile({ maxAbsolute: 10 })))).ok, true);
  // not configured for env => skipped
  assert.equal((await nginx5xx.verify(mkctx(profile({}), { env: 'prod' }))).skipped, true);
  // watch waits the configured window (injected sleep), prod default 15 / test 3
  const waits = [];
  await nginx5xx.verify({ ...ctx(profile({})), watch: true, sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(waits, [3 * 60000]);
  const pp = profile({});
  pp.webRoots[0].env = 'prod';
  pp.verifiers[0].envs = ['prod'];
  await nginx5xx.verify({ ...mkctx(pp, { env: 'prod' }), watch: true, sleep: async (ms) => waits.push(ms) });
  assert.equal(waits[1], 15 * 60000);
  // dryRun never waits
  await nginx5xx.verify({ ...ctx(profile({})), watch: true, dryRun: true, sleep: async () => assert.fail('must not wait') });
});

test('command: expected exit codes, env filter, timeout, no shell', async () => {
  const profile = { verifiers: [
    { name: 'command', id: 'ok', cmd: process.execPath, args: ['-e', 'process.exit(0)'], envs: ['test'] },
    { name: 'command', id: 'expect-3', cmd: process.execPath, args: ['-e', 'process.exit(3)'], expectExit: 3 },
    { name: 'command', id: 'prod-only', cmd: process.execPath, args: ['-e', 'process.exit(9)'], envs: ['prod'] },
  ] };
  let r = await command.verify(mkctx(profile));
  assert.equal(r.ok, true);
  assert.deepEqual(r.checks.map((c) => c.id), ['ok', 'expect-3']);
  profile.verifiers.push({ name: 'command', id: 'bad', cmd: process.execPath, args: ['-e', 'console.error("kaput");process.exit(1)'] });
  r = await command.verify(mkctx(profile));
  assert.equal(r.ok, false);
  assert.equal(r.component, 'command');
  assert.match(r.details, /bad: exit 1.*kaput/);
  r = await command.verify(mkctx({ verifiers: [{ name: 'command', id: 'slow', cmd: process.execPath, args: ['-e', 'setTimeout(()=>{},5000)'], timeoutMs: 200 }] }));
  assert.equal(r.ok, false);
  assert.match(r.details, /timeout/);
  r = await command.verify(mkctx({ verifiers: [{ name: 'command', id: 'enoent', cmd: '/nonexistent/binary' }] }));
  assert.equal(r.ok, false);
  r = await command.verify(mkctx({ verifiers: [] }));
  assert.equal(r.skipped, true);
});

test('external-hook: parses {ok,details}, rejects garbage/non-zero', async () => {
  const d = tmp();
  const mk = (name, body) => { const f = path.join(d, name); fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return f; };
  const good = mk('good.sh', `echo noise; echo '{"ok":true,"details":"all fine for '"$STACK_ENV"'"}'`);
  const bad = mk('bad.sh', `echo '{"ok":false,"details":{"zone":"home"},"component":"hv"}'; exit 1`);
  const junk = mk('junk.sh', 'echo hello');
  const liar = mk('liar.sh', `echo '{"ok":true}'; exit 2`);
  const profile = (script) => ({ verifiers: [{ name: 'external-hook', id: 'h', script }] });
  let r = await hook.verify(mkctx(profile(good)));
  assert.equal(r.ok, true);
  assert.match(r.checks[0].detail, /all fine for test/);
  r = await hook.verify(mkctx(profile(bad)));
  assert.equal(r.ok, false);
  assert.match(r.details, /zone/);
  assert.equal(r.checks[0].component, 'hv');
  r = await hook.verify(mkctx(profile(junk)));
  assert.equal(r.ok, false);
  assert.match(r.details, /no JSON/);
  r = await hook.verify(mkctx(profile(liar)));
  assert.equal(r.ok, false); // ok:true with non-zero exit is not trusted
  assert.deepEqual(hook.parseResult('x\n{"ok":true}\n'), { ok: true });
});

test('cron-smoke adapter only executes scripts behind a declared + present dry flag', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'profiles', 'example', 'verify', 'cron-smoke.sh'), 'utf8');
  const execs = src.split('\n').filter((l) => /"\$PHP"\s+"\$script"/.test(l) && !/-l\s/.test(l));
  assert.equal(execs.length, 1);
  assert.match(execs[0], /"\$flag"/);
  assert.match(src, /\[ -n "\$flag" \] && grep -qF -- "\$flag" "\$script"/);
});
