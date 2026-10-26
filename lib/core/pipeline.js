'use strict';
// `update` pipeline (core, server-agnostic). All side effects go through ctx.deps so the
// orchestration can be tested with fake stages/plugins (tests/runner.test.js).
//
//   window pre-check (apply-tier-a only, before any lock or host access)
//   -> run lock (flock) + deploy locks (< 2h => skip + notify)
//   -> inventory -> policy -> analyze
//   -> mode report-only|propose: report only (tier B => proposal entries, nothing applied)
//   -> mode apply-tier-a: tier-A "auto" targets grouped by component
//        TEST phase, per component: window check -> backup -> [env-specific components]
//          baseline/apply/verify TEST -> on failure: rollback this component only, incident, next
//        PROD phase, per component that passed TEST: window check -> [shared system components:
//          verify TEST before] -> baseline/apply/verify PROD (verifiers watch 5xx/logs, 15 min)
//          -> on failure: rollback this component only, incident, next
//   -> report + notify
// Shared system components (apt: php/nginx/mariadb/node, runtimes, docker, npm services) have
// no TEST copy: they are applied once, in the PROD phase.
// Timeouts: whole run 3h (soft: no new component after the deadline; hard: race + abort),
// each verifier 20 min (applied by the verify stage through withTimeout()).
const fs = require('fs');

const RUN_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const VERIFIER_TIMEOUT_MS = 20 * 60 * 1000;
// Ecosystems that exist per environment (a TEST copy can be applied and verified first).
const DEFAULT_ENV_SPECIFIC = ['composer', 'vendor-js', 'frontend'];

const itemKey = (x) => [x.ecosystem, x.scope || '', x.name].join(':');

function componentOf(t) {
  if (t.component) return String(t.component);
  if (t.meta && t.meta.group) return `${t.ecosystem}:${t.meta.group}`;
  return t.scope ? `${t.ecosystem}:${t.scope}` : `${t.ecosystem}:${t.name}`;
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'component';
}

function isShared(t, profile = {}) {
  const specific = Array.isArray(profile.envSpecificEcosystems) ? profile.envSpecificEcosystems : DEFAULT_ENV_SPECIFIC;
  return !specific.includes(t.ecosystem);
}

// Targets -> [{ component, slug, shared, targets[] }] in first-seen order.
function groupTargets(targets, profile = {}) {
  const map = new Map();
  for (const t of targets) {
    const c = componentOf(t);
    if (!map.has(c)) map.set(c, { component: c, slug: slug(c), shared: false, targets: [] });
    const g = map.get(c);
    g.targets.push(t);
    if (isShared(t, profile)) g.shared = true;
  }
  const seen = new Set();
  for (const g of map.values()) {
    let s = g.slug;
    for (let i = 2; seen.has(s); i++) s = `${g.slug}_${i}`;
    g.slug = s;
    seen.add(s);
  }
  return [...map.values()];
}

// Tier B => proposal entries only (never applied).
function proposalsFrom(decisions = [], analysis = {}) {
  const fromPolicy = decisions.filter((d) => d.tier === 'B' && d.target && d.action !== 'approved').map((d) => ({
    component: itemKey(d), from: d.installed || null, to: d.target, tier: 'B', action: d.action,
    summary: (d.reasons || []).join('; '), source: 'policy',
  }));
  const fromAnalysts = ((analysis && analysis.proposals) || []).map((p) => ({ ...p, source: p.analyst || 'analyst' }));
  return [...fromPolicy, ...fromAnalysts];
}

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 60000)} min`)), ms); });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(t));
}

// Mirrors every log event into a human-readable <runDir>/run.log (run.jsonl stays the
// machine log; stderr goes to the journal under systemd).
function teeLogger(log, file) {
  let fd = null;
  try { fd = fs.openSync(file, 'a'); } catch { fd = null; }
  const line = (lvl, stage, msg) => {
    if (fd === null) return;
    try { fs.writeSync(fd, `[${new Date().toISOString()}] ${lvl.toUpperCase()} ${stage ? `${stage}: ` : ''}${msg}\n`); } catch { /* best effort */ }
  };
  const api = {
    info: (s, m, d) => { line('info', s, m); return log.info(s, m, d); },
    warn: (s, m, d) => { line('warn', s, m); return log.warn(s, m, d); },
    error: (s, m, d) => { line('error', s, m); return log.error(s, m, d); },
    debug: (s, m, d) => log.debug(s, m, d),
    child: (stage) => ({
      info: (m, d) => api.info(stage, m, d),
      warn: (m, d) => api.warn(stage, m, d),
      error: (m, d) => api.error(stage, m, d),
      debug: (m, d) => api.debug(stage, m, d),
    }),
    close() {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } fd = null; }
      log.close();
    },
  };
  return api;
}

// ctx = { cfg, flags, deps, runTimeoutMs? }
// deps = { now, checkWindow, guardLocks, recordSkip, createRun, createLogger, inventory, policy,
//          analyze, selectTargets, markConsumed, backup, baseline, apply, verify, restore, report, notifyRun,
//          notifyText, stdout, stderr }
// Returns { code, status, runId?, timedOut? }.
async function run(ctx) {
  const { cfg, deps } = ctx;
  const flags = ctx.flags || {};
  const now = deps.now || (() => new Date());
  const stdout = deps.stdout || ((s) => process.stdout.write(s));
  const stderr = deps.stderr || ((s) => process.stderr.write(s));
  const wantNotify = !flags['no-notify'];
  const windowFor = (targets) => deps.checkWindow({ profile: cfg.profile, policy: cfg.policy, now: now(), force: !!flags.force, reason: flags.reason, targets });

  // 1. Hard guard: apply mode outside the window is refused before any lock or host access.
  if (cfg.mode === 'apply-tier-a') {
    const w = windowFor([]);
    if (!w.ok) {
      stderr(`stack-updater: refused: ${w.reason}\n`);
      stdout(`refused: ${w.reason}\n`);
      return { code: 1, status: 'refused', window: w };
    }
  }

  // 2. Locks.
  const g = deps.guardLocks();
  if (!g.ok) {
    const deployBusy = !!(g.deploy && g.deploy.busy);
    const msg = deployBusy ? g.reason : 'another run active';
    deps.recordSkip(msg);
    if (deployBusy && wantNotify && deps.notifyText) {
      try { deps.notifyText(`[stack-updater] ${cfg.mode}: run skipped — ${g.reason} (lock younger than 2h)`); } catch { /* best effort */ }
    }
    stdout(`skipped: ${msg}\n`);
    return { code: 0, status: 'skipped', reason: msg };
  }

  const runH = deps.createRun();
  const log = teeLogger(deps.createLogger(runH.dir), runH.file('run.log'));
  const runTimeoutMs = ctx.runTimeoutMs || RUN_TIMEOUT_MS;
  const deadline = Date.now() + runTimeoutMs;
  const summary = {
    runId: runH.id, mode: cfg.mode, dryRun: cfg.dryRun, envs: cfg.envs, startedAt: now().toISOString(), status: 'running',
    staleDeployLocks: (g.deploy && g.deploy.stale) || [], verify: [], components: [], incidents: [], blockers: [], proposals: [], restore: [],
    forced: flags.force ? { reason: flags.reason || null } : null,
  };
  const manifest = (stage) => runH.writeJson('manifest.json', { ...summary, stage, decisions: undefined, analysis: undefined });
  let aborted = false;
  const checkAbort = () => { if (aborted) throw new Error('run aborted: whole-run timeout reached'); };
  const incident = (rec, data) => {
    const inc = { component: rec.component, ts: now().toISOString(), ...data };
    summary.incidents.push(inc);
    log.error(`incident:${rec.component}`, `${data.stage}${data.env ? `@${data.env}` : ''}: ${data.message}`, inc);
    return inc;
  };

  async function body() {
    log.info('update', `mode ${cfg.mode}${cfg.dryRun ? ' (dry-run)' : ''}, envs ${cfg.envs.join(',')}${flags.force ? `, FORCED: ${flags.reason}` : ''}`);
    manifest('inventory');
    const inv = await deps.inventory(runH, log);
    summary.inventoryErrors = inv.errors || [];
    checkAbort();
    manifest('policy');
    summary.decisions = await deps.policy(runH, log, inv);
    checkAbort();
    manifest('analyze');
    summary.analysis = await deps.analyze(runH, log, summary.decisions);
    summary.proposals = proposalsFrom(summary.decisions, summary.analysis);
    checkAbort();

    if (cfg.mode !== 'apply-tier-a') {
      log.info('apply', `mode ${cfg.mode}: nothing is applied (${summary.proposals.length} proposal entries)`);
      return;
    }
    const targets = deps.selectTargets(summary.decisions);
    summary.targets = targets.map(itemKey);
    const groups = groupTargets(targets, cfg.profile);
    if (!groups.length) { log.info('apply', 'no tier-A auto / approved tier-B targets'); return; }

    const recs = new Map();
    for (const c of groups) {
      const rec = { component: c.component, shared: c.shared, targets: c.targets.map(itemKey), status: 'pending', steps: [] };
      recs.set(c.component, rec);
      summary.components.push(rec);
    }
    const backupAll = { dryRun: cfg.dryRun, entries: [], errors: [] };
    const applyAgg = {};
    const verifyAgg = {};
    const aggApply = (env, ap) => {
      const a = applyAgg[env] || (applyAgg[env] = { env, applied: [], failed: [], skipped: [] });
      a.applied.push(...(ap.applied || [])); a.failed.push(...(ap.failed || [])); a.skipped.push(...(ap.skipped || []));
    };
    const aggVerify = (env, vr, component) => {
      const v = verifyAgg[env] || (verifyAgg[env] = { env, ok: true, results: [] });
      v.ok = v.ok && vr.ok;
      v.results.push(...(vr.results || []).map((r) => ({ ...r, component: r.component || component })));
    };
    const step = (rec, name, ok, detail) => rec.steps.push({ step: name, ok, detail: detail || null, at: now().toISOString() });

    const gate = (c, rec, phase) => {
      checkAbort();
      if (Date.now() >= deadline) { rec.status = 'deferred'; step(rec, `${phase}:deadline`, false, 'whole-run deadline reached'); return false; }
      const w = windowFor(c.targets);
      if (!w.ok) {
        rec.status = 'deferred';
        step(rec, `${phase}:window`, false, w.reason);
        if (w.notifyOnly) summary.notify = (summary.notify || []).concat([{ type: 'critical-off-window', components: w.critical, message: w.reason }]);
        return false;
      }
      if (w.forced) step(rec, `${phase}:window`, true, w.reason);
      return true;
    };

    async function rollback(c, rec, env, why) {
      const entries = (rec.entries || []).filter((e) => c.shared || !e.env || e.env === env);
      let results = [];
      if (cfg.dryRun) step(rec, `rollback:${env}`, true, `dry-run: would restore ${entries.length} entries`);
      else {
        results = await deps.restore(runH, log, entries, env);
        summary.restore.push(...results.map((r) => ({ ...r, component: c.component, env })));
      }
      const ok = results.every((r) => r.ok);
      rec.status = ok ? 'rolled-back' : 'rollback-failed';
      step(rec, `rollback:${env}`, ok, `${results.length} entries restored`);
      for (const t of c.targets.filter((x) => x.approval)) {
        // The approval stays active (not consumed): the next window may retry once the cause is fixed.
        summary.blockers.push({ component: c.component, approval: t.approval.id, note: `rolled back on ${env} (${why.stage}); approval left active, fix the cause before the next window` });
      }
      incident(rec, { env, stage: why.stage, message: why.message, failedVerifiers: why.failedVerifiers || [], applyFailures: why.applyFailures || [], rollback: { ok, entries: results.length } });
    }

    // apply + verify one component on one env; rollback on failure. Returns true when it passed.
    async function applyAndVerify(c, rec, env) {
      const ts = c.shared ? c.targets : c.targets.filter((t) => !t.envs || t.envs.includes(env));
      // Rail: no fake "0 applied, 0 failed => ok" when the component's targets do not exist on this
      // env. TEST: recorded as having no TEST copy (prod-only roots keep their promotion path, as
      // before, but visibly); PROD: a failure.
      if (!ts.length) {
        const envsOf = [...new Set(c.targets.flatMap((t) => t.envs || []))].join(',') || 'none';
        if (env === 'test') { step(rec, 'test', true, `no TEST copy (item envs: ${envsOf}); nothing applied or verified on test`); return true; }
        step(rec, `apply:${env}`, false, `no target of this component is declared for env ${env} (item envs: ${envsOf})`);
        rec.status = `skipped(no ${env} target)`;
        return false;
      }
      const win = windowFor(c.targets);
      if (!cfg.dryRun) await deps.baseline(runH, log, env);
      manifest(`apply:${env}:${c.component}`);
      const ap = await deps.apply(runH, log, env, ts, win, { component: c.component, file: `apply-${env}--${c.slug}.json` });
      // Rail: every target must be reported by some applier (applied or failed); a silent target
      // means no applier handled its ecosystem => failure, never a silent pass.
      if (!cfg.dryRun) {
        const seen = new Set([...(ap.applied || []), ...(ap.failed || [])].map((x) => x && x.name).filter(Boolean));
        const silent = ts.filter((t) => !seen.has(t.name));
        if (silent.length) ap.failed = [...(ap.failed || []), ...silent.map((t) => ({ name: t.name, target: t.target, reason: `no applier handled ${itemKey(t)}` }))];
      }
      aggApply(env, ap);
      step(rec, `apply:${env}`, !(ap.failed || []).length, cfg.dryRun ? `dry-run: would apply ${ts.length}` : `${(ap.applied || []).length} applied, ${(ap.failed || []).length} failed`);
      if (cfg.dryRun) return true;
      checkAbort();
      manifest(`verify:${env}:${c.component}`);
      const vr = await deps.verify(runH, log, env, { watch: true, component: c.component, file: `verify-${env}--${c.slug}.json` });
      aggVerify(env, vr, c.component);
      summary.verify.push({ env, component: c.component, ok: vr.ok && !(ap.failed || []).length });
      step(rec, `verify:${env}`, vr.ok, vr.ok ? 'all verifiers ok' : 'verification failed');
      if (vr.ok && !(ap.failed || []).length) return true;
      await rollback(c, rec, env, {
        stage: (ap.failed || []).length ? 'apply' : 'verify',
        message: (ap.failed || []).length ? `apply failed on ${env}` : `verify --env ${env} failed`,
        failedVerifiers: (vr.results || []).filter((r) => !r.ok).map((r) => r.name),
        applyFailures: ap.failed || [],
      });
      return false;
    }

    // TEST phase: backup every component, apply+verify TEST for env-specific ones.
    const forProd = [];
    for (const c of groups) {
      const rec = recs.get(c.component);
      if (!gate(c, rec, 'test')) continue;
      manifest(`backup:${c.component}`);
      const bk = await deps.backup(runH, log, c.targets, { component: c.component });
      const entries = (bk.entries || []).map((e) => ({ ...e, stackComponent: c.component }));
      backupAll.entries.push(...entries);
      backupAll.errors.push(...(bk.errors || []).map((e) => ({ ...e, stackComponent: c.component })));
      runH.writeJson('backup.json', backupAll);
      rec.entries = entries;
      if ((bk.errors || []).length && !cfg.dryRun) {
        rec.status = 'failed';
        step(rec, 'backup', false, bk.errors.map((e) => `${e.plugin}: ${e.error}`).join('; '));
        incident(rec, { stage: 'backup', message: 'backup failed; component not applied', rollback: null });
        continue;
      }
      step(rec, 'backup', true, `${entries.length} entries${cfg.dryRun ? ' (dry-run)' : ''}`);
      if (c.shared) { rec.status = 'test-skipped(shared)'; forProd.push(c); continue; }
      if (!cfg.envs.includes('test')) {
        rec.status = 'skipped';
        step(rec, 'test', false, 'env-specific component must pass TEST first (--env excluded test)');
        continue;
      }
      if (await applyAndVerify(c, rec, 'test')) { rec.status = 'test-passed'; forProd.push(c); }
    }

    // PROD phase: only components that passed TEST (or shared ones, verified on TEST first).
    for (const c of forProd) {
      const rec = recs.get(c.component);
      if (!cfg.envs.includes('prod')) { if (c.shared) rec.status = 'not-applied(prod env not selected)'; continue; }
      if (!gate(c, rec, 'prod')) continue;
      if (c.shared && cfg.envs.includes('test') && !cfg.dryRun) {
        manifest(`preverify:test:${c.component}`);
        const pre = await deps.verify(runH, log, 'test', { watch: false, fresh: true, component: c.component, file: `verify-test--pre-${c.slug}.json` });
        step(rec, 'verify:test(before)', pre.ok, pre.ok ? 'TEST healthy before shared apply' : 'TEST unhealthy before shared apply');
        if (!pre.ok) {
          rec.status = 'failed';
          incident(rec, { env: 'test', stage: 'pre-verify', message: 'TEST verify failed before the shared apply; nothing applied', failedVerifiers: (pre.results || []).filter((r) => !r.ok).map((r) => r.name), rollback: null });
          continue;
        }
      }
      if (await applyAndVerify(c, rec, 'prod')) {
        rec.status = cfg.dryRun ? 'dry-run' : 'applied';
        if (!cfg.dryRun && deps.markConsumed) {
          // PROD verify passed: the approvals behind this component's targets are used up.
          for (const t of c.targets.filter((x) => x.approval)) {
            try { if (deps.markConsumed(t.approval.id, runH.id)) step(rec, 'approval', true, `consumed ${t.approval.id}`); } catch (e) { log.error('approval', `markConsumed ${t.approval.id}: ${e.message}`); }
          }
        }
      }
    }

    if (cfg.dryRun) {
      // dry-run: one verifier pass per env (current state), instead of per component.
      for (const env of cfg.envs) {
        const vr = await deps.verify(runH, log, env, { watch: false, fresh: true, file: `verify-${env}--dry-run.json` });
        aggVerify(env, vr, null);
        summary.verify.push({ env, ok: vr.ok, dryRun: true });
      }
    }
    for (const a of Object.values(applyAgg)) runH.writeJson(`apply-${a.env}.json`, a);
    for (const v of Object.values(verifyAgg)) runH.writeJson(`verify-${v.env}.json`, v);
  }

  let hardTimer = null;
  let timedOut = false;
  try {
    const hard = new Promise((resolve) => { hardTimer = setTimeout(() => resolve('timeout'), runTimeoutMs); });
    const r = await Promise.race([body().then(() => 'done'), hard]);
    if (r === 'timeout') {
      aborted = true;
      timedOut = true;
      summary.status = 'timeout';
      summary.error = `whole run exceeded ${Math.round(runTimeoutMs / 60000)} min; aborted`;
      log.error('update', summary.error);
    } else {
      summary.status = summary.incidents.length ? 'partial' : 'ok';
    }
  } catch (e) {
    summary.status = 'failed';
    summary.error = e.message;
    log.error('update', e.message);
  } finally {
    clearTimeout(hardTimer);
    summary.finishedAt = now().toISOString();
    manifest('report');
    let files = [];
    try { files = await deps.report(runH, log, summary); summary.reportFiles = files; } catch (e) { log.error('report', e.message); }
    if (wantNotify && deps.notifyRun) {
      try {
        const n = deps.notifyRun(runH, summary, files);
        log.info('notify', n && n.sent ? `sent (id=${((String((n && n.detail) || '').match(/"message_id":(\d+)/) || [])[1]) || 'n/a'})` : `not sent: ${(n && n.detail) || 'n/a'}`);
      } catch (e) { log.error('notify', e.message); }
    }
    manifest('done');
    log.close();
    g.release();
  }
  stdout(`${runH.id} ${summary.status}\n`);
  return { code: summary.status === 'ok' ? 0 : 1, status: summary.status, runId: runH.id, timedOut, summary };
}

module.exports = {
  run, groupTargets, componentOf, isShared, proposalsFrom, withTimeout, teeLogger, slug,
  RUN_TIMEOUT_MS, VERIFIER_TIMEOUT_MS, DEFAULT_ENV_SPECIFIC,
};
