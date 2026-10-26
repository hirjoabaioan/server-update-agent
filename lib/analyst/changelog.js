'use strict';
// Release-notes fetcher. For one candidate (installed -> target) returns
//   { source, urls[], text, truncated, error|null, cached }
// Raw text is cached under <run>/changelogs/<key>.txt. Network goes through ctx.analyst.fetchText
// (injectable for tests); default = global fetch with a timeout. GITHUB_TOKEN (optional) is only
// sent to api.github.com and never logged.
//
// Sources by ecosystem:
//   php-runtime      php-src UPGRADING at tag php-<target> (+ php.net ChangeLog-<major>.php section)
//   nginx            https://nginx.org/en/CHANGES
//   mariadb          mariadb.com/kb release-notes pages (one per patch in the range)
//   node-runtime     GitHub releases nodejs/node
//   composer         packagist metadata -> GitHub repo -> releases (fallback CHANGELOG/UPGRADE files)
//   npm / vendor-js  npm registry metadata -> GitHub repo -> releases (fallback CHANGELOG files)
const fs = require('fs');
const path = require('path');

const MAX_TEXT = 300 * 1024;
const UA = 'stack-updater/1 (changelog analyst, read-only)';

async function defaultFetchText(url, opts = {}) {
  const headers = { 'user-agent': UA, accept: opts.accept || '*/*' };
  if (/^https:\/\/api\.github\.com\//.test(url) && process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(opts.timeout || 20000), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
const stripV = (v) => String(v || '').replace(/^v/, '');

function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|pre|section)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => `\n${'#'.repeat(Number(n))} `)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

// nginx CHANGES: blocks start with "Changes with nginx X.Y.Z". Keep versions in (installed, target].
function sliceNginx(text, installed, target, semver) {
  const parts = String(text).split(/^(?=Changes with nginx\s)/m);
  const keep = [];
  for (const p of parts) {
    const m = /^Changes with nginx\s+(\d+\.\d+\.\d+)/.exec(p);
    if (!m) continue;
    if (semver.parse(installed) && semver.gt(m[1], installed) && semver.compare(m[1], target) <= 0) keep.push(p.trim());
  }
  return keep.join('\n\n');
}

// php.net ChangeLog page: sections "Version X.Y.Z". Keep versions (installed, target] of the same minor line.
function slicePhpChangelog(text, installed, target, semver) {
  const parts = String(text).split(/^(?=#{1,6}\s*Version\s+\d+\.\d+\.\d+|Version\s+\d+\.\d+\.\d+\s*$)/m);
  const keep = [];
  for (const p of parts) {
    const m = /^(?:#{1,6}\s*)?Version\s+(\d+\.\d+\.\d+)/.exec(p);
    if (!m) continue;
    if (semver.gt(m[1], installed) && semver.compare(m[1], target) <= 0) keep.push(p.trim());
  }
  return keep.join('\n\n');
}

function patchRange(installed, target, semver, cap = 12) {
  const a = semver.parse(installed);
  const b = semver.parse(target);
  if (!a || !b || a.major !== b.major || a.minor !== b.minor || b.patch <= a.patch) return [stripV(target)];
  const out = [];
  for (let p = a.patch + 1; p <= b.patch; p++) out.push(`${b.major}.${b.minor}.${p}`);
  return out.slice(-cap);
}

function githubRepoFrom(url) {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(String(url || ''));
  return m ? `${m[1]}/${m[2]}` : null;
}

async function githubReleases(repo, installed, target, semver, fetchText) {
  const raw = await fetchText(`https://api.github.com/repos/${repo}/releases?per_page=100`, { accept: 'application/vnd.github+json' });
  const list = JSON.parse(raw);
  const keep = [];
  for (const r of Array.isArray(list) ? list : []) {
    const v = stripV(String(r.tag_name || '').replace(/^[^0-9]*/, ''));
    if (!semver.parse(v) || r.draft) continue;
    if (semver.gt(v, installed) && semver.compare(v, target) <= 0) keep.push(`## ${r.tag_name}\n${r.body || ''}`);
  }
  return keep.join('\n\n');
}

async function repoFromRegistry(item, fetchText) {
  if (item.ecosystem === 'composer') {
    const j = JSON.parse(await fetchText(`https://repo.packagist.org/p2/${item.name}.json`));
    const pk = ((j.packages || {})[item.name] || [])[0] || {};
    return githubRepoFrom((pk.source && pk.source.url) || pk.homepage || (pk.support && pk.support.source));
  }
  const j = JSON.parse(await fetchText(`https://registry.npmjs.org/${item.name.replace('/', '%2F')}`));
  const repo = j.repository && (typeof j.repository === 'string' ? j.repository : j.repository.url);
  return githubRepoFrom(repo || j.homepage);
}

async function repoChangelogFiles(repo, fetchText) {
  for (const f of ['CHANGELOG.md', 'CHANGELOG', 'CHANGES.md', 'UPGRADE.md', 'UPGRADING.md', 'History.md']) {
    for (const branch of ['HEAD']) {
      try { return { file: f, text: await fetchText(`https://raw.githubusercontent.com/${repo}/${branch}/${f}`) }; } catch { /* next */ }
    }
  }
  return null;
}

async function gather(item, ctx, fetchText) {
  const { semver } = ctx;
  const installed = stripV(item.installed);
  const target = stripV(item.target);
  const eco = item.ecosystem;
  const urls = [];
  const chunks = [];
  const get = async (url, opts) => { urls.push(url); return fetchText(url, opts); };
  const tryGet = async (url, opts) => { try { return await get(url, opts); } catch (e) { chunks.push(`(unavailable: ${e.message})`); return null; } };

  if (eco === 'php-runtime') {
    const up = await tryGet(`https://raw.githubusercontent.com/php/php-src/php-${target}/UPGRADING`);
    if (up) chunks.push(`# UPGRADING (php-src @ php-${target})\n${up}`);
    const major = target.split('.')[0];
    const cl = await tryGet(`https://www.php.net/ChangeLog-${major}.php#${target}`);
    if (cl) chunks.push(`# ChangeLog-${major}.php\n${slicePhpChangelog(htmlToText(cl), installed, target, semver) || '(no matching sections)'}`);
    return { source: 'php.net + php-src UPGRADING', urls, chunks };
  }
  if (item.name === 'nginx' && (eco === 'eol' || eco === 'apt')) {
    const t = await tryGet('https://nginx.org/en/CHANGES');
    if (t) chunks.push(sliceNginx(t, installed, target, semver) || '(no matching sections)');
    return { source: 'nginx.org CHANGES', urls, chunks };
  }
  if (eco === 'mariadb') {
    for (const v of patchRange(installed, target, semver)) {
      const t = await tryGet(`https://mariadb.com/kb/en/mariadb-${v.replace(/\./g, '-')}-release-notes/`);
      if (t) chunks.push(`# MariaDB ${v}\n${htmlToText(t)}`);
    }
    return { source: 'mariadb.com release notes', urls, chunks };
  }
  if (eco === 'node-runtime') {
    const t = await tryGet('https://api.github.com/repos/nodejs/node/releases?per_page=100', { accept: 'application/vnd.github+json' });
    if (t) {
      const list = JSON.parse(t);
      for (const r of Array.isArray(list) ? list : []) {
        const v = stripV(r.tag_name);
        if (semver.parse(v) && semver.gt(v, installed) && semver.compare(v, target) <= 0) chunks.push(`## ${r.tag_name}\n${r.body || ''}`);
      }
    }
    return { source: 'github nodejs/node releases', urls, chunks };
  }
  if (['composer', 'npm', 'vendor-js', 'frontend'].includes(eco)) {
    let repo = null;
    try { repo = await repoFromRegistry({ ...item, ecosystem: eco === 'composer' ? 'composer' : 'npm' }, async (u, o) => { urls.push(u); return fetchText(u, o); }); } catch (e) { chunks.push(`(registry lookup failed: ${e.message})`); }
    if (repo) {
      let rel = '';
      try { rel = await githubReleases(repo, installed, target, semver, async (u, o) => { urls.push(u); return fetchText(u, o); }); } catch (e) { chunks.push(`(github releases failed: ${e.message})`); }
      if (rel) chunks.push(rel);
      else {
        const f = await repoChangelogFiles(repo, async (u, o) => { urls.push(u); return fetchText(u, o); });
        if (f) chunks.push(`# ${f.file} (${repo})\n${f.text}`);
      }
    }
    return { source: repo ? `github ${repo}` : 'registry (no repo found)', urls, chunks };
  }
  return { source: null, urls, chunks };
}

async function fetchChangelog(item, ctx) {
  const fetchText = (ctx.analyst && ctx.analyst.fetchText) || defaultFetchText;
  const key = safeName(`${item.ecosystem}__${item.name}__${stripV(item.installed)}__${stripV(item.target)}`);
  const dir = ctx.run && ctx.run.dir ? path.join(ctx.run.dir, 'changelogs') : null;
  const file = dir ? path.join(dir, `${key}.txt`) : null;
  if (file && fs.existsSync(file)) {
    return { source: 'cache', urls: [], text: fs.readFileSync(file, 'utf8'), truncated: false, error: null, cached: true, file };
  }
  try {
    const g = await gather(item, ctx, fetchText);
    let text = g.chunks.join('\n\n').trim();
    const usable = g.chunks.some((c) => !/^\(unavailable|^\(registry lookup|^\(github releases failed/.test(c));
    const truncated = text.length > MAX_TEXT;
    if (truncated) text = text.slice(0, MAX_TEXT);
    const error = g.source === null ? `no changelog source for ecosystem ${item.ecosystem}` : (usable ? null : 'no release notes could be fetched');
    if (file && text && usable) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, text);
    }
    return { source: g.source, urls: g.urls, text, truncated, error, cached: false, file: file && usable ? file : null };
  } catch (e) {
    return { source: null, urls: [], text: '', truncated: false, error: e.message, cached: false, file: null };
  }
}

module.exports = {
  helper: true, fetchChangelog, sliceNginx, slicePhpChangelog, htmlToText, githubRepoFrom, patchRange, defaultFetchText,
};
