'use strict';
// Run: node --test scripts/stack-updater/tests
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const markdown = require('../lib/reporter/markdown');
const notify = require('../lib/reporter/notify');
const { collectAdvisories } = require('../lib/reporter/_common');
const ADAPTER = path.join(ROOT, 'profiles', 'example', 'adapters', 'notify-telegram.sh');

function mkRun() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rep-'));
  const run = path.join(dir, '20261024-2200-apply-tier-a');
  fs.mkdirSync(run);
  const w = (n, d) => fs.writeFileSync(path.join(run, n), JSON.stringify(d));
  w('inventory.json', { items: [
    { ecosystem: 'composer', scope: 'web', name: 'vendor/pkg', installed: '1.0.0', candidates: [{ version: '1.0.1', security: true, cvss: 9.8, advisories: [{ id: 'GHSA-1', title: 'rce', cvss: 9.8 }] }] },
    { ecosystem: 'npm', name: 'lodash', installed: '4.0.0', candidates: [{ version: '4.0.1', security: true, cvss: 5, advisories: [{ id: 'GHSA-2', text: 'minor' }] }] },
    { ecosystem: 'usn', name: 'USN-9999-1', installed: 'n/a', candidates: [], meta: { title: 'openssl issue, actively exploited in the wild', cves: ['CVE-2026-1'] } },
    { ecosystem: 'os', name: 'ubuntu-release', installed: '22.04', eol: '2027-04-01', candidates: [] },
    { ecosystem: 'frontend', name: 'cdnRefs', installed: '7', candidates: [], meta: { kind: 'cdn-refs', total: 7, perLibrary: { jquery: ['3.6.0', '3.7.1'], bootstrap: ['5.3.1'] } } },
    { ecosystem: 'vendor-js', name: 'select2', installed: '4.1.0-rc.0', candidates: [] },
  ] });
  w('candidates.json', { candidates: [
    { key: 'php-runtime::8.3::php', ecosystem: 'php-runtime', name: 'php', installed: '8.3.12', target: '8.4.1', tier: 'B', status: 'blocked', action: 'hold', reason: ['minor bump'], blockers: ['ext imap missing on 8.4'], notes: [] },
    { key: 'apt::nginx', ecosystem: 'apt', name: 'nginx', installed: '1.31.3', target: '1.31.8', tier: 'A', status: 'soak', pending: { version: '1.31.8', ageDays: 2, eligibleOn: '2026-10-29' }, reason: [] },
    { key: 'os::ubuntu-release', ecosystem: 'os', name: 'ubuntu-release', installed: '22.04', target: '24.04', tier: 'C', status: 'report', reason: [], notes: [] },
    { key: 'eol::nginx', ecosystem: 'eol', name: 'nginx', installed: '1.31.3', tier: 'B', status: 'question', question: 'mainline->stable', reason: [] },
  ] });
  w('analysis.json', { findings: [], proposals: [], candidates: [{ name: 'php', installed: '8.3.12', target: '8.4.1', verdict: 'needs-code-change', summary: 'API changes.', codeChanges: [{ file: 'a.php', line: 3, what: 'each() removed' }] }] });
  w('backup.json', { dryRun: false, entries: [{ plugin: 'bundle', component: 'host', artifact: '/srv/bundle.tgz', remote: 's3remote:b/x' }], errors: [] });
  w('apply-test.json', { env: 'test', applied: [{ key: 'apt::curl', from: '1', to: '2', plugin: 'apt' }], failed: [], skipped: [] });
  w('verify-test.json', { env: 'test', ok: true, results: [{ name: 'http-smoke', ok: true }, { name: 'nginx-5xx', ok: true, details: '0 5xx' }] });
  w('summary.json', { runId: path.basename(run), mode: 'apply-tier-a', status: 'ok', startedAt: '2026-10-24T22:00:00Z', finishedAt: '2026-10-24T22:12:05Z', window: { reason: 'inside maintenance window' } });
  return { dir, run };
}

test('markdown renders all sections, UTC run date file, report.json', () => {
  const { dir, run } = mkRun();
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  const r = markdown.write(run, { repo, reportDir: 'qa/stack-updates' });
  assert.equal(path.basename(r.mdPath), '2026-10-24.md');
  const md = fs.readFileSync(r.mdPath, 'utf8');
  for (const s of markdown.SECTIONS) assert.match(md, new RegExp(`^## ${s}$`, 'm'), s);
  assert.match(md, /apt::curl/); assert.match(md, /12m 5s/); assert.match(md, /imap/); assert.match(md, /mainline → stable/);
  assert.match(md, /jquery \(3\.6\.0, 3\.7\.1\)/); assert.match(md, /a\.php:3/); assert.match(md, /\/srv\/bundle\.tgz/);
  const j = JSON.parse(fs.readFileSync(path.join(run, 'report.json'), 'utf8'));
  assert.equal(j.counts.applied, 1); assert.equal(j.counts.criticalAdvisories, 2);
  fs.rmSync(dir, { recursive: true });
});

// Noisy-run fixture: 4 composer roots (2 distinct locks), nginx/mariadb under eol::/mariadb::/apt::, 13 USN without score.
function mkNoisyRun() {
  const { dir, run } = mkRun();
  const rd = (n) => JSON.parse(fs.readFileSync(path.join(run, n), 'utf8'));
  const w = (n, d) => fs.writeFileSync(path.join(run, n), JSON.stringify(d));
  const roots = ['test.example.com', 'example.com', 'test.example.org', 'example.org'];
  const mtime = { 'test.example.com': 'T1', 'test.example.org': 'T1', 'example.com': 'T0', 'example.org': 'T0' };
  const inv = rd('inventory.json');
  for (const r of roots) inv.items.push({ ecosystem: 'composer', scope: r, name: '(lockfile)', installed: 'n/a', candidates: [], meta: { lockMtime: mtime[r], counts: {} } });
  for (const r of roots) inv.items.push({ ecosystem: 'composer', scope: r, name: 'guzzlehttp/guzzle', installed: '7.0.0', candidates: [{ version: '7.0.1', security: true, cvss: 7, advisories: [{ id: 'GHSA-GZ', cvss: 7 }] }] });
  for (let i = 0; i < 13; i++) inv.items.push({ ecosystem: 'usn', name: `USN-100${i}-1`, installed: 'n/a', candidates: [{ version: '1', cvss: 0, advisories: [] }], meta: { title: 'low prio' } });
  w('inventory.json', inv);
  const cand = rd('candidates.json');
  for (const r of roots) {
    // test roots are one tree, prod roots another; prod lags on installed version
    const prod = mtime[r] === 'T0';
    cand.candidates.push({ key: `composer:${r}:guzzlehttp/guzzle`, ecosystem: 'composer', scope: r, name: 'guzzlehttp/guzzle', installed: prod ? '7.0.0' : '7.1.0', target: '7.2.0', tier: 'B', status: 'hold', reason: ['minor'], blockers: [] });
  }
  cand.candidates.push(
    { key: 'eol::nginx', ecosystem: 'eol', name: 'nginx', installed: '1.31.3', target: '1.31.7', tier: 'A', status: 'ready', reason: ['patch'], blockers: [], pending: { version: '1.31.8', eligibleOn: '2026-10-28' } },
    { key: 'apt::nginx', ecosystem: 'apt', name: 'nginx', installed: '1.31.3', target: '1.31.7', tier: 'A', status: 'ready', reason: ['soaked 9 days'], blockers: [], pending: { version: '1.31.8', eligibleOn: '2026-10-28' } },
    { key: 'mariadb::mariadb-server', ecosystem: 'mariadb', name: 'mariadb-server', installed: '11.4.12', target: '11.4.13', tier: 'B', status: 'hold', reason: ['from lifecycle'], blockers: ['replication check'] },
    { key: 'apt::mariadb-server', ecosystem: 'apt', name: 'mariadb-server', installed: '11.4.12', target: '11.4.13', tier: 'B', status: 'blocked', reason: ['from apt'], blockers: [] },
  );
  w('candidates.json', cand);
  return { dir, run };
}

test('componentAlias maps lifecycle/apt keys to one component', () => {
  const { componentAlias } = require('../lib/reporter/_common');
  assert.equal(componentAlias('eol::nginx'), 'nginx'); assert.equal(componentAlias('apt::nginx'), 'nginx');
  assert.equal(componentAlias('mariadb::mariadb-server'), 'mariadb-server'); assert.equal(componentAlias('apt::mariadb-server'), 'mariadb-server');
  assert.equal(componentAlias('apt::curl'), 'apt::curl');
});

test('markdown dedup: composer grouping, nginx/mariadb merge, USN collapse; report.json unchanged', () => {
  const { dir, run } = mkNoisyRun();
  const common = require('../lib/reporter/_common');
  const d = common.loadRunData(run);
  const before = JSON.stringify(markdown.render(d).report);
  const out = markdown.render(d);
  assert.equal(JSON.stringify(out.report), before);
  // report.json written to disk equals the raw machine data (no labels / merged rows leak in)
  markdown.write(run, {});
  const onDisk = fs.readFileSync(path.join(run, 'report.json'), 'utf8');
  assert.equal(onDisk, JSON.stringify(out.report, null, 2) + '\n');
  assert.ok(!/_label|_roots|\(keys:/.test(onDisk));
  assert.equal(out.report.tierB.filter((c) => c.name === 'guzzlehttp/guzzle').length, 4);
  assert.equal(out.report.advisories.filter((x) => x.ecosystem === 'usn').length, 14);
  const md = out.md;
  // composer: 4 raw rows -> 2 rows (test group / prod group, differing installed stay separate)
  const tb = md.split('## Proposed tier B')[1].split('## Tier C')[0];
  const gz = tb.split('\n').filter((l) => l.startsWith('| composer::guzzlehttp/guzzle'));
  assert.equal(gz.length, 2);
  assert.ok(gz.some((l) => l.includes('[test.example.com, test.example.org]') && l.includes('7.1.0 → 7.2.0')));
  assert.ok(gz.some((l) => l.includes('[example.com, example.org]') && l.includes('7.0.0 → 7.2.0')));
  // mariadb merge: one row, union of reasons/blockers, strictest status, both keys kept
  const mr = tb.split('\n').filter((l) => l.includes('mariadb-server'));
  assert.equal(mr.length, 1);
  assert.match(mr[0], /\(keys: mariadb::mariadb-server, apt::mariadb-server\)/);
  assert.match(mr[0], /blocked/); assert.match(mr[0], /from lifecycle; from apt/); assert.match(mr[0], /replication check/);
  // nginx: single item among tier A ready lines
  const soakSec = md.split('## Tier A candidates in soak')[1].split('## Security')[0];
  assert.equal(soakSec.split('\n').filter((l) => /^- .*nginx/.test(l)).length, 1);
  assert.match(soakSec, /nginx \(keys: eol::nginx, apt::nginx\)/);
  // Security: 13 USN rows collapsed to a single count line; the exploited one stays; composer advisory deduped
  const sec = md.split('## Security')[1].split('## Dependency audit')[0];
  assert.match(sec, /13 USN notices without a CVSS score and without a fix \(listed in report\.json\)/);
  assert.ok(!/USN-100\d-1/.test(sec)); assert.match(sec, /USN-9999-1/);
  assert.equal(sec.split('\n').filter((l) => l.includes('GHSA-GZ')).length, 2);
  fs.rmSync(dir, { recursive: true });
});

test('critical = CVSS>=9 or actively exploited', () => {
  const { dir, run } = mkRun();
  const adv = collectAdvisories(JSON.parse(fs.readFileSync(path.join(run, 'inventory.json'), 'utf8')));
  assert.deepEqual(adv.filter((a) => a.critical).map((a) => a.id).sort(), ['GHSA-1', 'USN-9999-1']);
  fs.rmSync(dir, { recursive: true });
});

test('notify summary <= 900 chars and has the key counts', () => {
  const { dir, run } = mkRun();
  const d = require('../lib/reporter/_common').loadRunData(run);
  for (let i = 0; i < 40; i++) d.inventory.items.push({ ecosystem: 'npm', name: `x${i}`, installed: '1', candidates: [{ version: '2', security: true, cvss: 9.9, advisories: [{ id: `ID-${i}` }] }] });
  const t = notify.buildSummary(d, { reportPath: 'qa/stack-updates/2026-10-24.md' });
  assert.ok(t.length <= 900);
  assert.match(t, /applied: 1/); assert.match(t, /qa\/stack-updates\/2026-10-24\.md/);
  fs.rmSync(dir, { recursive: true });
});

test('advisory mode: critical wording, nothing when none', () => {
  const { dir, run } = mkRun();
  const inv = JSON.parse(fs.readFileSync(path.join(run, 'inventory.json'), 'utf8'));
  const s = notify.buildAdvisorySummary(inv);
  assert.ok(s.text.startsWith('Critical CVE — consider running outside the window'));
  assert.equal(s.critical.length, 2);
  assert.equal(notify.buildAdvisorySummary({ items: [] }).text, null);
  fs.rmSync(dir, { recursive: true });
});

function fakeCurl(dir, body) {
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash\ncat > "${dir}/cfg"\necho "$@" > "${dir}/args"\nfor a in "$@"; do case "$a" in text@*) cp "\${a#text@}" "${dir}/text";; esac; done\necho '${body}'\n`, { mode: 0o755 });
  return bin;
}

test('adapter: token via stdin config (not argv), HTML escaped, token masked, exit by ok', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'));
  fs.writeFileSync(path.join(dir, 'tok'), 'SECRETTOKEN123:abc\n', { mode: 0o400 });
  fs.writeFileSync(path.join(dir, 'env'), 'TELEGRAM_BOT_TOKEN=other\n');
  const run = (body) => spawnSync('bash', [ADAPTER], {
    input: 'a <b> & c', encoding: 'utf8',
    env: { PATH: `${fakeCurl(dir, body)}:${process.env.PATH}`, NOTIFY_TOKEN_FILE: path.join(dir, 'tok'), NOTIFY_ENV_FILE: path.join(dir, 'env'), NOTIFY_CHAT_ID: '42' },
  });
  let r = run('{"ok":true,"result":{"message_id":7,"echo":"SECRETTOKEN123:abc"}}');
  assert.equal(r.status, 0);
  assert.ok(!r.stdout.includes('SECRETTOKEN123'), 'token masked');
  assert.match(r.stdout, /message_id":7/);
  assert.ok(!fs.readFileSync(path.join(dir, 'args'), 'utf8').includes('SECRETTOKEN123'), 'token not in argv');
  assert.match(fs.readFileSync(path.join(dir, 'cfg'), 'utf8'), /bot SECRETTOKEN123:abc\/sendMessage|botSECRETTOKEN123:abc\/sendMessage/);
  assert.equal(fs.readFileSync(path.join(dir, 'text'), 'utf8').trim(), 'a &lt;b&gt; &amp; c');
  assert.match(fs.readFileSync(path.join(dir, 'args'), 'utf8'), /--max-time 10/);
  r = run('{"ok":false,"description":"bad"}');
  assert.equal(r.status, 1);
  fs.rmSync(dir, { recursive: true });
});

test('notify.send runs the profile adapter by type; no-op without config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-'));
  fs.mkdirSync(path.join(dir, 'adapters'));
  fs.writeFileSync(path.join(dir, 'adapters', 'notify-fake.sh'), '#!/bin/bash\ncat > "$NOTIFY_ENV_FILE.out"\necho "{\\"ok\\":true}"\n');
  const cfg = { profileDir: dir, profile: { notify: { type: 'fake', tokenFile: '/x', envFile: path.join(dir, 'e'), chatId: '1' } } };
  const r = notify.send(cfg, 'hello');
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'e.out'), 'utf8'), 'hello');
  assert.equal(notify.send({ profileDir: dir, profile: {} }, 'x').sent, false);
  assert.equal(notify.adapterPath(dir, '../evil'), null);
  fs.rmSync(dir, { recursive: true });
});

test('core reporter is channel- and site-agnostic', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'lib', 'reporter'))) {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'reporter', f), 'utf8');
    assert.ok(!/telegram|\/home\//i.test(src), `${f} has forbidden strings`);
  }
});
