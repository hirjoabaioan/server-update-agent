'use strict';
// Collector: vendored front-end libraries (assets/vendor manifest vs jsDelivr) + remaining CDN refs.
// Read-only. Manifest is optional (produced by a later phase): when absent an item with a
// warning is returned. CDN refs are counted with a server-local grep over the site tree.
const fs = require('fs');
const path = require('path');
const U = require('./_appUtil');
const { isExcluded } = require('../core/excluded');

const JSDELIVR_API = 'https://data.jsdelivr.com/v1/packages/npm/';
const CDN_RE = '(cdn.jsdelivr.net|cdnjs.cloudflare.com|unpkg.com)/[^"\'\' )]+';
const ALIASES = { 'twitter-bootstrap': 'bootstrap', chartjs: 'chart.js', 'chart.js': 'chart.js', 'font-awesome': 'fontawesome', 'intl-tel-input': 'intl-tel-input' };

function webRootsOf(ctx, env) {
  return ((ctx.profile && ctx.profile.webRoots) || []).filter((r) => (!env || r.env === env) && !isExcluded(ctx.profile, r));
}

function manifestPath(ctx) {
  const cfg = (ctx.profile && ctx.profile.frontend) || {};
  if (cfg.manifest) return ctx.repoPath ? ctx.repoPath(cfg.manifest) : cfg.manifest;
  const root = webRootsOf(ctx, 'test')[0];
  if (!root) return null;
  return path.join(ctx.repoPath ? ctx.repoPath(root.repoPath) : root.repoPath, 'public_html', 'assets', 'vendor', 'manifest.json');
}

// Accepts: [{name, version, ...}] | {libraries|packages|libs: <either form>} | {name: "1.2.3"|{version}}
function parseManifest(data) {
  let node = data;
  if (node && !Array.isArray(node) && typeof node === 'object') {
    for (const k of ['libraries', 'packages', 'libs', 'vendors']) {
      if (node[k] && typeof node[k] === 'object') { node = node[k]; break; }
    }
  }
  const out = [];
  if (Array.isArray(node)) {
    for (const e of node) {
      const name = e && (e.npm || e.package || e.name);
      if (name && e.version) out.push({ name: String(name), version: String(e.version), meta: e });
    }
  } else if (node && typeof node === 'object') {
    for (const [name, e] of Object.entries(node)) {
      // schema 1 manifest (assets/vendor/manifest.json): { active: '<ver>', versions: {...} }
      const version = typeof e === 'string' ? e : e && (e.active || e.version);
      if (version) out.push({ name: (e && (e.npm || e.package)) || name, version: String(version), meta: typeof e === 'object' ? e : {} });
    }
  }
  return out;
}

function jsdelivrVersions(data) {
  const list = (data && data.versions) || [];
  return list.map((v) => (typeof v === 'string' ? v : v && v.version)).filter(Boolean);
}

function allowedPre(policy, name) {
  const pins = (policy && policy.pins && policy.pins[name]) || null;
  return pins && Array.isArray(pins.allow) ? pins.allow : [];
}

function libraryOf(url) {
  let m = url.match(/^cdn\.jsdelivr\.net\/npm\/((?:@[^/@]+\/)?[^/@]+)/);
  if (!m) m = url.match(/^unpkg\.com\/((?:@[^/@]+\/)?[^/@]+)/);
  if (!m) m = url.match(/^cdnjs\.cloudflare\.com\/ajax\/libs\/([^/]+)/);
  if (!m) m = url.match(/^cdn\.jsdelivr\.net\/gh\/[^/]+\/([^/@]+)/);
  if (!m) return null;
  let lib = m[1].toLowerCase();
  if (lib !== 'chart.js') lib = lib.replace(/\.js$/, '');
  lib = ALIASES[lib] || lib;
  return lib;
}

function countCdnRefs(grepOutput) {
  const perLibrary = {};
  const hosts = {};
  let total = 0;
  const unpinned = [];
  for (const line of String(grepOutput || '').split('\n')) {
    const url = line.trim();
    if (!url) continue;
    // pinned = the URL carries an explicit version (pkg@1.2.3 or /libs/pkg/1.2.3/)
    if (!/@v?\d|\/v?\d+\.\d+/.test(url)) unpinned.push(url);
    const lib = libraryOf(url);
    const host = url.split('/')[0];
    hosts[host] = (hosts[host] || 0) + 1;
    total += 1;
    const key = lib || '(other)';
    perLibrary[key] = (perLibrary[key] || 0) + 1;
  }
  return { total, unpinned: unpinned.length, unpinnedSamples: [...new Set(unpinned)].slice(0, 10), perLibrary: Object.fromEntries(Object.entries(perLibrary).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))), hosts };
}

async function scanCdn(ctx, exec, log) {
  const cfg = (ctx.profile && ctx.profile.frontend) || {};
  const roots = Array.isArray(cfg.scanRoots) && cfg.scanRoots.length
    ? cfg.scanRoots.map((p) => (ctx.repoPath ? ctx.repoPath(p) : p))
    : webRootsOf(ctx, 'test').slice(0, 1).map((r) => path.join(r.path, 'public_html'));
  const existing = roots.filter((r) => { try { return fs.statSync(r).isDirectory(); } catch { return false; } });
  if (!existing.length && !ctx.exec) {
    log.warn('frontend: no scannable public_html tree for CDN refs', { roots });
    return null;
  }
  const targets = existing.length ? existing : roots;
  const r = await exec('grep', ['-rhoE', '--include=*.php', '--include=*.js', '--exclude-dir=vendor', '--exclude-dir=node_modules', '--exclude-dir=.git', CDN_RE, ...targets], { timeout: 120000 });
  // grep exit 1 = no matches, which is a valid (good) result
  if (r.timedOut || (r.code > 1 && !r.stdout)) {
    log.warn('frontend: CDN grep failed', { code: r.code, timedOut: r.timedOut, stderr: r.stderr.slice(0, 200) });
    return null;
  }
  return { roots: targets, ...countCdnRefs(r.stdout) };
}

module.exports = {
  name: 'frontend',
  async collect(ctx) {
    const log = U.logger(ctx);
    const exec = U.getExec(ctx);
    const fetchJson = U.getFetch(ctx);
    const semver = ctx.semver;
    const policy = ctx.policy || {};
    const preRe = policy.forbidPrerelease ? new RegExp(policy.forbidPrerelease, 'i') : undefined;
    const items = [];
    const dateCache = new Map();

    const mf = manifestPath(ctx);
    const manifest = mf ? U.readJson(mf) : null;
    if (!manifest) {
      log.warn('frontend: manifest not yet created', { manifest: mf });
      items.push({
        ecosystem: 'vendor-js', name: '(manifest)', scope: null, installed: 'missing', candidates: [],
        source: mf || 'assets/vendor/manifest.json', envs: ['test', 'prod'],
        meta: { kind: 'manifest-missing', warning: 'manifest not yet created', manifest: mf },
      });
    } else {
      for (const lib of parseManifest(manifest)) {
        const allow = allowedPre(policy, lib.name);
        let versions = [];
        let warning = null;
        try {
          versions = jsdelivrVersions(await fetchJson(JSDELIVR_API + lib.name.replace('/', '%2f'), { timeout: 15000 }));
        } catch (e) {
          warning = `jsdelivr lookup failed: ${String(e.message || e)}`;
          log.warn(`frontend: ${lib.name}: ${warning}`);
        }
        versions = versions.filter((v) => allow.includes(v) || !semver.isPrerelease(v, preRe));
        const npmName = lib.meta.npm || lib.meta.package || lib.name;
        const picked = U.pickCandidates(semver, lib.version, versions);
        const dates = await Promise.all(picked.map((c) => U.npmReleaseDate(ctx, dateCache, npmName, c.version, log)));
        const candidates = picked.map((c, i) => ({
          version: c.version, type: c.type, releaseDate: dates[i], source: 'jsdelivr:npm', security: false, cvss: null, advisories: [],
        }));
        items.push({
          ecosystem: 'vendor-js', name: lib.name, scope: 'assets/vendor', installed: lib.version, candidates,
          source: 'assets/vendor/manifest.json', envs: ['test', 'prod'],
          meta: Object.assign({ prereleaseAllowlist: allow, manifestEntry: lib.meta }, warning ? { warning } : {}),
        });
      }
    }

    let cdn = null;
    try {
      cdn = await scanCdn(ctx, exec, log);
    } catch (e) {
      log.warn(`frontend: CDN scan failed: ${String(e.message || e)}`);
    }
    items.push({
      ecosystem: 'frontend', name: 'cdnRefs', scope: null,
      installed: cdn ? String(cdn.total) : 'unknown',
      candidates: [],
      source: 'grep cdn.jsdelivr.net|cdnjs.cloudflare.com|unpkg.com over *.php,*.js (excl. vendor/)',
      envs: ['test'],
      meta: cdn ? { kind: 'cdn-refs', total: cdn.total, unpinned: cdn.unpinned, unpinnedSamples: cdn.unpinnedSamples, perLibrary: cdn.perLibrary, hosts: cdn.hosts, roots: cdn.roots } : { kind: 'cdn-refs', warning: 'scan unavailable' },
    });
    return items;
  },
  _internals: { webRootsOf, parseManifest, countCdnRefs, libraryOf, jsdelivrVersions },
};
