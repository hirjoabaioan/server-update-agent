'use strict';
// Run: node --test scripts/stack-updater/tests   (mocked shell — never calls real dpkg/apt)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const aptMod = require('../lib/backup/apt');
const bundleMod = require('../lib/backup/bundle');
const win = require('../lib/core/window');

const DAY = '20261023';
const NOW = new Date(Date.UTC(2026, 9, 23, 10, 0));

// Fake host: dpkg state + scripted commands. Records every call.
function fakeHost({ pkgs, upgrades = {}, fail = {}, logDir = null, policyRcD }) {
  const state = { ...pkgs };
  const held = new Set();
  const calls = [];
  const seen = { policyDuringInstall: null };
  const run = (cmd, args = [], opts = {}) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    for (const [re, res] of Object.entries(fail)) if (new RegExp(re).test(line)) return { status: 1, stdout: '', stderr: res };
    if (cmd === 'dpkg-query') {
      const p = args[args.length - 1];
      return state[p] ? { status: 0, stdout: `${state[p]}\tii `, stderr: '' } : { status: 1, stdout: '', stderr: 'no packages found' };
    }
    if (cmd === 'apt-get' && args[0] === '-s') {
      const out = Object.entries(upgrades).map(([p, to]) => `Inst ${p} [${state[p]}] (${to} Fake:1 [amd64])`).join('\n');
      return { status: 0, stdout: `Reading...\n${out}\n`, stderr: '' };
    }
    if (cmd === 'apt-get' && args[0] === 'install') {
      seen.policyDuringInstall = fs.existsSync(policyRcD) ? fs.readFileSync(policyRcD, 'utf8') : null;
      seen.installEnv = opts.env;
      for (const [p, to] of Object.entries(upgrades)) state[p] = to;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'apt-cache') return { status: 0, stdout: Object.entries(upgrades).map(([p, v]) => ` ${p} | ${v} | http://x focal/main`).join('\n'), stderr: '' };
    if (cmd === 'dpkg-repack') {
      const p = args[0];
      fs.writeFileSync(path.join(opts.cwd, `${p}_${state[p].replace(/^\d+:/, '')}_amd64.deb`), `deb:${p}:${state[p]}`);
      return { status: 0, stdout: `dpkg-deb: building package '${p}'`, stderr: '' };
    }
    if (cmd === 'dpkg-deb') return { status: 0, stdout: ' new Debian package', stderr: '' };
    if (cmd === 'dpkg' && args[0] === '-i') {
      seen.policyDuringInstall = fs.existsSync(policyRcD) ? fs.readFileSync(policyRcD, 'utf8') : null;
      for (const f of args.slice(1)) { const [p, v] = fs.readFileSync(f, 'utf8').split(':').slice(1); state[p] = v; }
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'apt-mark') {
      if (args[0] === 'showhold') return { status: 0, stdout: [...held].join('\n'), stderr: '' };
      for (const p of args.slice(1)) (args[0] === 'hold' ? held.add(p) : held.delete(p));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'systemctl' || cmd === 'nginx') return { status: 0, stdout: 'active', stderr: '' };
    if (logDir && cmd.endsWith('db.sh')) return { status: 0, stdout: 'dump ok', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls, state, held, seen };
}

function setup(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'su-apt-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const logDir = path.join(tmp, 'logs');
  fs.mkdirSync(logDir);
  fs.writeFileSync(path.join(logDir, 'a.json.log'), '');
  const runDir = path.join(tmp, 'runs', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  const msgs = [];
  const log = { info: (m, d) => msgs.push(['info', m, d]), warn: (m, d) => msgs.push(['warn', m, d]), error: (m, d) => msgs.push(['error', m, d]), debug() {} };
  const ctx = (extra = {}) => ({
    profile: { pkgRollbackDir: path.join(tmp, 'pkg-rollback'), phpFpmService: 'php8.3-fpm', nginxJsonLogDir: logDir, backupDbScript: path.join(tmp, 'backup_db.sh') },
    policy: { fivexxWindowSeconds: 1 }, mode: 'report-only', dryRun: false, run: { id: 'r1', dir: runDir, backupDir: path.join(tmp, 'backups', 'r1') },
    log, profileDir: tmp, repoPath: (p) => path.join(tmp, p), ...extra,
  });
  return { tmp, logDir, runDir, ctx, msgs, policyRcD: path.join(tmp, 'policy-rc.d') };
}

// sleep() appends nginx JSON log lines so before/after 5xx windows are measurable.
function sleeper(logDir, batches) {
  let i = 0;
  return async () => {
    const lines = batches[i++] || [];
    fs.appendFileSync(path.join(logDir, 'a.json.log'), lines.map((s) => JSON.stringify({ time: 'x', status: s })).join('\n') + (lines.length ? '\n' : ''));
  };
}

test('window: Saturday 22:00–23:59 UTC, --force needs a reason, critical off-window = notify only', () => {
  const profile = { maintenanceWindow: { dow: 6, hour: 22, tz: 'UTC' } };
  assert.equal(win.checkWindow({ profile, now: new Date(Date.UTC(2026, 9, 24, 22, 30)) }).ok, true);
  assert.equal(win.checkWindow({ profile, now: new Date(Date.UTC(2026, 9, 24, 23, 59)) }).ok, true);
  assert.equal(win.checkWindow({ profile, now: new Date(Date.UTC(2026, 9, 24, 21, 59)) }).ok, false);
  assert.equal(win.checkWindow({ profile, now: new Date(Date.UTC(2026, 9, 25, 0, 0)) }).ok, false);
  const fri = new Date(Date.UTC(2026, 9, 23, 22, 30));
  assert.match(win.checkWindow({ profile, now: fri, force: true }).reason, /requires --reason/);
  const forced = win.checkWindow({ profile, now: fri, force: true, reason: 'CVE hotfix' });
  assert.equal(forced.ok, true);
  assert.equal(forced.forced, true);
  const crit = win.checkWindow({ profile, now: fri, targets: [{ name: 'openssl', security: true, cvss: 9.8 }] });
  assert.equal(crit.ok, false);
  assert.equal(crit.notifyOnly, true);
  assert.deepEqual(crit.critical, ['openssl']);
  assert.equal(win.describeWindow(profile.maintenanceWindow), 'Sat 22:00–23:59 UTC');
});

test('apt backup: dpkg-repack every changing package, verify with dpkg-deb -I, manifest with sha256', async (t) => {
  const s = setup(t);
  const h = fakeHost({ pkgs: { 'php8.3-fpm': '8.3.33-1+u1', 'php8.3-common': '8.3.33-1+u1' }, upgrades: { 'php8.3-fpm': '8.3.36-1+u1', 'php8.3-common': '8.3.36-1+u1' }, policyRcD: s.policyRcD });
  const apt = aptMod.make({ run: h.run, now: () => NOW, policyRcD: s.policyRcD });
  const r = await apt.backup([{ ecosystem: 'apt', name: 'php8.3-fpm', component: 'php8.3', target: '8.3.36', targetDeb: '8.3.36-1+u1' }], s.ctx());
  assert.equal(r.entries.length, 1);
  const dir = r.entries[0].artifact;
  assert.equal(path.basename(dir), `php8.3-8.3.33-1+u1-${DAY}`);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.deepEqual(m.packages.map((x) => x.package).sort(), ['php8.3-common', 'php8.3-fpm']);
  for (const x of m.packages) {
    assert.equal(x.version, '8.3.33-1+u1');
    assert.equal(x.sha256, require('crypto').createHash('sha256').update(fs.readFileSync(path.join(dir, x.file))).digest('hex'));
  }
  assert.equal(h.calls.filter((c) => c.startsWith('dpkg-deb -I')).length, 2);
  assert.ok(h.calls.some((c) => c === 'apt-get -s install --only-upgrade php8.3-fpm=8.3.36-1+u1'));
  assert.equal(r.entries[0].meta.class, 'php');
  assert.ok(fs.existsSync(path.join(s.runDir, 'backup-apt.json')));
  // re-run reuses verified debs instead of repacking again
  const before = h.calls.filter((c) => c.startsWith('dpkg-repack')).length;
  await apt.backup([{ ecosystem: 'apt', name: 'php8.3-fpm', component: 'php8.3', target: '8.3.36', targetDeb: '8.3.36-1+u1' }], s.ctx());
  assert.equal(h.calls.filter((c) => c.startsWith('dpkg-repack')).length, before);
});

test('apt backup --dry-run: lists actions, writes nothing', async (t) => {
  const s = setup(t);
  const h = fakeHost({ pkgs: { jq: '1.6-2.1ubuntu3.2' }, policyRcD: s.policyRcD });
  const apt = aptMod.make({ run: h.run, now: () => NOW });
  const r = await apt.backup([{ ecosystem: 'apt', name: 'jq', target: null }], s.ctx({ dryRun: true }));
  assert.equal(r.entries[0].meta.dryRun, true);
  assert.ok(r.entries[0].meta.actions.some((a) => a.includes('dpkg-repack jq')));
  assert.equal(fs.existsSync(path.join(s.tmp, 'pkg-rollback')), false);
  assert.equal(h.calls.some((c) => c.startsWith('dpkg-repack')), false);
});

test('apt backup fails hard when dpkg-repack or dpkg-deb -I fails', async (t) => {
  const s = setup(t);
  for (const fail of [{ '^dpkg-repack': 'boom' }, { '^dpkg-deb -I': 'corrupt' }]) {
    const h = fakeHost({ pkgs: { jq: '1.6-2' }, fail, policyRcD: s.policyRcD });
    const apt = aptMod.make({ run: h.run, now: () => NOW });
    await assert.rejects(apt.backup([{ ecosystem: 'apt', name: 'jq' }], s.ctx()), /failed/);
  }
  const h = fakeHost({ pkgs: {}, policyRcD: s.policyRcD });
  await assert.rejects(aptMod.make({ run: h.run }).backup([{ ecosystem: 'apt', name: 'nope' }], s.ctx()), /not installed/);
});

test('apt apply refuses: dry-run, wrong mode, no window, missing repack', async (t) => {
  const s = setup(t);
  const tgt = { ecosystem: 'apt', name: 'jq', target: '1.7', targetDeb: '1.7-1' };
  const h = fakeHost({ pkgs: { jq: '1.6-2' }, upgrades: { jq: '1.7-1' }, policyRcD: s.policyRcD });
  const apt = aptMod.make({ run: h.run, now: () => NOW, sleep: async () => {} });
  assert.match((await apt.apply([tgt], s.ctx({ dryRun: true }))).failed[0].reason, /dry-run/);
  assert.match((await apt.apply([tgt], s.ctx())).failed[0].reason, /never applies/);
  assert.match((await apt.apply([tgt], s.ctx({ mode: 'apply-tier-a', window: { ok: false, reason: 'outside' } }))).failed[0].reason, /window/);
  assert.match((await apt.apply([tgt], s.ctx({ mode: 'apply-tier-a', window: { ok: true } }))).failed[0].reason, /no repack backup/);
  assert.equal(h.calls.some((c) => c.startsWith('apt-get install')), false);
});

test('apt apply php: policy-rc.d during install, reload fpm, 5xx before/after, hold; next run unholds', async (t) => {
  const s = setup(t);
  const tgt = { ecosystem: 'apt', name: 'php8.3-fpm', component: 'php8.3', target: '8.3.36', targetDeb: '8.3.36-1' };
  const h = fakeHost({ pkgs: { 'php8.3-fpm': '8.3.33-1' }, upgrades: { 'php8.3-fpm': '8.3.36-1' }, policyRcD: s.policyRcD });
  const apt = aptMod.make({ run: h.run, now: () => NOW, sleep: sleeper(s.logDir, [[200, 502, 200], [200, 200]]), policyRcD: s.policyRcD });
  const ctx = s.ctx({ mode: 'apply-tier-a', window: { ok: true, reason: 'inside' } });
  await apt.backup([tgt], ctx);
  h.held.add('php8.3-fpm'); // held by the previous run
  const r = await apt.apply([tgt], ctx);
  assert.equal(r.failed.length, 0, JSON.stringify(r.failed));
  assert.match(h.seen.policyDuringInstall, /exit 101/);
  assert.equal(fs.existsSync(s.policyRcD), false, 'policy-rc.d removed after install');
  assert.equal(h.seen.installEnv.DEBIAN_FRONTEND, 'noninteractive');
  const i = (re) => h.calls.findIndex((c) => re.test(c));
  assert.ok(i(/^apt-mark unhold php8\.3-fpm/) < i(/^apt-get install -y --only-upgrade .*php8\.3-fpm=8\.3\.36-1/));
  assert.ok(i(/^apt-get install/) < i(/^systemctl reload php8\.3-fpm$/));
  assert.ok(i(/^systemctl reload/) < i(/^apt-mark hold php8\.3-fpm/));
  assert.equal(h.calls.some((c) => /systemctl restart/.test(c)), false);
  assert.deepEqual(r.applied[0].fivexx.before, { windowSeconds: 1, requests: 3, status5xx: 1 });
  assert.deepEqual(r.applied[0].fivexx.after, { windowSeconds: 1, requests: 2, status5xx: 0 });
  assert.ok(h.held.has('php8.3-fpm'));
  // second env call: already at target, no reinstall
  const n = h.calls.length;
  const r2 = await apt.apply([tgt], ctx);
  assert.equal(r2.applied[0].detail, 'already at target');
  assert.equal(h.calls.slice(n).some((c) => c.startsWith('apt-get install')), false);
});

test('apt apply nginx: nginx -t && nginx -s reload, no policy-rc.d', async (t) => {
  const s = setup(t);
  const tgt = { ecosystem: 'apt', name: 'nginx', target: '1.26.3', targetDeb: '1.26.3-1' };
  const h = fakeHost({ pkgs: { nginx: '1.26.2-1' }, upgrades: { nginx: '1.26.3-1' }, policyRcD: s.policyRcD });
  const apt = aptMod.make({ run: h.run, now: () => NOW, sleep: async () => {}, policyRcD: s.policyRcD });
  const ctx = s.ctx({ mode: 'apply-tier-a', window: { ok: true } });
  await apt.backup([tgt], ctx);
  const r = await apt.apply([tgt], ctx);
  assert.equal(r.failed.length, 0);
  assert.equal(h.seen.policyDuringInstall, null);
  assert.deepEqual(r.applied[0].reload, ['nginx -t', 'nginx -s reload']);
});

test('apt apply mariadb: DB dump first, downtime expected', async (t) => {
  const s = setup(t);
  const tgt = { ecosystem: 'apt', name: 'mariadb-server', target: '10.11.14', targetDeb: '1:10.11.14-0' };
  const h = fakeHost({ pkgs: { 'mariadb-server': '1:10.11.13-0' }, upgrades: { 'mariadb-server': '1:10.11.14-0' }, logDir: s.logDir, policyRcD: s.policyRcD });
  const apt = aptMod.make({ run: h.run, now: () => NOW, sleep: async () => {}, policyRcD: s.policyRcD });
  const ctx = s.ctx({ mode: 'apply-tier-a', window: { ok: true } });
  const b = await apt.backup([tgt], ctx);
  assert.equal(path.basename(b.entries[0].artifact), `mariadb-server-10.11.13-0-${DAY}`);
  const r = await apt.apply([tgt], ctx);
  assert.equal(r.failed.length, 0, JSON.stringify(r.failed));
  assert.equal(r.applied[0].downtimeExpected, true);
  assert.ok(h.calls.findIndex((c) => c.endsWith('backup_db.sh')) < h.calls.findIndex((c) => c.startsWith('apt-get install')));
  assert.equal(h.seen.policyDuringInstall, null);
});

test('apt restore: dpkg -i the repacked debs, graceful reload, re-hold; dry-run lists only', async (t) => {
  const s = setup(t);
  const tgt = { ecosystem: 'apt', name: 'php8.3-fpm', component: 'php8.3', target: '8.3.36', targetDeb: '8.3.36-1' };
  const h = fakeHost({ pkgs: { 'php8.3-fpm': '8.3.33-1' }, upgrades: { 'php8.3-fpm': '8.3.36-1' }, policyRcD: s.policyRcD });
  const apt = aptMod.make({ run: h.run, now: () => NOW, sleep: async () => {}, policyRcD: s.policyRcD });
  const ctx = s.ctx({ mode: 'apply-tier-a', window: { ok: true } });
  const b = await apt.backup([tgt], ctx);
  await apt.apply([tgt], ctx);
  assert.equal(h.state['php8.3-fpm'], '8.3.36-1');
  const dry = await apt.restore(b.entries[0], s.ctx({ dryRun: true }));
  assert.match(dry.detail, /dry-run/);
  assert.equal(h.state['php8.3-fpm'], '8.3.36-1');
  const r = await apt.restore(b.entries[0], s.ctx());
  assert.equal(r.ok, true, r.detail);
  assert.equal(h.state['php8.3-fpm'], '8.3.33-1');
  assert.match(h.seen.policyDuringInstall, /exit 101/);
  assert.ok(h.calls.includes('systemctl reload php8.3-fpm'));
  assert.ok(h.held.has('php8.3-fpm'));
  // tampered deb => restore refuses
  const m = JSON.parse(fs.readFileSync(path.join(b.entries[0].artifact, 'manifest.json'), 'utf8'));
  fs.appendFileSync(path.join(b.entries[0].artifact, m.packages[0].file), 'x');
  await assert.rejects(apt.restore(b.entries[0], s.ctx()), /sha256 mismatch/);
});

test('bundle: debs + archives + state + MANIFEST.sha256, upload via profile.backupTargets', async (t) => {
  const s = setup(t);
  const h = fakeHost({ pkgs: { jq: '1.6-2' }, policyRcD: s.policyRcD });
  const apt = aptMod.make({ run: h.run, now: () => NOW });
  const ctx = s.ctx();
  await apt.backup([{ ecosystem: 'apt', name: 'jq' }], ctx);
  const etc = path.join(s.tmp, 'etc-nginx');
  fs.mkdirSync(path.join(s.tmp, 'u1', 'conf', 'web'), { recursive: true });
  fs.mkdirSync(etc);
  const uploads = [];
  const run = (cmd, args) => {
    if (cmd === 'tar') { fs.writeFileSync(args[1], 'tgz'); return { status: 0, stdout: '', stderr: '' }; }
    if (cmd === 'dpkg') return { status: 0, stdout: 'jq\tinstall\n', stderr: '' };
    if (cmd === 'apt-mark') return { status: 0, stdout: '', stderr: '' };
    uploads.push([cmd, ...args]);
    return { status: 0, stdout: 'upload OK', stderr: '' };
  };
  ctx.profile.bundle = { etcPaths: [etc], archives: [{ name: 'panel-conf', paths: [path.join(s.tmp, '*', 'conf', 'web')] }], files: ['missing.json'] };
  ctx.profile.backupTargets = [{ name: 'remote', script: 'adapters/up.sh' }];
  const b = bundleMod.make({ run, now: () => NOW });
  const dry = await b.backup([{ ecosystem: 'apt', name: 'jq' }], { ...ctx, dryRun: true });
  assert.ok(dry.entries[0].meta.actions.some((a) => a.includes('MANIFEST.sha256')));
  const r = await b.backup([{ ecosystem: 'apt', name: 'jq' }], ctx);
  const dir = r.entries[0].artifact;
  assert.equal(dir, path.join(s.runDir, 'bundle'));
  const files = bundleMod.walkFiles(dir);
  assert.ok(files.includes('MANIFEST.sha256'));
  assert.ok(files.some((f) => /^debs\/jq-1\.6-2-\d{8}\/jq_1\.6-2_amd64\.deb$/.test(f)));
  assert.ok(files.includes('archives/etc.tar.gz') && files.includes('archives/panel-conf.tar.gz'));
  assert.ok(files.includes('state/dpkg-selections.txt') && files.includes('state/apt-mark-showhold.txt'));
  assert.equal(r.entries[0].meta.db, 0);
  assert.deepEqual(uploads, [[path.join(s.tmp, 'adapters', 'up.sh'), dir, 'r1']]);
  assert.equal(bundleMod.verifyManifest(dir).ok, true);
  fs.appendFileSync(path.join(dir, 'state', 'dpkg-selections.txt'), 'tampered');
  const v = bundleMod.verifyManifest(dir);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(), /sha256 mismatch: state\/dpkg-selections\.txt/);
});

test('bin/stack-restore-bundle --dry-run verifies MANIFEST.sha256 and lists steps', (t) => {
  const s = setup(t);
  const dir = path.join(s.tmp, 'bundle');
  const debDir = path.join(dir, 'debs', `jq-1.6-2-${DAY}`);
  fs.mkdirSync(debDir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'archives'));
  fs.writeFileSync(path.join(debDir, 'jq_1.6-2_amd64.deb'), 'deb');
  const sha = require('crypto').createHash('sha256').update('deb').digest('hex');
  fs.writeFileSync(path.join(debDir, 'manifest.json'), JSON.stringify({ packages: [{ package: 'jq', version: '1.6-2', file: 'jq_1.6-2_amd64.deb', sha256: sha }] }));
  fs.writeFileSync(path.join(dir, 'archives', 'etc.tar.gz'), 'tgz');
  fs.writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify({ debs: [{ dir: `debs/jq-1.6-2-${DAY}`, component: 'jq' }], archives: [{ name: 'etc', file: 'archives/etc.tar.gz', paths: [{ path: '/etc/nginx', dir: true }] }], files: [], db: [], app: null }));
  bundleMod.writeManifest(dir);
  const bin = path.join(ROOT, 'bin', 'stack-restore-bundle');
  const r = spawnSync('node', [bin, dir, '--dry-run'], { encoding: 'utf8', env: { ...process.env, STACK_UPDATER_PROFILE: '' } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /MANIFEST\.sha256: OK \(4 files verified\)/);
  assert.match(r.stdout, /dpkg -i .*jq-1\.6-2-\d{8}\/\*\.deb/);
  assert.match(r.stdout, /rsync -a --backup --suffix=\.pre-restore-\S+ .*etc\/nginx\/ \/etc\/nginx\//);
  assert.match(r.stdout, /nginx -s reload/);
  assert.match(r.stdout, /dry-run: nothing changed/);
  const ny = spawnSync('node', [bin, dir], { encoding: 'utf8', env: { ...process.env, STACK_UPDATER_PROFILE: '' } });
  assert.equal(ny.status, 2, 'real restore requires --yes');
  fs.appendFileSync(path.join(dir, 'archives', 'etc.tar.gz'), 'x');
  const bad = spawnSync('node', [bin, dir, '--dry-run'], { encoding: 'utf8', env: { ...process.env, STACK_UPDATER_PROFILE: '' } });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /FAILED/);
});

test('cli: --component builds manual targets; --force/--reason/--component flags parse', () => {
  const { componentTargets, parseArgs } = require('../lib/cli');
  assert.deepEqual(componentTargets('jq, apt:curl').map((x) => [x.ecosystem, x.name, x.target]), [['apt', 'jq', null], ['apt', 'curl', null]]);
  const p = parseArgs(['backup', '--component', 'jq', '--force', '--reason', 'drill', '--dry-run']);
  assert.equal(p.flags.component, 'jq');
  assert.equal(p.flags.reason, 'drill');
  assert.equal(p.flags.force, true);
});
