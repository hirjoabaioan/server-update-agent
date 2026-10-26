'use strict';
// Config = profile.json (site adapter) + policy.json (update policy) + env overrides.
// The core never hardcodes site facts; everything site-specific comes from the profile.
const fs = require('fs');
const approvalsLib = require('./approvals');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MODES = ['report-only', 'apply-tier-a', 'propose'];
const ENVS = ['test', 'prod'];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read JSON ${file}: ${e.message}`);
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Deep merge: objects merge recursively, arrays and scalars are replaced.
function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

function resolveProfileDir(flag) {
  const dir = flag || process.env.STACK_UPDATER_PROFILE;
  if (!dir) throw new Error('no profile: pass --profile <dir> or set STACK_UPDATER_PROFILE');
  const abs = path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir);
  if (!fs.existsSync(path.join(abs, 'profile.json'))) {
    // allow a bare profile name relative to the bundled profiles/ dir
    const bundled = path.join(ROOT, 'profiles', dir);
    if (fs.existsSync(path.join(bundled, 'profile.json'))) return bundled;
    throw new Error(`profile.json not found in ${abs}`);
  }
  return abs;
}

function readModeFile(stateDir) {
  try {
    const m = fs.readFileSync(path.join(stateDir, 'config', 'mode'), 'utf8').trim();
    return MODES.includes(m) ? m : null;
  } catch {
    return null;
  }
}

// opts: { profile, mode, env, dryRun }
function loadConfig(opts = {}) {
  const profileDir = resolveProfileDir(opts.profile);
  const profile = readJson(path.join(profileDir, 'profile.json'));

  if (!Array.isArray(profile.excluded) && Array.isArray(profile.composerExcluded)) {
    profile.excluded = profile.composerExcluded;
    console.warn('stack-updater: profile.composerExcluded is deprecated, use profile.excluded');
  }

  const policyFile = process.env.STACK_UPDATER_POLICY
    || (profile.policyFile ? path.resolve(profileDir, profile.policyFile) : path.join(ROOT, 'policy.json'));
  let policy = readJson(policyFile);
  if (isPlainObject(profile.policyOverrides)) policy = deepMerge(policy, profile.policyOverrides);

  const stateDir = process.env.STACK_UPDATER_STATE_DIR || profile.stateDir;
  if (!stateDir) throw new Error('profile.stateDir is required (or STACK_UPDATER_STATE_DIR)');

  let mode = opts.mode || process.env.STACK_UPDATER_MODE || readModeFile(stateDir) || 'report-only';
  if (!MODES.includes(mode)) throw new Error(`invalid mode "${mode}" (allowed: ${MODES.join(', ')})`);

  if (opts.env && !ENVS.includes(opts.env)) throw new Error(`invalid env "${opts.env}" (allowed: ${ENVS.join(', ')})`);

  // Paths in the profile that are relative are resolved against profile.repo.
  const repo = profile.repo || process.cwd();
  const repoPath = (p) => (p ? (path.isAbsolute(p) ? p : path.join(repo, p)) : p);

  const approvalsFile = process.env.STACK_UPDATER_APPROVALS_FILE || path.join(stateDir, 'config', 'approvals.json');

  return {
    root: ROOT,
    profileDir,
    profile,
    policy,
    policyFile,
    stateDir,
    mode,
    env: opts.env || null,
    envs: opts.env ? [opts.env] : ENVS.slice(),
    dryRun: !!opts.dryRun || process.env.STACK_UPDATER_DRY_RUN === '1',
    repoPath,
    approvalsFile,
    approvals: approvalsLib.load(approvalsFile),
  };
}

module.exports = { loadConfig, deepMerge, readJson, MODES, ENVS, ROOT };
