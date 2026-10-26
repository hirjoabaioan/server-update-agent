'use strict';
// Notification (core, channel-agnostic). Builds a short plain-text summary and hands it to the profile
// adapter: <profileDir>/adapters/notify-<profile.notify.type>.sh (text on stdin, config via env).
// The core never knows which channel the adapter talks to.
const path = require('path');
const { spawnSync } = require('child_process');
const { loadRunData, collectAdvisories } = require('./_common');
const markdown = require('./markdown');

const MAX = 900;
const OFF_WINDOW_TITLE = 'Critical CVE — consider running outside the window';

function clip(s, max = MAX) {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

// d: loadRunData() result (or fixture); opts: { reportPath }
function buildSummary(d, opts = {}) {
  const { report } = markdown.render(d, opts);
  const c = report.counts;
  const lines = [
    `[stack-updater] ${report.mode}${d.summary && d.summary.dryRun ? ' (dry-run)' : ''} — ${report.runId}`,
    `applied: ${c.applied}, failed: ${c.failed}, rollback: ${c.rolledBack}`,
    `tier B proposals: ${c.tierB}, in soak: ${c.soak}`,
    `critical advisories: ${c.criticalAdvisories}`,
  ];
  const crit = report.advisories.filter((a) => a.critical).slice(0, 5);
  if (crit.length) lines.push(...crit.map((a) => `! ${a.name} ${a.id || ''} ${a.cvss != null ? `CVSS ${a.cvss}` : ''}`.trim()));
  if (opts.reportPath) lines.push(`report: ${opts.reportPath}`);
  return clip(lines.join('\n'));
}

// Daily advisory mode: only critical entries, never applies anything.
function buildAdvisorySummary(inventory) {
  const crit = collectAdvisories(inventory).filter((a) => a.critical);
  if (!crit.length) return { critical: [], text: null };
  const lines = [OFF_WINDOW_TITLE, ...crit.slice(0, 8).map((a) => `• ${a.ecosystem}::${a.name} ${a.installed || ''} — ${a.id || 'advisory'}${a.cvss != null ? ` (CVSS ${a.cvss})` : ''}${a.fixedIn ? ` → ${a.fixedIn}` : ''}`)];
  if (crit.length > 8) lines.push(`… +${crit.length - 8}`);
  lines.push('Nothing is applied automatically; run manually if needed.');
  return { critical: crit, text: clip(lines.join('\n')) };
}

function adapterPath(profileDir, type) {
  if (!/^[a-z0-9-]+$/.test(String(type || ''))) return null;
  return path.join(profileDir, 'adapters', `notify-${type}.sh`);
}

// profile.notify = { type, tokenFile, envFile, chatId? }. Returns { ok, sent, detail }.
function send(cfg, text, opts = {}) {
  const n = (cfg.profile && cfg.profile.notify) || null;
  if (!n || !n.type) return { ok: true, sent: false, detail: 'notify not configured' };
  const script = adapterPath(cfg.profileDir, n.type);
  const r = spawnSync('bash', [script], {
    input: text,
    encoding: 'utf8',
    timeout: opts.timeoutMs || 20000,
    env: { ...process.env, ...(opts.env || {}), NOTIFY_TOKEN_FILE: n.tokenFile || '', NOTIFY_ENV_FILE: n.envFile || '', NOTIFY_CHAT_ID: n.chatId || '' },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { ok: r.status === 0, sent: r.status === 0, detail: out.slice(0, 500), status: r.status };
}

function notifyRun(cfg, runDir, opts = {}) {
  const d = loadRunData(runDir);
  const text = buildSummary(d, { reportPath: opts.reportPath });
  return { text, ...send(cfg, text, opts) };
}

function notifyAdvisories(cfg, inventory, opts = {}) {
  const s = buildAdvisorySummary(inventory);
  if (!s.text) return { critical: 0, sent: false, ok: true, detail: 'no critical advisories' };
  return { critical: s.critical.length, text: s.text, ...send(cfg, s.text, opts) };
}

// helper: true => not a reporter plugin (lib/core/plugins.js skips it); the core calls it after report.
module.exports = { helper: true, buildSummary, buildAdvisorySummary, send, notifyRun, notifyAdvisories, adapterPath, OFF_WINDOW_TITLE, MAX };
