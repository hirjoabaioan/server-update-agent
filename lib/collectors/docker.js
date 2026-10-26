'use strict';
// docker collector (read-only): pinned image tags from the compose file(s) in the profile
// (profile.dockerCompose [repo-relative] and optional profile.dockerComposeLive [absolute]),
// running tags from `docker ps --format`, release candidates from the Docker Hub tags API.
// Only plain release tags (^v?\d+\.\d+\.\d+$) are ever candidates — never 'latest'.
const fs = require('fs');
const { httpGet, run, isoDate } = require('./_sysUtil');

const RELEASE_TAG_RE = /^v?\d+\.\d+\.\d+$/;
const MAX_PAGES = 3;
const MAX_CANDIDATES = 20;

// "grafana/loki:3.5.1" -> { registry:null, repository:'grafana/loki', tag:'3.5.1' }
function parseImageRef(ref) {
  let s = String(ref).trim().replace(/^['"]|['"]$/g, '');
  const digest = (s.match(/@(sha256:[0-9a-f]+)$/) || [])[1] || null;
  s = s.replace(/@sha256:[0-9a-f]+$/, '');
  let registry = null;
  const first = s.split('/')[0];
  if (s.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    registry = first;
    s = s.slice(first.length + 1);
  }
  const m = s.match(/^(.*?)(?::([^/:]+))?$/);
  return { registry: registry === 'docker.io' || registry === 'registry-1.docker.io' ? null : registry, repository: m[1], tag: m[2] || null, digest };
}

// Minimal compose reader (no YAML dependency): service name at 2-space indent, `image:` at 4.
function parseComposeImages(text) {
  const out = [];
  let inServices = false;
  let service = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    if (/^services:\s*$/.test(line)) { inServices = true; continue; }
    if (/^\S/.test(line) && !/^services:/.test(line)) inServices = false;
    if (!inServices) continue;
    let m = line.match(/^ {2}([A-Za-z0-9_.-]+):\s*$/);
    if (m) { service = m[1]; continue; }
    m = line.match(/^ {4}image:\s*(\S+)\s*$/);
    if (m && service) out.push({ service, ...parseImageRef(m[1]), ref: m[1].replace(/^['"]|['"]$/g, '') });
  }
  return out;
}

// docker ps --format '{{.Image}}|{{.Names}}'
function parseDockerPs(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const [image, name] = line.split('|');
    if (image && image.trim()) out.push({ name: (name || '').trim(), ...parseImageRef(image) });
  }
  return out;
}

// Docker Hub tags response -> [{ tag, date }] for release tags only
function parseHubTags(json) {
  const out = [];
  for (const r of (json && json.results) || []) {
    if (r && RELEASE_TAG_RE.test(r.name)) out.push({ tag: r.name, date: isoDate(r.tag_last_pushed || r.last_updated) });
  }
  return out;
}

async function hubTags(repository) {
  const repo = repository.includes('/') ? repository : `library/${repository}`;
  let url = `https://hub.docker.com/v2/repositories/${repo}/tags?page_size=100`;
  const all = [];
  for (let i = 0; i < MAX_PAGES && url; i++) {
    const j = await httpGet(url, { json: true });
    all.push(...parseHubTags(j));
    url = j.next || null;
  }
  return all;
}

function pickCandidates(installedTag, tags, semver) {
  if (!installedTag || !RELEASE_TAG_RE.test(installedTag)) return [];
  const vPrefix = installedTag.startsWith('v');
  const seen = new Set();
  return tags
    .filter((t) => t.tag.startsWith('v') === vPrefix && semver.gt(t.tag, installedTag) && !seen.has(t.tag) && seen.add(t.tag))
    .sort((a, b) => semver.compare(b.tag, a.tag))
    .slice(0, MAX_CANDIDATES);
}

module.exports = {
  name: 'docker',
  async collect(ctx) {
    const files = [];
    if (ctx.profile.dockerCompose) files.push({ path: ctx.repoPath(ctx.profile.dockerCompose), kind: 'repo' });
    if (ctx.profile.dockerComposeLive) files.push({ path: ctx.profile.dockerComposeLive, kind: 'live' });
    const global = [];
    let pinned = [];
    const live = new Map();
    for (const f of files) {
      try {
        const imgs = parseComposeImages(fs.readFileSync(f.path, 'utf8'));
        if (f.kind === 'repo') pinned = imgs; else for (const i of imgs) live.set(i.service, i);
      } catch (e) {
        global.push(`compose ${f.kind} unreadable: ${e.message}`);
      }
    }
    if (!pinned.length && live.size) pinned = [...live.values()];

    const ps = await run('docker', ['ps', '--format', '{{.Image}}|{{.Names}}']);
    const running = ps.ok ? parseDockerPs(ps.stdout) : [];
    if (!ps.ok) global.push(`docker ps failed: ${(ps.stderr || ps.error || '').trim().split('\n')[0]}`);

    const tagCache = new Map();
    const items = [];
    for (const img of pinned) {
      const warnings = [...global];
      const run1 = running.find((r) => r.repository === img.repository && r.registry === img.registry && r.tag);
      const liveImg = live.get(img.service);
      const installed = (run1 && run1.tag) || (liveImg && liveImg.tag) || img.tag;
      if (!installed) warnings.push('image has no tag (implicit latest); not versionable');
      if (img.tag === 'latest' || installed === 'latest') warnings.push("tag 'latest' is never a candidate");
      let candidates = [];
      if (img.registry) {
        warnings.push(`registry ${img.registry} not supported; no candidates`);
      } else if (installed && RELEASE_TAG_RE.test(installed)) {
        try {
          if (!tagCache.has(img.repository)) tagCache.set(img.repository, hubTags(img.repository));
          const tags = await tagCache.get(img.repository);
          candidates = pickCandidates(installed, tags, ctx.semver).map((t) => ({
            version: t.tag, tag: t.tag, releaseDate: t.date, source: `docker-hub:${img.repository}`, security: false, cvss: null, advisories: [],
          }));
        } catch (e) {
          warnings.push(`Docker Hub tags for ${img.repository}: ${e.message}`);
        }
      }
      const drift = [];
      if (run1 && run1.tag !== img.tag) drift.push(`running ${run1.tag} != compose-pinned ${img.tag}`);
      if (liveImg && liveImg.tag !== img.tag) drift.push(`live compose ${liveImg.tag} != repo compose ${img.tag}`);
      items.push({
        ecosystem: 'docker',
        name: img.repository,
        scope: img.service,
        installed: installed || 'unknown',
        candidates,
        source: run1 ? 'docker ps (running) + compose' : 'compose pinned tag',
        envs: ['prod'],
        warnings,
        meta: { service: img.service, ref: img.ref, pinned: img.tag, running: run1 ? run1.tag : null, container: run1 ? run1.name : null, drift },
      });
    }
    return items;
  },
  parse: { parseImageRef, parseComposeImages, parseDockerPs, parseHubTags, pickCandidates, RELEASE_TAG_RE },
};
