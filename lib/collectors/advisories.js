'use strict';
// advisories collector (read-only):
//  * endoflife.date API -> one lifecycle item per detected product (fields `eol`, `supportEnd`);
//  * Ubuntu USN feed -> one item per (notice, installed package) whose installed version is older
//    than the version fixed by the notice.
// osv.dev is intentionally not used here (unreliable for Ubuntu); it is reserved for the
// Packagist / npm collectors.
const fs = require('fs');
const { httpGet, run, isoDate } = require('./_sysUtil');
const { parse: aptParse } = require('./apt');

// The notices API caps `limit` at 20; page with `offset` to cover ~60 recent notices.
const USN_LIMIT = 20;
const USN_PAGES = 3;

// product -> how to detect it from dpkg and which inventory ecosystem/name it maps to.
// cycle: 'minor' = major.minor, 'major' = major
const PRODUCTS = [
  { product: 'php', ecosystem: 'php-runtime', name: 'php', match: /^php(\d+\.\d+)-cli$/, cycle: 'minor', scopeFromMatch: true },
  { product: 'nginx', ecosystem: 'eol', name: 'nginx', match: /^nginx$/, cycle: 'minor' },
  { product: 'mariadb', ecosystem: 'mariadb', name: 'mariadb-server', match: /^mariadb-server$/, cycle: 'minor' },
  { product: 'nodejs', ecosystem: 'node-runtime', name: 'nodejs', match: /^nodejs$/, cycle: 'major' },
  { product: 'docker-engine', ecosystem: 'eol', name: 'docker-engine', match: /^docker-ce$/, cycle: 'major' },
];

const dateOrNull = (v) => (typeof v === 'string' ? isoDate(v) : null);

// /etc/os-release text -> { id, versionId, codename }
function parseOsRelease(text) {
  const g = (k) => ((text.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1] || '').replace(/^"|"$/g, '');
  return { id: g('ID'), versionId: g('VERSION_ID'), codename: g('VERSION_CODENAME') };
}

// endoflife.date cycles array + installed version -> lifecycle fields
function lifecycleFor(cycles, version, mode) {
  const parts = String(version).split('.');
  const wanted = mode === 'major' ? parts[0] : parts.slice(0, 2).join('.');
  const row = (cycles || []).find((c) => String(c.cycle) === wanted)
    || (mode === 'minor' ? (cycles || []).find((c) => String(c.cycle) === parts[0]) : null);
  if (!row) return null;
  return {
    cycle: String(row.cycle),
    eol: dateOrNull(row.eol),
    supportEnd: dateOrNull(row.support),
    extendedSupportEnd: dateOrNull(row.extendedSupport),
    lts: row.lts === undefined ? null : !!row.lts,
    latest: row.latest || null,
    latestReleaseDate: dateOrNull(row.latestReleaseDate),
    cycleReleaseDate: dateOrNull(row.releaseDate),
    eolRaw: row.eol,
  };
}

// USN notices JSON + installed Map(name -> deb version) -> matches (installed older than fix)
function matchUsn(json, codename, installed) {
  const out = [];
  for (const n of (json && json.notices) || []) {
    const pkgs = (n.release_packages && n.release_packages[codename]) || [];
    const seen = new Set();
    for (const p of pkgs) {
      if (p.is_source || !installed.has(p.name) || seen.has(p.name)) continue;
      seen.add(p.name);
      const inst = installed.get(p.name);
      if (aptParse.debCompare(inst, p.version) >= 0) continue; // already fixed
      const cves = (n.cves || n.cves_ids || []).map((c) => (typeof c === 'string' ? { id: c } : c));
      const scores = cves.map((c) => Number(c.cvss3 ?? c.cvss ?? NaN)).filter((x) => !Number.isNaN(x));
      out.push({
        usn: n.id, title: n.title, published: isoDate(n.published), pocket: p.pocket || null, name: p.name,
        installedDeb: inst, fixedDeb: p.version, cves: cves.map((c) => c.id), cvss: scores.length ? Math.max(...scores) : null,
      });
    }
  }
  return out;
}

module.exports = {
  name: 'advisories',
  async collect(ctx) {
    const items = [];
    let osr = { id: '', versionId: '', codename: '' };
    try { osr = parseOsRelease(fs.readFileSync('/etc/os-release', 'utf8')); } catch { /* handled below */ }

    const dp = await run('dpkg-query', ['-W', '-f=${Package}\t${Version}\t${db:Status-Abbrev}\n']);
    const installed = dp.ok ? aptParse.dpkg(dp.stdout) : new Map();

    // ---- endoflife.date
    const eolCache = new Map();
    const eolFor = (product) => {
      if (!eolCache.has(product)) eolCache.set(product, httpGet(`https://endoflife.date/api/${product}.json`, { json: true }));
      return eolCache.get(product);
    };
    const detected = [];
    if (osr.id === 'ubuntu' && osr.versionId) {
      detected.push({ product: 'ubuntu', ecosystem: 'os', name: 'ubuntu-release', version: osr.versionId, cycleMode: 'minor', source: '/etc/os-release', extra: { codename: osr.codename } });
    }
    for (const p of PRODUCTS) {
      for (const [pkg, deb] of installed) {
        const m = pkg.match(p.match);
        if (!m) continue;
        const up = aptParse.upstreamOf(deb);
        detected.push({
          product: p.product, ecosystem: p.ecosystem, name: p.name, scope: p.scopeFromMatch ? m[1] : undefined,
          version: up, cycleMode: p.cycle, source: `dpkg-query ${pkg}`, extra: {},
        });
      }
    }
    for (const d of detected) {
      const warnings = [];
      let lc = null;
      try {
        lc = lifecycleFor(await eolFor(d.product), d.version, d.cycleMode);
        if (!lc) warnings.push(`endoflife.date has no cycle matching ${d.version} for ${d.product}`);
      } catch (e) {
        warnings.push(`endoflife.date ${d.product}: ${e.message}`);
      }
      items.push({
        ecosystem: d.ecosystem,
        name: d.name,
        ...(d.scope ? { scope: d.scope } : {}),
        installed: d.version,
        candidates: [],
        source: `${d.source}; endoflife.date/${d.product}`,
        envs: ['test', 'prod'],
        product: d.product,
        eol: lc ? lc.eol : null,
        supportEnd: lc ? lc.supportEnd : null,
        warnings,
        meta: { kind: 'lifecycle', product: d.product, ...d.extra, ...(lc || {}) },
      });
    }

    // ---- Ubuntu USN
    if (osr.id === 'ubuntu' && osr.codename && installed.size) {
      try {
        const notices = [];
        for (let page = 0; page < USN_PAGES; page++) {
          const j = await httpGet(`https://ubuntu.com/security/notices.json?release=${encodeURIComponent(osr.codename)}&limit=${USN_LIMIT}&offset=${page * USN_LIMIT}`, { json: true });
          notices.push(...((j && j.notices) || []));
          if (!j || !j.notices || j.notices.length < USN_LIMIT) break;
        }
        const json = { notices };
        for (const u of matchUsn(json, osr.codename, installed)) {
          items.push({
            ecosystem: 'usn',
            name: u.name,
            scope: u.usn,
            installed: aptParse.upstreamOf(u.installedDeb),
            candidates: [{
              version: aptParse.upstreamOf(u.fixedDeb), debVersion: u.fixedDeb, releaseDate: u.published,
              source: `ubuntu-usn:${u.usn}`, security: true, cvss: u.cvss, advisories: [u.usn, ...u.cves],
            }],
            source: 'dpkg-query + ubuntu.com/security/notices',
            envs: ['test', 'prod'],
            warnings: [],
            meta: { kind: 'usn', title: u.title, pocket: u.pocket, installedDeb: u.installedDeb, fixedDeb: u.fixedDeb, cves: u.cves },
          });
        }
      } catch (e) {
        items.push({
          ecosystem: 'usn', name: 'usn-feed', installed: 'n/a', candidates: [], source: 'ubuntu.com/security/notices', envs: ['test', 'prod'],
          warnings: [`USN feed: ${e.message}`], meta: { kind: 'usn-error' },
        });
      }
    }
    if (!dp.ok) items.push({ ecosystem: 'usn', name: 'usn-feed', installed: 'n/a', candidates: [], source: 'dpkg-query', warnings: [`dpkg-query failed: ${dp.error}`], meta: { kind: 'usn-error' } });
    return items;
  },
  parse: { parseOsRelease, lifecycleFor, matchUsn },
};
