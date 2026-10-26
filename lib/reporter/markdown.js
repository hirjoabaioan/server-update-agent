'use strict';
// Reporter: renders <run>/*.json into <profile.repo>/<profile.reportDir>/<YYYY-MM-DD>.md (UTC run date)
// and writes <run>/report.json (machine). Headings and text are English.
const fs = require('fs');
const path = require('path');
const { excludedOf } = require('../core/excluded');
const { loadRunData, collectAdvisories, mergeByAlias, groupComposerRows } = require('./_common');

const SECTIONS = [
  'Summary', 'Installed', 'Proposed tier B', 'Tier C', 'Tier A candidates in soak', 'Security', 'Dependency audit',
  'Frontend', 'Upstream changes', 'Required changes on our side', 'Verification', 'Rollback', 'Open questions',
];

const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const keyOf = (x) => [x.ecosystem, x.scope, x.name].filter(Boolean).join('::');
const NONE = '_Nothing to report._';

function table(head, rows) {
  if (!rows.length) return [NONE];
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)];
}

function runDate(d) {
  const s = d.summary || {};
  const m = String(d.runId || '').match(/^(\d{4})(\d{2})(\d{2})-/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return new Date(s.startedAt || Date.now()).toISOString().slice(0, 10);
}

function duration(s) {
  if (!s.startedAt || !s.finishedAt) return 'n/a';
  const sec = Math.max(0, Math.round((Date.parse(s.finishedAt) - Date.parse(s.startedAt)) / 1000));
  return sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`;
}

function analyze(d) {
  const cands = (d.candidates && d.candidates.candidates) || [];
  const ana = d.analysis || {};
  const applied = [];
  const failed = [];
  const skipped = [];
  for (const a of d.apply) {
    for (const x of a.applied || []) applied.push({ env: a.env, ...x });
    for (const x of a.failed || []) failed.push({ env: a.env, ...x });
    for (const x of a.skipped || []) skipped.push({ env: a.env, ...x });
  }
  const tierB = cands.filter((c) => c.tier === 'B' && c.status !== 'question');
  const tierC = cands.filter((c) => c.tier === 'C');
  const soak = cands.filter((c) => c.tier === 'A' && c.status === 'soak');
  const questions = cands.filter((c) => c.status === 'question');
  const advisories = collectAdvisories(d.inventory);
  const items = (d.inventory && d.inventory.items) || [];
  const cdn = items.find((i) => i.ecosystem === 'frontend' && i.name === 'cdnRefs');
  const vendor = items.filter((i) => i.ecosystem === 'vendor-js' && i.name !== '(manifest)');
  const verifyFailed = d.verify.flatMap((v) => (v.results || []).filter((r) => !r.ok).map((r) => ({ env: v.env, name: r.name })));
  const restore = (d.summary && d.summary.restore) || [];
  return { cands, ana, applied, failed, skipped, tierB, tierC, soak, questions, advisories, cdn, vendor, verifyFailed, restore };
}

function fiveXx(d) {
  const out = [];
  for (const v of d.verify) {
    for (const r of v.results || []) {
      if (r.name !== 'nginx-5xx') continue;
      const bad = (r.checks || []).filter((c) => !c.ok).length;
      out.push({ env: v.env, ok: r.ok, details: r.details || '', bad });
    }
  }
  return out;
}

function cdnStats(cdn) {
  if (!cdn || !cdn.meta || cdn.meta.warning) return { total: null, multi: [], warning: cdn && cdn.meta && cdn.meta.warning };
  const per = cdn.meta.perLibrary || {};
  const multi = [];
  for (const [lib, v] of Object.entries(per)) {
    const versions = Array.isArray(v) ? v : Array.isArray(v && v.versions) ? v.versions : v && typeof v === 'object' && !('count' in v) ? Object.keys(v) : [];
    if (new Set(versions.map((x) => (typeof x === 'object' ? x.version : x))).size > 1) multi.push({ lib, versions: [...new Set(versions.map((x) => (typeof x === 'object' ? x.version : x)))] });
  }
  return { total: cdn.meta.total, unpinned: cdn.meta.unpinned, samples: cdn.meta.unpinnedSamples, hosts: cdn.meta.hosts || {}, multi };
}

function render(d, opts = {}) {
  const s = d.summary || {};
  const a = analyze(d);
  const date = opts.date || runDate(d);
  const L = [`# stack-updater report — ${date}`, ''];
  const sec = (title, lines) => { L.push(`## ${title}`, '', ...lines, ''); };
  // Render-time dedup only: report.json keeps the raw decisions (a.tierB, a.tierC, ...).
  const lockIds = {};
  for (const i of ((d.inventory && d.inventory.items) || [])) if (i.ecosystem === 'composer' && i.name === '(lockfile)' && i.meta && i.meta.lockMtime) lockIds[i.scope] = i.meta.lockMtime;
  const dedup = (list) => groupComposerRows(mergeByAlias(list), (c) => [c.installed, c.target, c.status].join('|'), lockIds);
  const lab = (c) => c._label || c.key || keyOf(c);

  const mode = s.mode || opts.mode || 'n/a';
  sec('Summary', [
    `- mode: ${mode}${s.dryRun ? ' (dry-run)' : ''}`,
    `- run-id: ${d.runId}`,
    `- window: ${s.window ? `${s.window.reason || ''}${s.window.ok === false ? ' (outside the window)' : ''}` : 'n/a'}`,
    `- status: ${s.status || 'n/a'}${s.error ? ` — ${s.error}` : ''}`,
    `- duration: ${duration(s)}`,
    `- applied: ${a.applied.length}, failed: ${a.failed.length}, tier B proposals: ${a.tierB.length}, critical advisories: ${a.advisories.filter((x) => x.critical).length}`,
  ]);

  const five = fiveXx(d);
  sec('Installed', [
    ...table(['component', 'env', 'before → after', 'plugin'], mergeByAlias(a.applied).map((x) => [lab(x), x.env, `${x.from || x.installed || '?'} → ${x.to || x.target || x.version || '?'}`, x.plugin])),
    ...(a.failed.length ? ['', '**Failed:**', ...a.failed.map((x) => `- ${x.key || keyOf(x) || x.plugin} (${x.env}): ${x.error || x.reason || 'failed'}`)] : []),
    ...(a.skipped.length ? ['', `Skipped: ${a.skipped.length} (${[...new Set(a.skipped.map((x) => x.reason))].join(', ')})`] : []),
    '',
    `5xx during the switch: ${five.length ? five.map((f) => `${f.env}: ${f.ok ? 'ok' : `FAIL (${f.bad})`} ${f.details}`.trim()).join('; ') : 'not measured (nothing applied or verifier absent)'}`,
  ]);

  const imap = a.tierB.some((c) => /php/i.test(c.name) && /imap/i.test([...(c.blockers || []), ...(c.notes || []), ...(c.reason || [])].map(String).join(' ')));
  sec('Proposed tier B', [
    ...table(['component', 'installed → target', 'status', 'why', 'blockers'], dedup(a.tierB).map((c) => [lab(c), `${c.installed} → ${c.target || '—'}`, c.status, (c.reason || []).join('; '), (c.blockers || []).map((b) => (typeof b === 'string' ? b : JSON.stringify(b))).join('; ') || '—'])),
    '',
    `PHP side-by-side installed: ${a.cands.filter((c) => c.status === 'side-by-side' && c.ecosystem === 'php-runtime').map((c) => `${c.scope} (${c.installed})`).join(', ') || 'n/a'}: newer lines run alongside the active one (active FPM: ${(d.candidates && d.candidates.activePhp) || 'n/a'}).`,
    '',
    `PHP readiness: ${a.tierB.filter((c) => /^php/i.test(c.name) || c.ecosystem === 'php-runtime').map((c) => `${c.key || keyOf(c)}: ${c.status}`).join('; ') || 'no PHP line evaluated'}${imap ? ' — note: the imap extension is missing/blocked on the newer PHP (PECL imap needed)' : ''}.`,
  ]);

  sec('Tier C', [
    ...table(['component', 'installed', 'target', 'EOL / support'], dedup(a.tierC).map((c) => {
      const it = ((d.inventory && d.inventory.items) || []).find((i) => keyOf(i) === (c.key || keyOf(c))) || {};
      return [lab(c), c.installed, c.target || '—', [it.eol && `EOL ${it.eol}`, it.supportEnd && `support until ${it.supportEnd}`].filter(Boolean).join(', ') || (c.notes || []).join('; ') || 'n/a'];
    })),
    '',
    '_Calendar source: endoflife.date. Tier C is report-only and never applied automatically._',
  ]);

  const dayMs = 86400000;
  const today = Date.parse(`${date}T00:00:00Z`);
  const readyA = a.cands.filter((c) => c.tier === 'A' && c.status === 'ready');
  const readyMain = dedup(readyA).filter((c) => c.ecosystem !== 'apt' || /^(nginx|mariadb-server|php8\.3-fpm)$/.test(c.name));
  const mark = (c) => `${c.name} ${c.installed} → ${c.target}${c.pending ? ` (newer ${c.pending.version} in soak, eligible ${c.pending.eligibleOn})` : ''}`;
  sec('Tier A candidates in soak', [
    `Tier A ready to apply (nothing was applied in mode ${mode}): ${readyA.length} package(s)/component(s); main ones:`,
    ...readyMain.map((c) => `- ${lab(c)}: ${mark(c)}`),
    '',
    ...table(['component', 'version', 'released', 'days left'], dedup(a.soak).map((c) => {
    const p = c.pending || {};
    const rel = p.ageDays != null ? new Date(today - p.ageDays * dayMs).toISOString().slice(0, 10) : 'n/a';
    const left = p.eligibleOn ? Math.max(0, Math.ceil((Date.parse(p.eligibleOn) - today) / dayMs)) : 'n/a';
    return [lab(c), p.version || c.target || '?', rel, left];
  }))]);

  const crit = a.advisories.filter((x) => x.critical);
  const noScore = a.advisories.filter((x) => x.ecosystem === 'usn' && !x.critical && !(Number(x.cvss) > 0) && !x.fixedIn);
  const secRows = groupComposerRows(a.advisories.filter((x) => !noScore.includes(x)), (x) => [x.id, x.installed, x.cvss, x.fixedIn, x.critical].join('|'), lockIds);
  sec('Security', [
    `- advisories: ${a.advisories.length} (critice: ${crit.length})`,
    ...(noScore.length ? [`- ${noScore.length} USN notices without a CVSS score and without a fix (listed in report.json)`] : []),
    ...table(['source', 'component', 'id', 'CVSS', 'fixed in', 'critical'], secRows.map((x) => [x.ecosystem, x._label || x.name, x.id, x.cvss == null ? '—' : x.cvss, x.fixedIn || '—', x.critical ? 'YES' : 'no'])),
  ]);

  const invItems = (d.inventory && d.inventory.items) || [];
  const compRoots = invItems.filter((i) => i.ecosystem === 'composer' && i.name === '(lockfile)');
  const npmApps = invItems.filter((i) => i.ecosystem === 'npm' && i.name === '(app)');
  const excluded = excludedOf(opts.profile);
  sec('Dependency audit', [
    `Composer — ${compRoots.length} root(s) audited${excluded.length ? `, ${excluded.length} excluded` : ''}:`,
    ...table(['root', 'outdated', 'vulnerable', 'audit ran', 'platform php (require / config / lock)'], compRoots.map((i) => {
      const m = i.meta || {};
      const c = m.counts || {};
      const pl = m.platform || {};
      return [i.scope, c.outdated, c.vulnerable, m.auditRan ? 'yes' : 'NO', `${pl.require || '—'} / ${pl.configPlatform || '—'} / ${pl.lockPlatform || '—'}`];
    })),
    ...(excluded.length ? [`Excluded: ${excluded.map((x) => `${x.domain || x.path} (${x.reason || '—'})`).join('; ')}`] : []),
    '',
    `npm — ${npmApps.length} app(s):`,
    ...table(['app', 'outdated', 'vulnerable', 'critical', 'high', 'moderate'], npmApps.map((i) => {
      const m = i.meta || {};
      const c = m.counts || {};
      const sv = c.severities || m.severities || {};
      return [i.scope, c.outdated == null ? '—' : c.outdated, c.vulnerable == null ? '—' : c.vulnerable, sv.critical == null ? '—' : sv.critical, sv.high == null ? '—' : sv.high, sv.moderate == null ? '—' : sv.moderate];
    })),
  ]);

  const cs = cdnStats(a.cdn);
  sec('Frontend', [
    `- CDN consolidation: ${cs.total == null ? `scan unavailable${cs.warning ? ` (${cs.warning})` : ''}` : `${cs.unpinned == null ? cs.total : cs.unpinned} unpinned (versionless) references out of ${cs.total} total CDN references (cdn.jsdelivr/cdnjs/unpkg)${cs.samples && cs.samples.length ? ` — e.g.: ${cs.samples.join(', ')}` : ''}`}`,
    `- libraries with multiple versions: ${cs.multi.length ? cs.multi.map((m) => `${m.lib} (${m.versions.join(', ')})`).join('; ') : 'none'}`,
    `- manifest — active versions: ${a.vendor.length ? a.vendor.map((v) => `${v.name}@${v.installed}`).join(', ') : 'manifest absent or empty'}`,
  ]);

  const up = a.ana.candidates || [];
  sec('Upstream changes', up.length
    ? up.map((c) => `- **${c.name || c.component || '?'}** ${c.installed || ''} → ${c.target || ''} (${c.verdict || 'n/a'}): ${c.summary || ''}`)
    : [...(a.ana.proposals || []).map((p) => `- **${p.component}**: ${p.summary || ''}`), ...((a.ana.proposals || []).length ? [] : [NONE])]);

  const cc = up.flatMap((c) => (c.codeChanges || []).map((x) => ({ comp: c.name || c.component, ...x })));
  sec('Required changes on our side', table(['component', 'file:line', 'what'], cc.map((x) => [x.comp, `${x.file}:${x.line}`, x.what])));

  sec('Verification', d.verify.length ? d.verify.flatMap((v) => [`**${v.env}: ${v.ok ? 'ok' : 'FAILED'}**`, ...(v.results || []).map((r) => `- ${r.ok ? 'ok' : 'FAIL'} ${r.skipped ? '(skipped) ' : ''}${r.name}${r.details ? ` — ${String(r.details).slice(0, 200)}` : ''}`), '']) : ['No verification ran (nothing applied).']);

  const be = (d.backup && d.backup.entries) || [];
  const bundle = be.find((e) => /bundle/i.test(e.plugin || '')) || {};
  sec('Rollback', [
    `- actions: ${a.restore.length ? a.restore.map((r) => `${(r.entry && (r.entry.component || r.entry.plugin)) || '?'}: ${r.ok ? 'restored' : `FAILED (${r.detail})`}`).join('; ') : 'none'}`,
    `- local bundle: ${bundle.artifact || (be[0] && be[0].artifact) || 'n/a'}`,
    `- remote: ${bundle.remote || (be.find((e) => e.remote) || {}).remote || 'n/a'}`,
    ...(be.length ? [`- backup entries: ${be.length}${d.backup.dryRun ? ' (dry-run)' : ''}`] : []),
  ]);

  sec('Open questions', a.questions.length || (a.ana.findings || []).some((f) => f.severity === 'critical')
    ? [...a.questions.map((c) => `- ${c.name}: ${c.question === 'mainline->stable' ? 'nginx mainline → stable? The repo uses nginx.org mainline; stable requires a source change.' : c.question}`),
      ...(a.ana.findings || []).filter((f) => f.severity === 'critical').map((f) => `- critical: ${f.component || ''} ${f.message}`)]
    : [NONE]);

  const counts = { applied: a.applied.length, failed: a.failed.length, rolledBack: a.restore.length, tierB: a.tierB.length, tierC: a.tierC.length, soak: a.soak.length, advisories: a.advisories.length, criticalAdvisories: crit.length, questions: a.questions.length };
  const report = {
    runId: d.runId, date, mode, status: s.status || null, window: s.window || null, duration: duration(s), counts,
    applied: a.applied, failed: a.failed, tierB: a.tierB, tierC: a.tierC, soak: a.soak, advisories: a.advisories,
    verifyFailed: a.verifyFailed, questions: a.questions.map((q) => q.name), sections: SECTIONS,
  };
  return { md: L.join('\n').replace(/\n{3,}/g, '\n\n'), report, date };
}

// Writes the .md into <repo>/<reportDir>/<date>.md (if profile has both) and <run>/report.json.
function write(runDir, profile, opts = {}) {
  const d = loadRunData(runDir);
  const out = render(d, { ...opts, profile });
  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(out.report, null, 2) + '\n');
  const files = [path.join(runDir, 'report.json')];
  if (profile && profile.reportDir && profile.repo && fs.existsSync(profile.repo)) {
    const dir = path.resolve(profile.repo, profile.reportDir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${out.date}.md`);
    fs.writeFileSync(file, out.md + '\n');
    out.mdPath = file;
    files.push(file);
  }
  return { ...out, files };
}

module.exports = {
  name: 'markdown',
  SECTIONS,
  render,
  write,
  async report(summary, ctx) {
    const r = write(ctx.run.dir, ctx.profile);
    return { files: r.files };
  },
};
