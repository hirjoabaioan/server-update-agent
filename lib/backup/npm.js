'use strict';
// npm backup plugin (+ apply/restore) for profile.npmApps. Server-agnostic: site facts come from
// ctx.profile (npmApps[{path, runtimePath, owner, pm2Name, pm2User, healthUrl}], repo, branch,
// appBackup.{pm2RestartScript, keepPrev}).
//
// Everything targets the RUNTIME path (the directory pm2 runs), not the repo copy: the repo→web
// sync does not deploy automation apps and never copies node_modules.
// backup(): copy <runtime>/package{,-lock}.json to <run>/lockfiles/npm/<app>/, snapshot
//   node_modules as node_modules.prev-<run-id> (live dir untouched), keep at most 2 .prev dirs.
// apply() (mode apply-tier-a, not dry-run, with this run's snapshot): as the owner of the runtime
//   dir (`sudo -n -u <owner> -H` when it is not the current user)
//   `npm install <pkg>@<version> --save-exact --prefix <runtime>` (`npm ci --prefix` for the
//   "(app)" item), path-scoped lockfile commit when the runtime dir is inside the repo,
//   `<pm2RestartScript> <pm2Name> <pm2User>`, then GET healthUrl (status < 500).
//   Idempotent: a package already at the target is skipped (the core calls appliers per env).
// restore(): swap node_modules back, revert the commit (or copy the saved lockfiles back),
//   pm2 restart + health check.
const path = require('path');
const A = require('./_app');

function make(deps = {}) {
  const H = A.make(deps);
  const { sh, D } = H;
  const NAME = 'npm';

  const cfgOf = (ctx) => (ctx.profile && ctx.profile.appBackup) || {};
  const runIdOf = (ctx) => (ctx.run && ctx.run.id) || 'norun';
  const repoOf = (ctx) => (ctx.profile && ctx.profile.repo) || process.cwd();
  const keepPrev = (ctx) => Number(cfgOf(ctx).keepPrev) || 2;
  const restartScript = (ctx) => H.profileScript(ctx, cfgOf(ctx).pm2RestartScript);

  function appInfo(app, ctx) {
    const runtime = app.runtimePath || (ctx.repoPath ? ctx.repoPath(app.path) : app.path);
    const inRepo = H.inside(runtime, repoOf(ctx));
    let owner = app.owner || null;
    if (!owner) { const r = D.run('stat', ['-c', '%U', runtime]); owner = r.status === 0 ? r.stdout.trim() : null; }
    return { ...app, runtime, inRepo, owner, rel: inRepo ? path.relative(H.real(repoOf(ctx)), H.real(runtime)) : null };
  }

  function targetsByApp(targets, ctx) {
    const apps = (ctx.profile && ctx.profile.npmApps) || [];
    const out = [];
    for (const app of apps) {
      const ts = targets.filter((t) => t.ecosystem === 'npm' && t.scope === app.path);
      if (ts.length) out.push({ app: appInfo(app, ctx), targets: ts });
    }
    for (const t of targets.filter((x) => x.ecosystem === 'npm' && !apps.some((a) => a.path === x.scope))) {
      if (ctx.log) ctx.log.warn(`npm: ${t.scope || '(no scope)'} is not in profile.npmApps; ${t.name} skipped`);
    }
    return out;
  }

  const lockDirOf = (ctx, app) => path.join(ctx.run.dir, 'lockfiles', 'npm', A.sanitize(app.path));
  const commitsFile = (ctx) => path.join(ctx.run.dir, 'apply-npm.json');
  const gitPaths = (app) => [`${app.rel}/package.json`, `${app.rel}/package-lock.json`];

  function npmArgs(app, t) {
    if (t.name === '(app)' || !t.target) return ['ci', '--prefix', app.runtime];
    return ['install', `${t.name}@${t.target}`, '--save-exact', '--prefix', app.runtime];
  }
  const ownerCmd = (app, cmd, args) => H.asUser(app.owner, cmd, args);
  const restartCmd = (ctx, app) => (app.pm2Name ? ['bash', [restartScript(ctx) || 'pm2-restart.sh', app.pm2Name, app.pm2User || 'root']] : null);

  function applyCommands(ctx, app, targets) {
    const id = runIdOf(ctx);
    const cmds = [];
    for (const t of targets) {
      cmds.push(A.cmdLine(...ownerCmd(app, 'npm', npmArgs(app, t))));
      if (app.inRepo) {
        cmds.push(A.cmdLine('git', ['-C', repoOf(ctx), 'add', '--', ...gitPaths(app)]));
        cmds.push(A.cmdLine('git', ['-C', repoOf(ctx), 'commit', '-m', `stack-update ${id} npm ${t.name}`, '--', ...gitPaths(app)]));
      }
    }
    const rc = restartCmd(ctx, app);
    cmds.push(rc ? A.cmdLine(...rc) : '# no pm2 process: nothing to restart');
    cmds.push(app.healthUrl ? `GET ${app.healthUrl}  # expect status < 500` : '# no healthUrl configured: health check skipped');
    if (!app.inRepo) cmds.push('# runtime dir is outside the repo: no lockfile commit');
    return cmds;
  }

  function restoreCommands(ctx, app, lockDir) {
    const cmds = [...H.swapBackPlan(app.runtime, 'node_modules', runIdOf(ctx)).actions];
    if (app.inRepo) cmds.push(`git -C ${repoOf(ctx)} revert --no-edit <commit>   # if this run committed; else:`);
    cmds.push(A.cmdLine('cp', [path.join(lockDir, 'package.json'), path.join(lockDir, 'package-lock.json'), `${app.runtime}/`]));
    const rc = restartCmd(ctx, app);
    if (rc) cmds.push(A.cmdLine(...rc));
    if (app.healthUrl) cmds.push(`GET ${app.healthUrl}`);
    return cmds;
  }

  async function backup(targets, ctx) {
    const entries = [];
    const id = runIdOf(ctx);
    for (const { app, targets: ts } of targetsByApp(targets, ctx)) {
      const lockDir = lockDirOf(ctx, app);
      const snap = H.snapshotPlan(app.runtime, 'node_modules', id);
      const base = {
        component: `npm:${app.path}`, ecosystem: 'npm', scope: app.path, name: '(node_modules)', env: null, artifact: lockDir,
        restoreHint: `swap node_modules.prev-${id} back in ${app.runtime}${app.pm2Name ? `; pm2 restart ${app.pm2Name} (as ${app.pm2User || 'root'})` : ''}`,
      };
      const meta = {
        runtime: app.runtime, owner: app.owner, inRepo: app.inRepo, rel: app.rel, pm2Name: app.pm2Name || null, pm2User: app.pm2User || null,
        healthUrl: app.healthUrl || null, packages: ts.map((t) => ({ name: t.name, installed: t.installed || null, target: t.target || null })),
      };
      if (ctx.dryRun) {
        const actions = [`mkdir -p ${lockDir}`, A.cmdLine('cp', [path.join(app.runtime, 'package.json'), path.join(app.runtime, 'package-lock.json'), `${lockDir}/`]), ...snap.actions, `prune ${app.runtime}/node_modules.prev-* (keep ${keepPrev(ctx)})`];
        entries.push({ ...base, meta: { ...meta, dryRun: true, actions, applyPlan: applyCommands(ctx, app, ts), restorePlan: restoreCommands(ctx, app, lockDir) } });
        continue;
      }
      if (!H.exists(path.join(app.runtime, 'package.json'))) throw new Error(`${app.runtime}/package.json missing (runtimePath wrong?)`);
      const files = [];
      for (const f of ['package.json', 'package-lock.json']) {
        const src = path.join(app.runtime, f);
        if (H.exists(src)) { H.copyFile(src, path.join(lockDir, f)); files.push(f); }
      }
      const s = H.snapshot(app.runtime, 'node_modules', id);
      const snapshots = s.skipped ? [] : [app.runtime];
      if (s.skipped && ctx.log) ctx.log.warn(`npm: ${s.skipped}`);
      if (!s.skipped) H.prune(app.runtime, 'node_modules', keepPrev(ctx), H.prevName('node_modules', id));
      entries.push({ ...base, meta: { ...meta, files, snapshots } });
    }
    return { entries };
  }

  function installedOf(app, name) {
    const pj = H.readJson(path.join(app.runtime, 'node_modules', name, 'package.json'), null);
    return pj ? pj.version : null;
  }

  async function restartAndCheck(ctx, app) {
    const out = { restart: null, health: null };
    const rc = restartCmd(ctx, app);
    if (rc) { sh(...rc); out.restart = A.cmdLine(...rc); }
    if (app.healthUrl) out.health = await H.health(app.healthUrl, cfgOf(ctx).health || {});
    return out;
  }

  async function apply(targets, ctx) {
    const applied = []; const failed = [];
    const gate = H.applyGate(ctx);
    const id = runIdOf(ctx);
    for (const { app, targets: ts } of targetsByApp(targets, ctx)) {
      const refuse = (t, reason) => failed.push({ component: `npm:${app.path}`, name: t.name, target: t.target, reason });
      if (gate) { ts.forEach((t) => refuse(t, gate)); continue; }
      const pending = ts.filter((t) => t.name === '(app)' || !t.target || installedOf(app, t.name) !== t.target);
      ts.filter((t) => !pending.includes(t)).forEach((t) => applied.push({ component: `npm:${app.path}`, name: t.name, target: t.target, detail: 'already at target' }));
      if (!pending.length) continue;
      const bk = H.runEntries(ctx, NAME).find((e) => e.scope === app.path);
      if (!bk || !(bk.meta.snapshots || []).length) { pending.forEach((t) => refuse(t, 'no node_modules snapshot for this app in the run; refusing to apply')); continue; }
      let changed = false;
      for (const t of pending) {
        try {
          sh(...ownerCmd(app, 'npm', npmArgs(app, t)), { timeout: 15 * 60 * 1000 });
          changed = true;
          if (t.target && t.name !== '(app)' && installedOf(app, t.name) !== t.target) throw new Error(`${t.name} is ${installedOf(app, t.name)} after install, expected ${t.target}`);
          let sha = null;
          if (app.inRepo) {
            sha = H.gitCommitPaths(repoOf(ctx), gitPaths(app), `stack-update ${id} npm ${t.name}`, (ctx.profile && ctx.profile.branch) || null);
            if (sha) { const f = commitsFile(ctx); const d = H.readJson(f, { commits: [] }); d.commits.push({ scope: app.path, name: t.name, sha, paths: gitPaths(app) }); H.writeJson(f, d); }
          }
          applied.push({ component: `npm:${app.path}`, name: t.name, target: t.target, commit: sha });
        } catch (e) {
          if (ctx.log) ctx.log.error(`npm ${app.path} ${t.name} failed: ${e.message}`);
          refuse(t, e.message);
        }
      }
      if (!changed) continue;
      try {
        const r = await restartAndCheck(ctx, app);
        if (r.health && !r.health.ok) failed.push({ component: `npm:${app.path}`, name: '(health)', reason: `${app.healthUrl} -> ${r.health.status} after ${r.health.tries} tries` });
        else applied.push({ component: `npm:${app.path}`, name: '(restart)', detail: `${r.restart || 'no pm2 process'}; health ${r.health ? r.health.status : 'n/a'}` });
      } catch (e) {
        failed.push({ component: `npm:${app.path}`, name: '(restart)', reason: e.message });
      }
    }
    return { applied, failed };
  }

  async function restore(entry, ctx) {
    const m = entry.meta || {};
    const app = { path: entry.scope, runtime: m.runtime, owner: m.owner, inRepo: m.inRepo, rel: m.rel, pm2Name: m.pm2Name, pm2User: m.pm2User, healthUrl: m.healthUrl };
    const commits = ((H.readJson(commitsFile(ctx), { commits: [] }).commits) || []).filter((c) => c.scope === entry.scope).reverse();
    if (ctx.dryRun) return { ok: true, detail: `dry-run: swap node_modules back in ${m.runtime}; revert ${commits.length} commit(s); restart`, actions: restoreCommands(ctx, app, entry.artifact) };
    for (const d of m.snapshots || []) H.swapBack(d, 'node_modules', runIdOf(ctx));
    let revertErr = null; const reverted = [];
    for (const c of commits) { try { H.gitRevert(repoOf(ctx), c.sha, c.paths); reverted.push(c.sha.slice(0, 10)); } catch (e) { revertErr = e.message; break; } }
    if (!commits.length || revertErr) for (const f of m.files || []) H.copyFile(path.join(entry.artifact, f), path.join(m.runtime, f));
    const r = await restartAndCheck(ctx, app);
    const healthOk = !r.health || r.health.ok;
    return { ok: !revertErr && healthOk, detail: `node_modules restored in ${m.runtime}; reverted ${reverted.join(', ') || 'none'}${revertErr ? `; revert refused: ${revertErr}` : ''}; ${r.restart || 'no pm2 restart'}; health ${r.health ? r.health.status : 'n/a'}` };
  }

  return { name: NAME, backup, apply, restore, appInfo, targetsByApp };
}

module.exports = make();
module.exports.make = make;
