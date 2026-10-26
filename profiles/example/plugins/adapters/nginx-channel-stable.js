'use strict';
// Profile adapter "nginx-channel-stable": nginx.org mainline -> stable channel switch (downgrade).
// Selected by an approval with adapter "nginx-channel-stable" (lib/cli.js stageApply); the same
// object is also loaded as a backup plugin (plugins/backup/nginx-channel-stable.js) so the core's
// backup/restore stages own the rollback of exactly these targets (lib/backup/apt.js skips
// adapter-owned targets). All host work is done by adapters/nginx-channel-stable.sh:
//   plan | backup --backup-dir D | apply --target T --backup-dir D | verify --target T | rollback --backup-dir D
const path = require('path');
const { execFile } = require('child_process');

const NAME = 'nginx-channel-stable';

const defaultDeps = {
  exec(file, args, opts = {}) {
    return new Promise((resolve) => {
      execFile(file, args, { encoding: 'utf8', timeout: opts.timeoutMs || 900000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...(opts.env || {}) } },
        (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '', stderr: stderr || (err && !stdout ? err.message : '') }));
    });
  },
};

// "PLAN key=value" / "PIN line" / "CMD command" / "SIM line" -> structured plan.
function parsePlan(text) {
  const out = { plan: {}, pin: [], cmds: [], sim: [] };
  for (const line of String(text || '').split('\n')) {
    let m;
    if ((m = line.match(/^PLAN ([\w.]+)=(.*)$/))) out.plan[m[1]] = m[2];
    else if ((m = line.match(/^PIN (.*)$/))) out.pin.push(m[1]);
    else if ((m = line.match(/^CMD (.*)$/))) out.cmds.push(m[1]);
    else if ((m = line.match(/^SIM (.*)$/))) out.sim.push(m[1]);
  }
  out.installCmd = out.cmds.find((c) => / install -y --allow-downgrades /.test(c)) || null;
  out.pinContent = out.pin.join('\n');
  return out;
}

const owns = (t) => !!(t && t.approval && t.approval.adapter === NAME);
const lastLines = (s, n = 6) => String(s || '').trim().split('\n').slice(-n).join(' | ');

function make(deps = defaultDeps) {
  const D = { ...defaultDeps, ...deps };
  const script = (ctx) => {
    const rel = (ctx.profile && ctx.profile.adapterScripts && ctx.profile.adapterScripts[NAME]) || `adapters/${NAME}.sh`;
    return path.isAbsolute(rel) ? rel : path.join(ctx.profileDir || path.join(__dirname, '..', '..'), rel);
  };
  const sh = (ctx, args) => D.exec('bash', [script(ctx), ...args]);
  const backupDir = (ctx) => path.join((ctx.run && ctx.run.backupDir) || '/tmp', NAME);

  async function plan(ctx, target) {
    const r = await sh(ctx, ['plan', ...(target ? ['--target', target] : [])]);
    if (r.code !== 0) throw new Error(`plan failed (${r.code}): ${lastLines(r.stderr || r.stdout)}`);
    return parsePlan(r.stdout);
  }

  async function backup(targets, ctx) {
    const entries = [];
    for (const t of targets.filter(owns)) {
      const dir = backupDir(ctx);
      const r = await sh(ctx, ['backup', '--backup-dir', dir, ...(ctx.dryRun ? ['--dry-run'] : [])]);
      if (r.code !== 0) throw new Error(`backup failed (${r.code}): ${lastLines(r.stderr || r.stdout)}`);
      entries.push({
        component: `apt:${(t.meta && t.meta.group) || t.name}`, ecosystem: 'apt', scope: t.scope || null, name: t.name, env: null,
        artifact: dir, restoreHint: `bash ${script(ctx)} rollback --backup-dir ${dir}`,
        meta: { adapter: NAME, dryRun: !!ctx.dryRun, target: t.target, output: r.stdout.trim().split('\n') },
      });
    }
    return { entries };
  }

  async function apply(targets, ctx) {
    const applied = []; const failed = [];
    for (const t of targets.filter(owns)) {
      const refuse = (reason) => failed.push({ component: `apt:${t.name}`, name: t.name, target: t.target, reason });
      if (ctx.dryRun) { refuse('dry-run'); continue; }
      if (ctx.mode !== 'apply-tier-a') { refuse(`mode ${ctx.mode} never applies`); continue; }
      if (!(t.tier === 'B' && t.action === 'approved' && t.approval && t.approval.id)) { refuse('no explicit tier-B approval'); continue; }
      if (!ctx.window || !ctx.window.ok) { refuse(`window check did not pass${ctx.window ? `: ${ctx.window.reason}` : ''}`); continue; }
      const dir = backupDir(ctx);
      try {
        const p = await plan(ctx, t.target);
        ctx.log.info(`${NAME} plan`, p.plan);
        const ap = await sh(ctx, ['apply', '--target', t.target, '--backup-dir', dir]);
        if (ap.code !== 0) throw new Error(`apply failed (${ap.code}): ${lastLines(ap.stderr || ap.stdout)}`);
        const vr = await sh(ctx, ['verify', '--target', t.target]);
        if (vr.code !== 0) {
          const rb = await sh(ctx, ['rollback', '--backup-dir', dir]);
          throw new Error(`verify failed: ${lastLines(vr.stdout, 10)}; rollback ${rb.code === 0 ? 'ok' : `FAILED: ${lastLines(rb.stderr || rb.stdout)}`}`);
        }
        const res = { component: `apt:${t.name}`, name: t.name, target: t.target, from: p.plan.installed || t.installed, adapter: NAME,
          source: p.plan['source.new'], pinFile: p.plan['pin.file'], apply: ap.stdout.trim().split('\n').slice(-5), verify: vr.stdout.trim().split('\n') };
        ctx.log.info(`${NAME} applied ${t.target}`, res);
        applied.push(res);
      } catch (e) {
        ctx.log.error(`${NAME} ${t.name}: ${e.message}`);
        refuse(e.message);
      }
    }
    return { applied, failed };
  }

  async function restore(entry, ctx) {
    if (entry.meta && entry.meta.dryRun) return { ok: true, detail: 'dry-run entry, nothing to restore' };
    const r = await sh(ctx, ['rollback', '--backup-dir', entry.artifact]);
    return { ok: r.code === 0, detail: lastLines(r.code === 0 ? r.stdout : (r.stderr || r.stdout)) };
  }

  return { name: NAME, plan, backup, apply, restore, parsePlan, owns };
}

module.exports = make();
module.exports.make = make;
module.exports.parsePlan = parsePlan;
