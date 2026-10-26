'use strict';
// bundle backup plugin: one self-contained, checksummed rollback bundle per run at
//   <stateDir>/runs/<run-id>/bundle/
//     debs/<component-dir>/   copies of the apt plugin's dpkg-repack dirs (.deb + manifest.json)
//     archives/<name>.tar.gz  config trees (default "etc": nginx, php, mysql, systemd units, apt
//                             sources/preferences) + profile.bundle.archives (e.g. panel web conf)
//     state/                  dpkg --get-selections, apt-mark showhold
//     app/                    app backups of the run (lockfiles, vendor/node_modules archives)
//     files/                  profile.bundle.files (e.g. vendor manifests), if present
//     db/                     fresh dump via profile.backupDbScript when the run touches the DB
//     bundle.json             restore map (consumed by bin/stack-restore-bundle)
//     MANIFEST.sha256         sha256sum-compatible list of every file above
// Then each profile.backupTargets[] adapter is executed: `<script> <bundleDir> <dest-name>`
// (script path relative to the profile dir). Upload failure = warning; the local copy stays.
// Server-agnostic: all site paths come from the profile.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const apt = require('./apt');

const DEFAULT_ETC = ['/etc/nginx', '/etc/php', '/etc/mysql', '/etc/systemd/system',
  '/etc/apt/sources.list', '/etc/apt/sources.list.d', '/etc/apt/preferences', '/etc/apt/preferences.d'];

const defaultDeps = {
  run(cmd, args = [], opts = {}) {
    const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) }, maxBuffer: 256 * 1024 * 1024 });
    return { status: r.error ? 127 : r.status, stdout: r.stdout || '', stderr: r.error ? r.error.message : (r.stderr || '') };
  },
  fs,
  now: () => new Date(),
};

// Minimal glob: '*' matches one path segment (no '**').
function expandGlob(pattern, dfs = fs) {
  if (!pattern.includes('*')) return dfs.existsSync(pattern) ? [pattern] : [];
  const parts = pattern.split('/');
  let acc = [parts[0] === '' ? '/' : parts[0]];
  for (const seg of parts.slice(1)) {
    if (!seg) continue;
    const next = [];
    for (const base of acc) {
      if (!seg.includes('*')) { const p = path.join(base, seg); if (dfs.existsSync(p)) next.push(p); continue; }
      const re = new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
      let names = [];
      try { names = dfs.readdirSync(base); } catch { /* not a dir */ }
      for (const n of names.sort()) if (re.test(n)) next.push(path.join(base, n));
    }
    acc = next;
  }
  return acc;
}

function walkFiles(dir, dfs = fs, rel = '') {
  const out = [];
  for (const e of dfs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...walkFiles(dir, dfs, r));
    else if (e.isFile()) out.push(r);
  }
  return out.sort();
}

const sha256File = (file, dfs = fs) => crypto.createHash('sha256').update(dfs.readFileSync(file)).digest('hex');

function writeManifest(dir, dfs = fs) {
  const files = walkFiles(dir, dfs).filter((f) => f !== 'MANIFEST.sha256');
  const body = files.map((f) => `${sha256File(path.join(dir, f), dfs)}  ${f}`).join('\n') + '\n';
  dfs.writeFileSync(path.join(dir, 'MANIFEST.sha256'), body);
  return files.length;
}

// => { ok, checked, errors[] }; every listed file must match and no unlisted file may exist.
function verifyManifest(dir, dfs = fs) {
  const errors = [];
  let lines;
  try { lines = dfs.readFileSync(path.join(dir, 'MANIFEST.sha256'), 'utf8').split('\n').filter(Boolean); } catch (e) {
    return { ok: false, checked: 0, errors: [`MANIFEST.sha256 unreadable: ${e.message}`] };
  }
  const listed = new Set();
  for (const l of lines) {
    const m = l.match(/^([0-9a-f]{64}) {2}(.+)$/);
    if (!m) { errors.push(`bad manifest line: ${l}`); continue; }
    listed.add(m[2]);
    const f = path.join(dir, m[2]);
    if (!dfs.existsSync(f)) errors.push(`missing: ${m[2]}`);
    else if (sha256File(f, dfs) !== m[1]) errors.push(`sha256 mismatch: ${m[2]}`);
  }
  for (const f of walkFiles(dir, dfs)) if (f !== 'MANIFEST.sha256' && !listed.has(f)) errors.push(`not in manifest: ${f}`);
  return { ok: errors.length === 0, checked: listed.size, errors };
}

function make(deps = defaultDeps) {
  const D = { ...defaultDeps, ...deps };
  const dfs = D.fs;

  function sh(cmd, args, opts = {}) {
    const r = D.run(cmd, args, opts);
    const okCodes = opts.okCodes || [0];
    if (!okCodes.includes(r.status)) throw new Error(`${cmd} ${args.slice(0, 6).join(' ')} failed (${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    return r;
  }

  function settings(ctx) {
    const b = (ctx.profile && ctx.profile.bundle) || {};
    const archives = [{ name: 'etc', paths: b.etcPaths || DEFAULT_ETC }, ...(b.archives || [])];
    return { archives, files: b.files || [], dbDumpDir: b.dbDumpDir || null };
  }

  function needsDb(targets) {
    return targets.some((t) => t.ecosystem === 'mariadb' || t.schemaRelevant
      || (t.ecosystem === 'apt' && apt.pkgClass(t.name) === 'mariadb'));
  }

  function aptEntries(ctx) {
    try { return JSON.parse(dfs.readFileSync(path.join(ctx.run.dir, 'backup-apt.json'), 'utf8')).entries || []; } catch { return []; }
  }

  function plan(targets, ctx) {
    const s = settings(ctx);
    const archives = s.archives.map((a) => ({ name: a.name, paths: a.paths.flatMap((p) => expandGlob(p, dfs)) }));
    const files = s.files.map((f) => (ctx.repoPath ? ctx.repoPath(f) : f)).filter((f) => dfs.existsSync(f));
    return { dir: path.join(ctx.run.dir, 'bundle'), archives, files, db: needsDb(targets), dbDumpDir: s.dbDumpDir };
  }

  function uploads(dir, name, ctx) {
    const out = [];
    if (process.env.STACK_UPDATER_NO_UPLOAD === '1') return [{ target: '*', skipped: 'STACK_UPDATER_NO_UPLOAD=1' }];
    for (const t of (ctx.profile && ctx.profile.backupTargets) || []) {
      const script = path.isAbsolute(t.script) ? t.script : path.join(ctx.profileDir, t.script);
      const r = D.run(script, [dir, name], t.remote ? { env: { STACK_UPDATES_REMOTE: t.remote } } : {});
      const res = { target: t.name || t.script, ok: r.status === 0, detail: (r.status === 0 ? r.stdout : r.stderr || r.stdout).trim().slice(-500) };
      if (!res.ok) ctx.log.warn(`upload ${res.target} failed (local bundle kept)`, res);
      out.push(res);
    }
    return out;
  }

  async function backup(targets, ctx) {
    if (!targets.length) return { entries: [] };
    const p = plan(targets, ctx);
    const base = { component: 'bundle', ecosystem: 'bundle', scope: null, name: 'bundle', env: null, artifact: p.dir,
      restoreHint: `stack-restore-bundle ${ctx.run.id} [component] (verifies MANIFEST.sha256)` };
    const remoteTargets = ((ctx.profile && ctx.profile.backupTargets) || []).map((t) => t.name || t.script);
    if (ctx.dryRun) {
      return { entries: [{ ...base, meta: { dryRun: true, archives: p.archives, files: p.files, db: p.db, uploads: remoteTargets,
        actions: ['copy apt repack dirs -> debs/', ...p.archives.map((a) => `tar czf archives/${a.name}.tar.gz -C / ${a.paths.map((x) => x.replace(/^\//, '')).join(' ')}`),
          'dpkg --get-selections > state/dpkg-selections.txt', 'apt-mark showhold > state/apt-mark-showhold.txt',
          ...(p.db ? ['run profile.backupDbScript -> db/'] : []), 'write MANIFEST.sha256', ...remoteTargets.map((t) => `upload via ${t}`)] } }] };
    }
    dfs.rmSync(p.dir, { recursive: true, force: true });
    for (const d of ['debs', 'archives', 'state']) dfs.mkdirSync(path.join(p.dir, d), { recursive: true });
    const map = { runId: ctx.run.id, created: D.now().toISOString(), debs: [], archives: [], files: [], app: null, db: [] };

    for (const e of aptEntries(ctx)) {
      const name = path.basename(e.artifact);
      dfs.cpSync(e.artifact, path.join(p.dir, 'debs', name), { recursive: true });
      map.debs.push({ dir: `debs/${name}`, component: e.component, class: e.meta && e.meta.class, origin: e.artifact });
    }
    for (const a of p.archives) {
      if (!a.paths.length) continue;
      const file = `archives/${a.name}.tar.gz`;
      // tar exit 1 = "file changed as we read it" (logs etc.) — archive is still usable.
      sh('tar', ['czf', path.join(p.dir, file), '-C', '/', ...a.paths.map((x) => x.replace(/^\//, ''))], { okCodes: [0, 1] });
      map.archives.push({ name: a.name, file, paths: a.paths.map((x) => ({ path: x, dir: dfs.statSync(x).isDirectory() })) });
    }
    dfs.writeFileSync(path.join(p.dir, 'state', 'dpkg-selections.txt'), sh('dpkg', ['--get-selections']).stdout);
    dfs.writeFileSync(path.join(p.dir, 'state', 'apt-mark-showhold.txt'), sh('apt-mark', ['showhold']).stdout);

    if (ctx.run.backupDir && dfs.existsSync(ctx.run.backupDir) && dfs.readdirSync(ctx.run.backupDir).length) {
      dfs.mkdirSync(path.join(p.dir, 'app'), { recursive: true });
      sh('tar', ['czf', path.join(p.dir, 'app', 'app-backups.tar.gz'), '-C', ctx.run.backupDir, '.']);
      map.app = { file: 'app/app-backups.tar.gz', origin: ctx.run.backupDir };
    }
    if (p.files.length) {
      dfs.mkdirSync(path.join(p.dir, 'files'), { recursive: true });
      for (const f of p.files) {
        const rel = `files/${f.replace(/^\//, '').replace(/\//g, '__')}`;
        dfs.copyFileSync(f, path.join(p.dir, rel));
        map.files.push({ file: rel, origin: f });
      }
    }
    if (p.db) {
      const script = ctx.profile && ctx.profile.backupDbScript;
      if (!script) throw new Error('DB-relevant change in the run but profile.backupDbScript is not set');
      const startMs = Date.now() - 1000;
      sh(script, []);
      dfs.mkdirSync(path.join(p.dir, 'db'), { recursive: true });
      if (p.dbDumpDir) {
        for (const f of dfs.readdirSync(p.dbDumpDir)) {
          const full = path.join(p.dbDumpDir, f);
          if (dfs.statSync(full).mtimeMs >= startMs) { dfs.copyFileSync(full, path.join(p.dir, 'db', f)); map.db.push({ file: `db/${f}`, origin: full }); }
        }
      }
    }
    dfs.writeFileSync(path.join(p.dir, 'bundle.json'), JSON.stringify(map, null, 2) + '\n');
    const count = writeManifest(p.dir, dfs);
    ctx.log.info(`bundle built: ${count} files`, { dir: p.dir });
    const up = uploads(p.dir, ctx.run.id, ctx);
    return { entries: [{ ...base, meta: { files: count, debs: map.debs.length, archives: map.archives.map((a) => a.name), db: map.db.length, uploads: up } }] };
  }

  // A bundle is a disaster-recovery artifact: per-component rollback restores via the apt/app
  // plugins; the full bundle is restored explicitly with bin/stack-restore-bundle.
  async function restore(entry) {
    return { ok: true, detail: `bundle not auto-restored; use: stack-restore-bundle ${entry.artifact}` };
  }

  return { name: 'bundle', backup, restore, plan };
}

module.exports = make();
module.exports.make = make;
module.exports.expandGlob = expandGlob;
module.exports.writeManifest = writeManifest;
module.exports.verifyManifest = verifyManifest;
module.exports.walkFiles = walkFiles;
module.exports.DEFAULT_ETC = DEFAULT_ETC;
