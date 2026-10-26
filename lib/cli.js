#!/usr/bin/env node
'use strict';
// stack-updater CLI (server-agnostic core). Site facts come from --profile <dir>.
// Pipeline for `update` (orchestration in lib/core/pipeline.js; the stages live here):
//   inventory -> policy -> analyze -> per component: window -> backup -> apply/verify TEST
//             -> apply/verify PROD (rollback per component on failure) -> report + notify
// Modes: report-only (stop after analyze, then report), propose (same + proposals),
//        apply-tier-a (apply only tier-A decisions marked "auto").
// Mode source: --mode > $STACK_UPDATER_MODE_FILE > $STACK_UPDATER_MODE > <stateDir>/config/mode
//              > report-only. `stack-update mode <value>` writes the mode file.
const fs = require('fs');
const path = require('path');
const { loadConfig, MODES, ENVS } = require('./core/config');
const { acquireRunLock, checkDeployLocks } = require('./core/lock');
const { createLogger } = require('./core/log');
const { createRun, openRun, RUN_ID_RE } = require('./core/run');
const { loadPlugins } = require('./core/plugins');
const semver = require('./core/semver');
const { checkWindow } = require('./core/window');
const policyEngine = require('./policy/engine');
const notifier = require('./reporter/notify');
const pipeline = require('./core/pipeline');
const approvalsLib = require('./core/approvals');

const SUBCOMMANDS = {
  update: 'full pipeline (inventory→policy→analyze→backup→apply/verify test→apply/verify prod→report)',
  inventory: 'run collectors, print inventory items (JSON)',
  policy: 'inventory + policy evaluation, print decisions (JSON)',
  analyze: 'inventory + policy + analysts, print findings/proposals (JSON)',
  backup: 'back up the components that the current mode would change',
  verify: 'run verifiers for --env (default test)',
  report: 'write the run report (fresh report-only run, or --from <run-id>)',
  rollback: 'rollback <run-id> [component] — restore backups taken by a run',
  advisories: 'list security candidates from the inventory (security-watch hook reserved)',
  approve: 'approve <item-id> [--target X] [--not-before ISO] [--adapter name] [--by name] [--note text] — explicitly approve a tier-B item',
  approvals: 'list active and consumed tier-B approvals',
  mode: 'mode [report-only|apply-tier-a|propose] — print or set the default mode (mode file)',
};

const HELP = `stack-updater — server-agnostic stack update CLI

Usage:
  stack-update [flags]                        (= cli.js update)
  stack-rollback <run-id> [component] [flags] (= cli.js rollback)
  node lib/cli.js <subcommand> [args] [flags]

Subcommands:
${Object.entries(SUBCOMMANDS).map(([k, v]) => `  ${k.padEnd(11)} ${v}`).join('\n')}

Flags:
  --profile <dir>   site profile dir (default $STACK_UPDATER_PROFILE); a bare name
                    resolves to profiles/<name>
  --mode <m>        ${MODES.join(' | ')}
                    (default: $STACK_UPDATER_MODE_FILE or <stateDir>/config/mode, fallback report-only)
  --env <e>         ${ENVS.join(' | ')} (update: restrict to one env; verify: default test)
  --dry-run         never mutate: no backup/apply/restore side effects
  --baseline <run>  verify: use the verifier baselines (log offsets, apply time) taken by that run;
                    without it a baseline is created now
  --from <run-id>   reuse artifacts of a previous run (policy/analyze/backup/report)
  --force           update: apply outside the maintenance window (requires --reason);
                    rollback: ignore active deploy locks
  --reason <text>   why --force is used (logged in the run)
  --component <n>   backup only: back up these components (comma list, apt) directly,
                    without inventory/policy (e.g. a pre-change repack or a drill)
  --only <sel,...>  update: apply only targets matching a selector (component, item key
                    eco:scope:name, eco:name or name). "<sel>@<version>" pins a version (drills):
                    needs --force + --reason, the item must be in the inventory and the version
                    must be the installed one or within its major.minor (never a tier-B change)
  --target <v>      approve: the version approved for the item (default: the decision target of the latest run)
  --not-before <t>  approve: ISO timestamp; the approval is inactive before it
  --adapter <name>  approve: profile adapter plugin that performs the change instead of the generic applier
  --by <name>       approve: who approved (default: $SUDO_USER, $USER or 'operator'); --note <text>: free text
  --quiet         only errors on stderr
  --notify          report/advisories: send the summary through the profile notify adapter
  --no-notify       update: skip the end-of-run notification
  --<name>-confirmed  boolean confirmation passed to plugins as ctx.flags (e.g. the manual
                    disk-snapshot confirmation required by mariadb minor/major upgrades)
  -h, --help        this help

Exit codes: 0 ok or skipped (lock busy), 1 failure, 2 usage error.
`;

function parseArgs(argv) {
  const out = { positional: [], flags: {} };
  const valued = new Set(['profile', 'mode', 'env', 'from', 'reason', 'component', 'baseline', 'only', 'target', 'not-before', 'adapter', 'by', 'note']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { out.flags.help = true; continue; }
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
      if (valued.has(k)) {
        const v = inline !== undefined ? inline : argv[++i];
        if (v === undefined || v.startsWith('--')) throw usage(`--${k} requires a value`);
        out.flags[k] = v;
      } else if (['dry-run', 'force', 'quiet', 'notify', 'no-notify'].includes(k) || /^[a-z0-9-]+-confirmed$/.test(k)) {
        out.flags[k] = true;
      } else {
        throw usage(`unknown flag --${k}`);
      }
      continue;
    }
    out.positional.push(a);
  }
  return out;
}

function usage(msg) {
  const e = new Error(msg);
  e.usage = true;
  return e;
}

const itemKey = (x) => [x.ecosystem, x.scope || '', x.name].join(':');

function makeCtx(cfg, run, log, extra = {}) {
  return {
    profile: cfg.profile,
    policy: cfg.policy,
    profileDir: cfg.profileDir,
    stateDir: cfg.stateDir,
    mode: cfg.mode,
    dryRun: cfg.dryRun,
    flags: cfg.flags || {},
    env: extra.env || null,
    repoPath: cfg.repoPath,
    run: run ? { id: run.id, dir: run.dir, backupDir: run.backupDir } : null,
    log,
    semver,
    ...extra,
  };
}

// ---------------------------------------------------------------- stages
async function stageInventory(cfg, run, log) {
  const items = [];
  const errors = [];
  for (const p of loadPlugins('collectors', cfg)) {
    const l = log.child(`inventory:${p.name}`);
    try {
      const got = (await p.collect(makeCtx(cfg, run, l))) || [];
      for (const it of got) {
        if (!it || !it.ecosystem || !it.name) { l.warn('dropped malformed item', it); continue; }
        items.push({ candidates: [], ...it, collector: p.name });
      }
      l.info(`${got.length} items`);
    } catch (e) {
      errors.push({ plugin: p.name, error: e.message });
      l.error(`collector failed: ${e.message}`);
    }
  }
  const data = { items, errors };
  if (run) run.writeJson('inventory.json', data);
  return data;
}

// Core safety rails, applied after all policy plugins regardless of their output.
// approvals: array or {approvals:[]} (lib/core/approvals.js); now: Date. A tier-B decision becomes
// action 'approved' only with an active approval for its item key whose target is the decision target
// (or one of its candidates). Everything else keeps the strict behaviour.
function applyCoreRails(d, policy, approvals = [], now = new Date()) {
  const reasons = d.reasons ? d.reasons.slice() : [];
  let { action } = d;
  let { target } = d;
  let approval;
  const never = policy.componentsNeverAuto || [];
  if (d.tier === 'B' && action !== 'skip' && !(never.includes(d.name) || never.includes(`${d.ecosystem}:${d.name}`))) {
    const ap = approvalsLib.findActive(approvals, itemKey(d), now);
    if (ap) {
      const pool = (d.candidates || []).map((c) => (c && typeof c === 'object' ? c.version || c.target : c));
      if (ap.target === d.target || pool.includes(ap.target)) {
        action = 'approved';
        target = ap.target;
        approval = { id: ap.id, by: ap.approved_by, at: ap.approved_at, target: ap.target, adapter: ap.adapter || null, note: ap.note || null };
        reasons.push(`approved by ${ap.approved_by} ${ap.approved_at}`);
      } else {
        reasons.push(`core: approval target ${ap.target} does not match decision target ${d.target || '?'}`);
      }
    }
  }
  if (action === 'auto' && (never.includes(d.name) || never.includes(`${d.ecosystem}:${d.name}`))) {
    action = 'propose';
    reasons.push('core: component is in componentsNeverAuto');
  }
  if (action === 'auto' && d.tier !== 'A') {
    action = 'propose';
    reasons.push(`core: tier ${d.tier || '?'} is never applied automatically`);
  }
  const kr = policy.knownRegressions || {};
  const hit = target && (kr[`${d.name}@${target}`] || (kr[d.name] && kr[d.name][target]));
  if (hit && action !== 'skip') {
    action = 'hold';
    approval = undefined;
    reasons.push(`core: known regression: ${typeof hit === 'string' ? hit : JSON.stringify(hit)}`);
  }
  return approval ? { ...d, target, action, reasons, approval } : { ...d, action, reasons };
}

async function stagePolicy(cfg, run, log, inventory) {
  const byKey = new Map();
  for (const p of loadPlugins('policy', cfg)) {
    const l = log.child(`policy:${p.name}`);
    try {
      const got = (await p.evaluate(inventory.items, makeCtx(cfg, run, l))) || [];
      for (const d of got) byKey.set(itemKey(d), { ...d, policyPlugin: p.name });
      l.info(`${got.length} decisions`);
    } catch (e) {
      l.error(`policy plugin failed: ${e.message}`);
    }
  }
  const decisions = inventory.items.map((it) => {
    const d = byKey.get(itemKey(it)) || {
      ecosystem: it.ecosystem, scope: it.scope, name: it.name, installed: it.installed,
      target: null, tier: null, action: 'hold', reasons: ['core: no policy plugin handled this item'],
    };
    return applyCoreRails(d, cfg.policy, cfg.approvals, new Date());
  });
  if (run) {
    run.writeJson('decisions.json', { mode: cfg.mode, decisions });
    run.writeJson('candidates.json', policyEngine.compute(inventory, cfg.policy, { profile: cfg.profile }));
  }
  return decisions;
}

async function stageAnalyze(cfg, run, log, decisions) {
  const out = { findings: [], proposals: [], candidates: [] };
  for (const p of loadPlugins('analyst', cfg)) {
    const l = log.child(`analyze:${p.name}`);
    try {
      const r = (await p.analyze(decisions, makeCtx(cfg, run, l))) || {};
      out.findings.push(...(r.findings || []).map((f) => ({ ...f, analyst: p.name })));
      out.proposals.push(...(r.proposals || []).map((f) => ({ ...f, analyst: p.name })));
      out.candidates.push(...(r.candidates || []).map((f) => ({ ...f, analyst: p.name })));
    } catch (e) {
      l.error(`analyst failed: ${e.message}`);
      out.findings.push({ severity: 'warn', analyst: p.name, message: `analyst failed: ${e.message}` });
    }
  }
  if (run) run.writeJson('analysis.json', out);
  return out;
}

// --only "a,b@1.2.3" => [{ sel, version|null }]. The version is split on the LAST "@" that is
// followed by a digit, so scoped npm names (@scope/pkg) keep their leading "@".
function parseOnly(list) {
  return String(list || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.lastIndexOf('@');
    if (i > 0 && /^\d/.test(s.slice(i + 1))) return { sel: s.slice(0, i), version: s.slice(i + 1) };
    return { sel: s, version: null };
  });
}

const onlyMatches = (d, sel) => sel === pipeline.componentOf(d) || sel === itemKey(d) || sel === `${d.ecosystem}:${d.name}` || sel === d.name;

// A pin may only move within the installed major.minor (or re-pin the same version): never tier B.
function pinAllowed(installed, version, approved = false) {
  const strip = (v) => String(v || '').replace(/^\d+:/, '');
  if (approved) return true; // explicit tier-B approval: the pin may leave the installed major.minor
  return strip(installed) === strip(version) || semver.sameMinor(strip(installed), strip(version));
}

function selectTargets(cfg, decisions) {
  if (cfg.mode !== 'apply-tier-a') return [];
  const approved = decisions.filter((d) => d.action === 'approved' && d.tier === 'B' && d.target && d.approval);
  // approved tier-B first (e.g. a channel switch must precede the tier-A upgrades), then tier-A auto.
  const auto = approved.concat(decisions.filter((d) => d.action === 'auto' && d.tier === 'A' && d.target));
  const flags = cfg.flags || {};
  if (!flags.only) return auto;
  const out = [];
  const seen = new Set();
  for (const { sel, version } of parseOnly(flags.only)) {
    const matched = (version ? decisions : auto).filter((d) => onlyMatches(d, sel));
    if (!matched.length) throw usage(`--only ${sel}${version ? `@${version}` : ''}: no ${version ? 'inventory item' : 'tier-A auto target'} matches`);
    for (const d of matched) {
      if (seen.has(itemKey(d))) continue;
      if (!version) { out.push(d); seen.add(itemKey(d)); continue; }
      if (!flags.force || !String(flags.reason || '').trim()) throw usage(`--only ${sel}@${version}: a version pin requires --force --reason`);
      if (!pinAllowed(d.installed, version, !!d.approval)) throw usage(`--only ${sel}@${version}: ${d.installed} -> ${version} leaves the installed major.minor (tier B is never applied)`);
      if (d.approval) { out.push({ ...d, target: version, reasons: [...(d.reasons || []), `--only pin ${version} (forced: ${flags.reason})`] }); seen.add(itemKey(d)); continue; }
      const pinned = applyCoreRails({ ...d, target: version, tier: 'A', action: 'auto', reasons: [...(d.reasons || []), `--only pin ${version} (forced: ${flags.reason})`] }, cfg.policy);
      if (pinned.action !== 'auto') throw usage(`--only ${sel}@${version}: refused by core rails (${pinned.reasons.slice(-1)[0]})`);
      out.push(pinned); seen.add(itemKey(d));
    }
  }
  return out;
}

async function stageBackup(cfg, run, log, targets, opts = {}) {
  const entries = [];
  const errors = [];
  for (const p of loadPlugins('backup', cfg)) {
    const l = log.child(`backup:${p.name}`);
    try {
      const r = (await p.backup(targets, makeCtx(cfg, run, l))) || {};
      for (const e of r.entries || []) entries.push({ ...e, plugin: p.name });
      l.info(`${(r.entries || []).length} backup entries${cfg.dryRun ? ' (dry-run)' : ''}`);
    } catch (e) {
      errors.push({ plugin: p.name, error: e.message });
      l.error(`backup failed: ${e.message}`);
    }
  }
  const data = { dryRun: cfg.dryRun, entries, errors };
  if (opts.write !== false) run.writeJson('backup.json', data);
  return data;
}

async function stageApply(cfg, run, log, env, targets, window = null, opts = {}) {
  const out = { env, applied: [], failed: [], skipped: [] };
  if (cfg.dryRun) {
    out.skipped = targets.map((t) => ({ ...t, reason: 'dry-run' }));
    log.info(`apply:${env}`, `dry-run: would apply ${targets.length} targets`, targets.map(itemKey));
  } else {
    // Targets whose approval names an adapter are handled by that profile plugin, not the generic appliers.
    const adapters = new Map(loadPlugins('adapters', cfg).map((p) => [p.name, p]));
    const byAdapter = new Map();
    const generic = [];
    for (const t of targets) {
      const a = t.approval && t.approval.adapter;
      if (!a) { generic.push(t); continue; }
      if (!byAdapter.has(a)) byAdapter.set(a, []);
      byAdapter.get(a).push(t);
    }
    const jobs = [...loadPlugins('appliers', cfg).map((p) => [p, generic])];
    for (const [name, ts] of byAdapter) {
      const p = adapters.get(name);
      if (p) jobs.push([p, ts]);
      else out.failed.push(...ts.map((t) => ({ name: t.name, target: t.target, reason: `adapter "${name}" not found` })));
    }
    for (const [p, ts] of jobs) {
      if (!ts.length) continue;
      const l = log.child(`apply:${env}:${p.name}`);
      try {
        const r = (await p.apply(ts, makeCtx(cfg, run, l, { env, window, component: opts.component || null }))) || {};
        out.applied.push(...(r.applied || []).map((x) => ({ ...x, plugin: p.name })));
        out.failed.push(...(r.failed || []).map((x) => ({ ...x, plugin: p.name })));
      } catch (e) {
        out.failed.push({ plugin: p.name, error: e.message });
        l.error(`applier failed: ${e.message}`);
      }
    }
  }
  run.writeJson(opts.file || `apply-${env}.json`, out);
  return out;
}

// Verifiers may export an optional baseline(ctx) -> JSON snapshot taken BEFORE apply
// (log offsets, timestamps). Stored in baseline-<env>.json, keyed by verifier name.
async function stageBaseline(cfg, run, log, env) {
  const data = { env, takenAt: new Date().toISOString(), verifiers: {} };
  for (const p of loadPlugins('verifiers', cfg)) {
    if (typeof p.baseline !== 'function') continue;
    const l = log.child(`baseline:${env}:${p.name}`);
    try { data.verifiers[p.name] = (await p.baseline(makeCtx(cfg, run, l, { env }))) || null; l.info('baseline taken'); } catch (e) { l.error(`baseline failed: ${e.message}`); data.verifiers[p.name] = { error: e.message }; }
  }
  run.writeJson(`baseline-${env}.json`, data);
  return data;
}

// opts.baselineRun: run handle holding baseline-<env>.json; opts.watch: true right after an apply
// (verifiers with a watch window wait it out instead of reporting immediately).
async function stageVerify(cfg, run, log, env, opts = {}) {
  let baseline = null;
  const bf = `baseline-${env}.json`;
  if (opts.fresh) baseline = null;
  else if (opts.baselineRun && opts.baselineRun.has(bf)) baseline = opts.baselineRun.readJson(bf);
  else if (run && run.has(bf)) baseline = run.readJson(bf);
  const baselineCreated = !baseline;
  if (!baseline) baseline = await stageBaseline(cfg, run, log, env);
  const results = [];
  const timeoutMs = (cfg.policy.verifierTimeoutMinutes || 20) * 60000;
  for (const p of loadPlugins('verifiers', cfg)) {
    const l = log.child(`verify:${env}:${p.name}`);
    try {
      const r = (await pipeline.withTimeout(p.verify(makeCtx(cfg, run, l, { env, component: opts.component || null, baseline: (baseline.verifiers || {})[p.name] || null, baselineAt: baseline.takenAt, baselineCreated, watch: !!opts.watch })), timeoutMs, `verifier ${p.name}`)) || {};
      results.push({ name: p.name, ok: r.ok !== false, component: r.component, details: r.details, checks: r.checks || [], skipped: !!r.skipped });
      l.info(r.ok === false ? 'FAILED' : 'ok');
    } catch (e) {
      results.push({ name: p.name, ok: false, component: p.name, details: e.message, checks: [{ id: 'exception', ok: false, detail: e.message }] });
      l.error(`verifier threw: ${e.message}`);
    }
  }
  const data = { env, ok: results.every((r) => r.ok), baselineCreated, baselineAt: baseline.takenAt, results };
  if (run) run.writeJson(opts.file || `verify-${env}.json`, data);
  return data;
}

async function restoreEntries(cfg, run, log, entries, env) {
  const plugins = new Map(loadPlugins('backup', cfg).map((p) => [p.name, p]));
  const results = [];
  for (const entry of entries.slice().reverse()) {
    const p = plugins.get(entry.plugin);
    const l = log.child(`restore:${entry.plugin}`);
    if (!p) { results.push({ entry, ok: false, detail: 'backup plugin not available' }); continue; }
    try {
      const r = (await p.restore(entry, makeCtx(cfg, run, l, { env: env || entry.env || null }))) || {};
      results.push({ entry, ok: r.ok !== false, detail: r.detail || null });
    } catch (e) {
      results.push({ entry, ok: false, detail: e.message });
      l.error(`restore failed: ${e.message}`);
    }
  }
  return results;
}

function coreReport(summary) {
  const lines = [`# stack-updater run ${summary.runId}`, '', `- mode: ${summary.mode}`, `- dry-run: ${summary.dryRun}`, `- status: ${summary.status}`, ''];
  const counts = {};
  for (const d of summary.decisions || []) counts[d.action] = (counts[d.action] || 0) + 1;
  const countLines = Object.entries(counts).map(([k, v]) => `- ${k}: ${v}`);
  lines.push('## Decisions', '', ...(countLines.length ? countLines : ['- none (no inventory items)']), '');
  const actionable = (summary.decisions || []).filter((d) => d.target);
  if (actionable.length) {
    lines.push('| component | installed | target | tier | action | reasons |', '|---|---|---|---|---|---|');
    for (const d of actionable) lines.push(`| ${itemKey(d)} | ${d.installed || ''} | ${d.target} | ${d.tier || ''} | ${d.action} | ${(d.reasons || []).join('; ')} |`);
    lines.push('');
  }
  for (const v of summary.verify || []) lines.push(`- verify ${v.env}${v.component ? ` (${v.component})` : ''}: ${v.ok ? 'ok' : 'FAILED'}`);
  if ((summary.components || []).length) {
    lines.push('', '## Components', '', '| component | shared | status | steps |', '|---|---|---|---|');
    for (const c of summary.components) lines.push(`| ${c.component} | ${c.shared ? 'yes' : 'no'} | ${c.status} | ${(c.steps || []).map((s) => `${s.step}:${s.ok ? 'ok' : 'FAIL'}`).join(', ')} |`);
  }
  if ((summary.blockers || []).length) {
    lines.push('', '## Blockers', '');
    for (const b of summary.blockers) lines.push(`- ${b.component}: ${b.note}`);
  }
  if ((summary.incidents || []).length) {
    lines.push('', '## Incidents', '');
    for (const i of summary.incidents) lines.push(`- ${i.ts} ${i.component} ${i.stage}${i.env ? `@${i.env}` : ''}: ${i.message}${i.failedVerifiers && i.failedVerifiers.length ? ` (verifiers: ${i.failedVerifiers.join(', ')})` : ''}${i.rollback ? ` — rollback ${i.rollback.ok ? 'ok' : 'FAILED'} (${i.rollback.entries} entries)` : ''}`);
  }
  if ((summary.proposals || []).length) {
    lines.push('', '## Proposals (tier B; applied only with an explicit approval)', '');
    for (const p of summary.proposals) lines.push(`- ${p.component}: ${p.from || '?'} → ${p.to || '?'}${p.summary ? ` — ${p.summary}` : ''}`);
  }
  if (summary.error) lines.push('', `Error: ${summary.error}`);
  return lines.join('\n') + '\n';
}

async function stageReport(cfg, run, log, summary) {
  run.writeJson('summary.json', summary);
  fs.writeFileSync(run.file('report.md'), coreReport(summary));
  const files = [run.file('summary.json'), run.file('report.md')];
  for (const p of loadPlugins('reporter', cfg)) {
    const l = log.child(`report:${p.name}`);
    try {
      const r = (await p.report(summary, makeCtx(cfg, run, l))) || {};
      files.push(...(r.files || []));
    } catch (e) {
      l.error(`reporter failed: ${e.message}`);
    }
  }
  return files;
}

// ---------------------------------------------------------------- guards
function guardLocks(cfg, log, { force = false } = {}) {
  const dl = checkDeployLocks(cfg.profile.deployLocks || [], { maxAgeMs: (cfg.policy.deployLockMaxAgeMinutes || 120) * 60000 });
  for (const s of dl.stale) log.warn('lock', `stale deploy lock ignored: ${s.path} (mtime ${s.mtime})`, s);
  if (dl.busy && !force) return { ok: false, reason: `deploy in progress: ${dl.active.map((a) => a.path).join(', ')}`, deploy: dl };
  const rl = acquireRunLock(cfg.stateDir);
  if (!rl.ok) return { ok: false, reason: rl.reason };
  return { ok: true, release: rl.release, deploy: dl };
}

function recordSkip(cfg, command, reason) {
  try {
    fs.mkdirSync(cfg.stateDir, { recursive: true });
    fs.appendFileSync(path.join(cfg.stateDir, 'skipped.jsonl'), JSON.stringify({ ts: new Date().toISOString(), command, mode: cfg.mode, reason }) + '\n');
  } catch { /* best effort */ }
  process.stderr.write(`stack-updater: skipped (${reason})\n`);
}

// ---------------------------------------------------------------- commands
// Stage wiring for lib/core/pipeline.js. Tests pass extra.deps to override single stages.
function updateDeps(cfg, flags, extra = {}) {
  return {
    now: () => new Date(),
    checkWindow,
    guardLocks: () => guardLocks(cfg, createLogger(null, { quiet: flags.quiet })),
    recordSkip: (reason) => recordSkip(cfg, 'update', reason),
    createRun: () => createRun(cfg.stateDir, cfg.mode),
    createLogger: (dir) => createLogger(dir, { quiet: flags.quiet }),
    inventory: (run, log) => stageInventory(cfg, run, log),
    policy: (run, log, inv) => stagePolicy(cfg, run, log, inv),
    analyze: (run, log, decisions) => stageAnalyze(cfg, run, log, decisions),
    selectTargets: (decisions) => selectTargets(cfg, decisions),
    backup: (run, log, targets) => stageBackup(cfg, run, log, targets, { write: false }),
    baseline: (run, log, env) => stageBaseline(cfg, run, log, env),
    apply: (run, log, env, targets, window, opts) => stageApply(cfg, run, log, env, targets, window, opts),
    verify: (run, log, env, opts) => stageVerify(cfg, run, log, env, opts),
    restore: (run, log, entries, env) => restoreEntries(cfg, run, log, entries, env),
    report: (run, log, summary) => stageReport(cfg, run, log, summary),
    notifyRun: (run, summary, files) => notifier.notifyRun(cfg, run.dir, { reportPath: (files || []).find((f) => f.endsWith('.md') && f !== run.file('report.md')) }),
    notifyText: (text) => notifier.send(cfg, text),
    markConsumed: (id, runId) => approvalsLib.markConsumed(cfg.approvalsFile, id, runId),
    ...extra,
  };
}

async function cmdUpdate(cfg, flags, extra = {}) {
  const r = await pipeline.run({ cfg, flags, deps: updateDeps(cfg, flags, extra.deps), runTimeoutMs: extra.runTimeoutMs });
  if (r.timedOut) setImmediate(() => process.exit(r.code)); // stop stages still running in the background
  return r.code;
}

function modeFile(flags) {
  if (process.env.STACK_UPDATER_MODE_FILE) return process.env.STACK_UPDATER_MODE_FILE;
  const cfg = loadConfig({ profile: flags.profile, mode: 'report-only' });
  return path.join(cfg.stateDir, 'config', 'mode');
}

function readModeFrom(file) {
  try { return fs.readFileSync(file, 'utf8').trim() || null; } catch { return null; }
}

// `mode` prints the current default; `mode <value>` writes it (atomic) and confirms.
function cmdMode(flags, [value]) {
  const file = modeFile(flags);
  const current = readModeFrom(file);
  if (!value) { process.stdout.write(`mode: ${MODES.includes(current) ? current : 'report-only'} (${file}${current ? '' : ', absent: default'})\n`); return 0; }
  if (!MODES.includes(value)) throw usage(`invalid mode "${value}" (allowed: ${MODES.join(', ')})`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${value}\n`);
  fs.renameSync(`${file}.tmp`, file);
  process.stdout.write(`mode set: ${current || '(none)'} -> ${value} (${file})\n`);
  return 0;
}

// Latest run (lexicographic run-id order) that has decisions.json, or null.
function latestDecisions(stateDir) {
  const dir = path.join(stateDir, 'runs');
  let ids = [];
  try { ids = fs.readdirSync(dir).filter((i) => RUN_ID_RE.test(i)).sort().reverse(); } catch { return null; }
  for (const id of ids) {
    try { return { runId: id, decisions: JSON.parse(fs.readFileSync(path.join(dir, id, 'decisions.json'), 'utf8')).decisions || [] }; } catch { /* next */ }
  }
  return null;
}

// approve <item-id> [--target X] [--not-before ISO] [--adapter name] [--by name] [--note text]
function cmdApprove(cfg, flags, [id]) {
  if (!id) throw usage('approve requires <item-id> (decision key, e.g. apt::nginx)');
  const data = approvalsLib.load(cfg.approvalsFile);
  if (data.approvals.some((e) => e.id === id && !e.consumed_at)) throw usage(`an active approval for ${id} already exists (see: stack-update approvals)`);
  const latest = latestDecisions(cfg.stateDir);
  let dec = null;
  if (!latest) process.stderr.write(`warning: no previous run in ${cfg.stateDir}/runs; cannot check that "${id}" exists in the decisions\n`);
  else {
    dec = latest.decisions.find((d) => itemKey(d) === id);
    if (!dec) throw usage(`"${id}" is not in the decisions of the latest run ${latest.runId}`);
    if (dec.tier !== 'B') process.stderr.write(`warning: ${id} is tier ${dec.tier || '?'} in run ${latest.runId}; an approval only matters for tier B\n`);
  }
  const target = flags.target || (dec && dec.target);
  if (!target) throw usage('approve requires --target <version> (no decision target to default to)');
  const entry = { id, target: String(target), approved_by: flags.by || process.env.SUDO_USER || process.env.USER || 'operator', approved_at: new Date().toISOString() };
  if (flags['not-before']) {
    if (Number.isNaN(Date.parse(flags['not-before']))) throw usage(`--not-before "${flags['not-before']}" is not a valid ISO timestamp`);
    entry.not_before = new Date(flags['not-before']).toISOString();
  }
  if (flags.adapter) entry.adapter = flags.adapter;
  if (flags.note) entry.note = flags.note;
  const errs = approvalsLib.validate(entry);
  if (errs.length) throw usage(errs.join('; '));
  if (cfg.dryRun) { process.stdout.write(`dry-run: would approve ${JSON.stringify(entry)} in ${cfg.approvalsFile}\n`); return 0; }
  data.approvals.push(entry);
  approvalsLib.save(cfg.approvalsFile, data);
  process.stdout.write(`approved ${id} -> ${entry.target} by ${entry.approved_by}${entry.not_before ? ` (not before ${entry.not_before})` : ''}${entry.adapter ? ` [adapter ${entry.adapter}]` : ''} (${cfg.approvalsFile})\n`);
  return 0;
}

function cmdApprovals(cfg) {
  const rows = approvalsLib.list(cfg.approvals);
  const now = new Date();
  const state = (e) => (e.consumed_at ? 'consumed' : approvalsLib.isActive(e, now) ? 'active' : 'pending');
  const head = ['id', 'target', 'state', 'approved_by', 'approved_at', 'not_before', 'adapter', 'consumed_at'];
  const cells = rows.map((e) => [e.id, e.target, state(e), e.approved_by, e.approved_at, e.not_before || '-', e.adapter || '-', e.consumed_at || '-']);
  const w = head.map((h, i) => Math.max(h.length, ...cells.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd();
  process.stdout.write(`${line(head)}\n${w.map((n) => '-'.repeat(n)).join('  ')}\n`);
  for (const r of cells) process.stdout.write(`${line(r)}\n`);
  process.stdout.write(`${rows.length} approvals (${cells.filter((r) => r[2] === 'active').length} active) in ${cfg.approvalsFile}\n`);
  return 0;
}

async function cmdStandalone(cmd, cfg, flags) {
  const needsLock = cmd === 'backup';
  let g = null;
  if (needsLock) {
    g = guardLocks(cfg, createLogger(null, { quiet: flags.quiet }));
    if (!g.ok) { recordSkip(cfg, cmd, g.reason); return 0; }
  }
  const src = flags.from ? openRun(cfg.stateDir, flags.from) : null;
  const run = createRun(cfg.stateDir, cfg.mode);
  const log = createLogger(run.dir, { quiet: flags.quiet });
  let result;
  try {
    if (cmd === 'backup' && flags.component) {
      const targets = componentTargets(flags.component);
      log.info('backup', `--component: ${targets.map(itemKey).join(', ')}`);
      const bk = await stageBackup(cfg, run, log, targets);
      print({ runId: run.id, ...bk });
      return bk.errors.length ? 1 : 0;
    }
    if (cmd === 'verify') {
      result = await stageVerify(cfg, run, log, cfg.env || 'test', { baselineRun: flags.baseline ? openRun(cfg.stateDir, flags.baseline) : null });
      print(result);
      return result.ok ? 0 : 1;
    }
    const inv = src && src.has('inventory.json') && cmd !== 'inventory' ? src.readJson('inventory.json') : await stageInventory(cfg, run, log);
    if (cmd === 'inventory') { print(inv); return inv.errors.length ? 1 : 0; }
    if (cmd === 'advisories') {
      const adv = [];
      for (const it of inv.items) for (const c of it.candidates || []) if (c.security) adv.push({ ecosystem: it.ecosystem, scope: it.scope, name: it.name, installed: it.installed, ...c });
      const hook = cfg.profile.securityWatch || {};
      const crit = notifier.buildAdvisorySummary(inv);
      const out = { securityWatch: { enabled: !!hook.enabled, hook: hook.hook || null }, advisories: adv, critical: crit.critical.length };
      if (flags.notify) out.notify = notifier.notifyAdvisories(cfg, inv); // critical only; this subcommand never applies anything
      print(out);
      return 0;
    }
    const decisions = src && src.has('decisions.json') && cmd !== 'policy' ? src.readJson('decisions.json').decisions : await stagePolicy(cfg, run, log, inv);
    if (cmd === 'policy') { print({ mode: cfg.mode, runId: run.id, candidatesFile: path.join(run.dir, 'candidates.json'), decisions }); return 0; }
    if (cmd === 'analyze') { print(await stageAnalyze(cfg, run, log, decisions)); return 0; }
    if (cmd === 'backup') {
      const bk = await stageBackup(cfg, run, log, selectTargets(cfg, decisions));
      print(bk);
      return bk.errors.length ? 1 : 0;
    }
    if (cmd === 'report') {
      const analysis = src && src.has('analysis.json') ? src.readJson('analysis.json') : await stageAnalyze(cfg, run, log, decisions);
      const summary = { runId: src ? src.id : run.id, mode: cfg.mode, dryRun: cfg.dryRun, status: 'report', decisions, analysis, verify: [] };
      const files = await stageReport(cfg, src || run, log, summary);
      const out = { files };
      if (flags.notify) out.notify = notifier.notifyRun(cfg, (src || run).dir, { reportPath: files.find((f) => f.endsWith('.md') && !f.endsWith('/report.md')) });
      print(out);
      return 0;
    }
    throw usage(`unhandled subcommand ${cmd}`);
  } finally {
    log.close();
    if (g) g.release();
  }
}

async function cmdRollback(cfg, flags, [runId, component]) {
  if (!runId) throw usage('rollback requires <run-id>');
  const src = openRun(cfg.stateDir, runId);
  const g = guardLocks(cfg, createLogger(null, { quiet: flags.quiet }), { force: !!flags.force });
  if (!g.ok) { recordSkip(cfg, 'rollback', g.reason); return 0; }
  const log = createLogger(src.dir, { quiet: flags.quiet, file: 'rollback.jsonl' });
  try {
    const bk = src.readJson('backup.json', { entries: [] });
    let entries = bk.entries || [];
    // [component] = entry component, name, item key, pipeline component, or a plugin/ecosystem
    // name (e.g. `composer`, `npm`, `frontend`, `apt`) for every entry of that plugin.
    if (component) entries = entries.filter((e) => e.component === component || e.name === component || itemKey(e) === component || e.stackComponent === component || e.plugin === component || e.ecosystem === component);
    if (cfg.env) entries = entries.filter((e) => !e.env || e.env === cfg.env);
    if (!entries.length) { process.stderr.write(`no backup entries in run ${runId}${component ? ` for ${component}` : ''}\n`); return 1; }
    if (cfg.dryRun) { print({ dryRun: true, wouldRestore: entries }); return 0; }
    const results = await restoreEntries(cfg, src, log, entries, cfg.env);
    src.writeJson(`rollback-${Date.now()}.json`, { component: component || null, results });
    print({ results });
    return results.every((r) => r.ok) ? 0 : 1;
  } finally {
    log.close();
    g.release();
  }
}

// --component a,b[,eco:name] => manual backup targets (no target version: back up what is installed).
function componentTargets(list) {
  return String(list).split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [eco, name] = s.includes(':') ? s.split(':', 2) : ['apt', s];
    return { ecosystem: eco, scope: null, name, installed: null, target: null, tier: null, action: 'manual', reasons: ['--component'] };
  });
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

async function main(argv) {
  let parsed;
  try { parsed = parseArgs(argv); } catch (e) { process.stderr.write(`${e.message}\n\n${HELP}`); return 2; }
  const [cmd, ...rest] = parsed.positional;
  const { flags } = parsed;
  if (flags.help || !cmd || cmd === 'help') { process.stdout.write(HELP); return flags.help || cmd === 'help' ? 0 : 2; }
  if (!SUBCOMMANDS[cmd]) { process.stderr.write(`unknown subcommand "${cmd}"\n\n${HELP}`); return 2; }
  if (cmd === 'mode') {
    try { return cmdMode(flags, rest); } catch (e) { process.stderr.write(`${e.usage ? 'usage' : 'error'}: ${e.message}\n`); return e.usage ? 2 : 1; }
  }
  let cfg;
  try {
    let mode = flags.mode;
    if (!mode && process.env.STACK_UPDATER_MODE_FILE) {
      const m = readModeFrom(process.env.STACK_UPDATER_MODE_FILE);
      if (m && !MODES.includes(m)) throw new Error(`invalid mode "${m}" in ${process.env.STACK_UPDATER_MODE_FILE}`);
      mode = m || undefined;
    }
    cfg = loadConfig({ profile: flags.profile, mode, env: flags.env, dryRun: flags['dry-run'] });
    cfg.flags = flags;
  } catch (e) {
    process.stderr.write(`config error: ${e.message}\n`);
    return 2;
  }
  try {
    if (cmd === 'update') return await cmdUpdate(cfg, flags);
    if (cmd === 'rollback') return await cmdRollback(cfg, flags, rest);
    if (cmd === 'approve') return cmdApprove(cfg, flags, rest);
    if (cmd === 'approvals') return cmdApprovals(cfg);
    return await cmdStandalone(cmd, cfg, flags);
  } catch (e) {
    process.stderr.write(`${e.usage ? 'usage' : 'error'}: ${e.message}\n`);
    return e.usage ? 2 : 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { cmdApprove, cmdApprovals, latestDecisions, main, cmdUpdate, updateDeps, parseArgs, applyCoreRails, selectTargets, parseOnly, pinAllowed, componentTargets, itemKey, SUBCOMMANDS, HELP };
