'use strict';
// Run: node --test scripts/stack-updater/tests/runner.test.js
// `update` orchestration (lib/core/pipeline.js) with a fake plugin set living in a temp profile
// (profile.plugins.<kind>.only = ['fake'], so no core plugin touches the host).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { cmdUpdate } = require('../lib/cli');
const { loadConfig } = require('../lib/core/config');
const { acquireRunLock } = require('../lib/core/lock');
const { groupTargets } = require('../lib/core/pipeline');

const IN_WINDOW = new Date('2026-10-31T22:30:00Z'); // Saturday 22:30 UTC
const OFF_WINDOW = new Date('2026-10-30T10:00:00Z'); // Friday

const FAKES = {
  collectors: `module.exports = { name: 'fake', async collect() { return globalThis.__fake.items; } };`,
  policy: `module.exports = { name: 'fake', async evaluate(items) {
    return items.map((it) => ({ ecosystem: it.ecosystem, scope: it.scope, name: it.name, installed: it.installed,
      target: it.meta.target, tier: it.meta.tier, action: 'auto', component: it.meta.component, envs: it.envs, reasons: ['fake'] })); } };`,
  backup: `module.exports = { name: 'fake',
    async backup(targets, ctx) { globalThis.__fake.calls.push({ op: 'backup', targets: targets.map((t) => t.component) });
      return { entries: targets.map((t) => ({ component: t.component, ecosystem: t.ecosystem, scope: t.scope || null, name: t.name, env: null, artifact: 'x' })) }; },
    async restore(entry, ctx) { globalThis.__fake.calls.push({ op: 'restore', component: entry.component, env: ctx.env }); return { ok: true }; } };`,
  appliers: `module.exports = { name: 'fake', async apply(targets, ctx) {
    globalThis.__fake.calls.push({ op: 'apply', env: ctx.env, component: ctx.component, targets: targets.map((t) => t.name) });
    const silent = globalThis.__fake.silent || [];
    return { applied: targets.filter((t) => !silent.includes(t.name)).map((t) => ({ name: t.name, target: t.target })), failed: [] }; } };`,
  verifiers: `module.exports = { name: 'fake', async verify(ctx) {
    globalThis.__fake.calls.push({ op: 'verify', env: ctx.env, component: ctx.component, watch: ctx.watch });
    const f = globalThis.__fake.fail;
    const bad = f && f.component === ctx.component && f.env === ctx.env;
    return { ok: !bad, checks: [{ id: 'fake', ok: !bad }] }; } };`,
};

function makeProfile(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'su-runner-'));
  for (const [kind, src] of Object.entries(FAKES)) {
    fs.mkdirSync(path.join(dir, 'plugins', kind), { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugins', kind, 'fake.js'), src);
  }
  const only = { only: ['fake'] };
  const profile = {
    name: 'fake', stateDir: path.join(dir, 'state'), repo: dir, webRoots: [], deployLocks: [], securityWatch: { enabled: false },
    maintenanceWindow: { dow: 6, hour: 22, tz: 'UTC' },
    plugins: { collectors: only, policy: only, analyst: { only: [] }, backup: only, appliers: only, verifiers: only, reporter: { only: [] } },
    ...extra,
  };
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(profile));
  return dir;
}

const item = (name, ecosystem, component, tier = 'A') => ({ ecosystem, scope: null, name, installed: '1.0.0', candidates: [], source: 'fake', meta: { target: '1.0.1', tier, component } });

async function runUpdate(profileDir, { mode, now = IN_WINDOW, flags = {}, deps = {} } = {}) {
  const cfg = loadConfig({ profile: profileDir, mode });
  cfg.flags = flags;
  let out = '';
  let err = '';
  const code = await cmdUpdate(cfg, { quiet: true, 'no-notify': true, ...flags }, {
    deps: { now: () => now, stdout: (s) => { out += s; }, stderr: (s) => { err += s; }, ...deps },
  });
  return { code, out, err, cfg };
}

function reset(items, fail = null) {
  globalThis.__fake = { items, calls: [], fail };
  return globalThis.__fake.calls;
}

const ops = (calls, op) => calls.filter((c) => c.op === op);

test('mode report-only never calls backup/apply; tier B becomes a proposal entry', async () => {
  const dir = makeProfile();
  const calls = reset([item('libfoo', 'composer', 'composer:test-site'), item('bigthing', 'apt', 'bigthing', 'B')]);
  const r = await runUpdate(dir, { mode: 'report-only' });
  assert.equal(r.code, 0);
  assert.equal(ops(calls, 'backup').length, 0);
  assert.equal(ops(calls, 'apply').length, 0);
  assert.equal(ops(calls, 'restore').length, 0);
  const runId = r.out.trim().split(' ')[0];
  const summary = JSON.parse(fs.readFileSync(path.join(r.cfg.stateDir, 'runs', runId, 'summary.json'), 'utf8'));
  assert.equal(summary.status, 'ok');
  assert.ok(summary.proposals.some((p) => p.component === 'apt::bigthing' && p.tier === 'B'));
  assert.ok(fs.existsSync(path.join(r.cfg.stateDir, 'runs', runId, 'run.log')));
});

test('mode defaults to report-only and is read from STACK_UPDATER_MODE_FILE', async () => {
  const dir = makeProfile();
  const cfg = loadConfig({ profile: dir });
  assert.equal(cfg.mode, 'report-only');
  const mf = path.join(dir, 'modefile');
  const bin = path.join(ROOT, 'bin', 'stack-update');
  const env = { ...process.env, STACK_UPDATER_MODE_FILE: mf };
  const set = spawnSync('bash', [bin, 'mode', 'apply-tier-a'], { env, encoding: 'utf8' });
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /mode set: \(none\) -> apply-tier-a/);
  assert.equal(fs.readFileSync(mf, 'utf8').trim(), 'apply-tier-a');
  const bad = spawnSync('bash', [bin, 'mode', 'yolo'], { env, encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.equal(fs.readFileSync(mf, 'utf8').trim(), 'apply-tier-a');
});

test('apply-tier-a outside the window refuses before any stage (also with --dry-run)', async () => {
  const dir = makeProfile();
  const calls = reset([item('libfoo', 'composer', 'composer:test-site')]);
  for (const dry of [false, true]) {
    const cfg = loadConfig({ profile: dir, mode: 'apply-tier-a', dryRun: dry });
    let out = '';
    const code = await cmdUpdate(cfg, { quiet: true, 'no-notify': true }, { deps: { now: () => OFF_WINDOW, stdout: (s) => { out += s; }, stderr: () => {} } });
    assert.equal(code, 1);
    assert.match(out, /refused: outside maintenance window \(Sat 22:00–23:59 UTC; next 2026-10-31 22:00 UTC\)/);
  }
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'state', 'runs')), false);
  // --force without --reason is refused too; with a reason it proceeds.
  let r = await runUpdate(dir, { mode: 'apply-tier-a', now: OFF_WINDOW, flags: { force: true } });
  assert.equal(r.code, 1);
  r = await runUpdate(dir, { mode: 'apply-tier-a', now: OFF_WINDOW, flags: { force: true, reason: 'CVE hotfix' } });
  assert.equal(r.code, 0, r.out);
});

test('verify failure rolls back only that component and the run continues', async () => {
  const dir = makeProfile();
  const calls = reset([
    item('liba', 'composer', 'composer:bad-site'),
    item('libb', 'composer', 'composer:good-site'),
    item('nginx', 'apt', 'nginx'),
  ], { component: 'composer:bad-site', env: 'test' });
  const r = await runUpdate(dir, { mode: 'apply-tier-a' });
  assert.equal(r.code, 1); // partial
  const restores = ops(calls, 'restore');
  assert.ok(restores.length > 0);
  assert.deepEqual([...new Set(restores.map((c) => c.component))], ['composer:bad-site']);
  const applied = ops(calls, 'apply').map((c) => `${c.component}@${c.env}`);
  assert.deepEqual(applied, ['composer:bad-site@test', 'composer:good-site@test', 'composer:good-site@prod', 'nginx@prod']);
  // shared system component: TEST verify before (no watch), PROD verify after (watch).
  const nginxVerifies = ops(calls, 'verify').filter((c) => c.component === 'nginx').map((c) => `${c.env}:${c.watch}`);
  assert.deepEqual(nginxVerifies, ['test:false', 'prod:true']);
  const runId = r.out.trim().split(' ')[0];
  const runDir = path.join(r.cfg.stateDir, 'runs', runId);
  const summary = JSON.parse(fs.readFileSync(path.join(runDir, 'summary.json'), 'utf8'));
  assert.equal(summary.status, 'partial');
  assert.equal(summary.incidents.length, 1);
  assert.equal(summary.incidents[0].component, 'composer:bad-site');
  assert.match(fs.readFileSync(path.join(runDir, 'report.md'), 'utf8'), /## Incidents[\s\S]*composer:bad-site verify@test/);
  const backup = JSON.parse(fs.readFileSync(path.join(runDir, 'backup.json'), 'utf8'));
  assert.equal(backup.entries.length, 3);
  assert.ok(fs.existsSync(path.join(runDir, 'apply-test.json')) && fs.existsSync(path.join(runDir, 'verify-prod.json')));
});

test('held run lock => exit 0 "another run active"; young deploy lock => skip + note', async () => {
  const dir = makeProfile();
  const calls = reset([item('libfoo', 'composer', 'composer:test-site')]);
  const held = acquireRunLock(path.join(dir, 'state'));
  try {
    const r = await runUpdate(dir, { mode: 'report-only' });
    assert.equal(r.code, 0);
    assert.match(r.out, /another run active/);
  } finally { held.release(); }

  const lock = path.join(dir, 'deploy.lock');
  fs.writeFileSync(lock, '');
  const dir2 = makeProfile({ deployLocks: [lock] });
  const notes = [];
  const r2 = await runUpdate(dir2, { mode: 'report-only', flags: { 'no-notify': false }, deps: { notifyText: (t) => notes.push(t) } });
  assert.equal(r2.code, 0);
  assert.match(r2.out, /skipped: deploy in progress/);
  assert.equal(notes.length, 1);
  assert.equal(calls.length, 0);
});

test('groupTargets: env-specific vs shared components', () => {
  const g = groupTargets([
    { ecosystem: 'apt', name: 'php8.3-fpm', component: 'php8.3' },
    { ecosystem: 'apt', name: 'php8.3-cli', component: 'php8.3' },
    { ecosystem: 'vendor-js', scope: 'assets/vendor', name: 'select2' },
  ]);
  assert.deepEqual(g.map((x) => [x.component, x.shared, x.targets.length]), [['php8.3', true, 2], ['vendor-js:assets/vendor', false, 1]]);
});

test('rail: a target no applier reports is an apply failure (rolled back), not a silent pass', async () => {
  const dir = makeProfile();
  const calls = reset([item('liba', 'composer', 'composer:site')]);
  globalThis.__fake.silent = ['liba'];
  const r = await runUpdate(dir, { mode: 'apply-tier-a' });
  assert.equal(r.code, 1);
  const summary = JSON.parse(fs.readFileSync(path.join(r.cfg.stateDir, 'runs', r.out.trim().split(' ')[0], 'summary.json'), 'utf8'));
  assert.equal(summary.incidents.length, 1);
  assert.equal(summary.incidents[0].stage, 'apply');
  assert.match(summary.incidents[0].applyFailures[0].reason, /no applier handled composer::liba/);
  assert.deepEqual(ops(calls, 'restore').map((c) => c.component), ['composer:site']);
  assert.equal(ops(calls, 'apply').filter((c) => c.env === 'prod').length, 0);
});

test('rail: env-specific component without a TEST copy is recorded as such and still reaches PROD', async () => {
  const dir = makeProfile();
  const calls = reset([{ ...item('libp', 'composer', 'composer:prod-only'), envs: ['prod'] }]);
  const r = await runUpdate(dir, { mode: 'apply-tier-a' });
  assert.equal(r.code, 0);
  assert.deepEqual(ops(calls, 'apply').map((c) => c.env), ['prod']);
  const summary = JSON.parse(fs.readFileSync(path.join(r.cfg.stateDir, 'runs', r.out.trim().split(' ')[0], 'summary.json'), 'utf8'));
  assert.ok(summary.components[0].steps.some((x) => x.step === 'test' && /no TEST copy/.test(x.detail)));
});

// ---- tier-B approvals: consumed after PROD verify ok, left active after rollback
function writeApprovals(dir, list) {
  const f = path.join(dir, 'state', 'config', 'approvals.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ schema: 1, approvals: list }));
  return f;
}
const APPROVAL = { id: 'apt::bigb', target: '1.0.1', approved_by: 'operator', approved_at: '2026-10-26T10:00:00Z' };

test('approved tier B is applied before tier A and its approval is consumed after PROD verify ok', async () => {
  const dir = makeProfile();
  const f = writeApprovals(dir, [APPROVAL]);
  const calls = reset([item('liba', 'apt', 'liba'), item('bigb', 'apt', 'bigb', 'B'), item('unapproved', 'apt', 'unapproved', 'B')]);
  const r = await runUpdate(dir, { mode: 'apply-tier-a' });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(ops(calls, 'apply').map((c) => c.component), ['bigb', 'liba']);
  assert.equal(ops(calls, 'apply').flatMap((c) => c.targets).includes('unapproved'), false);
  const e = JSON.parse(fs.readFileSync(f, 'utf8')).approvals[0];
  assert.ok(e.consumed_at);
  assert.equal(e.consumed_run, r.out.trim().split(' ')[0]);
  // consumed => the next run no longer applies it
  const calls2 = reset([item('bigb', 'apt', 'bigb', 'B')]);
  await runUpdate(dir, { mode: 'apply-tier-a' });
  assert.equal(ops(calls2, 'apply').length, 0);
});

test('rollback leaves the approval active and records a blocker; dry-run consumes nothing', async () => {
  const dir = makeProfile();
  const f = writeApprovals(dir, [APPROVAL]);
  const calls = reset([item('bigb', 'apt', 'bigb', 'B')], { component: 'bigb', env: 'prod' });
  const r = await runUpdate(dir, { mode: 'apply-tier-a' });
  assert.equal(r.code, 1);
  assert.ok(ops(calls, 'restore').length > 0);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).approvals[0].consumed_at, undefined);
  const summary = JSON.parse(fs.readFileSync(path.join(r.cfg.stateDir, 'runs', r.out.trim().split(' ')[0], 'summary.json'), 'utf8'));
  assert.equal(summary.blockers.length, 1);
  assert.match(summary.blockers[0].note, /approval left active/);
  reset([item('bigb', 'apt', 'bigb', 'B')]);
  const dcfg = loadConfig({ profile: dir, mode: 'apply-tier-a', dryRun: true });
  await cmdUpdate(dcfg, { quiet: true, 'no-notify': true }, { deps: { now: () => IN_WINDOW, stdout: () => {}, stderr: () => {} } });
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).approvals[0].consumed_at, undefined);
});

test('adapter approval routes the target to the profile adapter plugin, not the generic applier', async () => {
  const dir = makeProfile({ plugins: { collectors: { only: ['fake'] }, policy: { only: ['fake'] }, analyst: { only: [] }, backup: { only: ['fake'] }, appliers: { only: ['fake'] }, verifiers: { only: ['fake'] }, reporter: { only: [] }, adapters: { only: ['chan'] } } });
  fs.mkdirSync(path.join(dir, 'plugins', 'adapters'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins', 'adapters', 'chan.js'), `module.exports = { name: 'chan', async apply(targets, ctx) {
    globalThis.__fake.calls.push({ op: 'adapter', env: ctx.env, targets: targets.map((t) => t.name) });
    return { applied: targets.map((t) => ({ name: t.name, target: t.target })), failed: [] }; } };`);
  const f = writeApprovals(dir, [{ ...APPROVAL, adapter: 'chan' }]);
  const calls = reset([item('bigb', 'apt', 'bigb', 'B')]);
  const r = await runUpdate(dir, { mode: 'apply-tier-a' });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(ops(calls, 'adapter').map((c) => c.targets), [['bigb']]);
  assert.equal(ops(calls, 'apply').length, 0);
  assert.ok(JSON.parse(fs.readFileSync(f, 'utf8')).approvals[0].consumed_at);
});
