'use strict';
// Fixture-based tests for the system collectors (apt / docker / advisories). No network, no host access.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const semver = require('../lib/core/semver');
const apt = require('../lib/collectors/apt');
const docker = require('../lib/collectors/docker');
const adv = require('../lib/collectors/advisories');
const { isoDate } = require('../lib/collectors/_sysUtil');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const fxj = (n) => JSON.parse(fx(n));
const P = apt.parse;

test('apt: parse apt list --upgradable', () => {
  const l = P.upgradable(fx('apt-list-upgradable.txt'));
  const nginx = l.find((u) => u.name === 'nginx');
  assert.deepEqual([nginx.installed, nginx.candidate, nginx.suites], ['1.31.3-1~jammy', '1.31.8-1~jammy', ['stable']]);
  assert.ok(l.find((u) => u.name === 'mariadb-server' && u.candidate.startsWith('1:11.4.13')));
});

test('apt: parse policy (versions, pins, origins)', () => {
  const pol = P.policy(fx('apt-policy.txt'));
  const node = pol.get('nodejs');
  assert.equal(node.installed, '22.23.2-1nodesource1');
  assert.equal(node.candidate, '22.23.4-1nodesource1');
  assert.equal(node.versions[0].pin, 600, 'nodesource apt pin 600 is recorded');
  assert.equal(node.versions.find((v) => v.current).version, '22.23.2-1nodesource1');
  const php = pol.get('php8.3-fpm');
  assert.equal(php.versions.length, 1);
  assert.match(php.versions[0].origins[0].url, /ppa\.launchpadcontent\.net\/ondrej\/php/);
  assert.equal(php.versions[0].origins[0].suite, 'jammy');
});

test('apt: parse madison, deb version compare, upstream extraction', () => {
  const m = P.madison(fx('apt-madison.txt'));
  assert.equal(m.get('nginx')[0].version, '1.31.8-1~jammy');
  assert.equal(m.get('php8.3-fpm').length, 1);
  assert.equal(P.debCompare('1:11.4.13+maria~ubu2204', '1:11.4.12+maria~ubu2204'), 1);
  assert.equal(P.debCompare('1.19.2-2ubuntu0.8', '1.19.2-2ubuntu0.10'), -1);
  assert.equal(P.debCompare('2:1.0', '9.9'), 1);
  assert.equal(P.debCompare('1.0~rc1', '1.0'), -1);
  assert.equal(P.upstreamOf('1:11.4.13+maria~ubu2204'), '11.4.13');
  assert.equal(P.upstreamOf('5:29.9.2-1~ubuntu.22.04~jammy'), '29.9.2');
  assert.equal(P.upstreamOf('8.3.36-1+ubuntu22.04.1+deb.sury.org+1'), '8.3.36');
});

test('apt: repo labels', () => {
  assert.equal(P.repoLabel('https://ppa.launchpadcontent.net/ondrej/php/ubuntu'), 'ppa:ondrej/php');
  assert.equal(P.repoLabel('https://nginx.org/packages/mainline/ubuntu'), 'nginx.org/packages/mainline');
  assert.equal(P.repoLabel('/var/lib/dpkg/status'), 'local');
});

test('apt: groups via glob patterns, first match wins', () => {
  const groups = [{ group: 'php8.3', patterns: ['php8.3', 'php8.3-*'] }, { group: 'nginx', patterns: ['nginx', 'nginx-*'] }];
  assert.equal(P.groupFor('php8.3-fpm', groups).group, 'php8.3');
  assert.equal(P.groupFor('php8.4-fpm', groups), null);
  assert.equal(P.groupFor('nginx', groups).group, 'nginx');
  assert.equal(P.groupFor('libnginx-mod-x', groups), null);
});

test('apt: release-date sources', () => {
  const n = P.nginxChanges(fx('nginx-changes.txt'));
  assert.equal(n.get('1.31.8').date, '2026-10-21');
  const node = P.nodeIndex(fxj('node-index.json'));
  assert.ok(node.get('22.23.4').date);
  assert.ok(node.get('22.23.4').lts, 'node 22 is an LTS line');
  assert.equal(node.get('26.12.1').lts, false);
  assert.equal(P.phpReleases(fxj('php-releases.json')).get('8.3.36').date, '2026-10-21');
  assert.equal(P.mariadbReleases(fxj('mariadb-releases.json')).get('11.4.13').date, '2026-08-22');
  assert.equal(P.phpReleases({ version: '8.3.36', date: '21 Oct 2026' }).get('8.3.36').date, '2026-10-21');
  assert.equal(P.mariadbNotesPage('<td>11.4.13</td><td>2026-08-22</td>').get('11.4.13').date, '2026-08-22');
  assert.equal(isoDate('3 Jan 2026'), '2026-01-03');
});

const group = { group: 'x', dates: 'nginx' };
const lookupDate = async (src, v) => ({ date: src === 'nginx' ? ({ '1.31.8': '2026-10-21' }[v] || null) : null });

test('apt: nginx 1.31.3 -> 1.31.8 candidate from nginx.org mainline, rollback available', async () => {
  const pol = P.policy(fx('apt-policy.txt')).get('nginx');
  const mad = P.madison(fx('apt-madison.txt')).get('nginx');
  const item = await apt.buildGroupItem({ name: 'nginx', group, installedDeb: '1.31.3-1~jammy', policy: pol, madison: mad, lookupDate, semver }).promise;
  assert.equal(item.installed, '1.31.3');
  assert.equal(item.candidates[0].version, '1.31.8');
  assert.equal(item.candidates[0].releaseDate, '2026-10-21');
  assert.equal(item.candidates[0].source, 'apt:nginx.org/packages/mainline');
  assert.equal(item.candidates[0].debVersion, '1.31.8-1~jammy');
  assert.equal(item.rollbackAvailableInRepo, true);
  assert.equal(item.candidates.every((c) => semver.gt(c.version, '1.31.3')), true);
});

test('apt: php8.3-fpm at 8.3.36 has no candidate; PPA => rollbackAvailableInRepo=false', async () => {
  const pol = P.policy(fx('apt-policy.txt')).get('php8.3-fpm');
  const mad = P.madison(fx('apt-madison.txt')).get('php8.3-fpm');
  const item = await apt.buildGroupItem({ name: 'php8.3-fpm', group: { group: 'php8.3' }, installedDeb: pol.installed, policy: pol, madison: mad, lookupDate, semver }).promise;
  assert.equal(item.installed, '8.3.36');
  assert.deepEqual(item.candidates, []);
  assert.equal(item.rollbackAvailableInRepo, false);
  assert.equal(item.meta.rollbackReason, 'ppa-keeps-only-newest-build');
});

test('apt: date lookup failure becomes a warning, not a crash', async () => {
  const pol = P.policy(fx('apt-policy.txt')).get('nginx');
  const mad = P.madison(fx('apt-madison.txt')).get('nginx');
  const item = await apt.buildGroupItem({
    name: 'nginx', group, installedDeb: '1.31.3-1~jammy', policy: pol, madison: mad, semver,
    lookupDate: async () => { throw new Error('timeout'); },
  }).promise;
  assert.ok(item.candidates.length > 0);
  assert.equal(item.candidates[0].releaseDate, null);
  assert.match(item.warnings[0], /timeout/);
});

test('apt: nodejs candidate carries nodesource pin 600', async () => {
  const pol = P.policy(fx('apt-policy.txt')).get('nodejs');
  const mad = [{ version: '22.23.4-1nodesource1', url: 'https://deb.nodesource.com/node_22.x', suite: 'nodistro' }, { version: '22.23.2-1nodesource1', url: 'https://deb.nodesource.com/node_22.x', suite: 'nodistro' }];
  const item = await apt.buildGroupItem({ name: 'nodejs', group: { group: 'nodejs', dates: 'nodejs' }, installedDeb: pol.installed, policy: pol, madison: mad, semver,
    lookupDate: async (s, v) => P.nodeIndex(fxj('node-index.json')).get(v) || null }).promise;
  assert.equal(item.candidates[0].version, '22.23.4');
  assert.equal(item.candidates[0].pin, 600);
  assert.ok(item.candidates[0].lts);
  assert.equal(item.rollbackAvailableInRepo, true);
});

test('docker: image refs, compose images, docker ps', () => {
  assert.deepEqual(docker.parse.parseImageRef('grafana/loki:3.5.1'), { registry: null, repository: 'grafana/loki', tag: '3.5.1', digest: null });
  assert.equal(docker.parse.parseImageRef('ghcr.io/a/b:1.2.3').registry, 'ghcr.io');
  assert.equal(docker.parse.parseImageRef('nginx').tag, null);
  const imgs = docker.parse.parseComposeImages(fx('compose.yml'));
  assert.deepEqual(imgs.map((i) => [i.service, i.repository, i.tag]), [['prometheus', 'prom/prometheus', 'v3.4.1'], ['alertmanager', 'prom/alertmanager', 'v0.28.1']]);
  const ps = docker.parse.parseDockerPs(fx('docker-ps.txt'));
  assert.equal(ps.find((p) => p.name === 'mon-loki').tag, '3.5.1');
});

test('docker: only release tags, never latest, same v-prefix style, newer than installed', () => {
  const tags = docker.parse.parseHubTags(fxj('hub-tags.json'));
  assert.ok(tags.length > 0);
  assert.ok(tags.every((t) => docker.parse.RELEASE_TAG_RE.test(t.tag)));
  assert.ok(!tags.some((t) => /latest|main/.test(t.tag)));
  const c = docker.parse.pickCandidates('3.5.1', [...tags, { tag: 'v9.9.9', date: null }, { tag: '3.5.0', date: null }], semver);
  assert.ok(c.every((t) => semver.gt(t.tag, '3.5.1') && !t.tag.startsWith('v')));
  assert.deepEqual(docker.parse.pickCandidates('latest', tags, semver), []);
});

test('advisories: endoflife lifecycle + os-release + USN matching', () => {
  const os = adv.parse.parseOsRelease(fx('os-release.txt'));
  assert.deepEqual(os, { id: 'ubuntu', versionId: '22.04', codename: 'jammy' });
  const lc = adv.parse.lifecycleFor(fxj('eol-ubuntu.json'), '22.04', 'minor');
  assert.equal(lc.eol, '2027-06-01');
  assert.equal(lc.supportEnd, '2024-09-30');
  assert.equal(adv.parse.lifecycleFor([{ cycle: '29', eol: false, support: false }], '29.9.0', 'major').eol, null);
  assert.equal(adv.parse.lifecycleFor([], '1.0', 'minor'), null);

  const usn = fxj('usn.json');
  const first = usn.notices[0].release_packages.jammy.find((p) => !p.is_source);
  const hits = adv.parse.matchUsn(usn, 'jammy', new Map([[first.name, '0.0.1-1'], ['unrelated', '1.0']]));
  assert.equal(hits.length >= 1, true);
  assert.equal(hits[0].name, first.name);
  assert.equal(hits[0].fixedDeb, first.version);
  assert.deepEqual(adv.parse.matchUsn(usn, 'jammy', new Map([[first.name, first.version]])).filter((h) => h.name === first.name), []);
});
