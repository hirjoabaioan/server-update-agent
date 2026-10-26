'use strict';
// Run: node --test scripts/stack-updater/tests/nginx-stable.test.js
// policy.nginx.channel=stable: channel-switch decision, mainline suppression, CHANGES-1.30 dates,
// stable Packages index, adapter plan parsing (fake exec) and the adapter script's plan/dry paths.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const engine = require('../lib/policy/engine');
const cli = require('../lib/cli');
const aptCollector = require('../lib/collectors/apt');
const aptBackup = require('../lib/backup/apt');
const PROFILE_DIR = path.join(ROOT, 'profiles', 'example');
const adapter = require(path.join(PROFILE_DIR, 'plugins', 'adapters', 'nginx-channel-stable.js'));
const SCRIPT = path.join(PROFILE_DIR, 'adapters', 'nginx-channel-stable.sh');

const FIX = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const policy = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'policy.json'), 'utf8'));
const RUN_AT = new Date('2026-10-31T22:00:00Z');
const STABLE_DATES = aptCollector.parse.nginxChanges(FIX('nginx-changes-1.30.txt'));
const MAIN_DATES = aptCollector.parse.nginxChanges(FIX('nginx-changes.txt'));

// Inventory as the apt collector builds it with channel=stable: mainline candidates from madison
// plus stable builds from the stable Packages index (older than installed).
function inventory({ installed = '1.31.3', stable = ['1.30.6', '1.30.5'], mainline = ['1.31.8', '1.31.7'] } = {}) {
  const cand = (v, channel) => ({
    version: v, debVersion: `${v}-1~jammy`, releaseDate: (channel === 'stable' ? STABLE_DATES : MAIN_DATES).get(v)?.date || null,
    source: channel === 'stable' ? 'apt:nginx.org/packages' : 'apt:nginx.org/packages/mainline', security: false, cvss: null, advisories: [],
    rebuild: false, ...(channel === 'stable' ? { channel, notConfigured: true, downgrade: true } : {}),
  });
  return {
    items: [
      { ecosystem: 'apt', name: 'nginx', installed, source: 'dpkg-query', envs: ['test', 'prod'], meta: { group: 'nginx', installedDeb: `${installed}-1~jammy` },
        candidates: [...mainline.map((v) => cand(v, 'mainline')), ...stable.map((v) => cand(v, 'stable'))] },
      { ecosystem: 'eol', name: 'nginx', installed, source: 'endoflife.date', envs: ['test', 'prod'], candidates: [],
        meta: { kind: 'lifecycle', product: 'nginx', cycle: '1.31', lts: false, latest: '1.31.8', latestReleaseDate: '2026-10-21' } },
    ],
  };
}
const entries = (res, name, eco) => res.candidates.filter((c) => c.name === name && c.ecosystem === eco);

// ------------------------------------------------------------------ release dates / index
test('CHANGES-1.30 fixture: stable dates parse; 1.30.6 = 2026-10-14', () => {
  assert.equal(STABLE_DATES.get('1.30.6').date, '2026-10-14');
  assert.equal(STABLE_DATES.get('1.30.0').date, '2026-04-14');
  assert.equal(STABLE_DATES.size, 7);
  assert.equal(aptCollector.parse.isNginxStableSeries('1.30'), true);
  assert.equal(aptCollector.parse.isNginxStableSeries('1.31'), false);
  assert.equal(aptCollector.parse.isNginxStableSeries('1.28'), true);
});

test('nginx date source: odd series reads CHANGES only, even series also CHANGES-<series>', async () => {
  const sysPath = require.resolve('../lib/collectors/_sysUtil');
  const aptPath = require.resolve('../lib/collectors/apt');
  const real = require(sysPath);
  const urls = [];
  require.cache[sysPath].exports = { ...real, httpGet: async (u) => { urls.push(u); return /CHANGES-1\.30$/.test(u) ? FIX('nginx-changes-1.30.txt') : FIX('nginx-changes.txt'); } };
  delete require.cache[aptPath];
  try {
    const fresh = require(aptPath);
    const main = await fresh.dateSources.nginx('1.31');
    assert.equal(main.get('1.31.8').date, '2026-10-21');
    assert.equal(main.has('1.30.6'), false);
    assert.deepEqual(urls, ['https://nginx.org/en/CHANGES']);
    const st = await fresh.dateSources.nginx('1.30');
    assert.equal(st.get('1.30.6').date, '2026-10-14');
    assert.equal(st.get('1.31.8').date, '2026-10-21'); // merged
    assert.ok(urls.includes('https://nginx.org/en/CHANGES-1.30'));
  } finally {
    require.cache[sysPath].exports = real;
    delete require.cache[aptPath];
    require(aptPath);
  }
});

test('stable Packages index: parse nginx versions; index URL derived from the mainline origin', () => {
  const idx = 'Package: nginx\nVersion: 1.30.5-1~jammy\nArchitecture: amd64\n\nPackage: nginx-module-njs\nVersion: 1.30.6+0.9.1-1~jammy\n\nPackage: nginx\nVersion: 1.30.6-1~jammy\n';
  assert.deepEqual(aptCollector.parse.packagesIndex(idx, 'nginx').map((x) => x.version), ['1.30.5-1~jammy', '1.30.6-1~jammy']);
  assert.equal(aptCollector.parse.nginxStableIndexUrl('https://nginx.org/packages/mainline/ubuntu', 'jammy', 'nginx', 'amd64'),
    'https://nginx.org/packages/ubuntu/dists/jammy/nginx/binary-amd64/Packages');
  assert.equal(aptCollector.parse.nginxStableIndexUrl('https://nginx.org/packages/ubuntu', 'jammy', 'nginx', 'amd64'), null);
  assert.equal(aptCollector.parse.nginxStableIndexUrl('x', 'jammy', 'nginx', 'amd64', 'https://mirror/P'), 'https://mirror/P');
});

test('collector: stable extra candidates are listed even though older than installed, with release date', async () => {
  const lookupDate = async (src, v) => (STABLE_DATES.get(v) || MAIN_DATES.get(v) || null);
  const r = aptCollector.buildGroupItem({
    name: 'nginx', group: { group: 'nginx', dates: 'nginx' }, installedDeb: '1.31.3-1~jammy',
    policy: { versions: [] }, madison: [{ version: '1.31.8-1~jammy', url: 'https://nginx.org/packages/mainline/ubuntu', suite: 'jammy' }, { version: '1.31.3-1~jammy', url: 'https://nginx.org/packages/mainline/ubuntu', suite: 'jammy' }],
    lookupDate, extraCandidates: ['1.30.5-1~jammy', '1.30.6-1~jammy'].map((deb) => ({ deb, url: 'https://nginx.org/packages/ubuntu', suite: 'jammy', channel: 'stable' })),
  });
  const it = await r.promise;
  const s = it.candidates.find((c) => c.version === '1.30.6');
  assert.equal(s.debVersion, '1.30.6-1~jammy');
  assert.equal(s.channel, 'stable');
  assert.equal(s.downgrade, true);
  assert.equal(s.releaseDate, '2026-10-14');
  assert.equal(s.source, 'apt:nginx.org/packages');
  assert.ok(it.candidates.find((c) => c.version === '1.31.8'));
});

// ------------------------------------------------------------------ policy decision
test('policy.json: nginx.channel = stable; soak value lets 1.30.6 (2026-10-14) pass on 31.10', () => {
  const p = policy();
  assert.equal(p.nginx.channel, 'stable');
  assert.ok(Math.floor((RUN_AT - Date.parse('2026-10-14')) / 86400000) >= p.patchSoakDays);
});

test('channel stable + installed 1.31.3 -> tier-B channel-switch to 1.30.6 (deb target, releaseDate from CHANGES-1.30)', () => {
  const res = engine.compute(inventory(), policy(), { now: RUN_AT });
  const sw = entries(res, 'nginx', 'apt').find((c) => c.line === 'switch');
  assert.equal(sw.kind, 'channel-switch');
  assert.equal(sw.tier, 'B');
  assert.equal(sw.status, 'eligible');
  assert.equal(sw.action, 'propose');
  assert.equal(sw.target, '1.30.6-1~jammy');
  assert.equal(sw.targetUpstream, '1.30.6');
  assert.equal(sw.releaseDate, '2026-10-14');
  assert.equal(sw.question, undefined);
  assert.ok(sw.altTargets.includes('1.30.5-1~jammy') && sw.altTargets.includes('1.30.6'));
});

test('channel stable: mainline 1.31.x candidates are never proposed (apt tier A, eol bump/latest)', () => {
  const res = engine.compute(inventory(), policy(), { now: RUN_AT });
  for (const eco of ['apt', 'eol']) {
    for (const e of entries(res, 'nginx', eco)) {
      assert.ok(!(e.target && /^1\.31\./.test(e.target)), `${eco} ${e.line} proposes ${e.target}`);
      assert.notEqual(e.tier, 'A');
    }
  }
  const base = entries(res, 'nginx', 'eol').find((c) => c.line === 'patch');
  assert.ok((base.rejected || []).some((r) => r.version === '1.31.8' && /mainline/.test(r.why)));
  assert.equal(entries(res, 'nginx', 'eol').some((c) => c.line === 'switch'), false); // switch only on apt::nginx
});

test('channel stable: plugin decision for apt::nginx is the channel-switch; approval matches; ordered before tier A', () => {
  const inv = inventory();
  const ds = engine.evaluate(inv.items, { policy: policy() });
  const d = ds.find((x) => x.ecosystem === 'apt' && x.name === 'nginx');
  assert.equal(d.tier, 'B');
  assert.equal(d.kind, 'channel-switch');
  assert.equal(d.target, '1.30.6-1~jammy');
  const eol = ds.find((x) => x.ecosystem === 'eol');
  assert.ok(!eol.target || !/^1\.31\./.test(eol.target));
  // compute() uses the wall clock inside evaluate(); the date-sensitive part is covered above.
  const ap = { id: 'apt::nginx', target: '1.30.6-1~jammy', approved_by: 'operator', approved_at: '2026-10-26T12:00:00Z', not_before: '2026-10-31T22:00:00Z', adapter: 'nginx-channel-stable' };
  const before = cli.applyCoreRails({ ...d, target: '1.30.6-1~jammy' }, policy(), [ap], new Date('2026-10-31T21:59:00Z'));
  assert.notEqual(before.action, 'approved');
  const rd = cli.applyCoreRails({ ...d, target: '1.30.6-1~jammy' }, policy(), [ap], RUN_AT);
  assert.equal(rd.action, 'approved');
  assert.equal(rd.approval.adapter, 'nginx-channel-stable');
  // a newer stable becoming the decision target keeps the approval valid via candidates
  const rd2 = cli.applyCoreRails({ ...d, target: '1.30.7-1~jammy', candidates: [...d.candidates, '1.30.7-1~jammy'] }, policy(), [ap], RUN_AT);
  assert.equal(rd2.action, 'approved');
  assert.equal(rd2.target, '1.30.6-1~jammy');
  const a = { ecosystem: 'apt', name: 'jq', installed: '1.7.0', target: '1.7.1', tier: 'A', action: 'auto', reasons: [] };
  assert.deepEqual(cli.selectTargets({ mode: 'apply-tier-a', flags: {}, policy: policy() }, [a, rd]).map((x) => x.name), ['nginx', 'jq']);
});

test('channel stable: newest stable not soaked -> hold with eligibleOn; no stable in pool -> blocked', () => {
  const res = engine.compute(inventory({ stable: ['1.30.6'] }), policy(), { now: new Date('2026-10-18T00:00:00Z') });
  const sw = entries(res, 'nginx', 'apt').find((c) => c.line === 'switch');
  assert.equal(sw.status, 'soak');
  assert.equal(sw.action, 'hold');
  assert.equal(sw.pending.eligibleOn, '2026-10-21');
  const none = engine.compute(inventory({ stable: [] }), policy(), { now: RUN_AT });
  assert.equal(entries(none, 'nginx', 'apt').find((c) => c.line === 'switch').status, 'blocked');
});

test('channel stable + installed stable 1.30.5: no switch, tier A patch within 1.30 only', () => {
  const inv = inventory({ installed: '1.30.5', stable: [], mainline: ['1.31.8'] });
  inv.items[0].candidates.push({ version: '1.30.6', debVersion: '1.30.6-1~jammy', releaseDate: '2026-10-14', source: 'apt:nginx.org/packages', security: false, rebuild: false });
  const res = engine.compute(inv, policy(), { now: RUN_AT });
  const apt = entries(res, 'nginx', 'apt');
  assert.equal(apt.some((c) => c.line === 'switch'), false);
  const p = apt.find((c) => c.line === 'patch');
  assert.equal(p.tier, 'A');
  assert.equal(p.target, '1.30.6');
});

test('no channel key: legacy mainline->stable question kept', () => {
  const p = policy(); delete p.nginx;
  const res = engine.compute(inventory(), p, { now: RUN_AT });
  assert.ok(res.candidates.some((c) => c.line === 'switch' && c.question === 'mainline->stable'));
});

// ------------------------------------------------------------------ backup core / adapter plugin
test('lib/backup/apt.js skips targets owned by an approval adapter (no apt-get -s planning)', async () => {
  const b = aptBackup.make({ run: () => { throw new Error('must not run'); } });
  const r = await b.backup([{ ecosystem: 'apt', name: 'nginx', target: '1.30.6-1~jammy', approval: { id: 'apt::nginx', adapter: 'nginx-channel-stable' } }],
    { dryRun: true, profile: {}, run: { backupDir: os.tmpdir() }, log: { info() {} } });
  assert.deepEqual(r.entries, []);
});

const PLAN_OUT = [
  'PLAN adapter=nginx-channel-stable', 'PLAN installed=1.31.3-1~jammy', 'PLAN target=1.30.6-1~jammy', 'PLAN direction=downgrade',
  'PLAN source.new=deb [arch=amd64 signed-by=/usr/share/keyrings/nginx-keyring.gpg] https://nginx.org/packages/ubuntu/ jammy nginx',
  'PLAN pin.file=/etc/apt/preferences.d/99-nginx-stable',
  'PIN Package: nginx*', 'PIN Pin: version /^[0-9]+\\.[0-9]*[02468]\\./', 'PIN Pin-Priority: 1001',
  'CMD apt-get install -y --allow-downgrades -o Dpkg::Options::=--force-confold nginx=1.30.6-1~jammy',
].join('\n');

test('adapter parsePlan: source line, pin content and install command', () => {
  const p = adapter.parsePlan(PLAN_OUT);
  assert.equal(p.plan.target, '1.30.6-1~jammy');
  assert.equal(p.plan.direction, 'downgrade');
  assert.match(p.plan['source.new'], /^deb \[arch=amd64 signed-by=\/usr\/share\/keyrings\/nginx-keyring\.gpg\] https:\/\/nginx\.org\/packages\/ubuntu\/ jammy nginx$/);
  assert.equal(p.pinContent, 'Package: nginx*\nPin: version /^[0-9]+\\.[0-9]*[02468]\\./\nPin-Priority: 1001');
  assert.equal(p.installCmd, 'apt-get install -y --allow-downgrades -o Dpkg::Options::=--force-confold nginx=1.30.6-1~jammy');
});

function fakeExec(results = {}) {
  const calls = [];
  return {
    calls,
    exec: async (file, args) => {
      calls.push(args.slice(1).join(' '));
      const sub = args[1];
      if (sub === 'plan') return { code: 0, stdout: PLAN_OUT, stderr: '' };
      return results[sub] || { code: 0, stdout: `OK ${sub}`, stderr: '' };
    },
  };
}
const ctxOf = (o = {}) => ({ profile: {}, profileDir: PROFILE_DIR, mode: 'apply-tier-a', dryRun: false, window: { ok: true }, run: { backupDir: '/tmp/run-x/backup' },
  log: { info() {}, error() {}, warn() {} }, ...o });
const T = { ecosystem: 'apt', name: 'nginx', installed: '1.31.3', target: '1.30.6-1~jammy', tier: 'B', action: 'approved', approval: { id: 'apt::nginx', adapter: 'nginx-channel-stable' } };

test('adapter plugin (fake exec): plan -> apply -> verify; failed verify triggers rollback; refusals', async () => {
  let f = fakeExec();
  let r = await adapter.make({ exec: f.exec }).apply([T], ctxOf());
  assert.equal(r.applied.length, 1);
  assert.deepEqual(f.calls, ['plan --target 1.30.6-1~jammy', 'apply --target 1.30.6-1~jammy --backup-dir /tmp/run-x/backup/nginx-channel-stable', 'verify --target 1.30.6-1~jammy']);
  f = fakeExec({ verify: { code: 1, stdout: 'FAIL nginx -v 1.31.3 != 1.30.6', stderr: '' } });
  r = await adapter.make({ exec: f.exec }).apply([T], ctxOf());
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].reason, /verify failed.*rollback ok/);
  assert.equal(f.calls[f.calls.length - 1], 'rollback --backup-dir /tmp/run-x/backup/nginx-channel-stable');
  f = fakeExec();
  r = await adapter.make({ exec: f.exec }).apply([T, { ...T, approval: { id: 'apt::nginx' } }], ctxOf({ dryRun: true }));
  assert.equal(r.failed.length, 1); // only the owned target, refused in dry-run
  assert.equal(f.calls.length, 0);
  r = await adapter.make({ exec: f.exec }).apply([{ ...T, action: 'propose' }], ctxOf());
  assert.match(r.failed[0].reason, /approval/);
  const bk = await adapter.make({ exec: f.exec }).backup([T, { ...T, name: 'jq', approval: null }], ctxOf({ dryRun: true }));
  assert.equal(bk.entries.length, 1);
  assert.equal(bk.entries[0].component, 'apt:nginx');
  assert.equal(f.calls[f.calls.length - 1], 'backup --backup-dir /tmp/run-x/backup/nginx-channel-stable --dry-run');
  assert.deepEqual(await adapter.make({ exec: f.exec }).restore(bk.entries[0], ctxOf()), { ok: true, detail: 'dry-run entry, nothing to restore' });
});

test('plugin loader: adapter is an adapters + backup plugin of the profile', () => {
  const { loadPlugins } = require('../lib/core/plugins');
  const cfg = { profileDir: PROFILE_DIR, profile: {} };
  assert.ok(loadPlugins('adapters', cfg).some((p) => p.name === 'nginx-channel-stable'));
  assert.ok(loadPlugins('backup', cfg).some((p) => p.name === 'nginx-channel-stable'));
});

// ------------------------------------------------------------------ adapter script (no side effects)
const hasBash = spawnSync('bash', ['-c', 'command -v dpkg-query jq']).status === 0;
test('adapter script: bash -n; plan prints source line, pin and install command without touching files', { skip: !hasBash && 'needs bash + dpkg-query + jq' }, () => {
  assert.equal(spawnSync('bash', ['-n', SCRIPT]).status, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'su-nginx-'));
  const list = path.join(dir, 'nginx.list');
  const pin = path.join(dir, '99-nginx-stable');
  const mainline = 'deb [arch=amd64 signed-by=/usr/share/keyrings/nginx-keyring.gpg] https://nginx.org/packages/mainline/ubuntu/ jammy nginx\n';
  fs.writeFileSync(list, mainline);
  const fakeDpkgQuery = path.join(dir, 'dpkg-query');
  fs.writeFileSync(fakeDpkgQuery, '#!/bin/sh\nprintf "1.31.3-1~jammy\\tii \\n"\n', { mode: 0o755 });
  const env = { ...process.env, NGINX_LIST: list, PIN_FILE: pin, SUITE: 'jammy', ARCH: 'amd64', DPKG_QUERY: fakeDpkgQuery };
  const r = spawnSync('bash', [SCRIPT, 'plan', '--target', '1.30.6-1~jammy'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const p = adapter.parsePlan(r.stdout);
  assert.equal(p.plan['source.new'], 'deb [arch=amd64 signed-by=/usr/share/keyrings/nginx-keyring.gpg] https://nginx.org/packages/ubuntu/ jammy nginx');
  assert.equal(p.plan['source.current'], mainline.trim());
  assert.match(p.pinContent, /Package: nginx\*\nPin: version \/\^\[0-9\]\+\\\.\[0-9\]\*\[02468\]\\\.\/\nPin-Priority: 1001$/);
  assert.equal(p.installCmd, 'apt-get install -y --allow-downgrades -o Dpkg::Options::=--force-confold nginx=1.30.6-1~jammy');
  // apply --dry-run with fake binaries: nothing written
  const fakeBin = path.join(dir, 'fake.sh');
  fs.writeFileSync(fakeBin, '#!/bin/sh\necho "fake $*" >> "$(dirname "$0")/calls.log"\n', { mode: 0o755 });
  const d = spawnSync('bash', [SCRIPT, 'apply', '--target', '1.30.6-1~jammy', '--backup-dir', path.join(dir, 'bk'), '--dry-run'],
    { env: { ...env, APT_GET: fakeBin, NGINX_BIN: fakeBin, DPKG_REPACK: fakeBin }, encoding: 'utf8' });
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /DRY: write .*nginx\.list: deb \[arch=amd64 .*\] https:\/\/nginx\.org\/packages\/ubuntu\/ jammy nginx/);
  assert.equal(fs.readFileSync(list, 'utf8'), mainline);
  assert.equal(fs.existsSync(pin), false);
  assert.equal(fs.existsSync(path.join(dir, 'bk')), false);
  assert.equal(fs.existsSync(path.join(dir, 'calls.log')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
