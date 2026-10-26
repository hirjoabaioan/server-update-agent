'use strict';
// Shared helpers for the reporter (core, server-agnostic). Underscore prefix: not a plugin.
const fs = require('fs');
const path = require('path');

const helper = true;
const EXPLOITED_RE = /actively[\s-]+exploited/i;

function readJson(dir, name, fallback = null) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return fallback; }
}

// Loads every artifact of a run directory. apply/verify exist per env (apply-test.json ...).
function loadRunData(dir) {
  const per = (base) => {
    const out = [];
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
      const m = f.match(new RegExp(`^${base}(?:-([a-z]+))?\\.json$`));
      if (!m || f.startsWith('baseline')) continue;
      const d = readJson(dir, f);
      if (d) out.push({ env: d.env || m[1] || null, ...d });
    }
    return out;
  };
  return {
    runId: path.basename(dir),
    inventory: readJson(dir, 'inventory.json', { items: [] }),
    candidates: readJson(dir, 'candidates.json', { candidates: [] }),
    analysis: readJson(dir, 'analysis.json', { findings: [], proposals: [], candidates: [] }),
    backup: readJson(dir, 'backup.json', { entries: [], errors: [] }),
    apply: per('apply'),
    verify: per('verify'),
    summary: readJson(dir, 'summary.json', null) || readJson(dir, 'manifest.json', {}) || {},
  };
}

function textOf(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  try { return JSON.stringify(x); } catch { return String(x); }
}

function isCritical(adv) {
  const cvss = Number(adv.cvss);
  return (Number.isFinite(cvss) && cvss >= 9) || EXPLOITED_RE.test(adv.text || '');
}

// Flattens security info out of inventory items: candidates flagged security, their advisories,
// and USN notices (ecosystem "usn").
function collectAdvisories(inventory) {
  const items = Array.isArray(inventory) ? inventory : (inventory && inventory.items) || [];
  const out = [];
  const push = (it, a) => {
    const adv = {
      ecosystem: it.ecosystem, scope: it.scope || null, name: it.name, installed: it.installed || null,
      id: a.id || a.advisoryId || a.cve || a.title || null, title: a.title || null,
      cvss: a.cvss == null ? null : Number(a.cvss), fixedIn: a.fixedIn || a.version || null,
      text: a.text || '',
    };
    adv.critical = isCritical(adv);
    out.push(adv);
  };
  for (const it of items) {
    if (it.ecosystem === 'usn') {
      if (it.name === 'usn-feed') continue;
      const m = it.meta || {};
      const cvss = [it.cvss, m.cvss, ...(it.candidates || []).map((c) => c.cvss)].map(Number).filter(Number.isFinite);
      push(it, { id: it.name, title: m.title, cvss: cvss.length ? Math.max(...cvss) : null, text: textOf([m.title, m.cves, m.description, m.summary]) });
      continue;
    }
    for (const c of it.candidates || []) {
      const advs = Array.isArray(c.advisories) ? c.advisories : [];
      if (!c.security && !advs.length) continue;
      if (!advs.length) { push(it, { id: `${it.name}@${c.version}`, cvss: c.cvss, fixedIn: c.version, text: textOf(c.notes) }); continue; }
      for (const a of advs) {
        const o = typeof a === 'string' ? { id: a } : a;
        push(it, { ...o, cvss: o.cvss != null ? o.cvss : c.cvss, fixedIn: c.version, text: textOf(o) });
      }
    }
  }
  return out;
}

// ---- render-time dedup helpers (presentation only; never applied to report.json data) ----
const ALIASES = { 'eol::nginx': 'nginx', 'apt::nginx': 'nginx', 'mariadb::mariadb-server': 'mariadb-server', 'apt::mariadb-server': 'mariadb-server' };
function componentAlias(key) { return Object.prototype.hasOwnProperty.call(ALIASES, key) ? ALIASES[key] : key; }

// strictest first
const STATUS_RANK = ['failed', 'blocked', 'question', 'hold', 'side-by-side', 'report', 'soak', 'ready', 'up-to-date', 'skip'];
const rankOf = (s) => { const i = STATUS_RANK.indexOf(s); return i < 0 ? STATUS_RANK.length : i; };
const union = (...lists) => [...new Set(lists.flatMap((l) => (Array.isArray(l) ? l : [])).map((v) => (typeof v === 'string' ? v : JSON.stringify(v))))];
const rowKey = (x) => x.key || [x.ecosystem, x.scope, x.name].filter(Boolean).join('::');

// Collapses rows whose key maps to the same alias (same env when present). Single rows are returned untouched.
// Merged row: first row's fields, union of reason/blockers/notes, strictest status, keys listed in `_label`.
function mergeByAlias(rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = componentAlias(rowKey(r));
    const gk = k === rowKey(r) ? `\0${groups.size}:${k}` : `${k}\0${r.env || ''}`;
    if (!groups.has(gk)) groups.set(gk, { alias: k, rows: [] });
    groups.get(gk).rows.push(r);
  }
  return [...groups.values()].map(({ alias, rows: g }) => {
    if (g.length === 1) return g[0];
    const first = g[0];
    const strict = g.reduce((a, b) => (rankOf(b.status) < rankOf(a.status) ? b : a));
    const keys = [...new Set(g.map(rowKey))];
    return {
      ...first,
      status: strict.status !== undefined ? strict.status : first.status,
      target: first.target || (g.find((x) => x.target) || {}).target || first.target,
      reason: union(...g.map((x) => x.reason)), blockers: union(...g.map((x) => x.blockers)), notes: union(...g.map((x) => x.notes)),
      _label: `${alias} (keys: ${keys.join(', ')})`,
    };
  });
}

// Groups composer rows that share name + the extra fields in `sig(row)`; roots with an identical lock
// (lockIds[scope]) collapse into one row, differing locks stay separate. Non-composer rows pass through.
function groupComposerRows(rows, sig = () => '', lockIds = {}) {
  const groups = new Map();
  const out = [];
  for (const r of rows) {
    if (r.ecosystem !== 'composer' || !r.scope) { out.push(r); continue; }
    const k = JSON.stringify([r.name, sig(r), lockIds[r.scope] || null]);
    if (!groups.has(k)) { const g = { first: r, roots: [] }; groups.set(k, g); out.push(g); }
    groups.get(k).roots.push(r.scope);
  }
  return out.map((x) => (x && x.first ? { ...x.first, _roots: x.roots, _label: `composer::${x.first.name} [${x.roots.join(', ')}]` } : x));
}

module.exports = { helper, readJson, loadRunData, collectAdvisories, isCritical, textOf, componentAlias, mergeByAlias, groupComposerRows };
