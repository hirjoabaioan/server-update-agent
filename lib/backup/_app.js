'use strict';
// Shared helpers for the application-level backup plugins (composer / npm / frontend / mariadb).
// Files starting with "_" are not loaded as plugins. Server-agnostic: every site fact comes from
// ctx.profile. All host access goes through deps.run / deps.fs so tests can mock the shell.
//
// Directory snapshot ("prev swap"):
//   backup : cp -a <dir>/<name> <dir>/<name>.prev-<run>.tmp && mv ... <name>.prev-<run>
//            (the live <name> is never moved away, so the running site keeps working; the
//            snapshot is equivalent to `mv <name> <name>.prev && cp -a <name>.prev <name>`
//            without the window in which <name> is missing)
//   restore: mv <name> <name>.failed-<run> && mv <name>.prev-<run> <name> && rm -rf <name>.failed-<run>
//   prune  : keep at most `keep` (default 2) <name>.prev-* dirs per parent dir.
// Git: staging is ALWAYS path-scoped (`git add -- <paths>` + `git commit -- <paths>`).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');

const defaultDeps = {
  run(cmd, args = [], opts = {}) {
    const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) }, maxBuffer: 256 * 1024 * 1024, timeout: opts.timeout || 0 });
    return { status: r.error ? 127 : r.status, stdout: r.stdout || '', stderr: r.error ? r.error.message : (r.stderr || '') };
  },
  fs,
  now: () => new Date(),
  sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
  whoami: () => { try { return os.userInfo().username; } catch { return null; } },
  httpStatus(url, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const mod = url.startsWith('https:') ? https : http;
      const req = mod.get(url, { timeout: timeoutMs }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('timeout', () => { req.destroy(); resolve(0); });
      req.on('error', () => resolve(0));
    });
  },
};

const sanitize = (v) => String(v).replace(/[^A-Za-z0-9.+~_@-]/g, '_');
const q = (s) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(String(s)) ? String(s) : `'${String(s).replace(/'/g, `'\\''`)}'`);
const cmdLine = (cmd, args = []) => [cmd, ...args].map(q).join(' ');

function make(deps = {}) {
  const D = { ...defaultDeps, ...deps };
  const dfs = D.fs;

  function sh(cmd, args = [], opts = {}) {
    const r = D.run(cmd, args, opts);
    if (r.status !== 0 && !opts.allowFail) {
      throw new Error(`${cmdLine(cmd, args)} failed (${r.status}): ${(r.stderr || r.stdout || '').trim().slice(0, 400)}`);
    }
    return r;
  }

  // Run as `user` (sudo -n -u <user> -H) unless that is the current user / not set.
  function asUser(user, cmd, args = []) {
    if (!user || user === D.whoami()) return [cmd, args];
    return ['sudo', ['-n', '-u', user, '-H', cmd, ...args]];
  }

  function exists(p) { try { return dfs.existsSync(p); } catch { return false; } }
  function real(p) { try { return dfs.realpathSync(p); } catch { return path.resolve(p); } }
  function inside(child, parent) {
    if (!child || !parent) return false;
    const rel = path.relative(real(parent), real(child));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  function prevName(name, runId) { return `${name}.prev-${sanitize(runId)}`; }

  // ---------------------------------------------------------------- snapshot of <dir>/<name>
  function snapshotPlan(dir, name, runId) {
    const live = path.join(dir, name);
    const prev = path.join(dir, prevName(name, runId));
    return { dir, name, live, prev, actions: [cmdLine('cp', ['-a', live, `${prev}.tmp`]), cmdLine('mv', [`${prev}.tmp`, prev])] };
  }

  function snapshot(dir, name, runId) {
    const p = snapshotPlan(dir, name, runId);
    if (!exists(p.live)) return { ...p, skipped: `${p.live} does not exist` };
    if (exists(p.prev)) return { ...p, reused: true };
    sh('rm', ['-rf', `${p.prev}.tmp`]);
    sh('cp', ['-a', p.live, `${p.prev}.tmp`]);
    sh('mv', [`${p.prev}.tmp`, p.prev]);
    return p;
  }

  function swapBackPlan(dir, name, runId) {
    const live = path.join(dir, name);
    const prev = path.join(dir, prevName(name, runId));
    const failed = path.join(dir, `${name}.failed-${sanitize(runId)}`);
    return { live, prev, failed, actions: [cmdLine('mv', [live, failed]), cmdLine('mv', [prev, live]), cmdLine('rm', ['-rf', failed])] };
  }

  function swapBack(dir, name, runId) {
    const p = swapBackPlan(dir, name, runId);
    if (!exists(p.prev)) throw new Error(`${p.prev} missing; cannot restore ${p.live}`);
    sh('rm', ['-rf', p.failed]);
    if (exists(p.live)) sh('mv', [p.live, p.failed]);
    sh('mv', [p.prev, p.live]);
    sh('rm', ['-rf', p.failed]);
    return p;
  }

  // Keep at most `keep` <name>.prev-* dirs in `dir` (newest by run-id, which starts with a timestamp).
  function prune(dir, name, keep = 2, protect = null) {
    let list = [];
    try { list = dfs.readdirSync(dir).filter((f) => f.startsWith(`${name}.prev-`) && !f.endsWith('.tmp')).sort().reverse(); } catch { return []; }
    const removed = [];
    for (const f of list.slice(Math.max(1, keep))) {
      if (protect && f === protect) continue;
      sh('rm', ['-rf', path.join(dir, f)]);
      removed.push(path.join(dir, f));
    }
    return removed;
  }

  function copyFile(src, dst) {
    dfs.mkdirSync(path.dirname(dst), { recursive: true });
    dfs.copyFileSync(src, dst);
  }

  // ---------------------------------------------------------------- git (path-scoped only)
  function gitBranch(repo) { return sh('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(); }

  function isTracked(repo, rel) {
    const r = D.run('git', ['-C', repo, 'ls-files', '--', rel]);
    return r.status === 0 && r.stdout.trim().length > 0;
  }

  function assertPaths(paths) {
    if (!paths.length) throw new Error('git: refusing to stage an empty path list');
    for (const p of paths) {
      if (!p || p === '.' || p === '/' || p.startsWith('-') || p.startsWith('..') || path.isAbsolute(p)) throw new Error(`git: refusing unscoped path "${p}"`);
    }
  }

  // Stage + commit ONLY `paths` (repo-relative). Returns the commit sha or null when nothing changed.
  function gitCommitPaths(repo, paths, message, branch = null) {
    assertPaths(paths);
    if (branch) {
      const cur = gitBranch(repo);
      if (cur !== branch) throw new Error(`git: repo is on "${cur}", expected "${branch}"; not committing`);
    }
    sh('git', ['-C', repo, 'add', '--', ...paths]);
    const diff = D.run('git', ['-C', repo, 'diff', '--cached', '--quiet', '--', ...paths]);
    if (diff.status === 0) return null;
    sh('git', ['-C', repo, 'commit', '-m', message, '--', ...paths]);
    return sh('git', ['-C', repo, 'rev-parse', 'HEAD']).stdout.trim();
  }

  // Revert only when the scoped paths are clean (no local edits that the revert would mix in).
  function gitRevert(repo, sha, paths) {
    const st = sh('git', ['-C', repo, 'status', '--porcelain', '--', ...paths]).stdout.trim();
    if (st) throw new Error(`git: ${paths.join(' ')} not clean, refusing to revert ${sha}:\n${st.slice(0, 300)}`);
    sh('git', ['-C', repo, 'revert', '--no-edit', sha]);
    return sh('git', ['-C', repo, 'rev-parse', 'HEAD']).stdout.trim();
  }

  // ---------------------------------------------------------------- health
  async function health(url, { tries = 6, delayMs = 5000 } = {}) {
    let last = 0;
    for (let i = 0; i < tries; i++) {
      last = await D.httpStatus(url);
      if (last >= 200 && last < 500) return { ok: true, status: last, tries: i + 1 };
      if (i < tries - 1) await D.sleep(delayMs);
    }
    return { ok: false, status: last, tries };
  }

  // ---------------------------------------------------------------- run artifacts
  function readJson(file, dflt = null) { try { return JSON.parse(dfs.readFileSync(file, 'utf8')); } catch { return dflt; } }
  function writeJson(file, data) { dfs.mkdirSync(path.dirname(file), { recursive: true }); dfs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n'); }

  // Backup entries this run recorded for `plugin` (backup.json is written by the core).
  function runEntries(ctx, plugin) {
    const data = ctx.run && ctx.run.dir ? readJson(path.join(ctx.run.dir, 'backup.json'), null) : null;
    return ((data && data.entries) || []).filter((e) => e.plugin === plugin && !(e.meta && e.meta.dryRun));
  }

  function profileScript(ctx, rel) {
    if (!rel) return null;
    return path.isAbsolute(rel) ? rel : path.join(ctx.profileDir || '.', rel);
  }

  function applyGate(ctx) {
    if (ctx.dryRun) return 'dry-run';
    if (ctx.mode !== 'apply-tier-a') return `mode ${ctx.mode} never applies`;
    return null;
  }

  return {
    D, sh, asUser, exists, real, inside, snapshotPlan, snapshot, swapBackPlan, swapBack, prune, prevName, copyFile,
    gitBranch, isTracked, gitCommitPaths, gitRevert, health, readJson, writeJson, runEntries, profileScript, applyGate,
  };
}

module.exports = { make, defaultDeps, sanitize, cmdLine, q };
