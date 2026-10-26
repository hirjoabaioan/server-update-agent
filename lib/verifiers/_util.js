'use strict';
// Shared helpers for verifiers (ignored by the plugin loader: leading underscore).
const { spawn } = require('child_process');

// profile.verifiers[] = [{ name, envs?: ['test','prod'], ...options }]. A plugin may be registered
// several times (e.g. `command` per check). No matching entry => the verifier is skipped for the env.
function entriesFor(ctx, name) {
  const list = (ctx.profile && ctx.profile.verifiers) || [];
  return list.filter((e) => e && e.name === name && (!e.envs || e.envs.includes(ctx.env)));
}

function runCmd(cmd, args = [], { timeoutMs = 60000, cwd, env, input } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '';
    let err = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { resolve({ code: null, out, err: e.message, timedOut, ms: 0 }); return; }
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < 1e6) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 1e6) err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, out, err: e.message, timedOut, ms: Date.now() - t0 }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err, timedOut, ms: Date.now() - t0 }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}

const oneLine = (s, n = 300) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// Standard failure shape: { ok:false, component, details, checks }
function fail(component, checks, details) {
  return { ok: false, component, details: details || checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`).join('; '), checks };
}

module.exports = { entriesFor, runCmd, oneLine, fail };
