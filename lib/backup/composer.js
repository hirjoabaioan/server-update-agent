'use strict';
// composer backup plugin (+ apply/restore). Server-agnostic: site facts come from ctx.profile
// (webRoots, excluded, repo, branch, composerBin, appBackup.{phpCli,keepPrev}).
//
// Per web root (deduplicated by the real path of <path>/public_html — roots whose public_html is
// a symlink to another root are aliases of that root):
// backup(): copy <repo root>/public_html/composer.{json,lock} to <run>/lockfiles/composer/<domain>/,
//   snapshot vendor/ as vendor.prev-<run-id> in the repo copy AND the live web copy (the live
//   vendor/ is never moved away), keep at most appBackup.keepPrev (2) .prev dirs per root.
// apply() (mode apply-tier-a, not dry-run, only roots of ctx.env, only with this run's backup):
//   `composer update <pkg>:<version> --no-interaction [--no-dev only if vendor/ has no dev pkgs]
//   --working-dir <repo root>/public_html` (strict: only <pkg> moves), `<phpCli> -l vendor/autoload.php`, commit with
//   `stack-update <run-id> composer <pkg>` staging ONLY composer.json, composer.lock and vendor/
//   (vendor/ only when tracked by git), then rsync vendor/ + lockfiles to the live copy.
// restore(): swap vendor.prev-<run-id> back (repo + live), `git revert --no-edit <commit>` for the
//   run's commits (only when those paths are clean), else copy the saved lockfiles back.
const path = require('path');
const A = require('./_app');
const { excludedOf } = require('../core/excluded');

function make(deps = {}) {
  const H = A.make(deps);
  const { sh, D } = H;
  const NAME = 'composer';

  const cfgOf = (ctx) => (ctx.profile && ctx.profile.appBackup) || {};
  const runIdOf = (ctx) => (ctx.run && ctx.run.id) || 'norun';
  const repoOf = (ctx) => (ctx.profile && ctx.profile.repo) || process.cwd();
  const composerBin = (ctx) => (ctx.profile && ctx.profile.composerBin) || 'composer';
  const phpCli = (ctx) => cfgOf(ctx).phpCli || 'php';
  const keepPrev = (ctx) => Number(cfgOf(ctx).keepPrev) || 2;

  // Canonical roots + alias map (domain -> canonical domain).
  function roots(ctx) {
    const excluded = new Set(excludedOf(ctx.profile).map((x) => x.domain));
    const byReal = new Map();
    const alias = new Map();
    const out = [];
    for (const r of (ctx.profile && ctx.profile.webRoots) || []) {
      if (excluded.has(r.domain)) continue;
      const repoDir = path.join(ctx.repoPath ? ctx.repoPath(r.repoPath) : r.repoPath, 'public_html');
      const webDir = path.join(r.path, 'public_html');
      const key = H.real(webDir);
      if (byReal.has(key)) { alias.set(r.domain, byReal.get(key).domain); continue; }
      const root = { domain: r.domain, env: r.env, repoDir, webDir, sameDir: H.real(repoDir) === key, aliases: [] };
      byReal.set(key, root);
      alias.set(r.domain, r.domain);
      out.push(root);
    }
    for (const [d, c] of alias) if (d !== c) out.find((x) => x.domain === c).aliases.push(d);
    return { list: out, alias };
  }

  function targetsByRoot(targets, ctx) {
    const { list, alias } = roots(ctx);
    const map = new Map(list.map((r) => [r.domain, { root: r, targets: [] }]));
    for (const t of targets.filter((x) => x.ecosystem === 'composer' && x.name && !x.name.startsWith('('))) {
      const doms = t.scope ? [alias.get(t.scope)].filter(Boolean) : list.map((r) => r.domain);
      if (t.scope && !doms.length && ctx.log) ctx.log.warn(`composer: ${t.scope} is not a managed web root (excluded or unknown); skipped`);
      for (const d of new Set(doms)) { const g = map.get(d); if (!g.targets.some((x) => x.name === t.name)) g.targets.push(t); }
    }
    return [...map.values()].filter((g) => g.targets.length);
  }

  const relIn = (ctx, dir) => path.relative(H.real(repoOf(ctx)), H.real(dir));

  function gitPaths(ctx, root) {
    const rel = relIn(ctx, root.repoDir);
    const paths = [`${rel}/composer.json`, `${rel}/composer.lock`];
    const vendorTracked = H.isTracked(repoOf(ctx), `${rel}/vendor`);
    if (vendorTracked) paths.push(`${rel}/vendor`);
    return { rel, paths, vendorTracked };
  }

  // Strict tier-A update: only <pkg> moves (no --with-all-dependencies: that let a patch drag
  // minor bumps of shared deps, e.g. symfony/process 7.3 -> 7.4; a patch that needs other packages
  // to move fails here and is reported). --no-dev only when the live vendor/ was installed without
  // dev packages, otherwise composer would uninstall them (symfony/panther & co.) from vendor/.
  function vendorHasDev(dir) {
    const inst = H.readJson(path.join(dir, 'vendor', 'composer', 'installed.json'), null);
    return !inst || inst.dev !== false;
  }
  function updateArgs(root, t) {
    const args = ['update', `${t.name}:${t.target}`, '--no-interaction'];
    if (!vendorHasDev(root.repoDir)) args.push('--no-dev');
    return [...args, '--working-dir', root.repoDir];
  }

  function snapshotDirs(root) { return root.sameDir ? [root.webDir] : [root.repoDir, root.webDir]; }
  const lockDirOf = (ctx, root) => path.join(ctx.run.dir, 'lockfiles', 'composer', A.sanitize(root.domain));
  const commitsFile = (ctx) => path.join(ctx.run.dir, 'apply-composer.json');

  function applyCommands(ctx, root, targets, gp) {
    const id = runIdOf(ctx);
    const cmds = [];
    for (const t of targets) {
      cmds.push(A.cmdLine(composerBin(ctx), updateArgs(root, t)));
      cmds.push(A.cmdLine(phpCli(ctx), ['-l', path.join(root.repoDir, 'vendor', 'autoload.php')]));
      cmds.push(A.cmdLine('git', ['-C', repoOf(ctx), 'add', '--', ...gp.paths]));
      cmds.push(A.cmdLine('git', ['-C', repoOf(ctx), 'commit', '-m', `stack-update ${id} composer ${t.name}`, '--', ...gp.paths]));
    }
    if (!root.sameDir) {
      cmds.push(`${A.cmdLine('rsync', ['-a', '--delete', '--chown=<owner of live public_html>', `${root.repoDir}/vendor/`, `${root.webDir}/vendor/`])}`);
      cmds.push(A.cmdLine('rsync', ['-a', '--chown=<owner of live public_html>', `${root.repoDir}/composer.json`, `${root.repoDir}/composer.lock`, `${root.webDir}/`]));
      cmds.push(A.cmdLine(phpCli(ctx), ['-l', path.join(root.webDir, 'vendor', 'autoload.php')]));
    }
    return cmds;
  }

  function restoreCommands(ctx, root, lockDir) {
    const id = runIdOf(ctx);
    const cmds = [];
    for (const d of snapshotDirs(root)) cmds.push(...H.swapBackPlan(d, 'vendor', id).actions);
    cmds.push(`git -C ${repoOf(ctx)} revert --no-edit <commit>   # for each commit of this run (clean paths only); else:`);
    cmds.push(A.cmdLine('cp', [path.join(lockDir, 'composer.lock'), path.join(lockDir, 'composer.json'), `${root.repoDir}/`]));
    return cmds;
  }

  async function backup(targets, ctx) {
    const entries = [];
    const id = runIdOf(ctx);
    for (const { root, targets: ts } of targetsByRoot(targets, ctx)) {
      const lockDir = lockDirOf(ctx, root);
      const gp = gitPaths(ctx, root);
      const snaps = snapshotDirs(root).map((d) => H.snapshotPlan(d, 'vendor', id));
      const actions = [
        `mkdir -p ${lockDir}`,
        A.cmdLine('cp', [path.join(root.repoDir, 'composer.lock'), path.join(root.repoDir, 'composer.json'), `${lockDir}/`]),
        ...snaps.flatMap((s) => s.actions),
        ...snapshotDirs(root).map((d) => `prune ${d}/vendor.prev-* (keep ${keepPrev(ctx)})`),
      ];
      const base = {
        component: `composer:${root.domain}`, ecosystem: 'composer', scope: root.domain, name: '(vendor)', env: root.env,
        artifact: lockDir,
        restoreHint: `swap vendor.prev-${id} back in ${snapshotDirs(root).join(' + ')}; git revert the run's composer commits`,
      };
      const meta = {
        packages: ts.map((t) => ({ name: t.name, installed: t.installed || null, target: t.target || null })),
        repoDir: root.repoDir, webDir: root.webDir, aliases: root.aliases, gitPaths: gp.paths,
        vendorTracked: gp.vendorTracked, note: gp.vendorTracked ? null : 'vendor/ is not tracked by git (gitignored): only composer.json/lock are committed',
      };
      if (ctx.dryRun) {
        entries.push({ ...base, meta: { ...meta, dryRun: true, actions, applyPlan: applyCommands(ctx, root, ts.filter((t) => t.target), gp), restorePlan: restoreCommands(ctx, root, lockDir) } });
        continue;
      }
      D.fs.mkdirSync(lockDir, { recursive: true });
      const files = [];
      for (const f of ['composer.lock', 'composer.json']) {
        const src = path.join(root.repoDir, f);
        if (!H.exists(src)) { if (f === 'composer.lock') throw new Error(`${src} missing`); continue; }
        H.copyFile(src, path.join(lockDir, f)); files.push(f);
      }
      const snapshots = [];
      for (const d of snapshotDirs(root)) {
        const s = H.snapshot(d, 'vendor', id);
        if (s.skipped) { if (ctx.log) ctx.log.warn(`composer: ${s.skipped}`); continue; }
        snapshots.push(d);
        const pruned = H.prune(d, 'vendor', keepPrev(ctx), H.prevName('vendor', id));
        if (pruned.length && ctx.log) ctx.log.info(`composer: pruned ${pruned.length} old vendor.prev dirs in ${d}`, { pruned });
      }
      entries.push({ ...base, meta: { ...meta, files, snapshots } });
    }
    return { entries };
  }

  function recordCommit(ctx, rec) {
    const f = commitsFile(ctx);
    const data = H.readJson(f, { commits: [] });
    data.commits.push(rec);
    H.writeJson(f, data);
  }

  async function apply(targets, ctx) {
    const applied = []; const failed = [];
    const gate = H.applyGate(ctx);
    const id = runIdOf(ctx);
    for (const { root, targets: ts } of targetsByRoot(targets, ctx)) {
      if (ctx.env && root.env !== ctx.env) continue;
      const refuse = (t, reason) => failed.push({ component: `composer:${root.domain}`, name: t.name, target: t.target, reason });
      if (gate) { ts.forEach((t) => refuse(t, gate)); continue; }
      const bk = H.runEntries(ctx, NAME).find((e) => e.scope === root.domain);
      if (!bk || !(bk.meta.snapshots || []).length) { ts.forEach((t) => refuse(t, 'no vendor snapshot for this root in the run; refusing to apply')); continue; }
      const gp = gitPaths(ctx, root);
      let changed = false;
      for (const t of ts) {
        if (!t.target) { refuse(t, 'no target version'); continue; }
        try {
          sh(composerBin(ctx), updateArgs(root, t),
            { env: { COMPOSER_ALLOW_SUPERUSER: '1' }, timeout: 15 * 60 * 1000 });
          sh(phpCli(ctx), ['-l', path.join(root.repoDir, 'vendor', 'autoload.php')]);
          changed = true;
          const sha = H.gitCommitPaths(repoOf(ctx), gp.paths, `stack-update ${id} composer ${t.name}`, (ctx.profile && ctx.profile.branch) || null);
          if (sha) recordCommit(ctx, { scope: root.domain, name: t.name, target: t.target, sha, paths: gp.paths });
          applied.push({ component: `composer:${root.domain}`, name: t.name, target: t.target, commit: sha });
          if (ctx.log) ctx.log.info(`composer ${root.domain}: ${t.name} -> ${t.target}`, { commit: sha });
        } catch (e) {
          if (ctx.log) ctx.log.error(`composer ${root.domain} ${t.name} failed: ${e.message}`);
          refuse(t, e.message);
        }
      }
      if (changed && !root.sameDir) {
        try {
          const owner = sh('stat', ['-c', '%U:%G', root.webDir]).stdout.trim();
          sh('rsync', ['-a', '--delete', `--chown=${owner}`, `${root.repoDir}/vendor/`, `${root.webDir}/vendor/`]);
          sh('rsync', ['-a', `--chown=${owner}`, `${root.repoDir}/composer.json`, `${root.repoDir}/composer.lock`, `${root.webDir}/`]);
          sh(phpCli(ctx), ['-l', path.join(root.webDir, 'vendor', 'autoload.php')]);
        } catch (e) {
          failed.push({ component: `composer:${root.domain}`, name: '(deploy)', reason: e.message });
        }
      }
    }
    return { applied, failed };
  }

  async function restore(entry, ctx) {
    const id = runIdOf(ctx);
    const m = entry.meta || {};
    const root = { domain: entry.scope, repoDir: m.repoDir, webDir: m.webDir, sameDir: m.repoDir && H.real(m.repoDir) === H.real(m.webDir) };
    const commits = ((H.readJson(commitsFile(ctx), { commits: [] }).commits) || []).filter((c) => c.scope === entry.scope).reverse();
    if (ctx.dryRun) {
      return { ok: true, detail: `dry-run: swap vendor back in ${(m.snapshots || []).join(', ')}; revert ${commits.length} commit(s)`, actions: restoreCommands(ctx, root, entry.artifact) };
    }
    const done = [];
    for (const d of m.snapshots || []) { H.swapBack(d, 'vendor', id); done.push(`vendor restored in ${d}`); }
    const reverted = [];
    let revertErr = null;
    for (const c of commits) {
      try { H.gitRevert(repoOf(ctx), c.sha, c.paths); reverted.push(c.sha.slice(0, 10)); } catch (e) { revertErr = e.message; break; }
    }
    const targetsForLock = [];
    if (!commits.length || revertErr) targetsForLock.push(m.repoDir);
    if (!root.sameDir) targetsForLock.push(m.webDir);
    for (const dir of targetsForLock) for (const f of m.files || []) H.copyFile(path.join(entry.artifact, f), path.join(dir, f));
    const lint = D.run(phpCli(ctx), ['-l', path.join(m.webDir, 'vendor', 'autoload.php')]);
    const ok = !revertErr && lint.status === 0;
    return { ok, detail: `${done.join('; ')}; reverted ${reverted.join(', ') || 'none'}${revertErr ? `; revert refused: ${revertErr}` : ''}; lockfiles copied to ${targetsForLock.join(', ') || 'none'}; lint ${lint.status === 0 ? 'ok' : 'FAILED'}` };
  }

  return { name: NAME, backup, apply, restore, roots, targetsByRoot };
}

module.exports = make();
module.exports.make = make;
