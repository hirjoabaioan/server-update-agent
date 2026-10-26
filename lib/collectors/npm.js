'use strict';
// Collector: npm apps (outdated + audit + puppeteer/Chrome/Node + pm2 process).
// Read-only: only `npm outdated`, `npm audit` and `pm2 jlist` are run; never npm install.
const fs = require('fs');
const os = require('os');
const path = require('path');
const U = require('./_appUtil');
const { isExcluded } = require('../core/excluded');

const OUTDATED_TIMEOUT = 60000;
// Envs an app's items belong to: profile.npmApps[].envs, default ['prod'] (one runtime copy shared by both sites).
const appEnvs = (app) => (Array.isArray(app && app.envs) && app.envs.length ? app.envs.slice() : ['prod']);
const AUDIT_TIMEOUT = 60000;
const PM2_TIMEOUT = 15000;
const NPM_ENV = { npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_progress: 'false' };

function currentUser() {
  try { return os.userInfo().username; } catch { return null; }
}

function isAppExcluded(ctx, app) {
  return isExcluded(ctx.profile, { path: ctx.repoPath ? ctx.repoPath(app.path) : app.path }) || (!!app.runtimePath && isExcluded(ctx.profile, { path: app.runtimePath }));
}

function resolveAppDir(ctx, app) {
  const repoDir = ctx.repoPath ? ctx.repoPath(app.path) : app.path;
  const runtime = app.runtimePath && fs.existsSync(path.join(app.runtimePath, 'package.json')) ? app.runtimePath : null;
  return { dir: runtime || repoDir, repoDir, runtimeDir: runtime, usesRuntime: !!runtime };
}

function lockVersions(lock) {
  const map = {};
  const pk = (lock && lock.packages) || {};
  for (const [k, v] of Object.entries(pk)) {
    if (!k.startsWith('node_modules/') || !v || !v.version) continue;
    const name = k.slice(k.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (k === `node_modules/${name}`) map[name] = v.version;
  }
  return map;
}

function depsOf(pkg) {
  return Object.assign({}, pkg && pkg.dependencies, pkg && pkg.devDependencies, pkg && pkg.optionalDependencies);
}

function puppeteerInfo(dir) {
  const ver = (p) => (U.readJson(path.join(dir, 'node_modules', p, 'package.json')) || {}).version || null;
  const puppeteer = ver('puppeteer');
  const core = ver('puppeteer-core');
  if (!puppeteer && !core) return null;
  let chrome = null;
  let source = null;
  for (const rel of ['lib/cjs/puppeteer/revisions.js', 'lib/cjs/puppeteer-core/revisions.js']) {
    for (const pkgName of ['puppeteer-core', 'puppeteer']) {
      try {
        const txt = fs.readFileSync(path.join(dir, 'node_modules', pkgName, rel), 'utf8');
        const m = txt.match(/chrome:\s*['"]([^'"]+)['"]/);
        if (m) { chrome = m[1]; source = `${pkgName}/${rel}`; break; }
      } catch { /* try next */ }
    }
    if (chrome) break;
  }
  return { puppeteer, puppeteerCore: core, bundledChrome: chrome, chromeSource: source };
}

function pm2Cache(exec, log) {
  const cache = new Map();
  return async function pm2For(user) {
    const key = user || '';
    if (cache.has(key)) return cache.get(key);
    const me = currentUser();
    const run = !user || user === me ? ['pm2', ['jlist']] : ['sudo', ['-n', '-u', user, 'pm2', 'jlist']];
    const r = await exec(run[0], run[1], { timeout: PM2_TIMEOUT });
    const data = U.parseJsonLoose(r.stdout);
    let list = [];
    if (Array.isArray(data)) {
      // keep only non-sensitive fields (pm2_env.env holds the process environment)
      list = data.map((p) => ({
        name: p.name,
        pid: p.pid,
        status: p.pm2_env && p.pm2_env.status,
        restarts: p.pm2_env && p.pm2_env.restart_time,
        uptimeSince: p.pm2_env && p.pm2_env.pm_uptime,
        cwd: p.pm2_env && p.pm2_env.pm_cwd,
        nodeVersion: p.pm2_env && p.pm2_env.node_version,
      }));
    } else {
      log.warn(`pm2 jlist failed for user ${user || me}`, { code: r.code, stderr: r.stderr.slice(0, 200) });
      list = null;
    }
    cache.set(key, list);
    return list;
  };
}

function auditIndex(audit) {
  const out = new Map();
  const vulns = (audit && audit.vulnerabilities) || {};
  for (const [name, v] of Object.entries(vulns)) {
    const via = Array.isArray(v.via) ? v.via : [];
    const advisories = via.filter((x) => x && typeof x === 'object').map((x) => ({
      id: (String(x.url || '').match(/GHSA-[\w-]+/) || [x.source ? String(x.source) : null])[0],
      title: x.title || null,
      severity: x.severity || v.severity,
      cvss: x.cvss && typeof x.cvss.score === 'number' ? x.cvss.score : null,
      range: x.range || null,
      url: x.url || null,
    }));
    const viaNames = via.filter((x) => typeof x === 'string');
    out.set(name, {
      severity: v.severity || 'unknown',
      isDirect: !!v.isDirect,
      range: v.range || null,
      fixAvailable: v.fixAvailable === undefined ? null : v.fixAvailable,
      advisories,
      viaPackages: viaNames,
      cvss: advisories.reduce((m, a) => (a.cvss !== null && (m === null || a.cvss > m) ? a.cvss : m), null),
    });
  }
  return out;
}

async function collectApp(ctx, app, h) {
  const { exec, log, pm2For } = h;
  const semver = ctx.semver;
  const loc = resolveAppDir(ctx, app);
  const dir = loc.dir;
  const pkgFile = path.join(dir, 'package.json');
  const pkg = U.readJson(pkgFile);
  if (!pkg) {
    log.warn(`npm: no readable package.json for ${app.path}`, { dir });
    return [];
  }
  const lockFile = path.join(dir, 'package-lock.json');
  const lock = U.readJson(lockFile);
  const locked = lockVersions(lock);
  const scope = app.path;
  const declared = depsOf(pkg);
  const hasNodeModules = fs.existsSync(path.join(dir, 'node_modules'));

  // drift between repo copy and runtime copy
  let drift = null;
  if (loc.usesRuntime && loc.repoDir !== loc.runtimeDir) {
    const repoPkg = U.readJson(path.join(loc.repoDir, 'package.json'));
    if (repoPkg) {
      const a = depsOf(repoPkg), b = depsOf(pkg);
      drift = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();
    }
  }

  const outRes = await exec('npm', ['outdated', '--json', '--prefix', dir], { timeout: OUTDATED_TIMEOUT, env: NPM_ENV });
  const outdatedData = U.parseJsonLoose(outRes.stdout);
  let outdatedOk = true;
  if (outRes.timedOut || outRes.error || (outdatedData === null && outRes.stdout.trim())) {
    outdatedOk = false;
    log.warn(`npm outdated failed for ${app.path}`, { timedOut: outRes.timedOut, error: outRes.error, stderr: outRes.stderr.slice(0, 200) });
  }
  const outdated = outdatedData && typeof outdatedData === 'object' && !Array.isArray(outdatedData) ? outdatedData : {};

  const audRes = await exec('npm', ['audit', '--json', '--prefix', dir], { timeout: AUDIT_TIMEOUT, env: NPM_ENV });
  const auditData = U.parseJsonLoose(audRes.stdout);
  let auditOk = true;
  if (audRes.timedOut || audRes.error || !auditData || auditData.error) {
    auditOk = false;
    log.warn(`npm audit failed for ${app.path}`, { timedOut: audRes.timedOut, error: audRes.error || (auditData && auditData.error && auditData.error.code) || null, stderr: audRes.stderr.slice(0, 200) });
  }
  const audit = auditOk ? auditIndex(auditData) : new Map();

  const pup = puppeteerInfo(dir);
  const pm2List = app.pm2Name ? await pm2For(app.pm2User) : null;
  const proc = pm2List ? pm2List.find((p) => p.name === app.pm2Name) || null : null;

  const names = new Set([...Object.keys(outdated), ...audit.keys()]);
  if (pup) names.add(pup.puppeteer ? 'puppeteer' : 'puppeteer-core');
  const items = [];
  let outdatedCount = 0;
  let vulnerableCount = 0;
  for (const name of [...names].sort()) {
    const o = outdated[name];
    const entry = Array.isArray(o) ? o[o.length - 1] : o;
    const a = audit.get(name);
    const installed = (entry && entry.current) || locked[name] || (declared[name] ? String(declared[name]).replace(/^[\^~>=<\s]+/, '') : null) || 'unknown';
    const versions = entry ? [entry.wanted, entry.latest].filter(Boolean) : [];
    const fix = a && a.fixAvailable && typeof a.fixAvailable === 'object' && a.fixAvailable.name === name ? a.fixAvailable.version : null;
    if (fix) versions.push(fix);
    const picked = U.pickCandidates(semver, installed, versions);
    const dates = await Promise.all(picked.map((c) => U.npmReleaseDate(ctx, h.dateCache || (h.dateCache = new Map()), name, c.version, log)));
    const candidates = picked.map((c, i) => {
      const sec = !!(a && (fix ? !semver.gt(fix, c.version) : false));
      return {
        version: c.version,
        type: c.type,
        releaseDate: dates[i],
        source: 'npm:registry',
        security: sec,
        cvss: sec ? a.cvss : null,
        severity: sec ? a.severity : null,
        advisories: sec ? a.advisories.map((x) => x.id).filter(Boolean) : [],
      };
    });
    if (entry) outdatedCount += 1;
    if (a) vulnerableCount += 1;
    const meta = {
      direct: name in declared,
      wanted: entry ? entry.wanted || null : null,
      latest: entry ? entry.latest || null : null,
      dependent: entry ? entry.dependent || null : null,
      vulnerable: !!a,
      audit: a || null,
    };
    if (pup && (name === 'puppeteer' || name === 'puppeteer-core')) meta.puppeteer = pup;
    items.push({
      ecosystem: 'npm', name, scope, installed, candidates,
      source: `package-lock.json + npm outdated${a ? ' + npm audit' : ''}`,
      envs: appEnvs(app), meta,
    });
  }
  const sevCounts = auditOk && auditData.metadata && auditData.metadata.vulnerabilities ? auditData.metadata.vulnerabilities : null;
  items.push({
    ecosystem: 'npm', name: '(app)', scope, installed: pkg.version || '0.0.0', candidates: [],
    source: 'package.json',
    envs: appEnvs(app),
    meta: {
      kind: 'app-summary',
      appName: pkg.name || null,
      dir,
      repoDir: loc.repoDir,
      runtimeDir: loc.runtimeDir,
      usesRuntime: loc.usesRuntime,
      hasNodeModules,
      lockMtime: U.mtimeIso(lockFile),
      hasLockfile: !!lock,
      engines: pkg.engines || null,
      nodeVersion: process.version,
      puppeteer: pup,
      pm2: app.pm2Name ? { name: app.pm2Name, user: app.pm2User || null, running: proc ? proc.status === 'online' : false, process: proc, queryOk: pm2List !== null } : null,
      counts: { outdated: outdatedCount, vulnerable: vulnerableCount, severities: sevCounts },
      driftRepoVsRuntime: drift,
      outdatedRan: outdatedOk,
      auditRan: auditOk,
    },
  });
  log.info(`npm ${app.path}: ${outdatedCount} outdated, ${vulnerableCount} vulnerable${pup ? `, puppeteer ${pup.puppeteer || pup.puppeteerCore} chrome ${pup.bundledChrome}` : ''}`);
  return items;
}

module.exports = {
  name: 'npm',
  async collect(ctx) {
    const log = U.logger(ctx);
    const exec = U.getExec(ctx);
    const h = { exec, log, pm2For: pm2Cache(exec, log), dateCache: new Map() };
    const items = [];
    for (const app of (ctx.profile && ctx.profile.npmApps) || []) {
      if (isAppExcluded(ctx, app)) { log.info(`npm: ${app.path} skipped (excluded)`); continue; }
      try {
        items.push(...await collectApp(ctx, app, h));
      } catch (e) {
        log.warn(`npm: ${app.path} failed: ${String(e.message || e)}`);
      }
    }
    return items;
  },
  _internals: { lockVersions, auditIndex, puppeteerInfo },
};
