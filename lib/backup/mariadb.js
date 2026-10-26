'use strict';
// mariadb backup plugin (+ apply guard / restore). Server-agnostic: site facts come from
// ctx.profile (backupDbScript, appBackup.{mariadbTestDb, snapshotConfirmFlag}).
//
// Targets: ecosystem "mariadb" items and apt items of the mariadb package family.
// backup(): run profile.backupDbScript (full production dump) AND
//   `mariadb-dump --single-transaction --quick <mariadbTestDb> | gzip` into <run>/db/,
//   verified with `gzip -t` and a non-empty size.
// apply() (ecosystem "mariadb" only; apt packages go through the apt applier):
//   patch  -> refused here (handled by the apt applier with its repack + DB dump rails);
//   minor/major -> refused unless the confirm flag (--<appBackup.snapshotConfirmFlag>) is set,
//   which certifies that a provider-level disk snapshot was taken by hand; then delegated to the
//   apt applier (which still requires its own repack backup + maintenance window).
// restore(): never downgrades data dirs. Returns the dump locations for a manual re-import.
const path = require('path');
const A = require('./_app');
const apt = require('./apt');
const semver = require('../core/semver');

function make(deps = {}) {
  const H = A.make(deps);
  const { sh, D } = H;
  const NAME = 'mariadb';

  const cfgOf = (ctx) => (ctx.profile && ctx.profile.appBackup) || {};
  const runIdOf = (ctx) => (ctx.run && ctx.run.id) || 'norun';
  const flagName = (ctx) => cfgOf(ctx).snapshotConfirmFlag || 'snapshot-confirmed';
  const confirmed = (ctx) => !!((ctx.flags && ctx.flags[flagName(ctx)]) || process.env.STACK_UPDATER_SNAPSHOT_CONFIRMED === '1');

  const isMariadb = (t) => t.ecosystem === 'mariadb' || (t.ecosystem === 'apt' && (apt.pkgClass(t.name) === 'mariadb' || t.component === 'mariadb'));

  function dumpCmd(db, file) {
    return ['bash', ['-o', 'pipefail', '-c', 'mariadb-dump --single-transaction --quick --routines --triggers "$1" | gzip > "$2"', 'dump', db, file]];
  }

  async function backup(targets, ctx) {
    const ts = targets.filter(isMariadb);
    if (!ts.length) return { entries: [] };
    const script = ctx.profile && ctx.profile.backupDbScript;
    const testDb = cfgOf(ctx).mariadbTestDb || null;
    const dir = path.join(ctx.run.dir, 'db');
    const file = testDb ? path.join(dir, `${A.sanitize(testDb)}-${A.sanitize(runIdOf(ctx))}.sql.gz`) : null;
    const base = {
      component: 'mariadb:dumps', ecosystem: 'mariadb', scope: null, name: '(dumps)', env: null, artifact: dir,
      restoreHint: 'manual re-import only (gunzip -c <dump> | mariadb <db>); data dirs are never downgraded',
    };
    const meta = { components: ts.map((t) => `${t.ecosystem}:${t.name}`), backupDbScript: script || null, testDb, testDump: file };
    const actions = [
      script ? A.cmdLine(script) + '   # full dump (profile.backupDbScript)' : '# no profile.backupDbScript',
      `mkdir -p ${dir}`,
      file ? `mariadb-dump --single-transaction --quick --routines --triggers ${testDb} | gzip > ${file}` : '# no appBackup.mariadbTestDb',
      file ? `gzip -t ${file}` : null,
    ].filter(Boolean);
    if (ctx.dryRun) return { entries: [{ ...base, meta: { ...meta, dryRun: true, actions } }] };
    if (!script) throw new Error('mariadb backup requires profile.backupDbScript');
    const r = sh(script, [], { timeout: 60 * 60 * 1000 });
    meta.backupDbScriptOutput = r.stdout.trim().slice(-400);
    if (file) {
      D.fs.mkdirSync(dir, { recursive: true });
      sh(...dumpCmd(testDb, file), { timeout: 60 * 60 * 1000 });
      sh('gzip', ['-t', file]);
      const size = D.fs.statSync(file).size;
      if (!size) throw new Error(`${file} is empty`);
      meta.testDumpBytes = size;
    }
    return { entries: [{ ...base, meta }] };
  }

  async function apply(targets, ctx) {
    const applied = []; const failed = [];
    const ts = targets.filter((t) => t.ecosystem === 'mariadb');
    const gate = H.applyGate(ctx);
    const delegate = [];
    for (const t of ts) {
      const refuse = (reason) => failed.push({ component: `mariadb:${t.name}`, name: t.name, target: t.target, reason });
      if (gate) { refuse(gate); continue; }
      const kind = t.installed && t.target ? semver.diffType(t.installed, t.target) : null;
      if (kind === 'downgrade') { refuse('downgrade refused: data dirs are never downgraded'); continue; }
      if (kind === 'patch' || kind === null) { refuse('patch updates go through the apt applier (repack + DB dump rails)'); continue; }
      if (!confirmed(ctx)) { refuse(`${kind} upgrade refused: take a provider disk snapshot by hand, then rerun with --${flagName(ctx)}`); continue; }
      delegate.push({ ...t, ecosystem: 'apt', name: t.name || 'mariadb-server', component: 'mariadb' });
    }
    if (delegate.length) {
      const r = await apt.apply(delegate, ctx);
      applied.push(...r.applied); failed.push(...r.failed);
    }
    return { applied, failed };
  }

  async function restore(entry) {
    const m = entry.meta || {};
    return { ok: true, manual: true, detail: `no automatic data restore (data dirs are never downgraded). Dumps: ${[m.testDump, m.backupDbScript ? `output of ${m.backupDbScript}` : null].filter(Boolean).join('; ')}` };
  }

  return { name: NAME, backup, apply, restore, isMariadb, confirmed };
}

module.exports = make();
module.exports.make = make;
