'use strict';
// Run identity + state dir layout.
//
// <stateDir>/
//   config/mode              current default mode (report-only | apply-tier-a | propose)
//   run.lock                 flock target (see lock.js)
//   runs/<run-id>/
//     run.jsonl              event log (log.js)
//     manifest.json          run metadata + stage status
//     inventory.json         collector output (inventory items)
//     decisions.json         policy output
//     analysis.json          analyst output
//     backup.json            backup manifest (entries consumed by rollback)
//     apply-<env>.json       applier output
//     verify-<env>.json      verifier output
//     report.md / summary.json
//   backups/<run-id>/        artifacts written by backup plugins
//
// run-id = YYYYMMDD-HHMM-<mode> (UTC); a numeric suffix is added on collision.
const fs = require('fs');
const path = require('path');

const pad = (n) => String(n).padStart(2, '0');

function makeRunId(mode, date = new Date()) {
  const d = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
  const t = `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`;
  return `${d}-${t}-${mode}`;
}

const RUN_ID_RE = /^\d{8}-\d{4}-[a-z-]+(?:-\d+)?$/;

function stateLayout(stateDir) {
  return {
    stateDir,
    configDir: path.join(stateDir, 'config'),
    modeFile: path.join(stateDir, 'config', 'mode'),
    runsDir: path.join(stateDir, 'runs'),
    backupsDir: path.join(stateDir, 'backups'),
    lockFile: path.join(stateDir, 'run.lock'),
  };
}

function createRun(stateDir, mode, { date } = {}) {
  const layout = stateLayout(stateDir);
  fs.mkdirSync(layout.runsDir, { recursive: true });
  fs.mkdirSync(layout.configDir, { recursive: true });
  const base = makeRunId(mode, date);
  let id = base;
  for (let i = 2; fs.existsSync(path.join(layout.runsDir, id)); i++) id = `${base}-${i}`;
  const dir = path.join(layout.runsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  return openRunHandle(layout, id, dir);
}

function openRun(stateDir, id) {
  if (!RUN_ID_RE.test(id)) throw new Error(`invalid run-id "${id}"`);
  const layout = stateLayout(stateDir);
  const dir = path.join(layout.runsDir, id);
  if (!fs.existsSync(dir)) throw new Error(`run ${id} not found in ${layout.runsDir}`);
  return openRunHandle(layout, id, dir);
}

function openRunHandle(layout, id, dir) {
  const file = (name) => path.join(dir, name);
  return {
    id,
    dir,
    layout,
    backupDir: path.join(layout.backupsDir, id),
    file,
    writeJson(name, data) {
      const tmp = file(name) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
      fs.renameSync(tmp, file(name));
      return file(name);
    },
    readJson(name, fallback = undefined) {
      try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch (e) {
        if (fallback !== undefined) return fallback;
        throw new Error(`run ${id}: cannot read ${name}: ${e.message}`);
      }
    },
    has: (name) => fs.existsSync(file(name)),
  };
}

module.exports = { makeRunId, createRun, openRun, stateLayout, RUN_ID_RE };
