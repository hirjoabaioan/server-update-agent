'use strict';
// apt collector (read-only): apt-get update -q (metadata only), dpkg-query, apt list --upgradable,
// apt-cache policy / madison. Never runs install/upgrade/remove.
// Component groups come from profile.aptComponentGroups:
//   [{ "group": "nginx", "patterns": ["nginx", "nginx-*"], "dates": "nginx" }, ...]
// "dates" selects a release-date source: php | nginx | mariadb | nodejs | (absent = unknown date).
// Installed packages matching no group are summarised as one 'apt-other' item.
const { httpGet, run, isoDate } = require('./_sysUtil');

// ------------------------------------------------------------------ pure parsers
function globToRegex(g) {
  return new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

function groupFor(name, groups) {
  for (const g of groups) {
    if ((g.patterns || []).some((p) => globToRegex(p).test(name))) return g;
  }
  return null;
}

// dpkg-query -W -f='${Package}\t${Version}\t${db:Status-Abbrev}\n'  ->  Map name -> version
function parseDpkgInstalled(text) {
  const out = new Map();
  for (const line of text.split('\n')) {
    const [name, version, status] = line.split('\t');
    if (name && version && /^ii/.test((status || '').trim() ? status : 'ii')) out.set(name.replace(/:.*$/, ''), version);
  }
  return out;
}

// "nginx/stable 1.31.8-1~jammy amd64 [upgradable from: 1.31.3-1~jammy]"
function parseUpgradable(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^(\S+?)\/(\S+)\s+(\S+)\s+(\S+)\s+\[upgradable from:\s*(\S+?)\]/);
    if (m) out.push({ name: m[1], suites: m[2].split(','), candidate: m[3], arch: m[4], installed: m[5] });
  }
  return out;
}

// apt-cache policy <pkgs...>  ->  Map name -> { installed, candidate, versions[] }
function parsePolicy(text) {
  const out = new Map();
  let cur = null;
  let ver = null;
  for (const line of text.split('\n')) {
    let m = line.match(/^(\S+):\s*$/);
    if (m) { cur = { name: m[1], installed: null, candidate: null, versions: [] }; out.set(m[1], cur); ver = null; continue; }
    if (!cur) continue;
    if ((m = line.match(/^\s+Installed:\s*(\S+)/))) { cur.installed = m[1] === '(none)' ? null : m[1]; continue; }
    if ((m = line.match(/^\s+Candidate:\s*(\S+)/))) { cur.candidate = m[1] === '(none)' ? null : m[1]; continue; }
    if ((m = line.match(/^(?: \*\*\* |     )(\S+) (-?\d+)\s*$/))) {
      ver = { version: m[1], pin: Number(m[2]), current: line.startsWith(' ***'), origins: [] };
      cur.versions.push(ver);
      continue;
    }
    if (ver && (m = line.match(/^\s{8}(-?\d+) (\S+)(?: (\S+) (\S+) Packages)?\s*$/))) {
      ver.origins.push({ pin: Number(m[1]), url: m[2], suite: m[3] ? m[3].split('/')[0] : null, component: m[3] ? m[3].split('/')[1] || null : null });
    }
  }
  return out;
}

// apt-cache madison <pkgs...>  ->  Map name -> [{ version, url, suite }] (newest first, as apt prints)
function parseMadison(text) {
  const out = new Map();
  for (const line of text.split('\n')) {
    const p = line.split('|').map((s) => s.trim());
    if (p.length < 3 || !p[0] || !p[1]) continue;
    const [url, suiteComp] = p[2].split(/\s+/);
    if (!out.has(p[0])) out.set(p[0], []);
    out.get(p[0]).push({ version: p[1], url, suite: suiteComp ? suiteComp.split('/')[0] : null });
  }
  return out;
}

// Debian version comparison (epoch:upstream-revision). Returns -1 | 0 | 1.
function debCmpFrag(a, b) {
  const ord = (c) => (c === '~' ? -1 : c === undefined ? 0 : /[A-Za-z]/.test(c) ? c.charCodeAt(0) : c.charCodeAt(0) + 256);
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    while ((i < a.length && !/\d/.test(a[i])) || (j < b.length && !/\d/.test(b[j]))) {
      const x = ord(i < a.length && !/\d/.test(a[i]) ? a[i] : undefined);
      const y = ord(j < b.length && !/\d/.test(b[j]) ? b[j] : undefined);
      if (x !== y) return x < y ? -1 : 1;
      if (i < a.length && !/\d/.test(a[i])) i++;
      if (j < b.length && !/\d/.test(b[j])) j++;
    }
    let x = '', y = '';
    while (i < a.length && /\d/.test(a[i])) x += a[i++];
    while (j < b.length && /\d/.test(b[j])) y += b[j++];
    const nx = Number(x || 0), ny = Number(y || 0);
    if (nx !== ny) return nx < ny ? -1 : 1;
  }
  return 0;
}

function debSplit(v) {
  let epoch = 0, rest = String(v);
  const e = rest.match(/^(\d+):(.*)$/);
  if (e) { epoch = Number(e[1]); rest = e[2]; }
  const idx = rest.lastIndexOf('-');
  return { epoch, upstream: idx >= 0 ? rest.slice(0, idx) : rest, revision: idx >= 0 ? rest.slice(idx + 1) : '' };
}

function debCompare(a, b) {
  const x = debSplit(a), y = debSplit(b);
  if (x.epoch !== y.epoch) return x.epoch < y.epoch ? -1 : 1;
  return debCmpFrag(x.upstream, y.upstream) || debCmpFrag(x.revision, y.revision);
}

// "1:11.4.13+maria~ubu2204" -> "11.4.13" ; "5:29.9.2-1~ubuntu" -> "29.9.2"
function upstreamOf(deb) {
  const m = debSplit(deb).upstream.match(/^(\d+(?:\.\d+)*)/);
  return m ? m[1] : debSplit(deb).upstream;
}

// Repo URL -> readable label. Launchpad PPA -> "ppa:owner/name"; others host+path (without trailing /ubuntu).
function repoLabel(url) {
  if (!url) return 'unknown';
  if (url.startsWith('/')) return 'local';
  let m = url.match(/^https?:\/\/ppa\.launchpad(?:content)?\.net\/([^/]+)\/([^/]+)\//);
  if (m) return `ppa:${m[1]}/${m[2]}`;
  m = url.match(/^https?:\/\/([^/]+)(\/.*)?$/);
  if (!m) return url;
  return `${m[1]}${(m[2] || '').replace(/\/+$/, '').replace(/\/ubuntu$/, '')}`;
}

const isPpa = (url) => /^https?:\/\/ppa\.launchpad(?:content)?\.net\//.test(url || '');
const isSecuritySuite = (s) => /-security$/.test(s || '');

// ---- release-date sources (pure parsers) ----
// nginx CHANGES: "Changes with nginx 1.31.8        21 Oct 2026"
function parseNginxChanges(text) {
  const out = new Map();
  for (const m of text.matchAll(/^Changes with nginx\s+(\S+)\s+(\d{1,2} \w{3} \d{4})\s*$/gm)) out.set(m[1], { date: isoDate(m[2]) });
  return out;
}
// php.net releases JSON (map keyed by version, or a single release object with `version`)
function parsePhpReleases(json) {
  const out = new Map();
  if (json && typeof json.version === 'string') out.set(json.version, { date: isoDate(json.date) });
  else for (const [v, r] of Object.entries(json || {})) if (/^\d+\.\d+\.\d+$/.test(v) && r) out.set(v, { date: isoDate(r.date) });
  return out;
}
// nodejs.org/dist/index.json: [{version:"v22.23.4", date, lts:"Jod"|false}]
function parseNodeIndex(json) {
  const out = new Map();
  for (const r of json || []) if (r && r.version) out.set(String(r.version).replace(/^v/, ''), { date: isoDate(r.date), lts: r.lts || false });
  return out;
}
// downloads.mariadb.org rest-api: { releases: { "11.4.13": { date_of_release } } }
function parseMariadbReleases(json) {
  const out = new Map();
  for (const [v, r] of Object.entries((json && json.releases) || {})) out.set(v, { date: isoDate(r && r.date_of_release) });
  return out;
}
// Fallback: release-notes series page rows ("11.4.13 ... 2026-08-22" / "22 Aug 2026")
function parseMariadbNotesPage(html) {
  const out = new Map();
  for (const m of html.replace(/<[^>]*>/g, ' ').matchAll(/(\d+\.\d+\.\d+)[^\n]{0,120}?(\d{4}-\d{2}-\d{2}|\d{1,2} \w{3} \d{4})/g)) {
    if (!out.has(m[1])) out.set(m[1], { date: isoDate(m[2]) });
  }
  return out;
}

const seriesOf = (v) => v.split('.').slice(0, 2).join('.');
// nginx.org numbering: even minor = stable series (dates in CHANGES-<series>), odd = mainline (CHANGES).
const isNginxStableSeries = (series) => /^\d+\.\d*[02468]$/.test(series);

// apt "Packages" index (Debian control stanzas) -> [{ version }] for one package name.
function parsePackagesIndex(text, pkg) {
  const out = [];
  for (const block of String(text || '').split(/\n\s*\n/)) {
    const name = (block.match(/^Package:\s*(\S+)/m) || [])[1];
    const ver = (block.match(/^Version:\s*(\S+)/m) || [])[1];
    if (name === pkg && ver) out.push({ version: ver });
  }
  return out;
}

// Installed from https://<host>/packages/mainline/<distro>  ->  stable index of the same repo.
// policy.nginx.stableIndexUrl overrides the derived URL.
function nginxStableIndexUrl(originUrl, suite, component, arch, override) {
  if (override) return override;
  const m = String(originUrl || '').match(/^(https?:\/\/[^/]+\/packages)\/mainline\/([^/\s]+)\/?$/);
  if (!m || !suite) return null;
  return `${m[1]}/${m[2]}/dists/${suite}/${component || 'nginx'}/binary-${arch || 'amd64'}/Packages`;
}

async function nginxChangesWithStable(series) {
  const main = parseNginxChanges(await httpGet('https://nginx.org/en/CHANGES'));
  if (!series || !isNginxStableSeries(series)) return main;
  // channel=stable: stable x.EVEN.y releases are only listed in CHANGES-x.EVEN
  const stable = parseNginxChanges(await httpGet(`https://nginx.org/en/CHANGES-${series}`));
  for (const [v, d] of main) if (!stable.has(v)) stable.set(v, d);
  return stable;
}

const DATE_SOURCES = {
  php: async (series) => parsePhpReleases(await httpGet(`https://www.php.net/releases/index.php?json&version=${series}&max=200`, { json: true })),
  nginx: nginxChangesWithStable,
  mariadb: async (series) => {
    try {
      return parseMariadbReleases(await httpGet(`https://downloads.mariadb.org/rest-api/mariadb/${series}/`, { json: true }));
    } catch (e) {
      const page = await httpGet(`https://mariadb.com/kb/en/release-notes-mariadb-${series.replace('.', '-')}-series/`);
      return parseMariadbNotesPage(page);
    }
  },
  nodejs: async () => parseNodeIndex(await httpGet('https://nodejs.org/dist/index.json', { json: true })),
};

// ------------------------------------------------------------------ item builder
// extraCandidates: builds from a repo that is NOT configured in apt (e.g. the nginx stable index
// while the mainline repo is installed) => [{ deb, url, suite, channel }]; listed newest per
// upstream, even when older than installed (channel switch = downgrade).
function buildGroupItem({ name, group, installedDeb, policy, madison, lookupDate, semver, extraCandidates = [] }) {
  const installedUp = upstreamOf(installedDeb);
  const pol = policy || { versions: [] };
  const mad = madison || [];
  const warnings = [];
  const polVer = (deb) => pol.versions.find((v) => v.version === deb);

  // Newer versions: everything madison lists above installed, newest per upstream.
  const newer = mad.filter((r) => debCompare(r.version, installedDeb) > 0)
    .sort((a, b) => debCompare(b.version, a.version));
  const byUp = new Map();
  for (const r of newer) if (!byUp.has(upstreamOf(r.version))) byUp.set(upstreamOf(r.version), r);
  const candidates = [];
  const jobs = [];
  for (const [up, r] of [...byUp.entries()].slice(0, 25)) {
    const pv = polVer(r.version);
    const origin = (pv && pv.origins.find((o) => o.url && !o.url.startsWith('/'))) || { url: r.url, suite: r.suite };
    const rebuild = up === installedUp;
    const cand = {
      version: rebuild ? `${up}-${debSplit(r.version).revision}` : up,
      debVersion: r.version,
      releaseDate: null,
      source: `apt:${repoLabel(origin.url)}`,
      security: isSecuritySuite(origin.suite) || /security\.ubuntu\.com/.test(origin.url || ''),
      cvss: null,
      advisories: [],
      suite: origin.suite || null,
      pin: pv ? pv.pin : null,
      rebuild,
    };
    if (group.dates && !rebuild) jobs.push(lookupDate(group.dates, up).then((d) => { if (d) { cand.releaseDate = d.date; if (d.lts !== undefined) cand.lts = d.lts; } }).catch((e) => warnings.push(`release date (${group.dates} ${up}): ${e.message}`)));
    candidates.push(cand);
  }
  const extraByUp = new Map();
  for (const x of [...extraCandidates].sort((a, b) => debCompare(b.deb, a.deb))) {
    if (x.deb !== installedDeb && !byUp.has(upstreamOf(x.deb)) && !extraByUp.has(upstreamOf(x.deb))) extraByUp.set(upstreamOf(x.deb), x);
  }
  for (const [up, x] of [...extraByUp.entries()].slice(0, 10)) {
    const cand = {
      version: up, debVersion: x.deb, releaseDate: null, source: `apt:${repoLabel(x.url)}`, security: false, cvss: null, advisories: [],
      suite: x.suite || null, pin: null, rebuild: false, channel: x.channel || null, notConfigured: true, downgrade: debCompare(x.deb, installedDeb) < 0,
    };
    if (group.dates) jobs.push(lookupDate(group.dates, up).then((d) => { if (d) cand.releaseDate = d.date; }).catch((e) => warnings.push(`release date (${group.dates} ${up}): ${e.message}`)));
    candidates.push(cand);
  }
  const instPv = polVer(installedDeb);
  const instMad = mad.find((r) => r.version === installedDeb);
  const instOriginUrl = (instPv && instPv.origins.find((o) => o.url && !o.url.startsWith('/')) || {}).url || (instMad && instMad.url) || null;
  const fromPpa = isPpa(instOriginUrl) || (mad.length > 0 && mad.every((r) => isPpa(r.url)));
  const rollbackAvailableInRepo = !!instMad && !fromPpa;
  const candPv = pol.candidate ? polVer(pol.candidate) : null;
  return {
    promise: Promise.all(jobs).then(() => ({
      ecosystem: 'apt',
      name,
      installed: installedUp,
      candidates,
      source: 'dpkg-query + apt-cache policy/madison',
      envs: ['test', 'prod'],
      rollbackAvailableInRepo,
      availableVersions: mad.map((r) => r.version),
      warnings,
      meta: {
        group: group.group,
        installedDeb,
        installedSource: instOriginUrl ? `apt:${repoLabel(instOriginUrl)}` : null,
        aptCandidateDeb: pol.candidate || null,
        candidatePin: candPv ? candPv.pin : null,
        pins: pol.versions.filter((v) => v.pin !== 500 && v.pin !== 100).map((v) => ({ version: v.version, pin: v.pin })),
        rollbackReason: fromPpa ? 'ppa-keeps-only-newest-build' : (instMad ? 'installed version still listed in madison' : 'installed version not listed in any repo'),
      },
    })),
  };
}

function chunk(arr, n) { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; }

// ------------------------------------------------------------------ collector
module.exports = {
  name: 'apt',
  async collect(ctx) {
    const globalWarnings = [];
    const groups = (ctx.profile && ctx.profile.aptComponentGroups) || [];
    if (!groups.length) globalWarnings.push('profile.aptComponentGroups missing: every package is grouped as apt-other');

    if (ctx.dryRun) {
      globalWarnings.push('dry-run: apt-get update skipped (package lists may be stale)');
    } else {
      const up = await run('apt-get', ['update', '-q'], { timeoutMs: 240000 });
      if (!up.ok) globalWarnings.push(`apt-get update failed: ${(up.stderr || up.error || '').trim().split('\n').slice(-3).join(' | ')}`);
      else if (/^(W|E):/m.test(up.stderr)) globalWarnings.push(`apt-get update warnings: ${up.stderr.trim().split('\n').slice(0, 3).join(' | ')}`);
      ctx.log.info(`apt-get update ${up.ok ? 'ok' : 'failed'}`);
    }

    const dp = await run('dpkg-query', ['-W', '-f=${Package}\t${Version}\t${db:Status-Abbrev}\n']);
    if (!dp.ok) throw new Error(`dpkg-query failed: ${dp.error}`);
    const installed = parseDpkgInstalled(dp.stdout);
    const upg = await run('apt', ['list', '--upgradable']);
    const upgradable = parseUpgradable(upg.stdout);
    if (!upg.ok) globalWarnings.push(`apt list --upgradable failed: ${upg.error}`);

    const grouped = new Map(); // name -> group
    const other = [];
    for (const name of [...installed.keys()].sort()) {
      const g = groupFor(name, groups);
      if (g) grouped.set(name, g); else other.push(name);
    }

    const names = [...grouped.keys()];
    const policy = new Map();
    const madison = new Map();
    for (const part of chunk(names, 60)) {
      const [pol, mad] = await Promise.all([run('apt-cache', ['policy', ...part]), run('apt-cache', ['madison', ...part])]);
      if (!pol.ok) globalWarnings.push(`apt-cache policy failed: ${pol.error}`);
      if (!mad.ok) globalWarnings.push(`apt-cache madison failed: ${mad.error}`);
      for (const [k, v] of parsePolicy(pol.stdout)) policy.set(k, v);
      for (const [k, v] of parseMadison(mad.stdout)) madison.set(k, v);
    }

    const dateCache = new Map();
    const lookupDate = async (src, version) => {
      const series = seriesOf(version);
      const key = `${src}:${['php', 'mariadb'].includes(src) || (src === 'nginx' && isNginxStableSeries(series)) ? series : ''}`;
      if (!dateCache.has(key)) dateCache.set(key, DATE_SOURCES[src](series));
      const map = await dateCache.get(key);
      return map.get(version) || null;
    };

    // policy.nginx.channel=stable while a mainline build is installed: the stable repo is not in apt,
    // so read its Packages index over HTTP (read-only) to offer the channel-switch target.
    const extras = new Map();
    const nginxPolicy = (ctx.policy && ctx.policy.nginx) || {};
    if (nginxPolicy.channel === 'stable') {
      const nginxNames = names.filter((n) => grouped.get(n).dates === 'nginx');
      const origin = nginxNames.map((n) => {
        const pv = (policy.get(n) || { versions: [] }).versions.find((v) => v.version === installed.get(n));
        return pv && pv.origins.find((o) => o.url && /\/packages\/mainline\//.test(o.url));
      }).find(Boolean);
      if (origin) {
        const arch = await run('dpkg', ['--print-architecture']);
        const url = nginxStableIndexUrl(origin.url, origin.suite, origin.component, arch.ok ? arch.stdout.trim() : null, nginxPolicy.stableIndexUrl);
        try {
          const text = await httpGet(url);
          const base = url.replace(/\/dists\/.*$/, '');
          for (const n of nginxNames) {
            const list = parsePackagesIndex(text, n).map((x) => ({ deb: x.version, url: base, suite: origin.suite, channel: 'stable' }));
            if (list.length) extras.set(n, list);
          }
          ctx.log.info(`nginx stable index: ${[...extras.values()].reduce((a, l) => a + l.length, 0)} builds (${url})`);
        } catch (e) {
          globalWarnings.push(`nginx stable index ${url}: ${e.message}`);
        }
      }
    }

    const built = [];
    for (const name of names) {
      built.push(buildGroupItem({
        name, group: grouped.get(name), installedDeb: installed.get(name), policy: policy.get(name), madison: madison.get(name),
        lookupDate, semver: ctx.semver, extraCandidates: extras.get(name) || [],
      }).promise);
    }
    const items = await Promise.all(built);

    const otherSet = new Set(other);
    const otherUpg = upgradable.filter((u) => otherSet.has(u.name)).map((u) => ({
      name: u.name, installed: u.installed, candidate: u.candidate, suites: u.suites, security: u.suites.some(isSecuritySuite),
    }));
    items.push({
      ecosystem: 'apt',
      name: 'apt-other',
      installed: String(other.length),
      candidates: [],
      source: 'dpkg-query + apt list --upgradable',
      envs: ['test', 'prod'],
      warnings: globalWarnings,
      meta: {
        group: 'apt-other',
        count: other.length,
        upgradableCount: otherUpg.length,
        securityUpgradableCount: otherUpg.filter((u) => u.security).length,
        names: otherUpg.map((u) => u.name),
        upgradable: otherUpg,
      },
    });
    return items;
  },
  // exported for tests
  parse: {
    dpkg: parseDpkgInstalled, upgradable: parseUpgradable, policy: parsePolicy, madison: parseMadison,
    nginxChanges: parseNginxChanges, phpReleases: parsePhpReleases, nodeIndex: parseNodeIndex,
    packagesIndex: parsePackagesIndex, nginxStableIndexUrl, isNginxStableSeries,
    mariadbReleases: parseMariadbReleases, mariadbNotesPage: parseMariadbNotesPage,
    debCompare, upstreamOf, repoLabel, groupFor, globToRegex,
  },
  buildGroupItem,
  dateSources: DATE_SOURCES,
};
