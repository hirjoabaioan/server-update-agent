'use strict';
// Run: node --test scripts/stack-updater/tests
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const semver = require('../lib/core/semver');
const analyst = require('../lib/analyst');
const { extractIdentifiers } = require('../lib/analyst/impact');
const { sliceNginx, slicePhpChangelog, fetchChangelog } = require('../lib/analyst/changelog');
const { mask, parseSummary, readEnvFile } = require('../lib/analyst/llm');
const { loadPlugins } = require('../lib/core/plugins');

const SECRET = 'sk-test-SECRET-1234567890';

const UPGRADING = `PHP 8.4 UPGRADE NOTES

1. Backward Incompatible Changes
  - Core: The \`round()\` function now behaves differently.

2. Removed Extensions and SAPIs
  - The IMAP extension has been moved to PECL.
  - The \`legacy_fn()\` function has been removed.

3. Deprecated Features
  - Core: Using \`old_helper()\` is deprecated.
`;

const NGINX = `
Changes with nginx 1.31.7                                        01 Oct 2026

    *) Bugfix: something.

Changes with nginx 1.31.3                                        01 Sep 2026

    *) Bugfix: old.
`;

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'analyst-')); }

function makeCtx({ llmUrl, envFile, extra = {}, exec, fetchText, patterns } = {}) {
  const base = tmp();
  const pub = path.join(base, 'site', 'public_html');
  fs.mkdirSync(pub, { recursive: true });
  const runDir = path.join(base, 'run');
  fs.mkdirSync(runDir);
  const logs = [];
  const mk = (level) => (msg, data) => logs.push({ level, msg: String(msg), data });
  return {
    logs,
    base,
    ctx: {
      profile: {
        webRoots: [{ domain: 'a.test', env: 'test', path: path.join(base, 'site'), repoPath: 'site' }],
        analyst: { llmUrl, llmEnvFile: envFile, phpcsBin: 'phpcs', ...extra },
      },
      profileDir: base,
      repoPath: (p) => (path.isAbsolute(p) ? p : path.join(base, p)),
      run: { id: 'r', dir: runDir },
      log: { info: mk('info'), warn: mk('warn'), error: mk('error'), debug: mk('debug') },
      semver,
      analyst: {
        exec,
        fetchText: fetchText || (async (url) => {
          if (/UPGRADING/.test(url)) return UPGRADING;
          if (/ChangeLog/.test(url)) return '<h3>Version 8.4.27</h3><ul><li>Fixed bug</li></ul>';
          if (/nginx\.org/.test(url)) return NGINX;
          throw new Error('HTTP 404');
        }),
        patterns: patterns || { php: { extensions: { imap: { pattern: 'imap_[a-z_]+\\(' } } } },
      },
    },
  };
}

const PHP_DECISION = { ecosystem: 'php-runtime', scope: '8.3', name: 'php', installed: '8.3.36', target: '8.4.27', tier: 'B', action: 'propose', reasons: [] };

function fakeExec(phpcsJson, { grepOut = '', modules = 'Core\ndate\nimap\njson\n', baseline = { files: {} } } = {}) {
  const calls = [];
  const fn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false, missing: false });
    if (cmd === 'phpcs') return ok(JSON.stringify(args.includes('8.3') ? baseline : phpcsJson));
    if (cmd === 'php8.4') return ok(modules);
    if (cmd === 'dpkg-query') return ok('ii |1.0.3-1');
    if (cmd === 'sh') return ok('');
    if (cmd === 'grep') return { ...ok(grepOut), code: grepOut ? 0 : 1 };
    return { code: 127, stdout: '', stderr: '', missing: true };
  };
  fn.calls = calls;
  return fn;
}

function fakeLlmServer(handler) {
  const seen = { auth: [], bodies: [] };
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      seen.auth.push(req.headers.authorization);
      seen.bodies.push(b);
      handler(req, res, seen);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

const okLlm = (req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content: '```json\n{"summary":"English summary.","riskNotes":["watch FPM pool"]}\n```' } }] }));
};

function envFile(dir, content = `LLM_API_KEY=${SECRET}\n`, name = 'llm.env') {
  const f = path.join(dir, name);
  fs.writeFileSync(f, content);
  return f;
}

test('analyst helpers are not loaded as plugins; index is', () => {
  const names = loadPlugins('analyst', { profile: {} }).map((p) => p.name);
  assert.deepEqual(names, ['impact-analyst']);
});

test('extractIdentifiers: removed vs deprecated vs changed, ignores plain words', () => {
  const ids = extractIdentifiers(UPGRADING);
  const by = Object.fromEntries(ids.map((i) => [i.id, i.kind]));
  assert.equal(by.legacy_fn, 'removed');
  assert.equal(by.old_helper, 'deprecated');
  assert.equal(by.round, 'changed'); // behaviour change: never a removal hit
  assert.equal(by.imap, undefined); // plain word, no parens/underscore
});

test('changelog slicing: nginx range and php.net sections', () => {
  const s = sliceNginx(NGINX, '1.31.3', '1.31.7', semver);
  assert.match(s, /1\.31\.7/);
  assert.doesNotMatch(s, /1\.31\.3\s/);
  const p = slicePhpChangelog('### Version 8.4.27\nA\n### Version 8.3.36\nB', '8.3.36', '8.4.27', semver);
  assert.match(p, /8\.4\.27/);
  assert.doesNotMatch(p, /Version 8\.3\.36/);
});

test('fetchChangelog caches raw text under <run>/changelogs', async () => {
  const { ctx } = makeCtx({});
  const a = await fetchChangelog(PHP_DECISION, ctx);
  assert.equal(a.error, null);
  assert.ok(a.file && fs.existsSync(a.file));
  assert.match(a.file, /changelogs/);
  const b = await fetchChangelog(PHP_DECISION, ctx);
  assert.equal(b.cached, true);
});

test('php target: phpcs error -> needs-code-change; fake LLM writes the summaries; key never logged', async () => {
  const { server, seen, url } = await fakeLlmServer(okLlm);
  try {
    const { ctx, base, logs } = makeCtx({ llmUrl: url });
    ctx.profile.analyst.llmEnvFile = envFile(base);
    ctx.analyst.exec = fakeExec({
      totals: { errors: 1, warnings: 1 },
      files: { [path.join(base, 'site', 'public_html', 'a.php')]: { messages: [
        { type: 'ERROR', line: 7, source: 'PHPCompatibility.FunctionUse.RemovedFunctions', message: "Function legacy_fn() is removed since PHP 8.4." },
        { type: 'WARNING', line: 9, source: 'PHPCompatibility.X', message: 'Implicitly nullable parameter is deprecated since PHP 8.4' },
      ] } },
    });
    const r = await analyst.analyze([PHP_DECISION], ctx);
    const c = r.candidates[0];
    assert.equal(c.verdict, 'needs-code-change');
    assert.equal(c.codeChanges[0].file, 'a.php');
    assert.equal(c.codeChanges[0].line, 7);
    assert.equal(c.summary, 'English summary.');
    assert.equal(c.llm.provider, 'primary');
    assert.equal(seen.auth[0], `Bearer ${SECRET}`);
    assert.ok(r.proposals.length === 1 && r.proposals[0].tier === 'B');
    assert.ok(!JSON.stringify({ r, logs }).includes(SECRET));
    const phpcs = ctx.analyst.exec.calls.find((x) => x[0] === 'phpcs');
    assert.ok(phpcs.includes('--parallel=4') && phpcs.includes('testVersion') && phpcs.includes('8.4'));
    assert.match(phpcs.join(' '), /--ignore=\*\/vendor\/\*,\*\/node_modules\/\*,\*\/assets\/\*/);
  } finally { server.close(); }
});

test('phpcs findings that also exist for the installed minor are not counted (baseline diff)', async () => {
  const { ctx, base } = makeCtx({ llmUrl: 'http://127.0.0.1:1' });
  ctx.profile.analyst.llmEnvFile = path.join(base, 'missing.env');
  const f = path.join(base, 'site', 'public_html', 'old.php');
  const msg = { type: 'ERROR', line: 3, source: 'PHPCompatibility.Old', message: 'old problem' };
  ctx.analyst.exec = fakeExec({ files: { [f]: { messages: [msg] } } }, { baseline: { files: { [f]: { messages: [msg] } } } });
  const r = await analyst.analyze([PHP_DECISION], ctx);
  assert.equal(r.candidates[0].verdict, 'safe');
  assert.equal(r.candidates[0].impact.php.phpcs.preExistingErrors, 1);
});

test('php target: imap usage + loaded php8.4-imap => safe-with-notes listing the files', async () => {
  const { ctx, base } = makeCtx({ llmUrl: 'http://127.0.0.1:1', extra: {} });
  ctx.profile.analyst.llmEnvFile = path.join(base, 'missing.env');
  const pub = path.join(base, 'site', 'public_html');
  ctx.analyst.exec = fakeExec({ totals: { errors: 1 }, files: { [path.join(pub, 'includes/services/zoho_mail_imap.php')]: { messages: [
    { type: 'ERROR', line: 12, source: 'PHPCompatibility.Extensions.RemovedExtensions', message: "Extension 'imap' is removed since PHP 8.4" },
  ] } } }, { grepOut: `${pub}/includes/services/zoho_mail_imap.php:12:imap_open(\n${pub}/includes/site_editor/se_custom_domain_zoho.php:30:imap_close(` });
  const r = await analyst.analyze([PHP_DECISION], ctx);
  const c = r.candidates[0];
  assert.equal(c.verdict, 'safe');
  assert.equal(c.verdictDetail, 'safe-with-notes');
  const notes = c.riskNotes.join('\n');
  assert.match(notes, /zoho_mail_imap\.php/);
  assert.match(notes, /se_custom_domain_zoho\.php/);
  assert.match(notes, /php8\.4-imap 1\.0\.3-1 installed/);
  assert.equal(c.impact.php.extensions.imap.loadedInTarget, true);
});

test('imap missing from target binary => needs-code-change', async () => {
  const { ctx, base } = makeCtx({ llmUrl: 'http://127.0.0.1:1' });
  ctx.profile.analyst.llmEnvFile = path.join(base, 'missing.env');
  const pub = path.join(base, 'site', 'public_html');
  ctx.analyst.exec = fakeExec({ files: {} }, { modules: 'Core\ndate\n', grepOut: `${pub}/x.php:3:imap_open(` });
  const r = await analyst.analyze([PHP_DECISION], ctx);
  assert.equal(r.candidates[0].verdict, 'needs-code-change');
  assert.match(r.candidates[0].codeChanges[0].what, /not loaded/);
});

test('LLM unavailable (closed port): run completes, warning finding, Romanian fallback summary', async () => {
  const { ctx, base } = makeCtx({ llmUrl: 'http://127.0.0.1:1' });
  ctx.profile.analyst.llmEnvFile = envFile(base);
  ctx.analyst.exec = fakeExec({ files: {} });
  const r = await analyst.analyze([PHP_DECISION], ctx);
  assert.equal(r.candidates[0].verdict, 'safe');
  assert.equal(r.candidates[0].llm, null);
  assert.match(r.candidates[0].summary, /no code change needed/);
  assert.ok(r.findings.some((f) => f.component === 'analyst:llm' && f.severity === 'warn'));
  assert.ok(!JSON.stringify(r).includes(SECRET));
});

test('LLM 401 and 5xx are treated as unavailable', async () => {
  for (const status of [401, 503]) {
    const { server, url } = await fakeLlmServer((req, res) => { res.statusCode = status; res.end('{"error":"x"}'); });
    try {
      const { ctx, base } = makeCtx({ llmUrl: url });
      ctx.profile.analyst.llmEnvFile = envFile(base);
      ctx.analyst.exec = fakeExec({ files: {} });
      const r = await analyst.analyze([PHP_DECISION, { ...PHP_DECISION, name: 'php2', target: '8.4.28' }], ctx);
      assert.equal(r.candidates.length, 2);
      assert.ok(r.findings.some((f) => f.component === 'analyst:llm'), `status ${status}`);
    } finally { server.close(); }
  }
});

test('missing env file / key => LLM skipped with warning, no failure', async () => {
  const { ctx, base, logs } = makeCtx({ llmUrl: 'http://127.0.0.1:1' });
  ctx.profile.analyst.llmEnvFile = path.join(base, 'nope.env');
  ctx.analyst.exec = fakeExec({ files: {} });
  const r = await analyst.analyze([PHP_DECISION], ctx);
  assert.equal(r.candidates.length, 1);
  assert.ok(logs.some((l) => l.level === 'warn' && /skipping primary/.test(l.msg)));
});

test('anthropic fallback: only tier B, only when the env file exists', async () => {
  const anth = await fakeLlmServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ content: [{ type: 'text', text: '{"summary":"From anthropic."}' }] }));
  });
  try {
    const down = { llmUrl: 'http://127.0.0.1:1' };
    for (const [tier, withFile, expect] of [['B', true, 'anthropic'], ['A', true, null], ['B', false, null]]) {
      const { ctx, base } = makeCtx(down);
      ctx.profile.analyst.llmEnvFile = envFile(base);
      ctx.profile.analyst.anthropicUrl = anth.url;
      ctx.profile.analyst.anthropicEnvFile = withFile ? envFile(base, 'ANTHROPIC_API_KEY=sk-ant-SECRETSECRET\n', 'anthropic-api.env') : path.join(base, 'secrets/anthropic-api.env');
      ctx.analyst.exec = fakeExec({ files: {} });
      const r = await analyst.analyze([{ ...PHP_DECISION, tier }], ctx);
      assert.equal(r.candidates[0].llm && r.candidates[0].llm.provider, expect, `${tier}/${withFile}`);
      assert.ok(!JSON.stringify(r).includes('sk-ant-SECRETSECRET'));
    }
  } finally { anth.server.close(); }
});

test('policy hold => blocked, no network, no impact run', async () => {
  const { ctx } = makeCtx({ llmUrl: 'http://127.0.0.1:1' });
  ctx.analyst.exec = fakeExec({ files: {} });
  ctx.analyst.fetchText = async () => { throw new Error('must not fetch'); };
  const r = await analyst.analyze([{ ecosystem: 'npm', scope: 'automation/apps/x', name: 'express', installed: '5.1.0', target: '5.3.0', tier: 'B', action: 'hold', reasons: ['known regression'] }], ctx);
  assert.equal(r.candidates[0].verdict, 'blocked');
  assert.match(r.candidates[0].blockers[0], /known regression/);
  assert.equal(ctx.analyst.exec.calls.length, 0);
});

test('library usage x changelog keywords (intl-tel-input utilsScript removed => needs-code-change)', async () => {
  const { ctx, base } = makeCtx({ llmUrl: 'http://127.0.0.1:1' });
  ctx.profile.analyst.llmEnvFile = path.join(base, 'missing.env');
  const pub = path.join(base, 'site', 'public_html');
  ctx.analyst.patterns = { libraries: { 'intl-tel-input': { patterns: { utilsScript: 'utilsScript', separateDialCode: 'separateDialCode' } } } };
  ctx.analyst.exec = async (cmd, args) => {
    if (cmd === 'grep') {
      const hit = args.includes('utilsScript') ? `${pub}/includes/functions/phone_input_setup.php:40:utilsScript: "x"` : '';
      return { code: hit ? 0 : 1, stdout: hit, stderr: '' };
    }
    return { code: 127, stdout: '', stderr: '', missing: true };
  };
  ctx.analyst.fetchText = async (url) => {
    if (/registry\.npmjs/.test(url)) return JSON.stringify({ repository: { url: 'git+https://github.com/jackocnr/intl-tel-input.git' } });
    if (/api\.github\.com/.test(url)) return JSON.stringify([{ tag_name: 'v25.0.0', body: '## Breaking\n- The `utilsScript` option has been removed, use loadUtils instead.\n- separateDialCode now defaults to true' }]);
    throw new Error('404');
  };
  const r = await analyst.analyze([{ ecosystem: 'vendor-js', scope: null, name: 'intl-tel-input', installed: '24.0.0', target: '25.0.0', tier: 'B', action: 'propose' }], ctx);
  const c = r.candidates[0];
  assert.equal(c.verdict, 'needs-code-change');
  assert.equal(c.codeChanges[0].file, 'includes/functions/phone_input_setup.php');
  assert.match(c.codeChanges[0].what, /utilsScript/);
});

test('mask / parseSummary / readEnvFile', () => {
  assert.equal(mask('Bearer abcdef123456789 and key sk-abcdefgh12345', []), 'Bearer *** and key ***');
  assert.equal(mask('token=hunter22secret', ['hunter22secret']), 'token=***');
  assert.equal(parseSummary('{"summary":"b"}').summary, 'b');
  assert.equal(parseSummary('plain text').summary, 'plain text');
  const d = tmp();
  const f = path.join(d, 'e.env');
  fs.writeFileSync(f, '# c\nA="x y"\nexport B=2\n');
  assert.deepEqual(readEnvFile(f), { A: 'x y', B: '2' });
  assert.equal(readEnvFile(path.join(d, 'none')), null);
});
