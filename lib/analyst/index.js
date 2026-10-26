'use strict';
// Analyst plugin "impact-analyst": for every tier A/B decision with a target it
//   1. fetches release notes (changelog.js), 2. runs deterministic impact checks (impact.js),
//   3. derives the verdict WITHOUT the LLM, 4. asks the LLM (llm.js) only for the explanations.
// Output per candidate: { verdict: safe|needs-code-change|blocked, codeChanges[], riskNotes[],
//                         summary, ... }  (collected in analysis.json -> candidates[]).
// The LLM being down never fails the run: deterministic fallback summaries + a warning finding.
const fs = require('fs');
const path = require('path');
const { fetchChangelog } = require('./changelog');
const { analyzeImpact } = require('./impact');
const { createLlm, parseSummary } = require('./llm');

const systemPrompt = (lang) => [
  'You are a release-notes analyst for a small PHP/Node server stack.',
  'The verdict (safe | needs-code-change | blocked) is ALREADY decided by deterministic checks; never change or contradict it.',
  'Write concise explanations only. Reply with ONE JSON object and nothing else:',
  '{"summary": "...", "riskNotes": ["..."]}',
  `summary is written in ${lang}: 2-4 sentences, plain words. riskNotes: at most 3 extra risks visible in the changelog excerpt (may be empty).`,
  'Never invent facts that are not in the input.',
].join('\n');

const keyOf = (d) => `${d.ecosystem}:${d.name}:${d.installed}:${d.target}`;

function loadPatterns(ctx) {
  const rel = (ctx.profile && ctx.profile.analyst && ctx.profile.analyst.patternsFile) || 'analyst-patterns.json';
  const file = path.isAbsolute(rel) ? rel : path.join(ctx.profileDir || '.', rel);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function deriveVerdict(decision, impact) {
  if (decision.action === 'hold' || decision.action === 'skip') {
    return { verdict: 'blocked', blockers: [`policy ${decision.action}: ${(decision.reasons || []).join('; ') || 'no reason given'}`] };
  }
  if (impact.blockers.length) return { verdict: 'blocked', blockers: impact.blockers };
  if (impact.codeChanges.length) return { verdict: 'needs-code-change', blockers: [] };
  return { verdict: 'safe', blockers: [] };
}

function fallbackSummary(c) {
  const what = `${c.name} ${c.installed} → ${c.target}`;
  const n = c.codeChanges.length;
  return {
    safe: c.riskNotes.length ? `${what}: no code change needed, but ${c.riskNotes.length} risk note(s) should be reviewed.` : `${what}: no code change needed according to the automatic checks.`,
    'needs-code-change': `${what}: code changes are required (${n} place(s)); see codeChanges.`,
    blocked: `${what}: blocked. ${c.blockers.join(' ')}`,
  }[c.verdict];
}

function buildPrompt(c, changelog) {
  return [
    `Component: ${c.ecosystem}/${c.name} (${c.scope || 'host'}), ${c.installed} -> ${c.target}, tier ${c.tier}`,
    `Verdict (fixed): ${c.verdict}`,
    c.blockers.length ? `Blockers: ${c.blockers.join(' | ')}` : '',
    `Code changes (${c.codeChanges.length}): ${c.codeChanges.slice(0, 12).map((x) => `${x.file}:${x.line} ${x.what}`).join(' ; ')}`,
    `Risk notes: ${c.riskNotes.slice(0, 8).join(' ; ')}`,
    'Changelog excerpt:',
    String((changelog && changelog.text) || '(none)').slice(0, 6000),
  ].filter(Boolean).join('\n');
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

async function analyzeOne(group, ctx, llm, cfg, llmBudget) {
  const d = group[0];
  const log = ctx.log;
  const base = {
    ecosystem: d.ecosystem, name: d.name, scopes: group.map((g) => g.scope).filter(Boolean),
    installed: d.installed, target: d.target, tier: d.tier, action: d.action,
    verdict: 'safe', codeChanges: [], riskNotes: [], blockers: [],
  };
  let changelog = null;
  let impact = { codeChanges: [], riskNotes: [], blockers: [], details: {} };
  if (d.action !== 'hold' && d.action !== 'skip') {
    changelog = await fetchChangelog(d, ctx);
    if (changelog.error) base.riskNotes.push(`changelog: ${changelog.error}`);
    impact = await analyzeImpact(d, changelog, ctx);
  }
  const v = deriveVerdict(d, impact);
  const cand = {
    ...base,
    verdict: v.verdict,
    verdictDetail: v.verdict === 'safe' ? ((base.riskNotes.length + impact.riskNotes.length) ? 'safe-with-notes' : 'safe') : v.verdict,
    blockers: v.blockers,
    codeChanges: impact.codeChanges,
    riskNotes: [...base.riskNotes, ...impact.riskNotes],
    changelog: changelog ? { source: changelog.source, urls: changelog.urls, file: changelog.file, truncated: changelog.truncated, error: changelog.error, cached: changelog.cached } : null,
    impact: impact.details,
    llm: null,
  };
  const fb = fallbackSummary(cand);
  cand.summary = fb;
  if (changelog && changelog.text && llmBudget.left > 0) {
    llmBudget.left--;
    const r = await llm.complete(systemPrompt(cfg.summaryLanguage || 'English'), buildPrompt(cand, changelog), { tier: d.tier });
    const p = r && parseSummary(r.text);
    if (p) {
      cand.summary = p.summary;
      for (const n of p.riskNotes) cand.riskNotes.push(`llm: ${n}`);
      cand.llm = { provider: r.provider };
    }
  }
  log.info(`${d.ecosystem}:${d.name} ${d.installed}->${d.target}: ${cand.verdict}`);
  return cand;
}

module.exports = {
  name: 'impact-analyst',
  deriveVerdict,
  async analyze(decisions, ctx) {
    const cfg = (ctx.profile && ctx.profile.analyst) || {};
    ctx.log = ctx.log || { info() {}, warn() {}, error() {}, debug() {} };
    ctx.analyst = ctx.analyst || {};
    if (!ctx.analyst.patterns) ctx.analyst.patterns = loadPatterns(ctx);
    const llm = ctx.analyst.llm || createLlm(ctx, { post: ctx.analyst.post });
    const wanted = (decisions || []).filter((d) => (d.tier === 'A' || d.tier === 'B') && d.target);
    // One analysis per component/version; scopes (domains/apps) are merged, the first scope drives the dry-run lock diff.
    const groups = new Map();
    for (const d of wanted) {
      const k = keyOf(d);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(d);
    }
    const list = [...groups.values()].filter((g) => !(g[0].ecosystem === 'apt' && g.length && /^(lib)?mariadb|^nginx$|^nodejs$/.test(g[0].name))); // covered by their own entries
    const budget = { left: cfg.maxLlmCalls ?? 40 };
    const candidates = await pool(list, cfg.concurrency || 3, (g) => analyzeOne(g, ctx, llm, cfg, budget));

    const findings = [];
    const proposals = [];
    for (const c of candidates) {
      const component = `${c.ecosystem}:${c.scopes[0] || ''}:${c.name}`;
      if (c.verdict !== 'safe' || c.riskNotes.length) {
        findings.push({
          severity: c.verdict === 'safe' ? 'info' : 'warn', component,
          message: `${c.name} ${c.installed} → ${c.target}: ${c.verdict}${c.codeChanges.length ? ` (${c.codeChanges.length} code change(s))` : ''}`,
        });
      }
      if (c.tier === 'B') {
        proposals.push({
          component, from: c.installed, to: c.target, tier: 'B', verdict: c.verdict,
          summary: c.summary,
          steps: c.verdict === 'needs-code-change' ? ['Apply the code changes listed in analysis.json candidates[].codeChanges', 'Re-run stack-update analyze', 'Apply on test, verify, then prod'] : ['Apply on test, verify, then prod'],
          risks: c.riskNotes.slice(0, 8),
        });
      }
    }
    const down = llm.state && llm.state.primary && llm.state.primary.available === false;
    if (down) findings.push({ severity: 'warn', component: 'analyst:llm', message: `LLM summaries unavailable (${llm.mask ? llm.mask(llm.state.primary.reason || 'unknown') : 'unknown'}); deterministic summaries used` });
    if (llm.state && llm.state.anthropic && llm.state.anthropic.available === false && wanted.some((d) => d.tier === 'B')) {
      findings.push({ severity: 'info', component: 'analyst:llm', message: `anthropic fallback inactive: ${llm.state.anthropic.reason}` });
    }
    return { findings, proposals, candidates };
  },
};
