'use strict';
// Run: node --test scripts/stack-updater/tests   (pure engine, fixture inventory, no network/shell)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const engine = require('../lib/policy/engine');
const compat = require('../lib/policy/rules/compat');

const NOW = new Date('2026-10-23T10:00:00Z');
const PROFILE = { phpFpmService: 'php8.3-fpm' };
// These cases use the nginx mainline fixture to exercise generic soak/question logic, so they run
// without policy.nginx.channel (legacy behaviour); channel=stable is covered by nginx-stable.test.js.
const basePolicy = () => {
  const pol = JSON.parse(fs.readFileSync(path.join(ROOT, 'policy.json'), 'utf8'));
  delete pol.nginx;
  return pol;
};
const baseInv = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'inventory-sample.json'), 'utf8'));

function run({ mutateInv, mutatePolicy, now } = {}) {
  const inv = baseInv();
  const pol = basePolicy();
  if (mutateInv) mutateInv(inv);
  if (mutatePolicy) mutatePolicy(pol);
  return engine.compute(inv, pol, { now: now || NOW, profile: PROFILE });
}
const find = (res, name, line, ecosystem) => res.candidates.find((c) => c.name === name && c.line === line && (!ecosystem || c.ecosystem === ecosystem));
const item = (inv, name, ecosystem) => inv.items.find((i) => i.name === name && (!ecosystem || i.ecosystem === ecosystem));
const dropNginx7 = (inv) => { item(inv, 'nginx', 'apt').candidates = item(inv, 'nginx', 'apt').candidates.filter((c) => c.version !== '1.31.7'); };

test('A: newest patch not soaked -> previous soaked patch chosen, newest recorded as pending', () => {
  for (const eco of ['apt', 'eol']) {
    const e = find(run(), 'nginx', 'patch', eco);
    assert.equal(e.tier, 'A');
    assert.equal(e.target, '1.31.7');
    assert.equal(e.pending.version, '1.31.8');
    assert.equal(e.pending.ageDays, 2);
    assert.equal(e.pending.eligibleOn, '2026-10-28');
  }
});

test('A: soak not reached and no older soaked patch -> status soak, no target', () => {
  const e = find(run({ mutateInv: dropNginx7 }), 'nginx', 'patch', 'eol');
  assert.equal(e.tier, null);
  assert.equal(e.target, null);
  assert.equal(e.status, 'soak');
  assert.equal(e.action, 'hold');
  assert.match(e.reason[0], /soak: newest patch 1\.31\.8 is 2d old < 7d/);
  const node = find(run(), 'nodejs', 'patch');
  assert.equal(node.status, 'soak');
  assert.equal(node.pending.version, '22.23.4');
});

test('A: soak satisfied -> tier A (mariadb 11.4.13); 10.6 series ignored', () => {
  const res = run();
  const e = find(res, 'mariadb-server', 'patch', 'mariadb');
  assert.equal(e.tier, 'A');
  assert.equal(e.target, '11.4.13');
  assert.ok(e.reason.some((r) => /soaked \d+ days >= 7/.test(r)));
  assert.equal(find(res, 'mariadb-common', 'patch').tier, null);
});

test('A: soak boundary is exactly 7 days', () => {
  const at = (iso) => run({ mutateInv: dropNginx7, now: new Date(iso) });
  assert.equal(find(at('2026-10-27T10:00:00Z'), 'nginx', 'patch', 'eol').status, 'soak');
  const ok = find(at('2026-10-28T10:00:00Z'), 'nginx', 'patch', 'eol');
  assert.equal(ok.tier, 'A');
  assert.equal(ok.target, '1.31.8');
});

test('A: security candidate (USN, CVSS 8.1) skips soak and flags it', () => {
  const e = find(run(), 'libsec1', 'patch');
  assert.equal(e.tier, 'A');
  assert.equal(e.target, '2.0.2');
  assert.equal(e.soakSkipped, true);
  assert.equal(e.soakSkipReason, 'security');
  assert.ok(e.reason.some((r) => /^security: soak skipped/.test(r)));
});

test('A: advisory without CVSS skips soak; low CVSS does not', () => {
  assert.equal(find(run(), 'lodash', 'patch').soakSkipped, true);
  const low = run({ mutateInv: (inv) => { item(inv, 'lodash').candidates[0].cvss = 3.1; } });
  const e = find(low, 'lodash', 'patch');
  assert.equal(e.status, 'soak');
  assert.equal(e.soakSkipped, undefined);
});

test('A: known regression on newest patch -> previous good patch used and recorded', () => {
  const res = run({ mutatePolicy: (p) => { p.knownRegressions = { 'express@4.18.3': 'breaks res.redirect' }; } });
  const e = find(res, 'express', 'patch');
  assert.equal(e.target, '4.18.2');
  assert.deepEqual(e.regressionFallback, { skipped: ['4.18.3'], chosen: '4.18.2' });
  assert.ok(e.reason.some((r) => /known regression \(breaks res\.redirect\); using previous good 4\.18\.2/.test(r)));
  const nested = run({ mutatePolicy: (p) => { p.knownRegressions = { express: { '4.18.3': 'x', '4.18.2': 'y' } }; } });
  assert.equal(find(nested, 'express', 'patch').target, '4.18.1');
  const all = run({ mutatePolicy: (p) => { p.knownRegressions = { 'express@4.18.3': 'a', 'express@4.18.2': 'b', 'express@4.18.1': 'c' }; } });
  assert.equal(find(all, 'express', 'patch').status, 'regression-hold');
});

test('prerelease versions are filtered (semver beta, docker rc/alpine/latest)', () => {
  const res = run();
  const s = find(res, 'sortablejs', 'patch');
  assert.equal(s.target, '1.15.2');
  assert.ok(s.rejected.some((r) => r.version === '1.16.0-beta.1' && r.why === 'prerelease'));
  assert.equal(find(res, 'sortablejs', 'bump'), undefined);
  const d = find(res, 'prom/prometheus', 'patch');
  assert.equal(d.target, 'v3.13.4'); // v3.13.5 is only 2 days old
  const why = Object.fromEntries(d.rejected.map((r) => [r.version, r.why]));
  assert.equal(why['v3.14.0-rc.1'], 'prerelease');
  assert.equal(why['v3.14.0-alpine'], 'not a release tag');
  assert.equal(why.latest, 'not a release tag');
});

test('select2 4.1.0-rc.0 is accepted via policy.pins (installed and as candidate)', () => {
  const e = find(run(), 'select2', 'patch');
  assert.equal(e.pinned, true);
  assert.match(e.reason[0], /prerelease 4\.1\.0-rc\.0 accepted: allowed by policy\.pins\.select2/);
  const mut = (inv) => { const s = item(inv, 'select2'); s.installed = '4.0.13'; s.candidates = [{ version: '4.1.0-rc.0', releaseDate: '2025-01-01', source: 'f', security: false }]; };
  assert.equal(find(run({ mutateInv: mut }), 'select2', 'bump').target, '4.1.0-rc.0');
  assert.equal(find(run({ mutateInv: mut, mutatePolicy: (p) => { p.pins = {}; } }), 'select2', 'bump'), undefined);
});

test('Node: non-LTS major (25) is rejected, LTS major (24) considered', () => {
  const res = run({ mutateInv: (inv) => { inv.items = inv.items.filter((i) => i.name !== '(app)'); } });
  const b = find(res, 'nodejs', 'bump');
  assert.equal(b.tier, 'B');
  assert.equal(b.lineKey, '24');
  assert.equal(b.status, 'eligible');
  assert.ok(!(b.alternatives || []).some((a) => a.line === '25'));
  assert.ok(find(res, 'nodejs', 'patch').rejected.some((r) => /Node 25 is not an LTS/.test(r.why)));
});

test('Node: only a non-LTS newer major -> no B candidate', () => {
  const res = run({ mutateInv: (inv) => { inv.nodeIndex = inv.nodeIndex.filter((n) => !/^v24/.test(n.version)); } });
  assert.equal(find(res, 'nodejs', 'bump'), undefined);
});

test('B: age >= 30d AND follow-up patch -> eligible line wins over a younger line', () => {
  const b = find(run(), 'luxon', 'bump');
  assert.equal(b.tier, 'B');
  assert.equal(b.lineKey, '3.5');
  assert.equal(b.target, '3.5.1');
  assert.equal(b.status, 'eligible');
  assert.equal(b.action, 'propose');
  const four = b.alternatives.find((a) => a.line === '4.0');
  assert.equal(four.status, 'not-yet-eligible');
  assert.equal(four.missing.length, 2);
});

test('B: not yet eligible lists the missing conditions (age, follow-up patch)', () => {
  const only = (list) => ({ mutateInv: (inv) => { item(inv, 'luxon').candidates = list.map(([version, releaseDate]) => ({ version, releaseDate, source: 'f', security: false })); } });
  const young = find(run(only([['4.0.0', '2026-10-15']])), 'luxon', 'bump');
  assert.equal(young.status, 'not-yet-eligible');
  assert.equal(young.action, 'hold');
  assert.equal(young.reason[0], 'not yet eligible: age 8d < 30d; no follow-up patch (4.0.1+ not released)');
  const noFollow = find(run(only([['4.0.0', '2026-08-01']])), 'luxon', 'bump');
  assert.equal(noFollow.reason[0], 'not yet eligible: no follow-up patch (4.0.1+ not released)');
  const ok = find(run(only([['4.0.0', '2026-08-01'], ['4.0.1', '2026-09-01']])), 'luxon', 'bump');
  assert.equal(ok.status, 'eligible');
  assert.equal(ok.target, '4.0.1');
});

test('B: PHP needs x.y.2+ as follow-up', () => {
  const b = find(run(), 'php', 'bump');
  assert.equal(b.scope, '8.3');
  assert.equal(b.lineKey, '8.4');
  assert.equal(b.status, 'eligible');
  const early = run({ mutateInv: (inv) => { inv.items.find((i) => i.ecosystem === 'php-runtime' && i.scope === '8.4').meta.latest = '8.4.1'; } });
  const e = find(early, 'php', 'bump');
  assert.equal(e.status, 'not-yet-eligible');
  assert.match(e.reason[0], /no follow-up patch \(8\.4\.2\+ not released\)/);
});

test('B: PHP 8.4 eligibility from endoflife data + imap note; 8.5 kept as alternative', () => {
  const b = find(run(), 'php', 'bump');
  assert.equal(b.tier, 'B');
  assert.equal(b.target, '8.4.27');
  assert.ok(b.reason.some((r) => /age \d+d >= 30d/.test(r)));
  assert.ok(b.reason.some((r) => /follow-up patch 8\.4\.2\+ exists/.test(r)));
  assert.equal(b.notes.length, 1);
  assert.match(b.notes[0], /ext-imap is no longer bundled with PHP 8\.4\+/);
  assert.deepEqual(b.alternatives.map((a) => a.line), ['8.5']);
});

test('PHP side-by-side minors/packages are tier null with a note; EOL minors are never targets', () => {
  const res = run();
  const sbs = res.candidates.filter((c) => (c.name === 'php' && c.scope === '8.4') || c.name === 'php8.4-cli');
  assert.equal(sbs.length, 2);
  for (const c of sbs) {
    assert.equal(c.tier, null);
    assert.equal(c.status, 'side-by-side');
    assert.ok(c.notes.includes('installed side-by-side, handled by maint/tier-B proposal'));
  }
  const eol = res.candidates.find((c) => c.name === 'php' && c.scope === '8.1');
  assert.ok(eol.reason.some((r) => /PHP 8\.1 reached end-of-life on 2025-12-31/.test(r)));
  const none = run({ mutateInv: (inv) => { for (const i of inv.items) if (i.ecosystem === 'php-runtime' && ['8.4', '8.5'].includes(i.scope)) { i.eol = '2025-01-01'; i.meta.eol = '2025-01-01'; } } });
  assert.equal(find(none, 'php', 'bump'), undefined);
});

test('B blocked: composer require.php / config.platform.php vs target PHP', () => {
  const req = run({ mutateInv: (inv) => { item(inv, '(lockfile)').meta.platform.require = '>=8.2 <8.4'; } });
  const b = find(req, 'php', 'bump');
  assert.equal(b.status, 'blocked');
  assert.match(b.blockers[0], /composer require\.php ">=8\.2 <8\.4" \(site\.example\) does not allow PHP 8\.4/);
  const plat = run({ mutateInv: (inv) => { item(inv, '(lockfile)').meta.platform.configPlatform = '8.5.0'; } });
  assert.match(find(plat, 'php', 'bump').blockers[0], /config\.platform\.php 8\.5\.0 .* above target PHP 8\.4/);
});

test('B blocked: npm engines vs Node target, puppeteer major vs Node major, engines/peerDeps of a candidate', () => {
  const eng = find(run(), 'nodejs', 'bump');
  assert.equal(eng.status, 'blocked');
  assert.match(eng.blockers[0], /npm app app-a engines\.node ">=18 <=22" excludes Node 24/);
  const pup = run({
    mutateInv: (inv) => { inv.items = inv.items.filter((i) => i.name !== '(app)'); inv.items.push({ ecosystem: 'npm', name: 'puppeteer', scope: 'pdf', installed: '24.1.0', candidates: [], source: 'f', meta: {} }); },
    mutatePolicy: (p) => { p.compat.puppeteerMinNode['24'] = 26; },
  });
  assert.match(find(pup, 'nodejs', 'bump').blockers[0], /puppeteer 24\.1\.0 \(pdf\) needs Node >= 26, target is Node 24/);
  const mk = (version, releaseDate, extra) => ({ version, releaseDate, source: 'f', security: false, ...extra });
  const peer = run({ mutateInv: (inv) => { item(inv, 'zod').candidates = [mk('3.30.0', '2026-08-01'), mk('3.30.1', '2026-08-10', { engines: { node: '>=30' }, peerDependencies: { luxon: '>=9' } })]; } });
  const z = find(peer, 'zod', 'bump');
  assert.equal(z.status, 'blocked');
  assert.match(z.blockers.join('|'), /engines\.node ">=30" excludes installed Node 22/);
  assert.match(z.blockers.join('|'), /peerDependency luxon ">=9" not satisfied by installed 3\.4\.0/);
});

test('B blocked: bootstrap major vs select2-bootstrap-5-theme', () => {
  const b = find(run(), 'bootstrap', 'bump');
  assert.equal(b.status, 'blocked');
  assert.match(b.blockers[0], /bootstrap 6 conflicts with select2-bootstrap-5-theme/);
  const free = run({ mutateInv: (inv) => { inv.items = inv.items.filter((i) => i.name !== 'select2-bootstrap-5-theme'); } });
  assert.equal(find(free, 'bootstrap', 'bump').status, 'eligible');
});

test('B blocked: flatpickr core needs plugins at the same version; intl-tel-input major change', () => {
  const f = find(run(), 'flatpickr', 'bump');
  assert.equal(f.status, 'blocked');
  assert.match(f.blockers[0], /flatpickr core 4\.7\.1 requires plugin flatpickr-confirm at the same version/);
  const ok = run({ mutateInv: (inv) => { item(inv, 'flatpickr-confirm').candidates = [{ version: '4.7.1', releaseDate: '2026-09-02', source: 'f', security: false }]; } });
  assert.equal(find(ok, 'flatpickr', 'bump').status, 'eligible');
  const t = find(run(), 'intl-tel-input', 'bump');
  assert.equal(t.status, 'blocked');
  assert.match(t.blockers[0], /intl-tel-input major change 23 -> 24/);
});

test('C: ubuntu-release is report-only tier C with next LTS target and never auto', () => {
  const e = find(run(), 'ubuntu-release', 'os');
  assert.equal(e.tier, 'C');
  assert.equal(e.target, '24.04');
  assert.equal(e.status, 'report');
  assert.equal(e.neverAuto, true);
  assert.ok(e.reason.some((r) => /end-of-life 2027-06-01 \(\d+ days left\)/.test(r)));
  assert.equal(find(run(), 'ubuntu-release', 'patch'), undefined);
});

test('nginx emits one tier-B mainline->stable runtime switch question without choosing', () => {
  const q = run().candidates.filter((c) => c.line === 'switch');
  assert.equal(q.length, 1);
  assert.equal(q[0].tier, 'B');
  assert.equal(q[0].question, 'mainline->stable');
  assert.equal(q[0].target, null);
  assert.ok(q[0].reason.some((r) => /repo is nginx\.org mainline; stable requires a source change/.test(r)));
});

test('edge cases: unknown release date cannot satisfy soak; docker latest held; informational items skipped', () => {
  const nodate = run({ mutateInv: (inv) => { item(inv, 'express').candidates.forEach((c) => { c.releaseDate = null; }); } });
  assert.equal(find(nodate, 'express', 'patch').status, 'soak');
  const lat = run({ mutateInv: (inv) => { item(inv, 'prom/prometheus').installed = 'latest'; } });
  assert.equal(find(lat, 'prom/prometheus', 'patch').status, 'hold');
  assert.equal(find(run(), 'cdnRefs', 'patch').status, 'info');
  assert.equal(find(run(), '(app)', 'patch').status, 'info');
});

test('plugin contract: evaluate() returns one decision per item; summary is consistent', () => {
  const inv = baseInv();
  const decisions = engine.evaluate(inv.items, { policy: basePolicy(), profile: PROFILE });
  assert.equal(decisions.length, inv.items.length);
  const mdb = decisions.find((d) => d.name === 'mariadb-server' && d.ecosystem === 'mariadb');
  assert.equal(mdb.tier, 'A');
  assert.equal(mdb.action, 'auto');
  const ng = decisions.find((d) => d.name === 'nginx' && d.ecosystem === 'eol');
  assert.equal(ng.target, '1.31.7');
  const res = run();
  assert.equal(res.summary.entries, res.candidates.length);
  assert.equal(Object.values(res.summary.byTier).reduce((a, b) => a + b, 0), res.candidates.length);
});

test('engine is pure: no child_process / network / fs in lib/policy', () => {
  const dir = path.join(ROOT, 'lib', 'policy');
  const files = [path.join(dir, 'engine.js'), ...fs.readdirSync(path.join(dir, 'rules')).map((f) => path.join(dir, 'rules', f))];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /require\(['"](child_process|fs|http|https|net|node:[a-z_]+)['"]\)/, f);
    assert.doesNotMatch(src, /\bfetch\(|\bexec(Sync)?\(|\bspawn(Sync)?\(/, f);
  }
});

test('compat.satisfies handles caret, tilde, wildcard, ranges and OR', () => {
  assert.equal(compat.satisfies('8.4.0', '>=8.2'), true);
  assert.equal(compat.satisfies('8.4.0', '^8.2'), true);
  assert.equal(compat.satisfies('9.0.0', '^8.2'), false);
  assert.equal(compat.satisfies('8.4.0', '~8.3.0'), false);
  assert.equal(compat.satisfies('8.3.5', '8.3.*'), true);
  assert.equal(compat.satisfies('8.5.0', '>=8.2 <8.5'), false);
  assert.equal(compat.satisfies('7.4.0', '^7.4 || ^8.0'), true);
  assert.equal(compat.satisfies('24.0.0', '>=18 <=22'), false);
});

test('npm candidate with a real 10+ day old releaseDate is no longer blocked by "release date unknown"', () => {
  const dated = run({ mutateInv: (inv) => { item(inv, 'express').candidates.forEach((c) => { c.releaseDate = '2026-10-10'; }); } });
  const d = find(dated, 'express', 'patch');
  assert.notEqual(d.status, 'soak');
  assert.ok(!JSON.stringify(d).includes('release date unknown'));
  assert.equal(find(run({ mutateInv: (inv) => { item(inv, 'express').candidates.forEach((c) => { c.releaseDate = null; }); } }), 'express', 'patch').status, 'soak');
});
