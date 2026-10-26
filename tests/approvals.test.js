'use strict';
// Run: node --test scripts/stack-updater/tests/approvals.test.js
// Tier-B approvals: lib/core/approvals.js + rails/ordering in lib/cli.js (+ approve/approvals subcommands).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const approvals = require('../lib/core/approvals');
const cli = require('../lib/cli');

const NOW = new Date('2026-10-31T22:30:00Z');
const ap = (o = {}) => ({ id: 'apt::nginx', target: '1.28.0', approved_by: 'operator', approved_at: '2026-10-26T10:00:00Z', ...o });
const D = (o = {}) => ({ ecosystem: 'apt', scope: '', name: 'nginx', installed: '1.24.0', target: '1.28.0', tier: 'B', action: 'propose', reasons: [], ...o });
const policy = { componentsNeverAuto: ['ubuntu-release'] };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'su-appr-'));

test('load: missing file => empty list; bad schema / bad entry throw; save+load roundtrip', () => {
  const dir = tmp();
  const f = path.join(dir, 'config', 'approvals.json');
  assert.deepEqual(approvals.load(f), { schema: 1, approvals: [] });
  approvals.save(f, { approvals: [ap()] });
  assert.equal(approvals.load(f).approvals[0].id, 'apt::nginx');
  fs.writeFileSync(f, '{"schema":2,"approvals":[]}');
  assert.throws(() => approvals.load(f), /expected \{"schema":1/);
  fs.writeFileSync(f, JSON.stringify({ schema: 1, approvals: [{ id: 'x' }] }));
  assert.throws(() => approvals.load(f), /target is required/);
  fs.writeFileSync(f, '{nope');
  assert.throws(() => approvals.load(f), /invalid JSON/);
});

test('validate: required fields and timestamps', () => {
  assert.deepEqual(approvals.validate(ap()), []);
  assert.ok(approvals.validate(ap({ not_before: 'tomorrow-ish' })).some((e) => /not_before/.test(e)));
  assert.ok(approvals.validate(ap({ approved_by: '' })).length);
});

test('findActive: not_before in the future and consumed approvals are inactive', () => {
  const list = [ap({ not_before: '2026-11-01T00:00:00Z' })];
  assert.equal(approvals.findActive(list, 'apt::nginx', NOW), null);
  assert.ok(approvals.findActive(list, 'apt::nginx', new Date('2026-11-01T00:00:01Z')));
  assert.equal(approvals.findActive([ap({ consumed_at: '2026-10-31T23:00:00Z' })], 'apt::nginx', NOW), null);
  assert.equal(approvals.findActive([ap()], 'apt::other', NOW), null);
  assert.ok(approvals.findActive({ schema: 1, approvals: [ap()] }, 'apt::nginx', NOW)); // file object accepted
});

test('markConsumed: sets consumed_at/run once; then inactive', () => {
  const f = path.join(tmp(), 'approvals.json');
  approvals.save(f, { approvals: [ap()] });
  assert.equal(approvals.markConsumed(f, 'apt::nginx', 'RUN1', NOW), true);
  const e = approvals.load(f).approvals[0];
  assert.equal(e.consumed_run, 'RUN1');
  assert.equal(e.consumed_at, NOW.toISOString());
  assert.equal(approvals.markConsumed(f, 'apt::nginx', 'RUN2', NOW), false);
  assert.equal(approvals.findActive(approvals.load(f), 'apt::nginx', NOW), null);
});

test('applyCoreRails: unapproved tier B stays propose; auto on tier B is still forced to propose', () => {
  assert.equal(cli.applyCoreRails(D(), policy, [], NOW).action, 'propose');
  const r = cli.applyCoreRails(D({ action: 'auto' }), policy, [], NOW);
  assert.equal(r.action, 'propose');
  assert.match(r.reasons.join(), /tier B is never applied automatically/);
  assert.equal(cli.applyCoreRails(D(), policy).action, 'propose'); // no approvals argument at all
  // approval for another id / future not_before / wrong target / consumed: no effect
  for (const a of [ap({ id: 'apt::php' }), ap({ not_before: '2026-12-01T00:00:00Z' }), ap({ target: '9.9.9' }), ap({ consumed_at: '2026-10-30T00:00:00Z' })]) {
    const x = cli.applyCoreRails(D(), policy, [a], NOW);
    assert.equal(x.action, 'propose');
    assert.equal(x.approval, undefined);
  }
});

test('applyCoreRails: tier B with an active approval => approved + reason; candidate-pool target accepted', () => {
  const r = cli.applyCoreRails(D(), policy, [ap({ adapter: 'chan' })], NOW);
  assert.equal(r.action, 'approved');
  assert.equal(r.tier, 'B');
  assert.match(r.reasons.join(), /approved by operator 2026-10-26T10:00:00Z/);
  assert.equal(r.approval.adapter, 'chan');
  const c = cli.applyCoreRails(D({ target: '1.26.0', candidates: [{ version: '1.28.0' }] }), policy, [ap()], NOW);
  assert.equal(c.action, 'approved');
  assert.equal(c.target, '1.28.0');
  // approvals never override componentsNeverAuto or a known regression
  assert.equal(cli.applyCoreRails(D({ name: 'ubuntu-release' }), policy, [ap({ id: 'apt::ubuntu-release' })], NOW).action, 'propose');
  const kr = cli.applyCoreRails(D(), { knownRegressions: { 'nginx@1.28.0': 'bad' } }, [ap()], NOW);
  assert.equal(kr.action, 'hold');
  assert.equal(kr.approval, undefined);
  // tier A is unaffected by approvals
  assert.equal(cli.applyCoreRails(D({ tier: 'A', action: 'auto' }), policy, [ap()], NOW).action, 'auto');
});

test('selectTargets: approved tier B first, then tier-A auto; unapproved B never selected', () => {
  const a1 = D({ ecosystem: 'composer', scope: 's', name: 'a/b', tier: 'A', action: 'auto', target: '1.2.1', installed: '1.2.0' });
  const a2 = D({ ecosystem: 'apt', name: 'jq', tier: 'A', action: 'auto', target: '1.7.1', installed: '1.7.0' });
  const b = cli.applyCoreRails(D(), policy, [ap()], NOW);
  const bUn = D({ name: 'php', tier: 'B', action: 'propose' });
  const cfg = { mode: 'apply-tier-a', flags: {}, policy };
  assert.deepEqual(cli.selectTargets(cfg, [a1, bUn, a2, b]).map((d) => d.name), ['nginx', 'a/b', 'jq']);
  assert.deepEqual(cli.selectTargets(cfg, [a1, bUn]).map((d) => d.name), ['a/b']);
  assert.deepEqual(cli.selectTargets({ ...cfg, mode: 'report-only' }, [b]), []);
  // a hand-made 'approved' decision without an approval entry is not selected
  assert.deepEqual(cli.selectTargets(cfg, [{ ...b, approval: undefined }]), []);
  assert.deepEqual(cli.selectTargets({ ...cfg, flags: { only: 'nginx' } }, [a1, a2, b]).map((d) => d.name), ['nginx']);
});

test('pinAllowed: leaving major.minor only when approved', () => {
  assert.equal(cli.pinAllowed('1.24.0', '1.26.0'), false);
  assert.equal(cli.pinAllowed('1.24.0', '1.26.0', true), true);
  assert.equal(cli.pinAllowed('1.24.0', '1.24.5'), true);
  const cfg = { mode: 'apply-tier-a', policy, flags: { only: 'apt::nginx@1.26.1', force: true, reason: 'drill' } };
  const un = D({ target: null, tier: null, action: 'skip' });
  assert.throws(() => cli.selectTargets(cfg, [un]), /leaves the installed major.minor/);
  const ok = cli.selectTargets(cfg, [cli.applyCoreRails(D(), policy, [ap()], NOW)]);
  assert.equal(ok[0].target, '1.26.1');
  assert.equal(ok[0].action, 'approved');
});

test('approve / approvals CLI: writes, refuses duplicates, validates id, lists', () => {
  const dir = tmp();
  const state = path.join(dir, 'state');
  const profile = path.join(dir, 'profile');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'profile.json'), JSON.stringify({ name: 'x', stateDir: state, repo: dir }));
  const env = { ...process.env, STACK_UPDATER_PROFILE: profile, STACK_UPDATER_STATE_DIR: state, SUDO_USER: 'operator' };
  delete env.STACK_UPDATER_APPROVALS_FILE;
  const run = (...a) => spawnSync('node', [path.join(__dirname, '..', 'lib', 'cli.js'), ...a], { env, encoding: 'utf8' });
  const file = path.join(state, 'config', 'approvals.json');

  let r = run('approvals');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 approvals \(0 active\)/);
  r = run('approve');
  assert.equal(r.status, 2);
  r = run('approve', 'apt::nginx'); // no run, no --target
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--target/);
  r = run('approve', 'apt::nginx', '--target', '1.28.0', '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(file), false);
  r = run('approve', 'apt::nginx', '--target', '1.28.0', '--note', 'channel switch', '--adapter', 'chan', '--not-before', '2026-10-31T22:00:00Z');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /warning: no previous run/);
  const e = approvals.load(file).approvals[0];
  assert.deepEqual([e.id, e.target, e.approved_by, e.adapter, e.note], ['apt::nginx', '1.28.0', 'operator', 'chan', 'channel switch']);
  r = run('approve', 'apt::nginx', '--target', '1.28.0');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /already exists/);
  r = run('approvals');
  assert.match(r.stdout, /apt::nginx\s+1\.28\.0\s+(active|pending)/);
  // with a run present the id must exist in its decisions
  const rd = path.join(state, 'runs', '20261026-0600-report-only');
  fs.mkdirSync(rd, { recursive: true });
  fs.writeFileSync(path.join(rd, 'decisions.json'), JSON.stringify({ decisions: [D({ name: 'php', target: '8.4.1' })] }));
  r = run('approve', 'apt::nope', '--target', '1');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not in the decisions/);
  r = run('approve', 'apt::php', '--by', 'Ana');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(approvals.load(file).approvals[1].target, '8.4.1');
  assert.equal(approvals.load(file).approvals[1].approved_by, 'Ana');
});
