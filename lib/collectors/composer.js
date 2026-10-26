'use strict';
// Collector: composer (direct deps outdated + security audit) for every web root in the profile.
// Read-only: only `composer outdated --locked` and `composer audit` are run, never update/install.
const fs = require('fs');
const path = require('path');
const U = require('./_appUtil');
const { excludedOf, isExcluded } = require('../core/excluded');

const CALL_TIMEOUT = 15000;

function composerEnv() {
  return { COMPOSER_ALLOW_SUPERUSER: '1', COMPOSER_NO_INTERACTION: '1', COMPOSER_DISABLE_XDEBUG_WARN: '1', COMPOSER_NO_AUDIT: '1' };
}

async function composerJson(exec, bin, sub, extra, dir, log, label) {
  const args = [sub, ...extra, '--format=json', '--no-interaction', '--no-plugins', '--no-scripts', `--working-dir=${dir}`];
  const r = await exec(bin, args, { timeout: CALL_TIMEOUT, env: composerEnv() });
  const data = U.parseJsonLoose(r.stdout);
  if (r.timedOut) log.warn(`composer ${sub} timed out after ${CALL_TIMEOUT}ms`, { label });
  else if (r.error) log.warn(`composer ${sub} failed to run: ${r.error}`, { label });
  else if (data === null) log.warn(`composer ${sub} returned no JSON (exit ${r.code})`, { label, stderr: r.stderr.slice(0, 300) });
  return data;
}

// `--locked` reports under "locked", the vendor-based mode under "installed".
const outdatedList = (d) => (d && Array.isArray(d.locked) ? d.locked : d && Array.isArray(d.installed) ? d.installed : []);

function lockVersions(lock) {
  const map = {};
  for (const p of [...(lock && lock.packages || []), ...(lock && lock['packages-dev'] || [])]) map[p.name] = String(p.version || '').replace(/^v/, '');
  return map;
}

async function packagistDate(ctx, cache, name, version, log) {
  const key = `${name}@${version}`;
  if (cache.has(key)) return cache.get(key);
  let date = null;
  try {
    const data = await U.getFetch(ctx)(`https://repo.packagist.org/p2/${name}.json`, { timeout: 10000 });
    const list = (data && data.packages && data.packages[name]) || [];
    const hit = list.find((v) => String(v.version).replace(/^v/, '') === version);
    if (hit && hit.time) date = String(hit.time).slice(0, 10);
  } catch (e) {
    log.debug(`packagist date lookup failed for ${name}`, { error: String(e.message || e) });
  }
  cache.set(key, date);
  return date;
}

function advisoriesFor(audit, name) {
  const raw = audit && audit.advisories ? audit.advisories[name] : null;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
  return list.map((a) => ({
    id: a.advisoryId || a.id || null,
    cve: a.cve || null,
    title: a.title || null,
    severity: (a.severity || 'unknown').toLowerCase(),
    affected: a.affectedVersions || null,
    link: a.link || null,
  }));
}

async function collectRoot(ctx, root, helpers) {
  const { exec, bin, log, dateCache } = helpers;
  const semver = ctx.semver;
  const dir = path.join(root.path, 'public_html');
  const lockFile = path.join(dir, 'composer.lock');
  const jsonFile = path.join(dir, 'composer.json');
  if (!fs.existsSync(jsonFile)) {
    log.warn(`composer.json not found for ${root.domain}`, { dir });
    return [];
  }
  const cj = U.readJson(jsonFile) || {};
  const lock = U.readJson(lockFile);
  const locked = lockVersions(lock);
  const platform = {
    require: (cj.require && cj.require.php) || null,
    configPlatform: (cj.config && cj.config.platform && cj.config.platform.php) || null,
    lockPlatform: (lock && lock.platform && lock.platform.php) || null,
  };
  const lockMtime = U.mtimeIso(lockFile);
  const scope = root.domain;
  const label = root.domain;

  const latest = await composerJson(exec, bin, 'outdated', ['--locked', '--direct'], dir, log, label);
  const patchOnly = await composerJson(exec, bin, 'outdated', ['--locked', '--direct', '--patch-only'], dir, log, label);
  const minorOnly = await composerJson(exec, bin, 'outdated', ['--locked', '--direct', '--minor-only'], dir, log, label);
  const audit = await composerJson(exec, bin, 'audit', ['--locked'], dir, log, label);

  const byName = new Map();
  const knownDates = new Map();
  for (const d of [latest, patchOnly, minorOnly]) {
    for (const p of outdatedList(d)) {
      if (p['latest-release-date']) knownDates.set(`${p.name}@${String(p.latest).replace(/^v/, '')}`, String(p['latest-release-date']).slice(0, 10));
    }
  }
  for (const p of outdatedList(latest)) byName.set(p.name, { pkg: p, versions: new Set([String(p.latest).replace(/^v/, '')]) });
  for (const d of [patchOnly, minorOnly]) {
    for (const p of outdatedList(d)) {
      const e = byName.get(p.name) || { pkg: p, versions: new Set() };
      e.versions.add(String(p.latest).replace(/^v/, ''));
      byName.set(p.name, e);
    }
  }
  const auditPkgs = audit && audit.advisories ? Object.keys(audit.advisories) : [];
  const names = new Set([...byName.keys(), ...auditPkgs]);

  const items = [];
  let outdated = 0;
  let vulnerable = 0;
  for (const name of [...names].sort()) {
    const entry = byName.get(name);
    const installed = entry ? String(entry.pkg.version).replace(/^v/, '') : locked[name] || 'unknown';
    const advisories = advisoriesFor(audit, name);
    const candidates = [];
    if (entry) {
      for (const c of U.pickCandidates(semver, installed, [...entry.versions])) {
        const fixing = advisories.filter((a) => a.affected && !U.inRange(semver, c.version, a.affected));
        const sec = fixing.length > 0;
        candidates.push({
          version: c.version,
          type: c.type,
          releaseDate: knownDates.get(`${name}@${c.version}`) || await packagistDate(ctx, dateCache, name, c.version, log),
          source: 'composer:packagist',
          security: sec,
          cvss: null,
          severity: sec ? U.maxSeverity(fixing.map((a) => a.severity)) : null,
          advisories: fixing.map((a) => a.cve || a.id).filter(Boolean),
        });
      }
      outdated += 1;
    }
    if (advisories.length) vulnerable += 1;
    items.push({
      ecosystem: 'composer',
      name,
      scope,
      installed,
      candidates,
      source: 'composer.lock + composer outdated --locked --direct',
      envs: [root.env],
      meta: {
        direct: !!(cj.require && cj.require[name]) || !!(cj['require-dev'] && cj['require-dev'][name]),
        constraint: (cj.require && cj.require[name]) || (cj['require-dev'] && cj['require-dev'][name]) || null,
        latestStatus: entry ? entry.pkg['latest-status'] || null : null,
        abandoned: entry && entry.pkg.abandoned ? entry.pkg.abandoned : null,
        advisories,
        vulnerable: advisories.length > 0,
      },
    });
  }
  items.push({
    ecosystem: 'composer',
    name: '(lockfile)',
    scope,
    installed: `${Object.keys(locked).length} packages`,
    candidates: [],
    source: 'composer.lock',
    envs: [root.env],
    meta: {
      kind: 'lockfile-summary',
      root: root.path,
      lockMtime,
      platform,
      counts: { outdated, vulnerable, advisories: auditPkgs.reduce((n, p) => n + advisoriesFor(audit, p).length, 0) },
      abandoned: audit && audit.abandoned ? Object.keys(audit.abandoned) : [],
      auditRan: audit !== null,
      outdatedRan: latest !== null,
    },
  });
  log.info(`composer ${root.domain}: ${outdated} outdated, ${vulnerable} vulnerable`);
  return items;
}

module.exports = {
  name: 'composer',
  async collect(ctx) {
    const log = U.logger(ctx);
    const roots = ((ctx.profile && ctx.profile.webRoots) || []).filter((r) => !isExcluded(ctx.profile, r));
    for (const ex of excludedOf(ctx.profile)) {
      log.info(`composer: ${ex.domain || ex.path} skipped (excluded: ${ex.reason || 'no reason given'})`, { excluded: true });
    }
    const helpers = { exec: U.getExec(ctx), bin: (ctx.profile && ctx.profile.composerBin) || 'composer', log, dateCache: new Map() };
    const items = [];
    for (const root of roots) {
      try {
        items.push(...await collectRoot(ctx, root, helpers));
      } catch (e) {
        log.warn(`composer: ${root.domain} failed: ${String(e.message || e)}`);
      }
    }
    return items;
  },
  _internals: { lockVersions, advisoriesFor },
};
