'use strict';
// Runs profile.verifiers entries { name:'command', id, cmd, args?, cwd?, expectExit?:0, timeoutMs?, envs? }.
// One registration per command (php -l, nginx -t, node --test ...). Never uses a shell.
const { entriesFor, runCmd, oneLine, fail } = require('./_util');

module.exports = {
  name: 'command',
  async verify(ctx) {
    const entries = entriesFor(ctx, 'command');
    if (!entries.length) return { ok: true, skipped: true, checks: [] };
    const checks = [];
    for (const e of entries) {
      const want = e.expectExit === undefined ? 0 : e.expectExit;
      const r = await runCmd(e.cmd, e.args || [], { timeoutMs: e.timeoutMs || 120000, cwd: e.cwd });
      const ok = !r.timedOut && r.code === want;
      checks.push({ id: e.id || [e.cmd, ...(e.args || [])].join(' '), ok, exit: r.code,
        detail: r.timedOut ? `timeout after ${e.timeoutMs || 120000}ms` : `exit ${r.code} (expect ${want}) in ${r.ms}ms${ok ? '' : ': ' + oneLine(r.err || r.out)}` });
    }
    return checks.every((c) => c.ok) ? { ok: true, checks } : fail('command', checks);
  },
};
