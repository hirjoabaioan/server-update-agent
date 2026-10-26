'use strict';
// Maintenance-window guard (core, server-agnostic). The window comes from
// profile.maintenanceWindow = { dow, hour, endHour?, tz: 'UTC' } — default Saturday 22:00–23:59 UTC.
// Rules:
//   - inside the window                      => apply allowed
//   - outside + --force with a reason        => apply allowed (forced, reason logged)
//   - outside + --force without a reason     => refused
//   - outside + critical security target     => NOT applied, notify only
//   - outside otherwise                      => skipped until the next window

const DEFAULT_WINDOW = { dow: 6, hour: 22, endHour: 23, tz: 'UTC' };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function normalizeWindow(mw) {
  const w = { ...DEFAULT_WINDOW, ...(mw || {}) };
  if (mw && mw.hour !== undefined && mw.endHour === undefined) w.endHour = 23;
  if (String(w.tz).toUpperCase() !== 'UTC') throw new Error(`maintenanceWindow.tz must be UTC (got ${w.tz})`);
  return w;
}

function isInWindow(now, mw) {
  const w = normalizeWindow(mw);
  const h = now.getUTCHours();
  return now.getUTCDay() === w.dow && h >= w.hour && h <= w.endHour;
}

function describeWindow(mw) {
  const w = normalizeWindow(mw);
  const p = (n) => String(n).padStart(2, '0');
  return `${DAYS[w.dow]} ${p(w.hour)}:00–${p(w.endHour)}:59 UTC`;
}

// Start of the next window strictly after `now` (or `now`'s window start if we are inside it).
function nextWindowStart(now, mw) {
  const w = normalizeWindow(mw);
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), w.hour, 0, 0));
  d.setUTCDate(d.getUTCDate() + ((w.dow - d.getUTCDay() + 7) % 7));
  if (d.getTime() + (w.endHour - w.hour + 1) * 3600000 <= now.getTime()) d.setUTCDate(d.getUTCDate() + 7);
  return d;
}

// A target is "critical" when it fixes a security issue with cvss >= policy.criticalCvss (default 9)
// or carries severity 'critical'.
function isCritical(d, policy = {}) {
  const min = policy.criticalCvss || 9;
  if (!d) return false;
  if (d.severity === 'critical') return true;
  const cvss = Number(d.cvss);
  return !!d.security && Number.isFinite(cvss) && cvss >= min;
}

// opts: { profile, policy, now, force, reason, targets }
function checkWindow(opts = {}) {
  const now = opts.now || new Date();
  const mw = (opts.profile && opts.profile.maintenanceWindow) || null;
  const window = describeWindow(mw);
  if (isInWindow(now, mw)) return { ok: true, forced: false, notifyOnly: false, window, reason: 'inside maintenance window' };
  if (opts.force) {
    const reason = String(opts.reason || '').trim();
    if (!reason) return { ok: false, forced: false, notifyOnly: false, window, reason: '--force requires --reason "<why>"' };
    return { ok: true, forced: true, notifyOnly: false, window, reason: `forced off-window: ${reason}` };
  }
  const critical = (opts.targets || []).filter((t) => isCritical(t, opts.policy));
  if (critical.length) {
    return { ok: false, forced: false, notifyOnly: true, window, critical: critical.map((t) => t.name), reason: `critical security update off-window (${window}): notify only` };
  }
  const next = nextWindowStart(now, mw).toISOString().replace(/:\d\d\.\d{3}Z$/, ' UTC').replace('T', ' ');
  return { ok: false, forced: false, notifyOnly: false, window, next, reason: `outside maintenance window (${window}; next ${next}); use --force --reason '<text>' to override` };
}

module.exports = { checkWindow, isInWindow, isCritical, describeWindow, nextWindowStart, DEFAULT_WINDOW };
