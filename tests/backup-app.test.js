'use strict';
// Run: node --test scripts/stack-updater/tests   (mocked shell — never calls real composer/npm/git/pm2)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const composerMod = require('../lib/backup/composer');
const npmMod = require('../lib/backup/npm');
const frontendMod = require('../lib/backup/frontend');
const mariadbMod = require('../lib/backup/mariadb');
const app = require('../lib/backup/_app');
const ADAPTERS = path.join(ROOT, 'profiles', 'example', 'adapters');
const RUN_ID = '20261024-2205-apply-tier-a';

// Fake host: cp/mv/rm/rsync act on the temp tree, everything else is scripted + recorded.
function fakeHost(opts = {}) {
  const calls = [];
  const git = { commits: [], reverts: [], tracked: new Set(opts.tracked || []), branch: opts.branch || 'develop', dirty: opts.dirty || '' };
  const run = (cmd, args = [], o = {}) => {
    const line = [cmd, ...args].join(' ');
    calls.push({ line, cmd, args, opts: o });
    for (const [re, msg] of Object.entries(opts.fail || {})) if (new RegExp(re).test(line)) return { status: 1, stdout: '', stderr: msg };
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    if (cmd === 'cp' && args[0] === '-a') { fs.cpSync(args[1], args[2], { recursive: true }); return ok(); }
    if (cmd === 'mv') { fs.renameSync(args[0], args[1]); return ok(); }
    if (cmd === 'rm') { fs.rmSync(args[1], { recursive: true, force: true }); return ok(); }
    if (cmd === 'rsync') {
      const dst = args[args.length - 1];
      for (const src of args.slice(0, -1).filter((a) => !a.startsWith('-'))) {
        if (src.endsWith('/')) { if (args.includes('--delete')) fs.rmSync(dst, { recursive: true, force: true }); fs.cpSync(src, dst, { recursive: true }); } else fs.copyFileSync(src, path.join(dst, path.basename(src)));
      }
      return ok();
    }
    if (cmd === 'stat') return ok(args[1] === '%U' ? 'automation\n' : 'deploy:deploy\n');
    if (cmd === 'git') {
      const sub = args[2];
      if (sub === 'rev-parse' && args[3] === '--abbrev-ref') return ok(`${git.branch}\n`);
      if (sub === 'rev-parse') return ok(`${git.commits.length ? git.commits[git.commits.length - 1].sha : 'base'}\n`);
      if (sub === 'ls-files') return ok(git.tracked.has(args[4]) ? `${args[4]}/x\n` : '');
      if (sub === 'add' || sub === 'status') return ok(sub === 'status' ? git.dirty : '');
      if (sub === 'diff') return { status: opts.noDiff ? 0 : 1, stdout: '', stderr: '' };
      if (sub === 'commit') { git.commits.push({ sha: `c0ffee${git.commits.length}${'0'.repeat(30)}`, msg: args[4], paths: args.slice(args.indexOf('--') + 1) }); return ok(); }
      if (sub === 'revert') { git.reverts.push(args[4]); return ok(); }
      return ok();
    }
    if (cmd === 'composer') {
      const dir = args[args.indexOf('--working-dir') + 1];
      fs.writeFileSync(path.join(dir, 'vendor', 'autoload.php'), '<?php // new');
      fs.writeFileSync(path.join(dir, 'composer.lock'), '{"new":true}');
      return ok();
    }
    if (cmd === 'sudo' || cmd === 'npm') {
      const a = cmd === 'sudo' ? args.slice(args.indexOf('-H') + 2) : args;
      const prefix = a[a.indexOf('--prefix') + 1];
      if (a[0] === 'install') {
        const [name, ver] = a[1].split(/@(?=[^@]+$)/);
        fs.mkdirSync(path.join(prefix, 'node_modules', name), { recursive: true });
        fs.writeFileSync(path.join(prefix, 'node_modules', name, 'package.json'), JSON.stringify({ version: ver }));
        fs.writeFileSync(path.join(prefix, 'package-lock.json'), '{"new":true}');
      }
      return ok();
    }
    return ok();
  };
  return { run, calls, git, lines: () => calls.map((c) => c.line) };
}

function tmpdir(t, p = 'su-app-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
function mkfile(f, s = 'x') { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); }
const logger = () => { const msgs = []; return { msgs, info: (m) => msgs.push(['info', m]), warn: (m) => msgs.push(['warn', m]), error: (m) => msgs.push(['error', m]), debug() {} }; };

// Temp site: repo + web copies of two roots, an alias root (public_html symlink) and an excluded one.
function composerSite(t) {
  const tmp = tmpdir(t);
  const repo = path.join(tmp, 'repo');
  const web = path.join(tmp, 'web');
  for (const d of ['a.test', 'a.prod']) {
    for (const base of [path.join(repo, 'sites', d, 'public_html'), path.join(web, d, 'public_html')]) {
      mkfile(path.join(base, 'composer.json'), '{"require":{}}');
      mkfile(path.join(base, 'composer.lock'), '{"old":true}');
      mkfile(path.join(base, 'vendor', 'autoload.php'), '<?php // old');
    }
  }
  fs.mkdirSync(path.join(web, 'alias.test'), { recursive: true });
  fs.symlinkSync(path.join(web, 'a.test', 'public_html'), path.join(web, 'alias.test', 'public_html'));
  fs.mkdirSync(path.join(repo, 'sites', 'alias.test'), { recursive: true });
  fs.symlinkSync(path.join(web, 'a.test', 'public_html'), path.join(repo, 'sites', 'alias.test', 'public_html'));
  const runDir = path.join(tmp, 'runs', RUN_ID);
  fs.mkdirSync(runDir, { recursive: true });
  const profile = {
    repo, branch: 'develop',
    webRoots: [
      { domain: 'a.test', env: 'test', path: path.join(web, 'a.test'), repoPath: 'sites/a.test' },
      { domain: 'alias.test', env: 'test', path: path.join(web, 'alias.test'), repoPath: 'sites/alias.test' },
      { domain: 'a.prod', env: 'prod', path: path.join(web, 'a.prod'), repoPath: 'sites/a.prod' },
      { domain: 'gone.example', env: 'prod', path: path.join(web, 'gone'), repoPath: 'sites/gone' },
    ],
    composerExcluded: [{ domain: 'gone.example', reason: 'not in repo' }],
    appBackup: { keepPrev: 2, phpCli: 'php8.3' },
  };
  const log = logger();
  const ctx = (extra = {}) => ({ profile, mode: 'report-only', dryRun: false, env: null, run: { id: RUN_ID, dir: runDir, backupDir: path.join(runDir, 'b') }, log, profileDir: tmp, repoPath: (p) => path.join(repo, p), ...extra });
  return { tmp, repo, web, runDir, profile, ctx, log };
}

const writeBackupJson = (runDir, plugin, entries) => fs.writeFileSync(path.join(runDir, 'backup.json'), JSON.stringify({ dryRun: false, entries: entries.map((e) => ({ ...e, plugin })) }));

// ------------------------------------------------------------------ composer
test('composer dry-run: exact plan, aliases deduplicated, excluded roots skipped, nothing written', async (t) => {
  const s = composerSite(t);
  const h = fakeHost();
  const c = composerMod.make({ run: h.run });
  const r = await c.backup([
    { ecosystem: 'composer', scope: 'a.test', name: 'guzzlehttp/guzzle', installed: '7.9.2', target: '7.9.3' },
    { ecosystem: 'composer', scope: 'alias.test', name: 'guzzlehttp/guzzle', installed: '7.9.2', target: '7.9.3' },
    { ecosystem: 'composer', scope: 'gone.example', name: 'x/y', target: '1.0.1' },
  ], s.ctx({ dryRun: true }));
  assert.equal(r.entries.length, 1);
  const e = r.entries[0];
  assert.equal(e.scope, 'a.test');
  assert.equal(e.env, 'test');
  assert.deepEqual(e.meta.aliases, ['alias.test']);
  const repoDir = path.join(s.repo, 'sites', 'a.test', 'public_html');
  assert.ok(e.meta.applyPlan.includes(`composer update guzzlehttp/guzzle:7.9.3 --no-interaction --working-dir ${repoDir}`));
  assert.ok(e.meta.applyPlan.includes(`php8.3 -l ${repoDir}/vendor/autoload.php`));
  assert.ok(e.meta.applyPlan.some((l) => l === `git -C ${s.repo} add -- sites/a.test/public_html/composer.json sites/a.test/public_html/composer.lock`));
  assert.ok(e.meta.applyPlan.some((l) => l.includes(`commit -m 'stack-update ${RUN_ID} composer guzzlehttp/guzzle'`)));
  assert.match(e.meta.note, /not tracked/);
  assert.ok(e.meta.actions.some((l) => l.startsWith(`cp -a ${repoDir}/vendor ${repoDir}/vendor.prev-${RUN_ID}.tmp`)));
  assert.ok(e.meta.restorePlan.some((l) => l.includes(`mv ${repoDir}/vendor.prev-${RUN_ID} ${repoDir}/vendor`)));
  assert.deepEqual(h.lines().filter((l) => /^(cp|mv|rm|composer|rsync)\b|git -C \S+ (add|commit)/.test(l)), [], 'dry-run must not mutate');
  assert.equal(fs.existsSync(path.join(s.runDir, 'lockfiles')), false);
  assert.ok(s.log.msgs.some(([, m]) => /gone\.example is not a managed web root/.test(m)));
});

test('composer backup → apply → restore with vendor.prev swap, path-scoped commit and revert', async (t) => {
  const s = composerSite(t);
  const h = fakeHost({ tracked: ['sites/a.test/public_html/vendor'] });
  const c = composerMod.make({ run: h.run });
  const repoDir = path.join(s.repo, 'sites', 'a.test', 'public_html');
  const webDir = path.join(s.web, 'a.test', 'public_html');
  // three older .prev dirs => pruned down to 2 including this run's
  for (const id of ['20261001-2200-x', '20261008-2200-x', '20261015-2200-x']) fs.mkdirSync(path.join(webDir, `vendor.prev-${id}`));
  const targets = [{ ecosystem: 'composer', scope: 'a.test', name: 'guzzlehttp/guzzle', installed: '7.9.2', target: '7.9.3' }];
  const bk = await c.backup(targets, s.ctx());
  assert.equal(bk.entries.length, 1);
  const e = bk.entries[0];
  assert.deepEqual(e.meta.snapshots, [repoDir, webDir]);
  assert.equal(fs.readFileSync(path.join(e.artifact, 'composer.lock'), 'utf8'), '{"old":true}');
  assert.equal(fs.readFileSync(path.join(webDir, 'vendor', 'autoload.php'), 'utf8'), '<?php // old', 'live vendor untouched');
  assert.deepEqual(fs.readdirSync(webDir).filter((f) => f.startsWith('vendor.prev-')).sort(), ['vendor.prev-20261015-2200-x', `vendor.prev-${RUN_ID}`]);
  writeBackupJson(s.runDir, 'composer', bk.entries);

  // report-only / prod env never applies
  const no = await c.apply(targets, s.ctx({ env: 'test' }));
  assert.match(no.failed[0].reason, /mode report-only never applies/);
  const prod = await c.apply(targets, s.ctx({ env: 'prod', mode: 'apply-tier-a' }));
  assert.equal(prod.applied.length + prod.failed.length, 0);

  const ap = await c.apply(targets, s.ctx({ env: 'test', mode: 'apply-tier-a' }));
  assert.deepEqual(ap.failed, []);
  assert.equal(h.git.commits.length, 1);
  assert.equal(h.git.commits[0].msg, `stack-update ${RUN_ID} composer guzzlehttp/guzzle`);
  assert.deepEqual(h.git.commits[0].paths, ['sites/a.test/public_html/composer.json', 'sites/a.test/public_html/composer.lock', 'sites/a.test/public_html/vendor']);
  const adds = h.lines().filter((l) => / add /.test(l));
  assert.ok(adds.every((l) => l.includes(' add -- ') && !/ add (-A|\.|--all)/.test(l)), adds.join('\n'));
  assert.ok(h.lines().some((l) => l.startsWith(`composer update guzzlehttp/guzzle:7.9.3 --no-interaction --working-dir ${repoDir}`)));
  assert.equal(fs.readFileSync(path.join(webDir, 'vendor', 'autoload.php'), 'utf8'), '<?php // new', 'rsynced to the live copy');

  const rs = await c.restore({ ...e, plugin: 'composer' }, s.ctx());
  assert.equal(rs.ok, true, rs.detail);
  assert.equal(fs.readFileSync(path.join(repoDir, 'vendor', 'autoload.php'), 'utf8'), '<?php // old');
  assert.equal(fs.readFileSync(path.join(webDir, 'vendor', 'autoload.php'), 'utf8'), '<?php // old');
  assert.equal(fs.readFileSync(path.join(webDir, 'composer.lock'), 'utf8'), '{"old":true}');
  assert.deepEqual(h.git.reverts, [h.git.commits[0].sha]);
  assert.equal(fs.existsSync(path.join(webDir, `vendor.prev-${RUN_ID}`)), false);
});

test('composer apply refuses without a snapshot; revert refused on dirty paths falls back to lockfile copy', async (t) => {
  const s = composerSite(t);
  const h = fakeHost({ dirty: ' M sites/a.test/public_html/composer.lock' });
  const c = composerMod.make({ run: h.run });
  const targets = [{ ecosystem: 'composer', scope: 'a.test', name: 'monolog/monolog', target: '3.8.1' }];
  fs.writeFileSync(path.join(s.runDir, 'backup.json'), JSON.stringify({ entries: [] }));
  const r = await c.apply(targets, s.ctx({ env: 'test', mode: 'apply-tier-a' }));
  assert.match(r.failed[0].reason, /no vendor snapshot/);
  assert.equal(h.lines().filter((l) => l.startsWith('composer')).length, 0);

  const bk = await c.backup(targets, s.ctx());
  writeBackupJson(s.runDir, 'composer', bk.entries);
  await c.apply(targets, s.ctx({ env: 'test', mode: 'apply-tier-a' }));
  const rs = await c.restore(bk.entries[0], s.ctx());
  assert.equal(rs.ok, false);
  assert.match(rs.detail, /revert refused/);
  assert.equal(fs.readFileSync(path.join(s.repo, 'sites', 'a.test', 'public_html', 'composer.lock'), 'utf8'), '{"old":true}');
});

test('git helper refuses unscoped staging and wrong branch', () => {
  const h = fakeHost({ branch: 'main' });
  const H = app.make({ run: h.run });
  for (const bad of ['.', '-A', '/abs', '../up']) assert.throws(() => H.gitCommitPaths('/r', [bad], 'm'), /unscoped/);
  assert.throws(() => H.gitCommitPaths('/r', [], 'm'), /empty/);
  assert.throws(() => H.gitCommitPaths('/r', ['a/composer.lock'], 'm', 'develop'), /expected "develop"/);
  for (const f of ['composer.js', 'npm.js', '_app.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'backup', f), 'utf8');
    assert.doesNotMatch(src, /'add',\s*'(-A|\.|--all)'|git add (-A|\.(\s|$)|--all)/, `${f} must stage path-scoped only`);
  }
});

// ------------------------------------------------------------------ npm
function npmSite(t) {
  const tmp = tmpdir(t, 'su-npm-');
  const repo = path.join(tmp, 'repo');
  const ext = path.join(tmp, 'ext', 'apps', 'svc-a');
  const inRepo = path.join(repo, 'apps', 'svc-b');
  for (const d of [ext, inRepo, path.join(repo, 'apps', 'svc-a')]) {
    mkfile(path.join(d, 'package.json'), '{"dependencies":{}}');
    mkfile(path.join(d, 'package-lock.json'), '{"old":true}');
    mkfile(path.join(d, 'node_modules', 'express', 'package.json'), '{"version":"4.21.1"}');
  }
  const runDir = path.join(tmp, 'runs', RUN_ID);
  fs.mkdirSync(runDir, { recursive: true });
  const profile = {
    repo, branch: 'develop',
    npmApps: [
      { path: 'apps/svc-a', runtimePath: ext, owner: 'svcuser', pm2Name: 'svc-a', pm2User: 'root', healthUrl: 'http://127.0.0.1:9/health' },
      { path: 'apps/svc-b', runtimePath: inRepo, owner: 'root', pm2Name: 'svc-b', pm2User: 'root', healthUrl: null },
      { path: 'apps/tool', runtimePath: path.join(tmp, 'ext', 'apps', 'tool'), pm2Name: null, pm2User: null },
    ],
    appBackup: { pm2RestartScript: 'adapters/pm2-restart.sh', health: { tries: 2, delayMs: 0 } },
  };
  const ctx = (extra = {}) => ({ profile, mode: 'report-only', dryRun: false, env: null, run: { id: RUN_ID, dir: runDir }, log: logger(), profileDir: tmp, repoPath: (p) => path.join(repo, p), ...extra });
  return { tmp, repo, ext, inRepo, runDir, ctx };
}

test('npm dry-run: runtime path, owner via sudo, lockfile commit only for in-repo apps', async (t) => {
  const s = npmSite(t);
  const h = fakeHost();
  const n = npmMod.make({ run: h.run, whoami: () => 'root' });
  const r = await n.backup([
    { ecosystem: 'npm', scope: 'apps/svc-a', name: 'express', installed: '4.21.1', target: '4.21.2' },
    { ecosystem: 'npm', scope: 'apps/svc-b', name: 'express', installed: '4.21.1', target: '4.21.2' },
  ], s.ctx({ dryRun: true }));
  const [a, b] = r.entries;
  assert.equal(a.meta.runtime, s.ext);
  assert.equal(a.meta.inRepo, false);
  assert.ok(a.meta.applyPlan.includes(`sudo -n -u svcuser -H npm install express@4.21.2 --save-exact --prefix ${s.ext}`));
  assert.ok(a.meta.applyPlan.includes(`bash ${path.join(s.tmp, 'adapters', 'pm2-restart.sh')} svc-a root`));
  assert.ok(a.meta.applyPlan.includes('GET http://127.0.0.1:9/health  # expect status < 500'));
  assert.ok(!a.meta.applyPlan.some((l) => l.startsWith('git ')));
  assert.equal(b.meta.inRepo, true);
  assert.ok(b.meta.applyPlan.includes(`npm install express@4.21.2 --save-exact --prefix ${s.inRepo}`));
  assert.ok(b.meta.applyPlan.includes(`git -C ${s.repo} add -- apps/svc-b/package.json apps/svc-b/package-lock.json`));
  assert.ok(a.meta.actions.some((l) => l === `cp -a ${s.ext}/node_modules ${s.ext}/node_modules.prev-${RUN_ID}.tmp`));
  assert.deepEqual(h.lines().filter((l) => /^(cp|mv|rm|npm|sudo|bash)\b/.test(l)), []);
});

test('npm apply: install as owner on the runtime path, restart, failed health => failed; restore swaps back', async (t) => {
  const s = npmSite(t);
  const h = fakeHost();
  let status = 502;
  const n = npmMod.make({ run: h.run, whoami: () => 'root', httpStatus: async () => status, sleep: async () => {} });
  const targets = [{ ecosystem: 'npm', scope: 'apps/svc-a', name: 'express', installed: '4.21.1', target: '4.21.2' }];
  const bk = await n.backup(targets, s.ctx());
  assert.deepEqual(bk.entries[0].meta.snapshots, [s.ext]);
  writeBackupJson(s.runDir, 'npm', bk.entries);
  const ap = await n.apply(targets, s.ctx({ env: 'test', mode: 'apply-tier-a' }));
  assert.ok(h.lines().includes(`sudo -n -u svcuser -H npm install express@4.21.2 --save-exact --prefix ${s.ext}`));
  assert.ok(h.lines().includes(`bash ${path.join(s.tmp, 'adapters', 'pm2-restart.sh')} svc-a root`));
  assert.equal(ap.applied.find((x) => x.name === 'express').commit, null, 'no commit for apps outside the repo');
  assert.equal(h.git.commits.length, 0);
  assert.match(ap.failed.find((x) => x.name === '(health)').reason, /502/);
  // the repo copy was never touched (rollback must target the runtime path)
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.repo, 'apps', 'svc-a', 'node_modules', 'express', 'package.json'))).version, '4.21.1');
  // second env pass: already at target => no reinstall
  const before = h.lines().filter((l) => l.includes('npm install')).length;
  const again = await n.apply(targets, s.ctx({ env: 'prod', mode: 'apply-tier-a' }));
  assert.equal(again.applied[0].detail, 'already at target');
  assert.equal(h.lines().filter((l) => l.includes('npm install')).length, before);

  status = 200;
  const rs = await n.restore(bk.entries[0], s.ctx());
  assert.equal(rs.ok, true, rs.detail);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.ext, 'node_modules', 'express', 'package.json'))).version, '4.21.1');
  assert.equal(fs.readFileSync(path.join(s.ext, 'package-lock.json'), 'utf8'), '{"old":true}');
});

test('npm apply in-repo app commits only its lockfiles', async (t) => {
  const s = npmSite(t);
  const h = fakeHost();
  const n = npmMod.make({ run: h.run, whoami: () => 'root', httpStatus: async () => 200 });
  const targets = [{ ecosystem: 'npm', scope: 'apps/svc-b', name: 'express', installed: '4.21.1', target: '4.21.2' }];
  const bk = await n.backup(targets, s.ctx());
  writeBackupJson(s.runDir, 'npm', bk.entries);
  const ap = await n.apply(targets, s.ctx({ env: 'test', mode: 'apply-tier-a' }));
  assert.deepEqual(ap.failed, []);
  assert.ok(h.lines().includes(`npm install express@4.21.2 --save-exact --prefix ${s.inRepo}`), 'root-owned app runs without sudo');
  assert.deepEqual(h.git.commits[0].paths, ['apps/svc-b/package.json', 'apps/svc-b/package-lock.json']);
  assert.equal(h.git.commits[0].msg, `stack-update ${RUN_ID} npm express`);
  const rs = await n.restore(bk.entries[0], s.ctx());
  assert.equal(rs.ok, true);
  assert.deepEqual(h.git.reverts, [h.git.commits[0].sha]);
});

// ------------------------------------------------------------------ frontend
function frontSite(t) {
  const tmp = tmpdir(t, 'su-fe-');
  const vendor = path.join(tmp, 'repo', 'site', 'public_html', 'assets', 'vendor');
  const manifest = { libs: { flatpickr: { active: '4.6.13', versions: { '4.6.13': { files: [{ path: 'flatpickr/4.6.13/flatpickr.min.js', sri: 'sha384-a' }] }, '4.6.14': { files: [{ path: 'flatpickr/4.6.14/flatpickr.min.js', sri: 'sha384-b' }] } } } } };
  mkfile(path.join(vendor, 'manifest.json'), JSON.stringify(manifest));
  mkfile(path.join(vendor, 'flatpickr/4.6.14/flatpickr.min.js'));
  const runDir = path.join(tmp, 'run');
  fs.mkdirSync(runDir);
  const profile = { repo: path.join(tmp, 'repo'), syncScript: '/opt/sync.sh', webRoots: [{ domain: 't', env: 'test', path: '/srv/t', repoPath: 'site' }] };
  const ctx = (extra = {}) => ({ profile, mode: 'report-only', dryRun: false, run: { id: RUN_ID, dir: runDir }, log: logger(), repoPath: (p) => path.join(tmp, 'repo', p), ...extra });
  return { tmp, vendor, runDir, ctx };
}

test('frontend: backup manifest, move the active pointer (TEST only) + sync, restore the saved manifest', async (t) => {
  const s = frontSite(t);
  const h = fakeHost();
  const f = frontendMod.make({ run: h.run });
  const targets = [{ ecosystem: 'vendor-js', scope: 'assets/vendor', name: 'flatpickr', installed: '4.6.13', target: '4.6.14' }];
  const dry = await f.backup(targets, s.ctx({ dryRun: true }));
  assert.deepEqual(dry.entries[0].meta.changes, [{ name: 'flatpickr', from: '4.6.13', to: '4.6.14' }]);
  assert.ok(dry.entries[0].meta.applyPlan.includes('bash /opt/sync.sh   # env test only'));
  assert.equal(fs.existsSync(path.join(s.runDir, 'frontend')), false);

  const bk = await f.backup(targets, s.ctx());
  writeBackupJson(s.runDir, 'frontend', bk.entries);
  const prod = await f.apply(targets, s.ctx({ env: 'prod', mode: 'apply-tier-a' }));
  assert.match(prod.applied[0].detail, /promotion/);
  assert.equal(h.lines().length, 0);
  const ap = await f.apply(targets, s.ctx({ env: 'test', mode: 'apply-tier-a' }));
  assert.deepEqual(ap.failed, []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.vendor, 'manifest.json'))).libs.flatpickr.active, '4.6.14');
  assert.deepEqual(h.lines(), ['bash /opt/sync.sh']);
  const rs = await f.restore(bk.entries[0], s.ctx());
  assert.equal(rs.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.vendor, 'manifest.json'))).libs.flatpickr.active, '4.6.13');
  assert.equal(h.lines().length, 2);
  // a version that the manifest phase did not add is refused
  assert.throws(() => f.rewrite(JSON.parse(fs.readFileSync(path.join(s.vendor, 'manifest.json'))), [{ name: 'flatpickr', target: '9.9.9' }]), /not present/);
  assert.throws(() => f.rewrite({ libs: { x: { active: '1', versions: { 2: { files: [{ path: 'nope.js' }] } } } } }, [{ name: 'x', target: '2' }], s.vendor), /missing on disk/);
});

// ------------------------------------------------------------------ mariadb
test('mariadb: dumps on backup, minor/major refused without the snapshot flag, patch left to apt', async (t) => {
  const tmp = tmpdir(t, 'su-db-');
  const h = fakeHost();
  const run = (cmd, args, o) => { const r = h.run(cmd, args, o); if (cmd === 'bash' && args.some((a) => a.includes('mariadb-dump'))) fs.writeFileSync(args[args.length - 1], 'gz'); return r; };
  const m = mariadbMod.make({ run });
  const profile = { backupDbScript: '/opt/backup_db.sh', appBackup: { mariadbTestDb: 'site_test', snapshotConfirmFlag: 'disk-snapshot-confirmed' } };
  const ctx = (extra = {}) => ({ profile, mode: 'apply-tier-a', dryRun: false, run: { id: RUN_ID, dir: tmp }, log: logger(), flags: {}, ...extra });
  const targets = [{ ecosystem: 'mariadb', name: 'mariadb-server', installed: '10.11.14', target: '11.4.8' }];
  const dry = await m.backup(targets, ctx({ dryRun: true }));
  assert.ok(dry.entries[0].meta.actions.some((l) => l.includes('mariadb-dump --single-transaction --quick --routines --triggers site_test | gzip')));
  assert.equal(h.lines().length, 0);
  const bk = await m.backup(targets, ctx());
  assert.deepEqual(h.lines().slice(0, 1), ['/opt/backup_db.sh']);
  assert.ok(h.lines().some((l) => l.startsWith('gzip -t ')));
  assert.equal(bk.entries[0].meta.testDumpBytes, 2);

  const no = await m.apply(targets, ctx({ env: 'test' }));
  assert.match(no.failed[0].reason, /--disk-snapshot-confirmed/);
  const patch = await m.apply([{ ...targets[0], target: '10.11.15' }], ctx({ env: 'test' }));
  assert.match(patch.failed[0].reason, /apt applier/);
  const down = await m.apply([{ ...targets[0], target: '10.6.1' }], ctx({ env: 'test' }));
  assert.match(down.failed[0].reason, /never downgraded/);
  // with the flag it is delegated to the apt applier, whose own rails still apply
  const yes = await m.apply(targets, ctx({ env: 'test', flags: { 'disk-snapshot-confirmed': true }, window: { ok: false, reason: 'outside window' } }));
  assert.match(yes.failed[0].reason, /window check did not pass/);
  const rs = await m.restore(bk.entries[0]);
  assert.equal(rs.manual, true);
});

test('cli accepts --<name>-confirmed flags and passes them to plugins as ctx.flags', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'cli.js'), 'utf8');
  assert.match(src, /-confirmed\$\//);
  assert.match(src, /flags: cfg\.flags \|\| \{\}/);
});

// ------------------------------------------------------------------ adapters
test('pm2-restart.sh: runs under the owning pm2 user', (t) => {
  const me = require('os').userInfo().username;
  const sh = (...a) => spawnSync('bash', [path.join(ADAPTERS, 'pm2-restart.sh'), ...a], { encoding: 'utf8' });
  assert.equal(sh('svc', 'someoneelse', '--dry-run').stdout.trim(), 'sudo -n -u someoneelse -H pm2 restart svc --update-env');
  assert.equal(sh('svc', me, '--dry-run').stdout.trim(), 'pm2 restart svc --update-env');
  assert.equal(sh('bad;name', me, '--dry-run').status, 2);
  // real path with a fake pm2 binary
  const tmp = tmpdir(t, 'su-pm2-');
  const fake = path.join(tmp, 'pm2');
  fs.writeFileSync(fake, `#!/bin/bash\necho "$@" >> ${tmp}/calls\n[ "$1" = jlist ] && echo '[{"name":"svc","pm2_env":{"status":"online"}}]'\nexit 0\n`, { mode: 0o755 });
  const r = spawnSync('bash', [path.join(ADAPTERS, 'pm2-restart.sh'), 'svc', me], { encoding: 'utf8', env: { ...process.env, PM2_BIN: fake } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /online/);
  assert.deepEqual(fs.readFileSync(path.join(tmp, 'calls'), 'utf8').trim().split('\n'), ['describe svc', 'restart svc --update-env', 'jlist']);
});
