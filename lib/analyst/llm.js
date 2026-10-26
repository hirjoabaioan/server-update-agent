'use strict';
// LLM client used ONLY to write explanations (summaries). Verdicts are deterministic (impact.js).
//   primary : any OpenAI-compatible chat endpoint (profile.analyst.llmUrl), bearer key read from the
//             variable named by profile.analyst.llmKeyVar (default LLM_API_KEY) in profile.analyst.llmEnvFile.
//             Not configured (no llmUrl / llmEnvFile / key) => the LLM stays disabled, never an error.
//   fallback: Anthropic Messages API, ONLY for tier-B reports and ONLY if profile.analyst.anthropicEnvFile
//             exists (key ANTHROPIC_API_KEY). Missing file => hook stays inactive (open item, never an error).
// Any network error / 401 / 403 / 5xx => provider "unavailable" for the rest of the run (one warning,
// no retries storm). Secrets are never logged: every message goes through mask().
const fs = require('fs');

const DEFAULTS = {
  llmUrl: null,
  llmEnvFile: null,
  llmKeyVar: 'LLM_API_KEY',
  llmModel: 'default',
  anthropicUrl: 'https://api.anthropic.com',
  anthropicKeyVar: 'ANTHROPIC_API_KEY',
  anthropicModel: 'claude-haiku-5-5',
  timeoutMs: 90000,
};

function readEnvFile(file) {
  const out = {};
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  for (const raw of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function mask(text, secrets = []) {
  let s = String(text === undefined || text === null ? '' : text);
  for (const sec of secrets) if (sec && sec.length >= 6) s = s.split(sec).join('***');
  return s
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})/g, '***');
}

async function postJson(url, headers, body, timeoutMs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  return { status: res.status, text };
}

function createLlm(ctx, opts = {}) {
  const cfg = { ...DEFAULTS, ...((ctx.profile && ctx.profile.analyst) || {}), ...(opts.config || {}) };
  const log = ctx.log || { info() {}, warn() {}, error() {}, debug() {} };
  const post = opts.post || postJson;
  const secrets = [];
  const state = { primary: null, anthropic: null, warned: new Set(), used: { primary: 0, anthropic: 0 } };

  function warnOnce(key, msg) {
    if (state.warned.has(key)) return;
    state.warned.add(key);
    log.warn(mask(msg, secrets));
  }

  function loadPrimary() {
    if (state.primary !== null) return state.primary;
    if (!cfg.llmUrl || !cfg.llmEnvFile) {
      state.primary = { available: false, reason: 'llmUrl/llmEnvFile not configured' };
      warnOnce('primary-nokey', `llm: skipping primary summaries (${state.primary.reason})`);
      return state.primary;
    }
    const env = readEnvFile(cfg.llmEnvFile);
    const key = env && (env[cfg.llmKeyVar] || process.env[cfg.llmKeyVar]);
    if (!key) {
      state.primary = { available: false, reason: env ? `${cfg.llmKeyVar} not set in ${cfg.llmEnvFile}` : `env file ${cfg.llmEnvFile} missing` };
      warnOnce('primary-nokey', `llm: skipping primary summaries (${state.primary.reason})`);
    } else {
      secrets.push(key);
      state.primary = { available: true, key };
    }
    return state.primary;
  }

  function loadAnthropic() {
    if (state.anthropic !== null) return state.anthropic;
    const file = cfg.anthropicEnvFile;
    const env = file ? readEnvFile(file) : null;
    const key = env && env[cfg.anthropicKeyVar];
    if (!key) {
      state.anthropic = { available: false, reason: file ? `anthropic env file ${file} missing or without ${cfg.anthropicKeyVar}` : 'no anthropicEnvFile configured' };
    } else {
      secrets.push(key);
      state.anthropic = { available: true, key };
    }
    return state.anthropic;
  }

  async function viaPrimary(system, prompt) {
    const p = loadPrimary();
    if (!p.available) return null;
    try {
      const r = await post(`${cfg.llmUrl.replace(/\/+$/, '')}/v1/chat/completions`, { authorization: `Bearer ${p.key}` }, {
        model: cfg.llmModel,
        temperature: 0.2,
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      }, cfg.timeoutMs);
      if (r.status === 401 || r.status === 403 || r.status >= 500 || r.status === 429) {
        p.available = false;
        p.reason = `HTTP ${r.status}`;
        warnOnce('primary-down', `llm: primary provider unavailable (HTTP ${r.status}); continuing without LLM summaries`);
        return null;
      }
      if (r.status >= 400) { warnOnce(`primary-${r.status}`, `llm: primary provider rejected request (HTTP ${r.status})`); return null; }
      const j = JSON.parse(r.text);
      const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!text) { warnOnce('primary-empty', 'llm: primary provider returned no content'); return null; }
      state.used.primary++;
      return { text: String(text), provider: 'primary' };
    } catch (e) {
      p.available = false;
      p.reason = mask(e.message, secrets);
      warnOnce('primary-down', `llm: primary provider unavailable (${mask(e.cause && e.cause.code ? e.cause.code : e.message, secrets)}); continuing without LLM summaries`);
      return null;
    }
  }

  async function viaAnthropic(system, prompt) {
    const a = loadAnthropic();
    if (!a.available) {
      warnOnce('anthropic-off', `llm: anthropic fallback inactive (${a.reason})`);
      return null;
    }
    try {
      const r = await post(`${cfg.anthropicUrl.replace(/\/+$/, '')}/v1/messages`, { 'x-api-key': a.key, 'anthropic-version': '2023-06-01' }, {
        model: cfg.anthropicModel, max_tokens: 1500, system,
        messages: [{ role: 'user', content: prompt }],
      }, cfg.timeoutMs);
      if (r.status >= 400) {
        if (r.status === 401 || r.status === 403 || r.status >= 500) a.available = false;
        warnOnce(`anthropic-${r.status}`, `llm: anthropic fallback failed (HTTP ${r.status})`);
        return null;
      }
      const j = JSON.parse(r.text);
      const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      if (!text) return null;
      state.used.anthropic++;
      return { text, provider: 'anthropic' };
    } catch (e) {
      a.available = false;
      warnOnce('anthropic-down', `llm: anthropic fallback unavailable (${mask(e.message, secrets)})`);
      return null;
    }
  }

  return {
    mask: (t) => mask(t, secrets),
    state,
    // tier: 'A' | 'B'. Returns { text, provider } or null (never throws).
    async complete(system, prompt, { tier = 'A' } = {}) {
      const r = await viaPrimary(system, prompt);
      if (r) return r;
      if (tier === 'B') return viaAnthropic(system, prompt);
      return null;
    },
  };
}

// Extract {summary, riskNotes?} from a model answer (JSON, possibly fenced).
function parseSummary(text) {
  const s = String(text || '');
  const m = /\{[\s\S]*\}/.exec(s);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (j && j.summary) {
        return {
          summary: String(j.summary),
          riskNotes: Array.isArray(j.riskNotes) ? j.riskNotes.map(String).slice(0, 8) : [],
        };
      }
    } catch { /* fall through */ }
  }
  return s.trim() ? { summary: s.trim().slice(0, 1500), riskNotes: [] } : null;
}

module.exports = { helper: true, createLlm, readEnvFile, mask, parseSummary, DEFAULTS };
