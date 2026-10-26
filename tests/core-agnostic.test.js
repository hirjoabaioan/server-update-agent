'use strict';
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FORBIDDEN = /ifindspec|avocatescu|hetzner|\/home\//i;
// Personal / infrastructure specifics must not appear anywhere in the published tree.
const FORBIDDEN_EVERYWHERE = /ifindspec|avocatescu|hetzner|hestia|wasabi|dsweb|john\b|\/root\/ifindspec/i;
// Documented exception: the example profile README names HestiaCP as an example of a site-specific adapter.
const MENTION_ALLOWED = [path.join('profiles', 'example', 'README.md')];

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

test('core (lib/ + bin/) contains no site-specific strings', () => {
  const hits = [];
  for (const sub of ['lib', 'bin']) {
    for (const file of walk(path.join(ROOT, sub))) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (FORBIDDEN.test(line)) hits.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  assert.deepEqual(hits, [], `site-specific strings found in core:\n${hits.join('\n')}`);
});

test('no personal or infrastructure specifics in lib/, bin/, profiles/, tests/ and README', () => {
  const hits = [];
  const files = [...['lib', 'bin', 'profiles', 'tests'].flatMap((d) => walk(path.join(ROOT, d))), path.join(ROOT, 'README.md')];
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    if (file === __filename || MENTION_ALLOWED.includes(rel)) continue;
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (FORBIDDEN_EVERYWHERE.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(hits, [], `forbidden strings found:\n${hits.join('\n')}`);
});

test('policy.json implements the written policy', () => {
  const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'policy.json'), 'utf8'));
  assert.equal(p.patchSoakDays, 7);
  assert.equal(p.minorMajorMinAgeDays, 30);
  assert.equal(p.stableChannelsOnly, true);
  assert.equal(p.nodeLtsOnly, true);
  assert.equal(p.mariadbLtsOnly, true);
  assert.equal(p.dockerNeverLatest, true);
  assert.equal(p.securitySkipSoak.minCvss, 7);
  assert.equal(p.requiresFollowUpPatch.components.php.minPatch, 2);
  assert.deepEqual(Object.keys(p.tiers), ['A', 'B', 'C']);
  assert.deepEqual(p.pins.select2.allow, ['4.1.0-rc.0']);
  assert.match(p.pins.select2.comment, /rc rule intentionally bypassed/);
  assert.deepEqual(p.knownRegressions, {});
  assert.ok(p.componentsNeverAuto.includes('ubuntu-release'));
  for (const w of ['alpha', 'beta', 'rc', 'dev', 'nightly', 'preview', 'snapshot']) assert.match(w, new RegExp(p.forbidPrerelease));
});

test('every profile.json is valid and declares the required keys', () => {
  const dir = path.join(ROOT, 'profiles');
  for (const name of fs.readdirSync(dir)) {
    const f = path.join(dir, name, 'profile.json');
    if (!fs.existsSync(f)) continue;
    const p = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const k of ['stateDir', 'repo', 'webRoots', 'deployLocks', 'securityWatch']) assert.ok(k in p, `${name}: missing ${k}`);
    assert.equal(p.securityWatch.enabled, false);
    for (const w of p.webRoots) assert.ok(['test', 'prod'].includes(w.env), `${name}: bad env ${w.env}`);
    if (name === 'example') {
      const ex = p.excluded.find((c) => c.domain === 'legacy.example.com');
      assert.ok(ex && ex.path && /^not in the repo, returns 404/.test(ex.reason));
      assert.ok(!p.composerExcluded);
      assert.ok(!p.smokeUrls.some((u) => u.url.includes('legacy.example.com')));
      assert.ok(!p.webRoots.some((w) => w.domain === 'legacy.example.com'));
    }
  }
});

test('semver: parse/compare/diffType/prerelease', () => {
  const s = require('../lib/core/semver');
  assert.equal(s.compare('1.2.3', '1.2.10'), -1);
  assert.equal(s.compare('v2.0.0', '2.0.0'), 0);
  assert.equal(s.compare('4.1.0-rc.0', '4.1.0'), -1);
  assert.equal(s.compare('1.0.0-beta.2', '1.0.0-beta.10'), -1);
  assert.equal(s.compare('8.3.12-1+ubuntu24.04.1+deb.sury.org+1', '8.3.11'), 1);
  assert.equal(s.parse('8.3.12-1+ubuntu24.04.1').pre.length, 0);
  assert.equal(s.diffType('8.3.12', '8.3.13'), 'patch');
  assert.equal(s.diffType('8.3.12', '8.4.0'), 'minor');
  assert.equal(s.diffType('22.11.0', '24.0.0'), 'major');
  assert.equal(s.diffType('2.0.0', '1.9.9'), 'downgrade');
  assert.equal(s.isPrerelease('11.4.0-rc1'), true);
  assert.equal(s.isPrerelease('11.4.4'), false);
  assert.equal(s.sameMinor('10.11.8', '10.11.14'), true);
  assert.equal(s.maxVersion(['1.2.0', '1.10.0', '1.9.9']), '1.10.0');
});

test('core rails: never-auto, tier B/C and known regressions', () => {
  const { applyCoreRails } = require('../lib/cli');
  const policy = { componentsNeverAuto: ['ubuntu-release'], knownRegressions: { 'foo@1.2.4': 'breaks X' } };
  assert.equal(applyCoreRails({ name: 'ubuntu-release', tier: 'A', action: 'auto', target: '26.04' }, policy).action, 'propose');
  assert.equal(applyCoreRails({ name: 'php', tier: 'B', action: 'auto', target: '8.4.2' }, policy).action, 'propose');
  assert.equal(applyCoreRails({ name: 'foo', tier: 'A', action: 'auto', target: '1.2.4' }, policy).action, 'hold');
  assert.equal(applyCoreRails({ name: 'bar', tier: 'A', action: 'auto', target: '1.0.1' }, policy).action, 'auto');
});

test('deploy locks: fresh lock = busy, old lock = stale only', () => {
  const { checkDeployLocks } = require('../lib/core/lock');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'su-lock-'));
  const fresh = path.join(tmp, 'fresh.lock');
  const old = path.join(tmp, 'old.lock');
  fs.writeFileSync(fresh, '');
  fs.writeFileSync(old, '');
  const past = (Date.now() - 3 * 3600 * 1000) / 1000;
  fs.utimesSync(old, past, past);
  const r1 = checkDeployLocks([old, path.join(tmp, 'missing.lock')]);
  assert.equal(r1.busy, false);
  assert.equal(r1.stale.length, 1);
  const r2 = checkDeployLocks([fresh, old]);
  assert.equal(r2.busy, true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('run lock: second acquire fails while the first is held', { skip: spawnSync('flock', ['-V']).error ? 'flock not installed' : false }, () => {
  const { acquireRunLock } = require('../lib/core/lock');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'su-run-'));
  const a = acquireRunLock(tmp);
  assert.equal(a.ok, true);
  const child = spawnSync('flock', ['-n', '-E', '75', path.join(tmp, 'run.lock'), 'true']);
  assert.equal(child.status, 75, 'lock must be held after acquire');
  a.release();
  const b = acquireRunLock(tmp);
  assert.equal(b.ok, true);
  b.release();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('run id format', () => {
  const { makeRunId, RUN_ID_RE } = require('../lib/core/run');
  const id = makeRunId('apply-tier-a', new Date(Date.UTC(2026, 9, 24, 22, 5)));
  assert.equal(id, '20261024-2205-apply-tier-a');
  assert.match(id, RUN_ID_RE);
});

test('bin/stack-update --help prints subcommands and flags', () => {
  const r = spawnSync('bash', [path.join(ROOT, 'bin', 'stack-update'), '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  for (const w of ['update', 'inventory', 'policy', 'analyze', 'backup', 'verify', 'report', 'rollback', 'advisories',
    '--profile', '--mode', '--env', '--dry-run', 'report-only', 'apply-tier-a', 'propose']) {
    assert.ok(r.stdout.includes(w), `help misses ${w}`);
  }
});

test('end-to-end dry run with a temp profile and profile plugins', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'su-e2e-'));
  const prof = path.join(tmp, 'profile');
  const state = path.join(tmp, 'state');
  const pdir = (k) => { const d = path.join(prof, 'plugins', k); fs.mkdirSync(d, { recursive: true }); return d; };
  fs.mkdirSync(prof, { recursive: true });
  fs.writeFileSync(path.join(prof, 'profile.json'), JSON.stringify({ stateDir: state, repo: tmp, webRoots: [], deployLocks: [], securityWatch: { enabled: false, hook: null }, plugins: { collectors: { only: ['fake'] } } }));
  fs.writeFileSync(path.join(pdir('collectors'), 'fake.js'), `module.exports={name:'fake',collect:async()=>[
    {ecosystem:'apt',name:'libfoo',installed:'1.0.0',candidates:[{version:'1.0.1',releaseDate:'2026-01-01',source:'t',security:true}],source:'t'},
    {ecosystem:'os',name:'ubuntu-release',installed:'24.04',candidates:[{version:'26.04',releaseDate:'2026-04-23',source:'t',security:false}],source:'t'}]};`);
  fs.writeFileSync(path.join(pdir('policy'), 'fake.js'), `module.exports={name:'fake',evaluate:async(items)=>items.filter(i=>i.candidates.length).map(i=>({ecosystem:i.ecosystem,name:i.name,installed:i.installed,target:i.candidates[0].version,tier:'A',action:'auto',reasons:['test']}))};`);
  fs.writeFileSync(path.join(pdir('verifiers'), 'fake.js'), `module.exports={name:'fake',verify:async(ctx)=>({ok:true,checks:[{id:ctx.env,ok:true}]})};`);
  fs.writeFileSync(path.join(pdir('backup'), 'fake.js'), `module.exports={name:'fake',backup:async(t,ctx)=>({entries:t.map(x=>({component:x.name,ecosystem:x.ecosystem,env:null,artifact:'none',restoreHint:'dry'}))}),restore:async()=>({ok:true})};`);

  const r = spawnSync('node', [path.join(ROOT, 'lib', 'cli.js'), 'update', '--profile', prof, '--mode', 'apply-tier-a', '--dry-run', '--force', '--reason', 'e2e test (any weekday)', '--quiet', '--no-notify'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const runId = r.stdout.trim().split(' ')[0];
  const runDir = path.join(state, 'runs', runId);
  const dec = JSON.parse(fs.readFileSync(path.join(runDir, 'decisions.json'), 'utf8')).decisions;
  assert.equal(dec.find((d) => d.name === 'libfoo').action, 'auto');
  assert.equal(dec.find((d) => d.name === 'ubuntu-release').action, 'propose');
  // apt is a shared system component: applied once, in the PROD phase (no TEST copy).
  const apply = JSON.parse(fs.readFileSync(path.join(runDir, 'apply-prod.json'), 'utf8'));
  assert.equal(apply.applied.length, 0);
  assert.equal(apply.skipped.length, 1);
  assert.ok(fs.existsSync(path.join(runDir, 'verify-prod.json')));
  assert.ok(fs.existsSync(path.join(runDir, 'report.md')));
  assert.ok(fs.readFileSync(path.join(runDir, 'run.jsonl'), 'utf8').trim().split('\n').every((l) => JSON.parse(l).ts));

  // deploy lock younger than 2h => skipped (exit 0, no new run dir)
  const lock = path.join(tmp, 'deploy.lock');
  fs.writeFileSync(lock, '');
  const pj = JSON.parse(fs.readFileSync(path.join(prof, 'profile.json'), 'utf8'));
  pj.deployLocks = [lock];
  fs.writeFileSync(path.join(prof, 'profile.json'), JSON.stringify(pj));
  const before = fs.readdirSync(path.join(state, 'runs')).length;
  const s = spawnSync('node', [path.join(ROOT, 'lib', 'cli.js'), 'update', '--profile', prof, '--quiet'], { encoding: 'utf8' });
  assert.equal(s.status, 0);
  assert.match(s.stderr, /skipped/);
  assert.equal(fs.readdirSync(path.join(state, 'runs')).length, before);

  // rollback dry-run lists the backup entries of the run (lock ignored with --force)
  const rb = spawnSync('node', [path.join(ROOT, 'lib', 'cli.js'), 'rollback', runId, 'libfoo', '--profile', prof, '--dry-run', '--force', '--quiet'], { encoding: 'utf8' });
  assert.equal(rb.status, 0, rb.stderr);
  assert.equal(JSON.parse(rb.stdout).wouldRestore.length, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('excluded: loadConfig folds deprecated composerExcluded alias; isExcluded matches domain/path/url', () => {
  const fsx = require('fs'); const osx = require('os'); const pth = require('path');
  const { loadConfig } = require('../lib/core/config');
  const { isExcluded } = require('../lib/core/excluded');
  const dir = fsx.mkdtempSync(pth.join(osx.tmpdir(), 'su-exc-'));
  const prof = { stateDir: dir, repo: dir, composerExcluded: [{ domain: 'gone.example', path: '/srv/gone', reason: 'because' }] };
  fsx.writeFileSync(pth.join(dir, 'profile.json'), JSON.stringify(prof));
  const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
  let cfg; try { cfg = loadConfig({ profile: dir }); } finally { console.warn = warn; }
  assert.equal(warned, 1);
  assert.deepEqual(cfg.profile.excluded, prof.composerExcluded);
  assert.ok(isExcluded(cfg.profile, { domain: 'gone.example' }));
  assert.ok(isExcluded(cfg.profile, { url: 'https://gone.example/x' }));
  assert.ok(isExcluded(cfg.profile, { path: '/srv/gone/public_html' }));
  assert.ok(!isExcluded(cfg.profile, { domain: 'ok.example', path: '/srv/other' }));
});
