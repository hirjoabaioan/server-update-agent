'use strict';
// Plugin loader. One file per plugin, each exporting { name, <method> }.
// Search order per kind:
//   1. lib/<kind>/*.js                       (core, server-agnostic plugins)
//   2. <profileDir>/plugins/<kind>/*.js      (site adapter plugins)
// A module exporting `helper: true` is not a plugin and is skipped.
// A later plugin with the same name overrides an earlier one (profile wins).
// profile.plugins.<kind>.disabled = [names] turns plugins off;
// profile.plugins.<kind>.only = [names] restricts to an allow-list.
const fs = require('fs');
const path = require('path');

const KINDS = {
  collectors: 'collect',
  policy: 'evaluate',
  analyst: 'analyze',
  backup: 'backup',
  appliers: 'apply',
  adapters: 'apply', // profile-specific change procedures selected by an approval's `adapter` (same contract as appliers)
  verifiers: 'verify',
  reporter: 'report',
};

function listJs(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.startsWith('_')).sort().map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function loadPlugins(kind, cfg) {
  const method = KINDS[kind];
  if (!method) throw new Error(`unknown plugin kind "${kind}"`);
  const dirs = [path.join(__dirname, '..', kind)];
  if (cfg && cfg.profileDir) dirs.push(path.join(cfg.profileDir, 'plugins', kind));
  const settings = (cfg && cfg.profile && cfg.profile.plugins && cfg.profile.plugins[kind]) || {};
  const byName = new Map();
  for (const dir of dirs) {
    for (const file of listJs(dir)) {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const mod = require(file);
      if (mod && mod.helper === true) continue; // support module living next to plugins (e.g. analyst/llm.js)
      if (!mod || typeof mod.name !== 'string' || typeof mod[method] !== 'function') {
        throw new Error(`plugin ${file} must export { name: string, ${method}: function }`);
      }
      if (kind === 'backup' && typeof mod.restore !== 'function') {
        throw new Error(`backup plugin ${file} must also export restore()`);
      }
      byName.set(mod.name, Object.assign(Object.create(mod), { file }));
    }
  }
  let list = [...byName.values()];
  if (Array.isArray(settings.only)) list = list.filter((p) => settings.only.includes(p.name));
  if (Array.isArray(settings.disabled)) list = list.filter((p) => !settings.disabled.includes(p.name));
  return list;
}

module.exports = { loadPlugins, KINDS };
