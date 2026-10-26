'use strict';
// Runs profile.verifiers entries { name:'external-hook', id, script, args?, timeoutMs?, envs? }.
// Scripts are run directly (no shell) with the env in $STACK_ENV.
// It must print JSON { ok, details?, component? } as the whole stdout or its last JSON line.
// Non-JSON output, a non-zero exit or a timeout all fail the verifier.
const { entriesFor, runCmd, oneLine, fail } = require('./_util');

function parseResult(out) {
  const t = String(out || '').trim();
  try { return JSON.parse(t); } catch { /* fall through to last line */ }
  const lines = t.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]); } catch { /* keep looking */ } }
  return null;
}

module.exports = {
  name: 'external-hook',
  parseResult,
  async verify(ctx) {
    const entries = entriesFor(ctx, 'external-hook');
    if (!entries.length) return { ok: true, skipped: true, checks: [] };
    const checks = [];
    for (const e of entries) {
      const script = ctx.repoPath ? ctx.repoPath(e.script) : e.script;
      const r = await runCmd(script, e.args || [], { timeoutMs: e.timeoutMs || 600000, env: { STACK_ENV: ctx.env, STACK_PROFILE_DIR: ctx.profileDir || '' } });
      const j = parseResult(r.out);
      const id = e.id || e.script;
      if (r.timedOut) checks.push({ id, ok: false, detail: `timeout after ${e.timeoutMs || 600000}ms` });
      else if (!j || typeof j.ok !== 'boolean') checks.push({ id, ok: false, detail: `no JSON {ok,details} on stdout (exit ${r.code}): ${oneLine(r.err || r.out)}` });
      else checks.push({ id, ok: j.ok && r.code === 0, component: j.component, detail: oneLine(typeof j.details === 'string' ? j.details : JSON.stringify(j.details), 1500) || `exit ${r.code}`, hook: j });
    }
    return checks.every((c) => c.ok) ? { ok: true, checks } : fail('external-hook', checks);
  },
};
