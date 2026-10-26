'use strict';
// Tier-B compatibility pre-checks (pure). Return human-readable blocker strings.
const semver = require('../../core/semver');

// Does `version` satisfy a composer/npm-style constraint? (>=, >, <=, <, =, ^, ~, x/* wildcards, ||, AND by space/comma)
function satisfies(version, range) {
  if (!range || /^\s*\*?\s*$/.test(range)) return true;
  const v = semver.parse(version);
  if (!v) return true;
  return String(range).split(/\s*\|\|?\s*/).some((group) => {
    const parts = group.split(/[\s,]+/).filter(Boolean);
    const merged = [];
    for (let i = 0; i < parts.length; i++) {
      if (/^(>=|<=|>|<|=|\^|~)$/.test(parts[i]) && parts[i + 1]) merged.push(parts[i] + parts[++i]); else merged.push(parts[i]);
    }
    return merged.every((part) => {
      const m = part.match(/^(>=|<=|>|<|==|=|\^|~)?\s*v?([\dxX*.]+)/);
      if (!m) return true;
      const wild = m[2].split('.');
      if (wild.some((w) => /^[xX*]$/.test(w))) {
        const fixed = wild.filter((w) => !/^[xX*]$/.test(w)).map(Number);
        return fixed.every((n, i) => [v.major, v.minor, v.patch][i] === n);
      }
      const base = semver.parse(m[2]);
      const nParts = m[2].split('.').length;
      const c = semver.compare(v, base);
      switch (m[1]) {
        case '>=': return c >= 0;
        case '<=': return nParts < 3 ? semver.compare({ ...v, patch: 0, minor: nParts < 2 ? 0 : v.minor }, base) <= 0 : c <= 0;
        case '>': return c > 0;
        case '<': return c < 0;
        case '^': return c >= 0 && (base.major > 0 ? v.major === base.major : v.minor === base.minor);
        case '~': return c >= 0 && v.major === base.major && (nParts < 2 || v.minor === base.minor);
        default: return nParts >= 3 ? c === 0 : v.major === base.major && (nParts < 2 || v.minor === base.minor);
      }
    });
  });
}

const byEco = (inv, eco, name) => inv.filter((i) => i.ecosystem === eco && (!name || i.name === name));
const nodeMajorInstalled = (inv) => {
  const n = byEco(inv, 'node-runtime', 'nodejs')[0];
  const p = n && semver.parse(n.installed);
  return p ? p.major : null;
};

function puppeteerBlockers(inv, policy, nodeMajor, label) {
  const table = (policy.compat && policy.compat.puppeteerMinNode) || { 24: 18, 23: 18, 22: 18, 21: 16 };
  const out = [];
  for (const it of inv.filter((i) => i.ecosystem === 'npm' && /^puppeteer(-core)?$/.test(i.name))) {
    const p = semver.parse(it.installed);
    const min = p && table[p.major];
    if (min && nodeMajor < min) out.push(`${label}: puppeteer ${it.installed} (${it.scope || 'app'}) needs Node >= ${min}, target is Node ${nodeMajor}`);
  }
  return out;
}

// it: inventory item; line: { key, major, minor, version, candidate }; ctx: { inventory, policy, activePhp }
function check(it, line, ctx) {
  const inv = ctx.inventory;
  const out = [];
  const target = semver.parse(line.version);
  if (!target) return out;

  if (it.ecosystem === 'php-runtime') {
    const tv = `${target.major}.${target.minor}.0`;
    for (const l of byEco(inv, 'composer', '(lockfile)')) {
      const pl = (l.meta && l.meta.platform) || {};
      if (pl.configPlatform && semver.compare(pl.configPlatform, tv) > 0) out.push(`composer config.platform.php ${pl.configPlatform} (${l.scope}) is above target PHP ${target.major}.${target.minor}`);
      if (pl.require && !satisfies(tv, pl.require)) out.push(`composer require.php "${pl.require}" (${l.scope}) does not allow PHP ${target.major}.${target.minor}`);
    }
  }

  if (it.ecosystem === 'node-runtime') {
    const tv = `${target.major}.0.0`;
    for (const a of inv.filter((i) => i.ecosystem === 'npm' && i.name === '(app)')) {
      const eng = a.meta && a.meta.engines && a.meta.engines.node;
      if (eng && !satisfies(tv, eng)) out.push(`npm app ${a.scope} engines.node "${eng}" excludes Node ${target.major}`);
    }
    out.push(...puppeteerBlockers(inv, ctx.policy, target.major, 'node'));
  }

  const c = line.candidate || {};
  if (it.ecosystem === 'npm' || it.ecosystem === 'vendor-js') {
    const nodeMajor = nodeMajorInstalled(inv);
    const eng = (c.engines && c.engines.node) || null;
    if (eng && nodeMajor !== null && !satisfies(`${nodeMajor}.0.0`, eng)) out.push(`${it.name}@${line.version} engines.node "${eng}" excludes installed Node ${nodeMajor}`);
    for (const [dep, range] of Object.entries(c.peerDependencies || {})) {
      const peer = inv.find((i) => i.name === dep && (i.ecosystem === 'npm' || i.ecosystem === 'vendor-js') && (i.scope || null) === (it.scope || null));
      if (peer && !satisfies(peer.installed, range)) out.push(`${it.name}@${line.version} peerDependency ${dep} "${range}" not satisfied by installed ${peer.installed}`);
    }
    if (/^puppeteer(-core)?$/.test(it.name) && nodeMajor !== null) {
      const table = (ctx.policy.compat && ctx.policy.compat.puppeteerMinNode) || { 24: 18, 23: 18, 22: 18, 21: 16 };
      if (table[target.major] && nodeMajor < table[target.major]) out.push(`puppeteer ${target.major} needs Node >= ${table[target.major]}, installed Node ${nodeMajor}`);
    }
  }
  if (it.ecosystem === 'composer' && c.requirePhp) {
    const ph = byEco(inv, 'php-runtime').find((i) => i.scope === ctx.activePhp);
    if (ph && !satisfies(ph.installed, c.requirePhp)) out.push(`${it.name}@${line.version} requires php "${c.requirePhp}", installed ${ph.installed}`);
  }

  if (it.ecosystem === 'vendor-js' || it.ecosystem === 'npm') {
    const bsTheme = inv.find((i) => /select2-bootstrap-?5-theme/.test(i.name));
    if (it.name === 'bootstrap' && bsTheme && target.major !== 5) out.push(`bootstrap ${target.major} conflicts with select2-bootstrap-5-theme (${bsTheme.installed}, Bootstrap 5 only)`);
    if (it.name === 'flatpickr') {
      for (const pl of inv.filter((i) => /^(@?flatpickr[-/])/.test(i.name) && i.name !== 'flatpickr')) {
        const has = semver.eq(pl.installed, line.version) || (pl.candidates || []).some((x) => semver.eq(x.version, line.version));
        if (!has) out.push(`flatpickr core ${line.version} requires plugin ${pl.name} at the same version (installed ${pl.installed}, no matching release)`);
      }
    }
    if (it.name === 'intl-tel-input') {
      const cur = semver.parse(it.installed);
      if (cur && cur.major !== target.major) out.push(`intl-tel-input major change ${cur.major} -> ${target.major} needs markup/API migration of phone inputs`);
    }
  }
  return out;
}

module.exports = { check, satisfies };
