'use strict';
// Policy engine: inventory + policy -> candidates (pure: no shell, no network, no clock except opts.now).
//   compute(inventory, policy, { now, profile, activePhp }) -> { candidates[], summary, ... }
//   evaluate(items, ctx)  -> decision[]  (plugin contract, see lib/INTERFACES.md)
// One "base" entry per inventory item (tier A patch decision, or an informational/null entry),
// plus extra entries for the same key: line 'bump' (tier B), 'os' (tier C), 'switch' (nginx: tier-B
// channel-switch when policy.nginx.channel=stable and a mainline build is installed; without a
// channel key the legacy mainline->stable question).
const semver = require('../core/semver');
const { productOf, filterPool, pinAllows } = require('./rules/filters');
const compat = require('./rules/compat');

const DAY = 86400000;
const keyOf = (it) => `${it.ecosystem}:${it.scope || ''}:${it.name}`;
const ageDays = (date, now) => {
  if (!date) return null;
  const t = Date.parse(date);
  return Number.isNaN(t) ? null : Math.floor((now.getTime() - t) / DAY);
};
const addDays = (date, n) => (date ? new Date(Date.parse(date) + n * DAY).toISOString().slice(0, 10) : null);
const vOf = (c) => String(c.version);

// ------------------------------------------------------------------ helpers
function regressionHit(policy, it, version) {
  const kr = policy.knownRegressions || {};
  const names = [it.name, it.meta && it.meta.product, `${it.ecosystem}:${it.name}`].filter(Boolean);
  const plain = String(version).replace(/^v/, '');
  for (const n of names) {
    for (const v of [version, plain, `v${plain}`]) {
      if (kr[`${n}@${v}`]) return kr[`${n}@${v}`];
      if (kr[n] && typeof kr[n] === 'object' && kr[n][v]) return kr[n][v];
    }
  }
  return null;
}

function secSkip(policy, c) {
  const cfg = policy.securitySkipSoak || {};
  if (cfg.enabled === false) return false;
  const min = policy.securitySkipSoakCvss ?? cfg.minCvss ?? 7;
  if (c.cvss !== null && c.cvss !== undefined && Number(c.cvss) >= min) return true;
  if (c.security) return c.cvss === null || c.cvss === undefined || Number(c.cvss) >= min;
  return false;
}

function minPatchFor(policy, it) {
  const f = policy.requiresFollowUpPatch || {};
  if (f.enabled === false) return 0;
  const comp = f.components || {};
  const p = productOf(it);
  const own = comp[it.name] || (p && comp[p]);
  return own && own.minPatch !== undefined ? own.minPatch : (f.defaultMinPatch ?? 1);
}

const APT_OF = (it) => {
  if (it.ecosystem === 'eol' && it.name === 'nginx') return 'nginx';
  if (it.ecosystem === 'eol' && it.name === 'docker-engine') return 'docker-ce';
  if (it.ecosystem === 'mariadb') return 'mariadb-server';
  if (it.ecosystem === 'node-runtime') return 'nodejs';
  if (it.ecosystem === 'php-runtime') return `php${it.scope}-cli`;
  return null;
};

function buildPool(it, ctx) {
  const pool = [];
  const add = (c) => { if (c && c.version) pool.push({ ...c, version: vOf(c) }); };
  (it.candidates || []).forEach(add);
  const life = it.meta && it.meta.kind === 'lifecycle';
  if (life) {
    const aptName = APT_OF(it);
    const apt = aptName && ctx.inventory.find((x) => x.ecosystem === 'apt' && x.name === aptName);
    if (apt) (apt.candidates || []).forEach(add);
    if (it.meta.latest) {
      add({ version: it.meta.latest, releaseDate: it.meta.latestReleaseDate || null, lts: it.meta.lts === undefined ? null : it.meta.lts, security: false, source: 'endoflife.date', synthetic: true });
    }
  }
  if (it.ecosystem === 'node-runtime') {
    const idx = (it.meta && it.meta.nodeIndex) || ctx.inventory.nodeIndex || [];
    idx.forEach((e) => add({ version: String(e.version).replace(/^v/, ''), releaseDate: e.date || e.releaseDate || null, lts: e.lts || false, eol: e.eol || null, security: !!e.security, source: 'nodejs-index' }));
  }
  if (it.ecosystem === 'php-runtime' && (!ctx.activePhp || it.scope === ctx.activePhp)) {
    for (const [key, cyc] of ctx.phpCycles) {
      if (key === it.scope) continue;
      if (cyc.latest) add({ version: cyc.latest, releaseDate: cyc.latestReleaseDate, security: false, source: 'endoflife.date', synthetic: true });
      if (cyc.cycleReleaseDate) add({ version: `${key}.0`, releaseDate: cyc.cycleReleaseDate, security: false, source: 'endoflife.date', synthetic: true });
    }
  }
  const seen = new Map();
  for (const c of pool) {
    const k = c.version;
    if (!seen.has(k) || (!seen.get(k).releaseDate && c.releaseDate)) seen.set(k, c);
  }
  return [...seen.values()];
}

// ------------------------------------------------------------------ nginx channel (policy.nginx.channel)
// nginx.org numbering: odd minor = mainline, even minor = stable.
const nginxChannel = (policy) => (policy && policy.nginx && policy.nginx.channel) || null;
const isNginxItem = (it) => it.name === 'nginx' && (it.ecosystem === 'apt' || it.ecosystem === 'eol');
const isMainlineVersion = (v) => {
  const p = semver.parse(String(v));
  return !!p && p.minor % 2 === 1;
};

// channel=stable: mainline candidates are never proposed (no tier-A patch, eol bump or "latest").
function applyChannel(it, kept, rejected, ctx) {
  if (nginxChannel(ctx.policy) !== 'stable' || !isNginxItem(it)) return { kept, rejected };
  const out = { kept: [], rejected: rejected.slice() };
  for (const c of kept) {
    if (isMainlineVersion(c.version)) out.rejected.push({ version: c.tag || c.version, why: 'mainline build (policy.nginx.channel=stable)' });
    else out.kept.push(c);
  }
  return out;
}

// Installed mainline build + channel=stable => tier-B channel-switch to the newest soaked stable build.
// Target = the exact .deb version (the adapter installs pkg=<deb>); altTargets lets an approval
// given for an older (still valid) stable build keep matching after a newer stable is released.
function evalChannelSwitch(it, kept, ctx) {
  const { policy, now } = ctx;
  const soak = policy.patchSoakDays ?? 7;
  const e = entry(it, 'switch', { tier: 'B', kind: 'channel-switch', fromChannel: 'mainline', toChannel: 'stable' });
  const stable = kept.filter((c) => c.channel === 'stable' && !isMainlineVersion(c.version))
    .sort((a, b) => semver.compare(b.version, a.version));
  e.reason.push(`channel switch: installed ${it.installed} is a mainline build, policy.nginx.channel=stable`);
  if (!stable.length) {
    e.status = 'blocked';
    e.action = 'hold';
    e.blockers.push('no stable build in the candidate pool (stable repo index not collected)');
    return e;
  }
  const tgt = (c) => c.debVersion || c.tag || c.version;
  e.altTargets = [...new Set(stable.flatMap((c) => [c.version, c.debVersion].filter(Boolean)))];
  const soaked = stable.find((c) => {
    const a = ageDays(c.releaseDate, now);
    return a !== null && a >= soak;
  });
  if (!soaked) {
    const n = stable[0];
    const a = ageDays(n.releaseDate, now);
    e.status = 'soak';
    e.action = 'hold';
    e.target = tgt(n);
    e.targetUpstream = n.version;
    e.pending = { version: n.version, ageDays: a, eligibleOn: addDays(n.releaseDate, soak) };
    e.reason.push(a === null
      ? `soak: release date of stable ${n.version} unknown, cannot satisfy ${soak}-day soak`
      : `soak: stable ${n.version} is ${a}d old < ${soak}d (eligible on ${e.pending.eligibleOn})`);
    return e;
  }
  e.status = 'eligible';
  e.action = 'propose';
  e.target = tgt(soaked);
  e.targetUpstream = soaked.version;
  e.releaseDate = soaked.releaseDate || null;
  e.reason.push(`target: newest soaked stable ${soaked.version} (${e.target}), released ${soaked.releaseDate}, soaked ${ageDays(soaked.releaseDate, now)}d >= ${soak}`);
  e.reason.push('downgrade + apt source change: applied only with an explicit approval naming a profile adapter');
  if (stable[0] !== soaked) e.reason.push(`newer stable ${stable[0].version} still soaking`);
  return e;
}

function entry(it, line, extra) {
  return {
    key: keyOf(it), line, ecosystem: it.ecosystem, scope: it.scope || null, name: it.name, installed: it.installed,
    target: null, tier: null, status: 'info', action: 'skip', reason: [], blockers: [], notes: [], envs: it.envs || null,
    ...extra,
  };
}

// ------------------------------------------------------------------ tier A
function evalPatch(it, kept, rejected, ctx) {
  const { policy, now } = ctx;
  const soak = policy.patchSoakDays ?? 7;
  const e = entry(it, 'patch', {});
  if (rejected.length) e.rejected = rejected;
  const inst = semver.parse(it.installed);
  const pinned = pinAllows(policy, it.name, it.installed);
  if (pinned) { e.pinned = true; e.reason.push(`prerelease ${it.installed} accepted: allowed by policy.pins.${it.name}`); }

  const newer = kept
    .filter((c) => semver.sameMinor(c.version, it.installed) && (semver.gt(c.version, it.installed) || (c.rebuild === true && semver.eq(c.version, it.installed))))
    .sort((a, b) => semver.compare(b.version, a.version));
  if (!newer.length) {
    e.status = 'up-to-date';
    e.reason.push(`no newer patch within ${inst.major}.${inst.minor}`);
    return e;
  }
  const skippedRegr = [];
  const pending = [];
  let chosen = null;
  let skipped = false;
  for (const c of newer) {
    const hit = regressionHit(policy, it, c.version);
    if (hit) { skippedRegr.push({ version: c.version, why: typeof hit === 'string' ? hit : JSON.stringify(hit) }); continue; }
    const age = ageDays(c.releaseDate, now);
    if (secSkip(policy, c)) { chosen = c; skipped = true; break; }
    if (age !== null && age >= soak) { chosen = c; break; }
    pending.push({ version: c.version, ageDays: age, eligibleOn: addDays(c.releaseDate, soak) });
  }
  if (skippedRegr.length) e.regressionSkipped = skippedRegr;
  if (!chosen) {
    if (pending.length) {
      const p = pending[0];
      e.status = 'soak';
      e.pending = p;
      e.reason.push(p.ageDays === null
        ? `soak: release date of ${p.version} unknown, cannot satisfy ${soak}-day soak`
        : `soak: newest patch ${p.version} is ${p.ageDays}d old < ${soak}d (eligible on ${p.eligibleOn})`);
    } else {
      e.status = 'regression-hold';
      e.reason.push(`all newer patches are known regressions: ${skippedRegr.map((r) => r.version).join(', ')}`);
    }
    e.action = 'hold';
    return e;
  }
  e.target = chosen.tag || chosen.version;
  e.tier = 'A';
  e.status = 'ready';
  e.action = 'auto';
  e.reason.push(`patch within ${inst.major}.${inst.minor}`);
  if (skipped) {
    e.soakSkipped = true;
    e.soakSkipReason = 'security';
    e.reason.push(`security: soak skipped${chosen.cvss ? ` (CVSS ${chosen.cvss})` : ''}${(chosen.advisories || []).length ? ` [${chosen.advisories.join(', ')}]` : ''}`);
  } else {
    e.reason.push(`soaked ${ageDays(chosen.releaseDate, now)} days >= ${soak}`);
  }
  if (skippedRegr.length) {
    e.regressionFallback = { skipped: skippedRegr.map((r) => r.version), chosen: chosen.version };
    e.reason.push(`newest patch ${skippedRegr[0].version} is a known regression (${skippedRegr[0].why}); using previous good ${chosen.version}`);
  }
  if (pending.length && semver.gt(pending[0].version, chosen.version)) {
    e.pending = pending[0];
    e.reason.push(`newer ${pending[0].version} still soaking (eligible ${pending[0].eligibleOn || 'unknown'})`);
  }
  return e;
}

// ------------------------------------------------------------------ tier B
function evalBump(it, kept, ctx) {
  const { policy, now } = ctx;
  const mode = it.ecosystem === 'node-runtime' ? 'major' : 'minor';
  const inst = semver.parse(it.installed);
  const lk = (p) => (mode === 'major' ? `${p.major}` : `${p.major}.${p.minor}`);
  const minAge = policy.minorMajorMinAgeDays ?? 30;
  const minPatch = minPatchFor(policy, it);
  const groups = new Map();
  for (const c of kept) {
    const p = semver.parse(c.version);
    if (!semver.gt(c.version, it.installed) || lk(p) === lk(inst)) continue;
    if (!groups.has(lk(p))) groups.set(lk(p), []);
    groups.get(lk(p)).push({ c, p });
  }
  if (!groups.size) return null;
  const lines = [];
  for (const [key, list] of groups) {
    const newest = list.reduce((b, x) => (semver.gt(x.c.version, b.c.version) ? x : b));
    const dates = list.map((x) => x.c.releaseDate).filter(Boolean).sort();
    const age = dates.length ? ageDays(dates[0], now) : null;
    const hasFollow = minPatch === 0 || list.some((x) => x.p.patch >= minPatch || (mode === 'major' && x.p.minor >= 1));
    const missing = [];
    if (age === null) missing.push('release date unknown');
    else if (age < minAge) missing.push(`age ${age}d < ${minAge}d`);
    if (!hasFollow) missing.push(mode === 'major' ? 'no follow-up release yet' : `no follow-up patch (${key}.${minPatch}+ not released)`);
    const blockers = compat.check(it, { key, major: newest.p.major, minor: newest.p.minor, version: newest.c.version, candidate: newest.c }, ctx);
    lines.push({
      key, target: newest.c.tag || newest.c.version, ageDays: age, missing, blockers,
      status: blockers.length ? 'blocked' : missing.length ? 'not-yet-eligible' : 'eligible',
    });
  }
  const runtime = ['node-runtime', 'php-runtime', 'mariadb', 'os'].includes(it.ecosystem) || it.ecosystem === 'eol';
  lines.sort((a, b) => (runtime ? semver.compare(a.key, b.key) : semver.compare(b.key, a.key)));
  // runtimes: always report the nearest line; libraries: highest eligible line, else the highest line
  const pick = runtime ? lines[0] : (lines.find((l) => l.status === 'eligible') || lines[0]);
  const e = entry(it, 'bump', { tier: 'B', target: pick.target, status: pick.status, blockers: pick.blockers, lineKey: pick.key });
  if (pick.status === 'eligible') {
    e.action = 'propose';
    e.reason.push(`newer ${mode} line ${pick.key} available`, `age ${pick.ageDays}d >= ${minAge}d`, minPatch ? `follow-up patch ${pick.key}.${minPatch}+ exists` : 'no follow-up patch required');
  } else {
    e.action = 'hold';
    if (pick.missing.length) e.reason.push(`not yet eligible: ${pick.missing.join('; ')}`);
    if (pick.blockers.length) e.reason.push(`blocked: ${pick.blockers.length} compatibility blocker(s)`);
  }
  if (lines.length > 1) e.alternatives = lines.filter((l) => l !== pick).map((l) => ({ line: l.key, target: l.target, status: l.status, missing: l.missing, blockers: l.blockers }));
  if (it.ecosystem === 'php-runtime') {
    const tp = semver.parse(pick.target);
    const imap = ctx.inventory.find((x) => x.ecosystem === 'apt' && x.name === `php${ctx.activePhp || it.scope}-imap`);
    if (imap && tp && (tp.major > 8 || (tp.major === 8 && tp.minor >= 4))) {
      const sibling = ctx.inventory.find((x) => x.ecosystem === 'apt' && x.name === `php${pick.key}-imap`);
      const msg = `ext-imap is no longer bundled with PHP ${pick.key}+ (moved to PECL); php${ctx.activePhp || it.scope}-imap is installed${sibling ? ` and php${pick.key}-imap ${sibling.installed} is available (PECL build)` : ''} - verify the code that uses imap_* before switching`;
      e.notes.push(msg);
      e.reason.push(`note: ${msg}`);
    }
  }
  return e;
}

// ------------------------------------------------------------------ per item
const INFO_KINDS = new Set(['app-summary', 'lockfile-summary', 'manifest-missing', 'usn-error']);

function nextUbuntuLts(v) {
  const m = String(v).match(/^(\d+)\.(\d+)/);
  if (!m) return null;
  let y = Number(m[1]);
  y += y % 2 === 0 ? 2 : 1;
  return `${y}.04`;
}

function evaluateItem(it, ctx) {
  const { policy, now } = ctx;
  const out = [];
  const neverAuto = (policy.componentsNeverAuto || []).some((n) => n === it.name || n === `${it.ecosystem}:${it.name}`);
  const finish = (list) => {
    list.forEach((e) => {
      if (neverAuto) { e.neverAuto = true; if (e.action === 'auto') e.action = 'propose'; e.reason.push('component is in componentsNeverAuto'); }
    });
    return list;
  };
  const meta = it.meta || {};
  if (it.ecosystem === 'os') {
    const e = entry(it, 'os', { tier: 'C', action: 'propose', status: 'report', target: nextUbuntuLts(it.installed) });
    const left = meta.eol ? Math.floor((Date.parse(meta.eol) - now.getTime()) / DAY) : null;
    e.reason.push('operating system release upgrade is report-only (tier C), never applied automatically');
    if (left !== null) e.reason.push(`current release ${it.installed} end-of-life ${meta.eol} (${left} days left)`);
    if (e.target) e.reason.push(`next LTS release: ${e.target}`);
    return finish([e]);
  }
  if (INFO_KINDS.has(meta.kind) || it.ecosystem === 'frontend' || /^\(.*\)$/.test(it.name) || it.installed === 'n/a') {
    const e = entry(it, 'patch', { status: 'info' });
    e.reason.push('informational item, no version to evaluate');
    return [e];
  }
  const sideMinor = (() => {
    const m = it.ecosystem === 'php-runtime' ? [null, it.scope] : String(it.name).match(/^php(\d+\.\d+)-/);
    return m ? m[1] : null;
  })();
  if (sideMinor && ctx.activePhp && sideMinor !== ctx.activePhp) {
    const e = entry(it, 'patch', { status: 'side-by-side' });
    e.notes.push('installed side-by-side, handled by maint/tier-B proposal');
    e.reason.push('installed side-by-side, handled by maint/tier-B proposal');
    const cyc = ctx.phpCycles.get(sideMinor);
    if (cyc && cyc.eol && Date.parse(cyc.eol) < now.getTime()) e.reason.push(`PHP ${sideMinor} reached end-of-life on ${cyc.eol}`);
    return finish([e]);
  }
  if (productOf(it) === 'docker' && !/^v?\d/.test(String(it.installed))) {
    const e = entry(it, 'patch', { status: 'hold', action: 'hold' });
    e.reason.push(`installed tag "${it.installed}" is not a release tag (dockerNeverLatest); pin an explicit version first`);
    return [e];
  }
  const inst = semver.parse(it.installed);
  if (!inst) {
    const e = entry(it, 'patch', { status: 'info' });
    e.reason.push(`installed version "${it.installed}" is not parseable`);
    return [e];
  }
  const filtered = filterPool(it, buildPool(it, ctx), ctx);
  const { kept, rejected } = applyChannel(it, filtered.kept, filtered.rejected, ctx);
  const base = evalPatch(it, kept, rejected, ctx);
  out.push(base);
  if (it.ecosystem !== 'apt' && it.ecosystem !== 'usn') {
    const b = evalBump(it, kept, ctx);
    if (b) out.push(b);
    else if (rejected.length) {
      base.reason.push(`${rejected.length} candidate(s) rejected: ${[...new Set(rejected.map((r) => r.why))].join('; ')}`);
    }
  }
  const channel = nginxChannel(policy);
  if (channel === 'stable' && isNginxItem(it)) {
    // The switch belongs to the apt item (approval id apt::nginx); eol::nginx only without an apt item.
    const owner = it.ecosystem === 'apt' || !ctx.inventory.some((x) => x.ecosystem === 'apt' && x.name === 'nginx');
    if (owner && isMainlineVersion(it.installed)) out.push(evalChannelSwitch(it, kept, ctx));
  } else if (!channel && it.name === 'nginx' && (it.ecosystem === 'eol' || !ctx.inventory.some((x) => x.ecosystem === 'eol' && x.name === 'nginx'))) {
    const q = entry(it, 'switch', {
      tier: 'B', status: 'question', action: 'propose', question: 'mainline->stable',
      reason: ['runtime switch question: mainline -> stable', 'repo is nginx.org mainline; stable requires a source change'],
    });
    out.push(q);
  }
  return finish(out);
}

// ------------------------------------------------------------------ public
function compute(inventory, policy, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now || Date.now());
  const items = Array.isArray(inventory) ? inventory : (inventory && inventory.items) || [];
  const inv = items.slice();
  if (inventory && inventory.nodeIndex) inv.nodeIndex = inventory.nodeIndex;
  const phpCycles = new Map();
  for (const it of items) {
    if (it.ecosystem === 'php-runtime' && it.scope) {
      const m = it.meta || {};
      phpCycles.set(String(it.scope), { eol: it.eol ?? m.eol ?? null, latest: m.latest || null, latestReleaseDate: m.latestReleaseDate || null, cycleReleaseDate: m.cycleReleaseDate || null });
    }
  }
  const svc = opts.profile && opts.profile.phpFpmService;
  const activePhp = opts.activePhp || (svc && (String(svc).match(/php(\d+\.\d+)/) || [])[1]) || null;
  const ctx = { policy, now, inventory: inv, phpCycles, activePhp };
  const candidates = [];
  for (const it of items) candidates.push(...evaluateItem(it, ctx));
  const summary = { items: items.length, entries: candidates.length, byTier: {}, byStatus: {} };
  for (const c of candidates) {
    summary.byTier[c.tier || 'none'] = (summary.byTier[c.tier || 'none'] || 0) + 1;
    summary.byStatus[c.status] = (summary.byStatus[c.status] || 0) + 1;
  }
  return { generatedAt: now.toISOString(), policyVersion: policy.version ?? null, activePhp, summary, candidates };
}

// Plugin contract: one decision per inventory item (A entry wins; otherwise tier B/C entry; otherwise base).
function evaluate(items, ctx) {
  const res = compute({ items }, ctx.policy, { profile: ctx.profile });
  const byKey = new Map();
  for (const c of res.candidates) {
    const cur = byKey.get(c.key);
    const rank = (x) => (x.tier === 'A' || x.status === 'soak' ? 3 : x.tier ? 2 : 1);
    if (!cur || rank(c) > rank(cur) || (rank(c) === rank(cur) && c.line === 'bump' && cur.line !== 'bump' && !cur.tier)) byKey.set(c.key, c);
  }
  return items.map((it) => {
    const c = byKey.get(keyOf(it));
    return {
      ecosystem: it.ecosystem, scope: it.scope, name: it.name, installed: it.installed,
      target: c ? c.target : null, tier: c ? c.tier : null, action: c ? c.action : 'skip',
      reasons: c ? c.reason.concat(c.blockers.map((b) => `blocker: ${b}`)) : [], envs: it.envs,
      ...(c && c.kind ? { kind: c.kind } : {}),
      ...(c && c.altTargets ? { candidates: c.altTargets } : {}),
    };
  });
}

module.exports = { name: 'engine', evaluate, compute, keyOf, isMainlineVersion };
