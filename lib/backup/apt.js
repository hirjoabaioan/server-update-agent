'use strict';
// apt backup plugin (+ apply/restore helpers). Server-agnostic: every site fact comes from
// ctx.profile (pkgRollbackDir, phpFpmService, nginxJsonLogDir, backupDbScript).
//
// backup(): for every apt target, resolve the set of packages the upgrade would change
//   (apt-get -s), `dpkg-repack` each INSTALLED version into
//   <pkgRollbackDir>/<component>-<installedVersion>-<YYYYMMDD>/, verify each .deb with
//   `dpkg-deb -I`, write manifest.json {package, version, arch, file, sha256}.
//   PPAs often keep only the newest build, so the repack is the only rollback source:
//   any repack failure throws (the core then refuses to apply).
// apply(): only mode=apply-tier-a with a passing window check (ctx.window.ok) and a verified
//   repack for every package in the change set. `apt-get install -y --only-upgrade pkg=ver`;
//   php*: policy-rc.d "exit 101" during install, then `systemctl reload <phpFpmService>`;
//   nginx*: `nginx -t && nginx -s reload`; mariadb*: backupDbScript first, restart expected.
//   5xx counted from <nginxJsonLogDir>/*.json.log in a window before/after the switch.
//   Afterwards `apt-mark hold` the chosen versions (unheld again at the start of the next apply).
// restore(): `dpkg -i <dir>/*.deb`, same graceful reload, re-hold.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const POLICY_RC_D = '/usr/sbin/policy-rc.d';
const APT_ENV = { DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'l', NEEDRESTART_SUSPEND: '1' };

const defaultDeps = {
  run(cmd, args = [], opts = {}) {
    const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) }, maxBuffer: 64 * 1024 * 1024 });
    return { status: r.error ? 127 : r.status, stdout: r.stdout || '', stderr: r.error ? r.error.message : (r.stderr || '') };
  },
  fs,
  sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
  now: () => new Date(),
};

const pad = (n) => String(n).padStart(2, '0');
const dateStamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const sanitize = (v) => String(v).replace(/[^A-Za-z0-9.+~_-]/g, '_');
const noEpoch = (v) => String(v).replace(/^\d+:/, '');
const upstreamOf = (v) => noEpoch(v).replace(/-[^-]*$/, '');

function pkgClass(name) {
  if (/^(mariadb|mysql|galera|libmariadb)/.test(name)) return 'mariadb';
  if (/^nginx/.test(name)) return 'nginx';
  if (/^php(\d|-)/.test(name)) return 'php';
  return 'plain';
}

// Most disruptive class wins: mariadb > php > nginx > plain.
function groupClass(pkgs) {
  const cls = new Set(pkgs.map(pkgClass));
  for (const c of ['mariadb', 'php', 'nginx']) if (cls.has(c)) return c;
  return 'plain';
}

function make(deps = defaultDeps) {
  const D = { ...defaultDeps, ...deps };
  const dfs = D.fs;

  function sh(cmd, args, opts = {}) {
    const r = D.run(cmd, args, opts);
    if (r.status !== 0 && !opts.allowFail) {
      throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
    }
    return r;
  }

  function sha256File(file) {
    return crypto.createHash('sha256').update(dfs.readFileSync(file)).digest('hex');
  }

  function installedVersion(pkg) {
    const r = D.run('dpkg-query', ['-W', '-f=${Version}\t${db:Status-Abbrev}', pkg]);
    if (r.status !== 0) return null;
    const [ver, st] = r.stdout.trim().split('\t');
    return st && st.startsWith('ii') ? ver : null;
  }

  function resolveDebVersion(pkg, t) {
    const want = t.targetDeb || t.debVersion || (t.meta && t.meta.targetDeb) || null;
    if (want) return want;
    if (!t.target) return null;
    const r = sh('apt-cache', ['madison', pkg], { allowFail: true });
    const vers = r.stdout.split('\n').map((l) => (l.split('|')[1] || '').trim()).filter(Boolean);
    return vers.find((v) => v === t.target) || vers.find((v) => upstreamOf(v) === t.target || noEpoch(v) === t.target) || null;
  }

  // apt-get -s => [{ package, from, to }] for every package the install would change.
  function simulate(specs) {
    const r = sh('apt-get', ['-s', 'install', '--only-upgrade', ...specs], { env: APT_ENV });
    const out = [];
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^Inst (\S+) \[([^\]]+)\] \((\S+)/);
      if (m) out.push({ package: m[1], from: m[2], to: m[3] });
    }
    return out;
  }

  function rollbackRoot(ctx) {
    return (ctx.profile && ctx.profile.pkgRollbackDir) || path.join(ctx.run.backupDir, 'pkg-rollback');
  }

  // Plan one target: component dir + packages (installed versions) + install specs.
  function plan(t, ctx) {
    const component = t.component || t.name;
    const names = [t.name, ...(t.packages || [])];
    const installed = installedVersion(t.name);
    if (!installed) throw new Error(`${t.name}: not installed (dpkg-query)`);
    const specs = [];
    let changes = [];
    if (t.target) {
      for (const n of names) {
        const deb = resolveDebVersion(n, n === t.name ? t : { target: t.target });
        if (!deb) throw new Error(`${n}: cannot resolve a .deb version for target ${t.target}`);
        specs.push(`${n}=${deb}`);
      }
      changes = simulate(specs);
    }
    const pkgs = new Map();
    for (const n of names) { const v = installedVersion(n); if (v) pkgs.set(n, { package: n, version: v, to: null }); }
    for (const c of changes) pkgs.set(c.package, { package: c.package, version: c.from, to: c.to });
    const dir = path.join(rollbackRoot(ctx), `${sanitize(component)}-${sanitize(noEpoch(installed))}-${dateStamp(D.now())}`);
    return { component, dir, installed, specs, packages: [...pkgs.values()], cls: groupClass([...pkgs.keys()]) };
  }

  function readManifest(dir) {
    try { return JSON.parse(dfs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { return null; }
  }

  function verifyDeb(file) {
    const r = D.run('dpkg-deb', ['-I', file]);
    if (r.status !== 0) throw new Error(`dpkg-deb -I ${path.basename(file)} failed: ${(r.stderr || '').trim().slice(0, 200)}`);
  }

  // dpkg-repack every package into dir (reusing an already verified .deb of the same version).
  function repack(p, log) {
    dfs.mkdirSync(p.dir, { recursive: true });
    const prev = readManifest(p.dir);
    const done = new Map(((prev && prev.packages) || []).map((x) => [`${x.package}=${x.version}`, x]));
    const out = [];
    for (const pkg of p.packages) {
      const old = done.get(`${pkg.package}=${pkg.version}`);
      if (old && dfs.existsSync(path.join(p.dir, old.file)) && sha256File(path.join(p.dir, old.file)) === old.sha256) {
        verifyDeb(path.join(p.dir, old.file));
        out.push({ ...old, to: pkg.to });
        continue;
      }
      sh('dpkg-repack', [pkg.package], { cwd: p.dir });
      const prefix = `${pkg.package}_${noEpoch(pkg.version)}_`;
      const file = dfs.readdirSync(p.dir).find((f) => f.startsWith(prefix) && f.endsWith('.deb'));
      if (!file) throw new Error(`dpkg-repack ${pkg.package}: no ${prefix}*.deb produced in ${p.dir}`);
      verifyDeb(path.join(p.dir, file));
      const arch = file.slice(prefix.length, -4);
      out.push({ package: pkg.package, version: pkg.version, arch, file, sha256: sha256File(path.join(p.dir, file)), to: pkg.to });
      if (log) log.info(`repacked ${pkg.package} ${pkg.version}`, { file });
    }
    const manifest = { component: p.component, installed: p.installed, created: D.now().toISOString(), packages: out };
    dfs.writeFileSync(path.join(p.dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  }

  function verifyManifest(dir) {
    const m = readManifest(dir);
    if (!m || !Array.isArray(m.packages) || !m.packages.length) throw new Error(`${dir}: missing or empty manifest.json`);
    for (const x of m.packages) {
      const f = path.join(dir, x.file);
      if (!dfs.existsSync(f)) throw new Error(`${dir}: ${x.file} missing`);
      if (sha256File(f) !== x.sha256) throw new Error(`${dir}: sha256 mismatch for ${x.file}`);
    }
    return m;
  }

  // ---------------------------------------------------------------- reload helpers
  async function withPolicyRcD(enabled, fn) {
    if (!enabled) return fn();
    const f = D.policyRcD || POLICY_RC_D;
    const had = dfs.existsSync(f) ? dfs.readFileSync(f) : null;
    dfs.writeFileSync(f, '#!/bin/sh\nexit 101\n', { mode: 0o755 });
    try { return await fn(); } finally {
      if (had !== null) dfs.writeFileSync(f, had, { mode: 0o755 }); else { try { dfs.unlinkSync(f); } catch { /* gone */ } }
    }
  }

  // Graceful reload after a package switch; returns the commands executed.
  function gracefulReload(cls, profile = {}) {
    const cmds = [];
    if (cls === 'php') {
      const svc = profile.phpFpmService;
      if (!svc) throw new Error('profile.phpFpmService is required to reload php-fpm');
      sh('systemctl', ['reload', svc]); cmds.push(`systemctl reload ${svc}`);
    } else if (cls === 'nginx') {
      sh('nginx', ['-t']); cmds.push('nginx -t');
      sh('nginx', ['-s', 'reload']); cmds.push('nginx -s reload');
    } else if (cls === 'mariadb') {
      const r = D.run('systemctl', ['is-active', 'mariadb']);
      cmds.push('systemctl is-active mariadb (restarted by the package; no reload trick)');
      if (r.status !== 0) throw new Error('mariadb not active after package switch');
    }
    return cmds;
  }

  function holds() {
    const r = D.run('apt-mark', ['showhold']);
    return r.status === 0 ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  }

  // ---------------------------------------------------------------- 5xx measurement
  function logOffsets(dir) {
    const out = new Map();
    if (!dir) return out;
    let files = [];
    try { files = dfs.readdirSync(dir).filter((f) => f.endsWith('.json.log')); } catch { return out; }
    for (const f of files) { try { out.set(path.join(dir, f), dfs.statSync(path.join(dir, f)).size); } catch { /* rotated */ } }
    return out;
  }

  function count5xxSince(offsets) {
    let total = 0; let errors = 0;
    for (const [file, off] of offsets) {
      let buf;
      try { buf = dfs.readFileSync(file); } catch { continue; }
      const chunk = buf.length >= off ? buf.subarray(off).toString('utf8') : buf.toString('utf8');
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue;
        try { const rec = JSON.parse(line); total++; if (Number(rec.status) >= 500) errors++; } catch { /* partial line */ }
      }
    }
    return { requests: total, status5xx: errors };
  }

  async function measure5xx(ctx) {
    const secs = (ctx.policy && Number.isFinite(ctx.policy.fivexxWindowSeconds)) ? ctx.policy.fivexxWindowSeconds : 60;
    const off = logOffsets(ctx.profile && ctx.profile.nginxJsonLogDir);
    await D.sleep(secs * 1000);
    return { windowSeconds: secs, ...count5xxSince(off) };
  }

  // ---------------------------------------------------------------- plugin methods
  async function backup(targets, ctx) {
    const entries = [];
    // Targets whose approval names a profile adapter are backed up / restored by that adapter's own
    // backup plugin (e.g. a downgrade or repo switch that `apt-get -s --only-upgrade` cannot plan).
    for (const t of targets.filter((x) => x.ecosystem === 'apt' && !(x.approval && x.approval.adapter))) {
      const p = plan(t, ctx);
      const actions = [
        `mkdir -p ${p.dir}`,
        ...p.packages.map((x) => `(cd ${p.dir} && dpkg-repack ${x.package})   # installed ${x.version}${x.to ? ` -> ${x.to}` : ''}`),
        `dpkg-deb -I ${p.dir}/*.deb`,
        `write ${path.join(p.dir, 'manifest.json')} (package, version, sha256)`,
      ];
      const base = { component: p.component, ecosystem: 'apt', scope: t.scope || null, name: t.name, env: null, artifact: p.dir,
        restoreHint: `dpkg -i ${p.dir}/*.deb && graceful reload (${p.cls})` };
      if (ctx.dryRun) {
        entries.push({ ...base, meta: { dryRun: true, class: p.cls, specs: p.specs, packages: p.packages, actions } });
        continue;
      }
      const m = repack(p, ctx.log);
      entries.push({ ...base, meta: { class: p.cls, specs: p.specs, installed: p.installed, manifest: path.join(p.dir, 'manifest.json'), packages: m.packages } });
    }
    if (ctx.run && ctx.run.dir && !ctx.dryRun) {
      dfs.writeFileSync(path.join(ctx.run.dir, 'backup-apt.json'), JSON.stringify({ entries }, null, 2) + '\n');
    }
    return { entries };
  }

  function backupFor(component, ctx) {
    try {
      const data = JSON.parse(dfs.readFileSync(path.join(ctx.run.dir, 'backup-apt.json'), 'utf8'));
      return (data.entries || []).find((e) => e.component === component) || null;
    } catch { return null; }
  }

  async function apply(targets, ctx) {
    const applied = []; const failed = [];
    const refuse = (t, reason) => failed.push({ component: t.component || t.name, name: t.name, target: t.target, reason });
    for (const t of targets.filter((x) => x.ecosystem === 'apt')) {
      if (ctx.dryRun) { refuse(t, 'dry-run'); continue; }
      if (ctx.mode !== 'apply-tier-a') { refuse(t, `mode ${ctx.mode} never applies`); continue; }
      // Tier B only with an explicit approval (decision action 'approved' + approval entry); never otherwise.
      if (t.tier && t.tier !== 'A' && !(t.tier === 'B' && t.action === 'approved' && t.approval && t.approval.id)) { refuse(t, `tier ${t.tier} without an explicit approval is never applied`); continue; }
      if (!ctx.window || !ctx.window.ok) { refuse(t, `window check did not pass${ctx.window ? `: ${ctx.window.reason}` : ''}`); continue; }
      const log = ctx.log;
      try {
        const p = plan(t, ctx);
        const pending = p.packages.filter((x) => x.to && installedVersion(x.package) !== x.to);
        if (!pending.length) { applied.push({ component: p.component, name: t.name, target: t.target, detail: 'already at target' }); continue; }
        // Rollback source must exist and verify for every package that changes.
        const bk = backupFor(p.component, ctx);
        if (!bk) throw new Error('no repack backup for this component in the run; refusing to apply');
        const m = verifyManifest(bk.artifact);
        const have = new Set(m.packages.map((x) => `${x.package}=${x.version}`));
        const missing = pending.filter((x) => !have.has(`${x.package}=${x.version}`));
        if (missing.length) throw new Error(`repack missing for ${missing.map((x) => x.package).join(', ')}; refusing to apply`);

        const pkgNames = p.packages.map((x) => x.package);
        const downtimeExpected = p.cls === 'mariadb';
        if (downtimeExpected) {
          const script = ctx.profile && ctx.profile.backupDbScript;
          if (!script) throw new Error('mariadb change requires profile.backupDbScript');
          sh(script, []);
          log.warn('mariadb: DB dump done, restart (downtime) expected');
        }
        const held = holds().filter((h) => pkgNames.includes(h));
        if (held.length) sh('apt-mark', ['unhold', ...held]);

        const before = await measure5xx(ctx);
        const off = logOffsets(ctx.profile && ctx.profile.nginxJsonLogDir);
        await withPolicyRcD(p.cls === 'php', async () => {
          sh('apt-get', ['install', '-y', '--only-upgrade', '-o', 'Dpkg::Options::=--force-confold', ...p.specs], { env: APT_ENV });
        });
        const reload = gracefulReload(p.cls, ctx.profile);
        const secs = (ctx.policy && Number.isFinite(ctx.policy.fivexxWindowSeconds)) ? ctx.policy.fivexxWindowSeconds : 60;
        await D.sleep(secs * 1000);
        const after = { windowSeconds: secs, ...count5xxSince(off) };

        const wrong = pending.filter((x) => installedVersion(x.package) !== x.to);
        if (wrong.length) throw new Error(`version mismatch after install: ${wrong.map((x) => x.package).join(', ')}`);
        sh('apt-mark', ['hold', ...pkgNames]);
        const res = { component: p.component, name: t.name, target: t.target, specs: p.specs, reload, downtimeExpected, fivexx: { before, after }, held: pkgNames };
        log.info(`applied ${p.specs.join(' ')}`, res);
        applied.push(res);
      } catch (e) {
        log.error(`apply ${t.name} failed: ${e.message}`);
        refuse(t, e.message);
      }
    }
    return { applied, failed };
  }

  async function restore(entry, ctx) {
    const dir = entry.artifact;
    const m = verifyManifest(dir);
    const files = m.packages.map((x) => path.join(dir, x.file)).sort();
    const pkgNames = m.packages.map((x) => x.package);
    const cls = groupClass(pkgNames);
    if (ctx.dryRun) return { ok: true, detail: `dry-run: dpkg -i ${files.length} debs from ${dir}, reload ${cls}, re-hold`, actions: [`dpkg -i ${files.join(' ')}`] };
    const held = holds().filter((h) => pkgNames.includes(h));
    if (held.length) sh('apt-mark', ['unhold', ...held]);
    await withPolicyRcD(cls === 'php', async () => { sh('dpkg', ['-i', ...files], { env: APT_ENV }); });
    const reload = gracefulReload(cls, ctx.profile);
    const wrong = m.packages.filter((x) => installedVersion(x.package) !== x.version);
    if (wrong.length) return { ok: false, detail: `version mismatch after dpkg -i: ${wrong.map((x) => x.package).join(', ')}` };
    sh('apt-mark', ['hold', ...pkgNames]);
    return { ok: true, detail: `reinstalled ${m.packages.map((x) => `${x.package}=${x.version}`).join(', ')}; ${reload.join('; ') || 'no reload needed'}; held` };
  }

  return {
    name: 'apt', backup, apply, restore,
    // helpers (used by bundle.js, bin/stack-restore-bundle and tests)
    plan, simulate, repack, verifyManifest, gracefulReload, withPolicyRcD, count5xxSince, logOffsets, sha256File, holds,
  };
}

module.exports = make();
module.exports.make = make;
module.exports.pkgClass = pkgClass;
module.exports.groupClass = groupClass;
module.exports.POLICY_RC_D = POLICY_RC_D;
