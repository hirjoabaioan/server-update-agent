'use strict';
// Explicit approvals for tier-B items: <stateDir>/config/approvals.json
//   { "schema": 1, "approvals": [ { id, target, approved_by, approved_at, not_before?, adapter?, note?, consumed_at?, consumed_run? } ] }
// `id` is the decision key as in report.json (ecosystem:scope:name, e.g. "apt::nginx").
// An approval is active when it is not consumed and not_before (if any) is <= now.
// Without an active approval a tier-B item is never applied (rails in cli.js applyCoreRails).
const fs = require('fs');
const path = require('path');

const SCHEMA = 1;

const empty = () => ({ schema: SCHEMA, approvals: [] });

function validate(e) {
  const errs = [];
  if (!e || typeof e !== 'object' || Array.isArray(e)) return ['entry must be an object'];
  for (const k of ['id', 'target', 'approved_by', 'approved_at']) {
    if (typeof e[k] !== 'string' || !e[k].trim()) errs.push(`${k} is required`);
  }
  for (const k of ['approved_at', 'not_before', 'consumed_at']) {
    if (e[k] !== undefined && e[k] !== null && Number.isNaN(Date.parse(e[k]))) errs.push(`${k} is not a valid ISO timestamp`);
  }
  for (const k of ['adapter', 'note']) {
    if (e[k] !== undefined && e[k] !== null && typeof e[k] !== 'string') errs.push(`${k} must be a string`);
  }
  return errs;
}

// Missing file => empty list. Wrong schema / invalid JSON / invalid entry => throws.
function load(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return empty();
    throw new Error(`cannot read approvals ${file}: ${e.message}`);
  }
  let data;
  try { data = JSON.parse(raw); } catch (e) { throw new Error(`invalid JSON in approvals ${file}: ${e.message}`); }
  if (!data || data.schema !== SCHEMA || !Array.isArray(data.approvals)) throw new Error(`approvals ${file}: expected {"schema":${SCHEMA},"approvals":[...]}`);
  data.approvals.forEach((e, i) => {
    const errs = validate(e);
    if (errs.length) throw new Error(`approvals ${file}: entry ${i}: ${errs.join('; ')}`);
  });
  return data;
}

function save(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ schema: SCHEMA, approvals: data.approvals || [] }, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return file;
}

const list = (approvals) => (Array.isArray(approvals) ? approvals : (approvals && approvals.approvals) || []);

function isActive(e, now = new Date()) {
  if (!e || e.consumed_at) return false;
  if (e.not_before && Date.parse(e.not_before) > new Date(now).getTime()) return false;
  return true;
}

// Accepts the file object or the plain array. Returns the first active entry for the id, or null.
function findActive(approvals, id, now = new Date()) {
  return list(approvals).find((e) => e.id === id && isActive(e, now)) || null;
}

// Marks the first not-yet-consumed approval for the id as consumed by the run. Returns true when changed.
function markConsumed(file, id, runId, now = new Date()) {
  const data = load(file);
  const e = data.approvals.find((x) => x.id === id && !x.consumed_at);
  if (!e) return false;
  e.consumed_at = new Date(now).toISOString();
  e.consumed_run = runId || null;
  save(file, data);
  return true;
}

module.exports = { load, save, findActive, markConsumed, validate, isActive, list, empty, SCHEMA };
