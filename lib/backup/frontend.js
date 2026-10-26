'use strict';
// frontend (vendored JS/CSS) backup plugin (+ apply/restore). Server-agnostic: the manifest path
// comes from profile.frontend.manifest or the first TEST web root
// (<repoPath>/public_html/assets/vendor/manifest.json); the deploy step is profile.syncScript.
//
// manifest.json: { libs: { <name>: { active: '<ver>', versions: { '<ver>': { files: [{ path, sri }] } } } } }
// The versioned folders/files are added by the manifest phase; this plugin only moves pointers.
// backup(): copy manifest.json to <run>/frontend/manifest.json.
// apply() (mode apply-tier-a, not dry-run, env test ONLY — prod gets the manifest through the
//   normal promotion): set libs[<name>].active = <target> (the version must already exist in
//   versions{} and its files on disk), write the manifest, run profile.syncScript.
// restore(): write the saved manifest back + run the sync script.
const path = require('path');
const A = require('./_app');

function make(deps = {}) {
  const H = A.make(deps);
  const { sh, D } = H;
  const NAME = 'frontend';

  function manifestPath(ctx) {
    const cfg = (ctx.profile && ctx.profile.frontend) || {};
    if (cfg.manifest) return ctx.repoPath ? ctx.repoPath(cfg.manifest) : cfg.manifest;
    const root = ((ctx.profile && ctx.profile.webRoots) || []).find((r) => r.env === 'test');
    if (!root) return null;
    return path.join(ctx.repoPath ? ctx.repoPath(root.repoPath) : root.repoPath, 'public_html', 'assets', 'vendor', 'manifest.json');
  }
  const savedPath = (ctx) => path.join(ctx.run.dir, 'frontend', 'manifest.json');
  const syncCmd = (ctx) => (ctx.profile && ctx.profile.syncScript ? ['bash', [ctx.profile.syncScript]] : null);
  const ours = (targets) => targets.filter((t) => t.ecosystem === 'vendor-js' && t.name && !t.name.startsWith('('));

  function libKey(manifest, name) {
    const libs = (manifest && manifest.libs) || {};
    if (libs[name]) return name;
    return Object.keys(libs).find((k) => libs[k] && (libs[k].npm === name || libs[k].package === name)) || null;
  }

  // Pure: new manifest with the pointers moved; throws when a version/folder is missing.
  function rewrite(manifest, targets, baseDir = null) {
    const next = JSON.parse(JSON.stringify(manifest));
    const changes = [];
    for (const t of targets) {
      const k = libKey(next, t.name);
      if (!k) throw new Error(`manifest has no library "${t.name}"`);
      const lib = next.libs[k];
      const v = lib.versions && lib.versions[t.target];
      if (!v) throw new Error(`${k}: version ${t.target} not present in manifest versions (add it in the manifest phase first)`);
      if (baseDir) {
        // schema 1 lists files per kind (css/js/assets); older drafts used files[]
        for (const f of ['files', 'css', 'js', 'assets'].flatMap((k) => (Array.isArray(v[k]) ? v[k] : []))) {
          if (!H.exists(path.join(baseDir, f.path))) throw new Error(`${k}@${t.target}: ${f.path} missing on disk`);
        }
      }
      if (lib.active === t.target) continue;
      changes.push({ name: k, from: lib.active || null, to: t.target });
      lib.active = t.target;
      if ('version' in lib) lib.version = t.target;
    }
    return { manifest: next, changes };
  }

  async function backup(targets, ctx) {
    const ts = ours(targets);
    if (!ts.length) return { entries: [] };
    const mf = manifestPath(ctx);
    const dst = savedPath(ctx);
    const base = {
      component: 'frontend:manifest', ecosystem: 'vendor-js', scope: 'assets/vendor', name: '(manifest)', env: 'test', artifact: dst,
      restoreHint: `cp ${dst} ${mf} && sync`,
    };
    const meta = { manifest: mf, libs: ts.map((t) => ({ name: t.name, installed: t.installed || null, target: t.target || null })) };
    if (ctx.dryRun) {
      const sc = syncCmd(ctx);
      let changes = null;
      const cur = H.readJson(mf, null);
      if (cur) { try { changes = rewrite(cur, ts.filter((t) => t.target)).changes; } catch (e) { changes = { error: e.message }; } }
      return { entries: [{ ...base, meta: { ...meta, dryRun: true, manifestExists: !!cur,
        actions: [`mkdir -p ${path.dirname(dst)}`, A.cmdLine('cp', [mf, dst])],
        applyPlan: [...ts.filter((t) => t.target).map((t) => `set libs["${t.name}"].active = "${t.target}" in ${mf}`), sc ? `${A.cmdLine(...sc)}   # env test only` : '# no syncScript'],
        changes,
        restorePlan: [A.cmdLine('cp', [dst, mf]), sc ? A.cmdLine(...sc) : '# no syncScript'] } }] };
    }
    if (!mf || !H.exists(mf)) throw new Error(`frontend manifest ${mf || '(none)'} missing; refusing to back up vendor-js targets`);
    H.copyFile(mf, dst);
    return { entries: [{ ...base, meta }] };
  }

  async function apply(targets, ctx) {
    const applied = []; const failed = [];
    const ts = ours(targets);
    if (!ts.length) return { applied, failed };
    const refuseAll = (reason) => ts.forEach((t) => failed.push({ component: 'frontend:manifest', name: t.name, target: t.target, reason }));
    const gate = H.applyGate(ctx);
    if (gate) { refuseAll(gate); return { applied, failed }; }
    if (ctx.env !== 'test') { if (ctx.env) ts.forEach((t) => applied.push({ component: 'frontend:manifest', name: t.name, target: t.target, detail: `env ${ctx.env}: manifest reaches prod via promotion, not here` })); return { applied, failed }; }
    if (!H.runEntries(ctx, NAME).length || !H.exists(savedPath(ctx))) { refuseAll('no saved manifest in this run; refusing to apply'); return { applied, failed }; }
    try {
      const mf = manifestPath(ctx);
      const cur = H.readJson(mf, null);
      if (!cur) throw new Error(`${mf} unreadable`);
      const { manifest, changes } = rewrite(cur, ts.filter((t) => t.target), path.dirname(mf));
      if (changes.length) {
        D.fs.writeFileSync(mf, JSON.stringify(manifest, null, 2) + '\n');
        const sc = syncCmd(ctx);
        if (sc) sh(...sc, { timeout: 10 * 60 * 1000 });
      }
      for (const t of ts) applied.push({ component: 'frontend:manifest', name: t.name, target: t.target, detail: changes.find((c) => c.name === t.name) ? 'pointer moved' : 'already active' });
    } catch (e) {
      refuseAll(e.message);
    }
    return { applied, failed };
  }

  async function restore(entry, ctx) {
    const mf = (entry.meta && entry.meta.manifest) || manifestPath(ctx);
    const sc = syncCmd(ctx);
    if (ctx.dryRun) return { ok: true, detail: `dry-run: write ${entry.artifact} back to ${mf} and sync`, actions: [A.cmdLine('cp', [entry.artifact, mf]), sc ? A.cmdLine(...sc) : '# no syncScript'] };
    if (!H.exists(entry.artifact)) return { ok: false, detail: `${entry.artifact} missing` };
    H.copyFile(entry.artifact, mf);
    if (sc) sh(...sc, { timeout: 10 * 60 * 1000 });
    return { ok: true, detail: `manifest restored to ${mf}${sc ? '; synced' : ''}` };
  }

  return { name: NAME, backup, apply, restore, manifestPath, rewrite };
}

module.exports = make();
module.exports.make = make;
