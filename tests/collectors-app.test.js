'use strict';
// Run: node --test scripts/stack-updater/tests
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const semver = require('../lib/core/semver');
const composer = require('../lib/collectors/composer');
const npm = require('../lib/collectors/npm');
const frontend = require('../lib/collectors/frontend');

const logs = [];
const log = { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]), error: () => {}, debug: () => {} };

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'su-coll-')); }

// ---------- fixtures ----------
const COMPOSER_LATEST = { installed: [
  { name: 'guzzlehttp/guzzle', version: '7.10.0', latest: '8.0.1', 'latest-status': 'update-possible', 'latest-release-date': '2026-09-01T10:00:00+00:00' },
  { name: 'phpmailer/phpmailer', version: 'v6.9.3', latest: '6.11.1', 'latest-status': 'semver-safe-update' },
] };
const COMPOSER_PATCH = { locked: [{ name: 'phpmailer/phpmailer', version: 'v6.9.3', latest: '6.9.4' }] };
const COMPOSER_MINOR = { locked: [{ name: 'phpmailer/phpmailer', version: 'v6.9.3', latest: '6.11.1' }] };
const COMPOSER_AUDIT = { advisories: {
  'phpmailer/phpmailer': [{ advisoryId: 'PKSA-1', packageName: 'phpmailer/phpmailer', affectedVersions: '>=6.0,<6.10.0', title: 'XSS', cve: 'CVE-2025-0001', severity: 'high' }],
  'dompdf/dompdf': [{ advisoryId: 'PKSA-2', affectedVersions: '<3.2.0', title: 'x', cve: null, severity: 'medium' }],
}, abandoned: {} };
const NPM_OUTDATED = { express: { current: '4.18.2', wanted: '4.21.2', latest: '5.1.0', dependent: 'app' }, puppeteer: { current: '22.0.0', wanted: '22.15.0', latest: '24.2.0', dependent: 'app' } };
const NPM_AUDIT = { vulnerabilities: {
  express: { severity: 'high', isDirect: true, range: '<4.20.0', fixAvailable: { name: 'express', version: '4.21.2', isSemVerMajor: false },
    via: [{ source: 1, name: 'express', title: 'Open redirect', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high', cvss: { score: 7.5 }, range: '<4.20.0' }] },
  qs: { severity: 'moderate', isDirect: false, fixAvailable: true, via: ['express'] },
}, metadata: { vulnerabilities: { total: 2, high: 1, moderate: 1 } } };
const JSDELIVR_SELECT2 = { type: 'npm', name: 'select2', versions: [{ version: '4.1.0-rc.0' }, { version: '4.0.13' }, { version: '3.5.4' }, { version: '4.1.0-beta.1' }] };
const JSDELIVR_BS = { versions: [{ version: '5.3.1' }, { version: '5.3.3' }, { version: '5.4.0' }, { version: '6.0.0-alpha.1' }, { version: '6.0.0' }] };

function mkExec(map, calls = []) {
  return async (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = [cmd, ...args].join(' ');
    for (const [pat, res] of map) if (key.includes(pat)) return Object.assign({ code: 0, stderr: '', timedOut: false, error: null }, typeof res === 'function' ? res(key) : res);
    return { code: 127, stdout: '', stderr: 'no fixture', timedOut: false, error: null };
  };
}

// ---------- composer ----------
test('composer: items, candidates split, security flag, lockfile + platform meta, excluded note', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'public_html'));
  fs.writeFileSync(path.join(root, 'public_html/composer.json'), JSON.stringify({ require: { php: '>=8.2', 'phpmailer/phpmailer': '^6.9', 'guzzlehttp/guzzle': '7.10.0' }, config: { platform: { php: '8.3.0' } } }));
  fs.writeFileSync(path.join(root, 'public_html/composer.lock'), JSON.stringify({ packages: [{ name: 'dompdf/dompdf', version: '3.1.0' }, { name: 'phpmailer/phpmailer', version: 'v6.9.3' }], platform: { php: '>=8.2' } }));
  const lockBefore = fs.statSync(path.join(root, 'public_html/composer.lock')).mtimeMs;
  const calls = [];
  const exec = mkExec([
    ['outdated --locked --direct --patch-only', { stdout: JSON.stringify(COMPOSER_PATCH) }],
    ['outdated --locked --direct --minor-only', { stdout: JSON.stringify(COMPOSER_MINOR) }],
    ['outdated', { stdout: 'Warning: noise\n' + JSON.stringify(COMPOSER_LATEST) }],
    ['audit', { code: 1, stdout: JSON.stringify(COMPOSER_AUDIT) }],
  ], calls);
  const ctx = {
    profile: { webRoots: [{ domain: 'a.example', env: 'test', path: root }], composerExcluded: [{ domain: 'gone.example', path: '/nowhere', reason: 'not in repo' }] },
    semver, log, exec,
    fetchJson: async () => ({ packages: { 'phpmailer/phpmailer': [{ version: 'v6.9.4', time: '2025-01-02T00:00:00+00:00' }] } }),
  };
  const items = await composer.collect(ctx);
  const by = Object.fromEntries(items.map((i) => [i.name, i]));
  assert.ok(items.every((i) => i.ecosystem === 'composer' && i.scope === 'a.example'));
  const pm = by['phpmailer/phpmailer'];
  assert.equal(pm.installed, '6.9.3');
  assert.deepEqual(pm.candidates.map((c) => [c.type, c.version]), [['patch', '6.9.4'], ['minor', '6.11.1']]);
  assert.equal(pm.candidates[0].security, false); // 6.9.4 is still inside <6.10.0
  assert.equal(pm.candidates[1].security, true);
  assert.deepEqual(pm.candidates[1].advisories, ['CVE-2025-0001']);
  assert.equal(pm.candidates[0].releaseDate, '2025-01-02');
  assert.deepEqual(by['guzzlehttp/guzzle'].candidates.map((c) => c.type), ['major']);
  assert.equal(by['guzzlehttp/guzzle'].candidates[0].releaseDate, '2026-09-01'); // from composer, no packagist call
  assert.equal(by['dompdf/dompdf'].installed, '3.1.0'); // audit-only package, version from lock
  assert.equal(by['dompdf/dompdf'].meta.vulnerable, true);
  const sum = by['(lockfile)'];
  assert.equal(sum.meta.platform.require, '>=8.2');
  assert.equal(sum.meta.platform.configPlatform, '8.3.0');
  assert.deepEqual(sum.meta.counts, { outdated: 2, vulnerable: 2, advisories: 2 });
  assert.ok(sum.meta.lockMtime);
  assert.ok(logs.some(([, m]) => /gone\.example.*skipped/.test(m)));
  // never mutating commands
  assert.ok(calls.every((c) => !c.some((a) => /^(update|install|require|remove)$/.test(a))));
  assert.ok(calls.some((c) => c.includes('--working-dir=' + path.join(root, 'public_html'))));
  assert.equal(fs.statSync(path.join(root, 'public_html/composer.lock')).mtimeMs, lockBefore);
});

test('composer: timeout/garbage is a warning, not a crash', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'public_html'));
  fs.writeFileSync(path.join(root, 'public_html/composer.json'), '{"require":{}}');
  const exec = async () => ({ code: 1, stdout: '', stderr: 'x', timedOut: true, error: null });
  const items = await composer.collect({ profile: { webRoots: [{ domain: 'b.example', env: 'prod', path: root }] }, semver, log, exec, fetchJson: async () => ({}) });
  assert.equal(items.length, 1);
  assert.equal(items[0].meta.outdatedRan, false);
  assert.equal(items[0].meta.auditRan, false);
});

// ---------- npm ----------
test('npm: outdated/audit/puppeteer/pm2 from fixtures, npm install never called', async () => {
  const app = tmp();
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'svc', version: '1.2.3', dependencies: { express: '^4.18.2', puppeteer: '^22.0.0' } }));
  fs.writeFileSync(path.join(app, 'package-lock.json'), JSON.stringify({ packages: { '': {}, 'node_modules/express': { version: '4.18.2' }, 'node_modules/qs': { version: '6.11.0' } } }));
  fs.mkdirSync(path.join(app, 'node_modules/puppeteer-core/lib/cjs/puppeteer'), { recursive: true });
  fs.mkdirSync(path.join(app, 'node_modules/puppeteer'), { recursive: true });
  fs.writeFileSync(path.join(app, 'node_modules/puppeteer/package.json'), '{"version":"22.0.0"}');
  fs.writeFileSync(path.join(app, 'node_modules/puppeteer-core/package.json'), '{"version":"22.0.0"}');
  fs.writeFileSync(path.join(app, 'node_modules/puppeteer-core/lib/cjs/puppeteer/revisions.js'), "exports.PUPPETEER_REVISIONS = { chrome: '121.0.6167.85', firefox: 'stable_122' };");
  const calls = [];
  const exec = mkExec([
    ['outdated', { code: 1, stdout: JSON.stringify(NPM_OUTDATED) }],
    ['audit', { code: 1, stdout: JSON.stringify(NPM_AUDIT) }],
    ['pm2 jlist', { stdout: JSON.stringify([{ name: 'svc', pid: 7, pm2_env: { status: 'online', restart_time: 2, pm_cwd: app, env: { SECRET: 'x' } } }]) }],
  ], calls);
  const items = await npm.collect({
    profile: { npmApps: [{ path: 'apps/svc', runtimePath: app, pm2Name: 'svc', pm2User: os.userInfo().username }] },
    semver, log, exec, repoPath: (p) => path.join('/nonexistent-repo', p),
  });
  const by = Object.fromEntries(items.map((i) => [i.name, i]));
  assert.equal(by.express.installed, '4.18.2');
  assert.deepEqual(by.express.candidates.map((c) => [c.type, c.version, c.security]), [['minor', '4.21.2', true], ['major', '5.1.0', true]]);
  assert.equal(by.express.candidates[0].cvss, 7.5);
  assert.deepEqual(by.express.candidates[0].advisories, ['GHSA-aaaa-bbbb-cccc']);
  assert.equal(by.qs.installed, '6.11.0');
  assert.equal(by.puppeteer.meta.puppeteer.bundledChrome, '121.0.6167.85');
  const sum = by['(app)'];
  assert.equal(sum.installed, '1.2.3');
  assert.equal(sum.meta.counts.outdated, 2);
  assert.equal(sum.meta.counts.vulnerable, 2);
  assert.equal(sum.meta.pm2.running, true);
  assert.equal(sum.meta.pm2.process.env, undefined);
  assert.equal(sum.meta.puppeteer.puppeteer, '22.0.0');
  assert.ok(calls.every((c) => !c.includes('install') && !c.includes('update') && !c.includes('ci')));
});

test('npm: failing audit/outdated degrade to warnings', async () => {
  const app = tmp();
  fs.writeFileSync(path.join(app, 'package.json'), '{"name":"x","version":"1.0.0"}');
  const exec = async () => ({ code: 1, stdout: '', stderr: 'boom', timedOut: true, error: null });
  const items = await npm.collect({ profile: { npmApps: [{ path: 'a', runtimePath: app }] }, semver, log, exec, repoPath: (p) => p });
  assert.equal(items.length, 1);
  assert.equal(items[0].meta.auditRan, false);
});

// ---------- frontend ----------
test('frontend: missing manifest -> warning item; CDN refs counted per library', async () => {
  const exec = mkExec([['grep', { stdout: [
    'cdn.jsdelivr.net/npm/bootstrap@5.3.1/dist/css/bootstrap.min.css',
    'cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/x.css',
    'cdnjs.cloudflare.com/ajax/libs/select2/4.1.0/js/select2.min.js',
    'cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/5.3.1/js/bootstrap.min.js',
    'unpkg.com/flatpickr',
    'cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.js',
    'cdn.jsdelivr.net/npm/intl-tel-input@18/build/js/intlTelInput.min.js',
  ].join('\n') }]]);
  const items = await frontend.collect({
    profile: { repo: '/nonexistent', webRoots: [{ domain: 't.example', env: 'test', path: '/nonexistent/t', repoPath: 'x/t' }] },
    semver, log, exec, policy: {}, repoPath: (p) => path.join('/nonexistent', p),
  });
  const m = items.find((i) => i.name === '(manifest)');
  assert.equal(m.meta.warning, 'manifest not yet created');
  const cdn = items.find((i) => i.ecosystem === 'frontend' && i.name === 'cdnRefs');
  assert.equal(cdn.meta.total, 7);
  assert.deepEqual(cdn.meta.perLibrary, { bootstrap: 2, 'bootstrap-icons': 1, 'chart.js': 1, flatpickr: 1, 'intl-tel-input': 1, select2: 1 });
});

test('frontend: manifest + jsdelivr, prereleases filtered except select2 whitelist', async () => {
  const repo = tmp();
  const vendor = path.join(repo, 'x/t/public_html/assets/vendor');
  fs.mkdirSync(vendor, { recursive: true });
  fs.writeFileSync(path.join(vendor, 'manifest.json'), JSON.stringify({ libraries: { bootstrap: { version: '5.3.1' }, select2: { version: '4.0.13' } } }));
  const fetchJson = async (url) => {
    if (url.endsWith('/select2')) return JSDELIVR_SELECT2;
    if (url.endsWith('/bootstrap')) return JSDELIVR_BS;
    throw new Error('404');
  };
  const items = await frontend.collect({
    profile: { repo, webRoots: [{ domain: 't.example', env: 'test', path: '/nonexistent/t', repoPath: 'x/t' }] },
    semver, log, exec: mkExec([['grep', { code: 1, stdout: '' }]]), fetchJson,
    policy: { forbidPrerelease: '(alpha|beta|rc|dev)', pins: { select2: { allow: ['4.1.0-rc.0'] } } },
    repoPath: (p) => path.join(repo, p),
  });
  const bs = items.find((i) => i.name === 'bootstrap');
  assert.deepEqual(bs.candidates.map((c) => [c.type, c.version]), [['patch', '5.3.3'], ['minor', '5.4.0'], ['major', '6.0.0']]);
  const s2 = items.find((i) => i.name === 'select2');
  assert.deepEqual(s2.candidates.map((c) => [c.type, c.version]), [['minor', '4.1.0-rc.0']]); // whitelisted rc, beta dropped
  const cdn = items.find((i) => i.name === 'cdnRefs');
  assert.equal(cdn.meta.total, 0);
});

// ---------- npm release dates (registry `time` map) ----------
const U = require('../lib/collectors/_appUtil');
const NPM_DOC = { name: 'x', time: { created: '2020-01-01T00:00:00.000Z', '4.21.2': '2025-03-04T11:22:33.000Z', '5.1.0': '2026-10-22T08:00:00.000Z', '4.0.13': '2022-05-06T00:00:00.000Z', '4.0.14': '2022-06-07T00:00:00.000Z' } };

test('npmReleaseDate: one fetch per package, scoped name encoded, 404 -> null + single log line', async () => {
  const urls = [];
  const warns = [];
  const ctx = { fetchJson: async (url, opts) => { urls.push([url, opts.timeout]); if (url.includes('missing')) throw new Error('HTTP 404'); return NPM_DOC; } };
  const lg = { warn: (m) => warns.push(m), debug: () => {} };
  const cache = new Map();
  assert.equal(await U.npmReleaseDate(ctx, cache, '@scope/pkg', '4.21.2', lg), '2025-03-04');
  assert.equal(await U.npmReleaseDate(ctx, cache, '@scope/pkg', 'v5.1.0', lg), '2026-10-22');
  assert.equal(await U.npmReleaseDate(ctx, cache, '@scope/pkg', '9.9.9', lg), null);
  assert.equal(urls.length, 1);
  assert.equal(urls[0][0], 'https://registry.npmjs.org/@scope%2Fpkg');
  assert.equal(urls[0][1], 20000);
  assert.equal(await U.npmReleaseDate(ctx, cache, 'missing', '1.0.0', lg), null);
  assert.equal(await U.npmReleaseDate(ctx, cache, 'missing', '1.0.1', lg), null);
  assert.equal(urls.length, 2);
  assert.equal(warns.length, 1);
});

test('npm collector: candidates carry releaseDate; registry fetched once per package', async () => {
  const app = tmp();
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'svc', version: '1.0.0', dependencies: { express: '^4.18.2' } }));
  fs.writeFileSync(path.join(app, 'package-lock.json'), JSON.stringify({ packages: { '': {}, 'node_modules/express': { version: '4.18.2' } } }));
  const exec = mkExec([
    ['outdated', { code: 1, stdout: JSON.stringify({ express: { current: '4.18.2', wanted: '4.21.2', latest: '5.1.0' } }) }],
    ['audit', { stdout: JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } }) }],
  ]);
  const urls = [];
  const fetchJson = async (url) => { urls.push(url); return url.endsWith('/express') ? NPM_DOC : { time: {} }; };
  const items = await npm.collect({ profile: { npmApps: [{ path: 'a', runtimePath: app }] }, semver, log, exec, fetchJson, repoPath: (p) => p });
  const ex = items.find((i) => i.name === 'express');
  assert.deepEqual(ex.candidates.map((c) => [c.version, c.releaseDate]), [['4.21.2', '2025-03-04'], ['5.1.0', '2026-10-22']]);
  assert.equal(urls.filter((u) => u.endsWith('/express')).length, 1);
});

test('frontend collector: manifest libs resolve releaseDate via npm alias; 404 -> null', async () => {
  const repo = tmp();
  const vendor = path.join(repo, 'x/t/public_html/assets/vendor');
  fs.mkdirSync(vendor, { recursive: true });
  fs.writeFileSync(path.join(vendor, 'manifest.json'), JSON.stringify({ libs: { 'my-lib': { active: '4.0.13', npm: '@scope/real' }, other: { active: '4.0.13' } } }));
  const regUrls = [];
  const fetchJson = async (url) => {
    if (url.includes('registry.npmjs.org')) { regUrls.push(url); if (url.endsWith('/other')) throw new Error('HTTP 404'); return NPM_DOC; }
    return { versions: [{ version: '4.0.14' }] };
  };
  const items = await frontend.collect({
    profile: { repo, webRoots: [{ domain: 't.example', env: 'test', path: '/nonexistent/t', repoPath: 'x/t' }] },
    semver, log, exec: mkExec([['grep', { code: 1, stdout: '' }]]), fetchJson, policy: {}, repoPath: (p) => path.join(repo, p),
  });
  assert.equal(items.find((i) => i.name === '@scope/real').candidates[0].releaseDate, '2022-06-07');
  assert.equal(items.find((i) => i.name === 'other').candidates[0].releaseDate, null);
  assert.deepEqual(regUrls.sort(), ['https://registry.npmjs.org/@scope%2Freal', 'https://registry.npmjs.org/other']);
});
