'use strict';
// Deterministic impact analysis. NO LLM here. Everything runs on the host that owns the code
// (never over an sshfs mount) and is strictly read-only / dry-run.
//   php-runtime : phpcs PHPCompatibility (testVersion <major.minor>), `php<target> -l`, extension
//                 availability in the target binary, extension-usage patterns, removed/deprecated
//                 identifiers grepped from the changelog
//   composer/npm: removed/deprecated identifiers from the changelog + `composer update <pkg> --dry-run`
//                 / `npm update <pkg> --dry-run` lock diff
//   libraries   : per-library usage patterns (options/methods/events we really use) intersected with
//                 changelog keywords
// Result: { codeChanges[{file,line,what}], riskNotes[], blockers[], details{} }
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PHPCS_TIMEOUT = 20 * 60 * 1000;
const EXCLUDE_DIRS = ['vendor', 'node_modules', '_legacy'];
const MAX_CODE_CHANGES = 120;
const STOP_IDS = new Set(['true', 'false', 'null', 'array', 'string', 'object', 'false()', 'null()']);

function defaultExec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(cmd, args, {
      timeout: opts.timeout || 60000,
      maxBuffer: 512 * 1024 * 1024,
      cwd: opts.cwd || undefined,
      env: Object.assign({}, process.env, opts.env || {}),
    }, (err, stdout, stderr) => resolve({
      code: err ? (typeof err.code === 'number' ? err.code : 127) : 0,
      stdout: String(stdout || ''),
      stderr: String(stderr || ''),
      timedOut: !!(err && err.killed),
      missing: !!(err && err.code === 'ENOENT'),
      error: err && typeof err.code !== 'number' ? String(err.message || err) : null,
      ms: Date.now() - started,
    }));
  });
}

const execOf = (ctx) => (ctx.analyst && ctx.analyst.exec) || defaultExec;
const logOf = (ctx) => ctx.log || { info() {}, warn() {}, error() {}, debug() {} };

function parseJsonLoose(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* fall through */ }
  const open = s.search(/[{[]/);
  const close = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (open < 0 || close <= open) return null;
  try { return JSON.parse(s.slice(open, close + 1)); } catch { return null; }
}

// ------------------------------------------------------------------ roots
function testRoots(ctx) {
  const roots = ((ctx.profile && ctx.profile.webRoots) || []).filter((r) => r.env === 'test');
  const abs = (p) => (ctx.repoPath ? ctx.repoPath(p) : p);
  const seen = new Set();
  const out = [];
  for (const r of roots) {
    const dir = path.join(abs(r.repoPath || r.path), 'public_html');
    let real = dir;
    try { real = fs.realpathSync(dir); } catch { /* missing dir: keep as is */ }
    if (seen.has(real)) continue; // several domains may share one tree (symlinks)
    seen.add(real);
    out.push({ domain: r.domain, dir: real, repoDir: abs(r.repoPath || r.path), webDir: r.path });
  }
  // The platform tree is shared by every test domain: scan the first one only (override: analyst.scanAllTestRoots).
  return (ctx.profile.analyst && ctx.profile.analyst.scanAllTestRoots) ? out : out.slice(0, 1);
}

function rootForScope(ctx, scope) {
  const all = ((ctx.profile && ctx.profile.webRoots) || []);
  const r = all.find((x) => x.domain === scope);
  if (!r) return null;
  const abs = (p) => (ctx.repoPath ? ctx.repoPath(p) : p);
  return { domain: r.domain, dir: path.join(abs(r.repoPath || r.path), 'public_html') };
}

// ------------------------------------------------------------------ grep (server-local)
async function grepRoots(ctx, { patterns, roots, includes, fixed = false, word = false, maxHits = 500, excludeDirs = EXCLUDE_DIRS }) {
  const exec = execOf(ctx);
  const hits = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const args = ['-rnI', fixed ? '-F' : '-E'];
    if (word) args.push('-w');
    for (const i of includes) args.push(`--include=${i}`);
    for (const d of excludeDirs) args.push(`--exclude-dir=${d}`);
    args.push('--exclude=*.min.js');
    for (const p of patterns) args.push('-e', p);
    args.push('--', root);
    const r = await exec('grep', args, { timeout: 5 * 60 * 1000 });
    for (const line of r.stdout.split('\n')) {
      const m = /^(.*?):(\d+):(.*)$/.exec(line);
      if (!m) continue;
      hits.push({ file: path.relative(root, m[1]) || m[1], root, line: Number(m[2]), text: m[3].trim().slice(0, 200) });
      if (hits.length >= maxHits) return hits;
    }
  }
  return hits;
}

// ------------------------------------------------------------------ changelog keyword extraction
const REMOVED_RE = /\b(remov(ed|es|al)|no longer|dropped|drops?)\b/i;
const DEPRECATED_RE = /\bdeprecat/i;
const RENAMED_RE = /\b(renam(ed|es)|moved to)\b/i;
const CHANGED_RE = /\b(breaking|backward[- ]incompat|incompatible|changed|replaced)\b/i;

function classifyLine(line, headingKind) {
  if (REMOVED_RE.test(line) || RENAMED_RE.test(line)) return 'removed';
  if (DEPRECATED_RE.test(line)) return 'deprecated';
  if (headingKind === 'removed') return 'removed';
  if (headingKind === 'deprecated') return 'deprecated';
  if (CHANGED_RE.test(line) || headingKind === 'changed') return 'changed';
  return null;
}

function headingKindOf(line) {
  if (/remov/i.test(line)) return 'removed';
  if (DEPRECATED_RE.test(line)) return 'deprecated';
  if (/breaking|backward|incompat/i.test(line)) return 'changed';
  return null;
}

const isHeading = (l) => /^\s*(#{1,6}\s|\d+\.\s+[A-Z]|[A-Z][A-Za-z ,/&-]{3,60}:?\s*$|\*\*[^*]+\*\*\s*:?\s*$)/.test(l) && !/^\s*[-*]\s/.test(l);

// -> [{ id, kind: removed|deprecated|changed, line }]
function extractIdentifiers(text) {
  const out = new Map();
  let headingKind = null;
  for (const line of String(text || '').split('\n')) {
    if (isHeading(line)) { headingKind = headingKindOf(line); }
    const kind = classifyLine(line, headingKind);
    if (!kind) continue;
    const ids = new Set();
    for (const m of line.matchAll(/`([^`]{2,80})`/g)) ids.add(m[1].trim());
    for (const m of line.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\(\)/g)) ids.add(`${m[1]}()`);
    for (const raw of ids) {
      const hadParens = /\(\)?$/.test(raw);
      const id = raw.replace(/\(.*$/, '');
      if (!/^\\?[A-Za-z_][A-Za-z0-9_\\]*(::\$?[A-Za-z_]\w*)?$/.test(id) || id.length < 5 || STOP_IDS.has(id.toLowerCase())) continue;
      const interesting = hadParens || id.includes('_') || id.includes('::') || /[a-z][A-Z]/.test(id) || /^[A-Z][A-Z0-9_]{4,}$/.test(id);
      if (!interesting) continue;
      const prev = out.get(id);
      if (!prev || (kind === 'removed' && prev.kind !== 'removed')) out.set(id, { id, kind, line: line.trim().slice(0, 220) });
    }
  }
  return [...out.values()].slice(0, 150);
}

function mmOf(ver) {
  const m = /^v?(\d+)\.(\d+)/.exec(String(ver || ''));
  return m ? `${m[1]}.${m[2]}` : null;
}

function extFromPhpcs(message) {
  let m = /[Ee]xtension\s+['"]?([a-z0-9_]+)['"]?/.exec(message);
  if (m) return m[1].toLowerCase();
  m = /^(?:The\s+)?(?:[Ff]unction|[Cc]onstant)\s+['"]?([A-Za-z0-9]+)_/.exec(message);
  return m ? m[1].toLowerCase() : null;
}

// ------------------------------------------------------------------ PHP runtime
async function phpImpact(item, changelog, ctx, acc) {
  const exec = execOf(ctx);
  const log = logOf(ctx);
  const mm = mmOf(item.target);
  const cfg = (ctx.profile && ctx.profile.analyst) || {};
  const patterns = (ctx.analyst && ctx.analyst.patterns) || {};
  const roots = testRoots(ctx);
  const rootDirs = roots.map((r) => r.dir).filter((d) => fs.existsSync(d));
  const details = { target: mm, roots: rootDirs, phpcs: null, lint: null, extensions: {} };
  acc.details.php = details;
  if (!mm) { acc.riskNotes.push(`cannot derive major.minor from target ${item.target}`); return; }
  if (!rootDirs.length) { acc.riskNotes.push('no test public_html root found for the PHP compatibility scan'); return; }

  // Extensions loaded by the target binary + package status.
  const bin = `php${mm}`;
  const loaded = new Set();
  const mods = await exec(bin, ['-m'], { timeout: 20000 });
  if (mods.missing || mods.code !== 0) {
    details.binary = { name: bin, present: false };
    acc.riskNotes.push(`${bin} binary not available on this host: syntax lint and extension check skipped`);
  } else {
    details.binary = { name: bin, present: true };
    for (const l of mods.stdout.split('\n')) if (/^[A-Za-z0-9_ .-]+$/.test(l.trim()) && l.trim() && !l.startsWith('[')) loaded.add(l.trim().toLowerCase());
  }
  const pkgStatus = async (ext) => {
    const r = await exec('dpkg-query', ['-W', '-f=${db:Status-Abbrev}|${Version}', `php${mm}-${ext}`], { timeout: 10000 });
    return r.code === 0 && /^ii/.test(r.stdout) ? { package: `php${mm}-${ext}`, installed: true, version: r.stdout.split('|')[1] } : { package: `php${mm}-${ext}`, installed: false };
  };

  // phpcs PHPCompatibility.
  const phpcsBin = cfg.phpcsBin || 'phpcs';
  const phpcsErrors = [];
  const phpcsWarnings = [];
  const totals = { errors: 0, warnings: 0, preExistingErrors: 0, files: 0, timedOut: false, roots: [], baselineVersion: null };
  const baseMm = mmOf(item.installed);
  const runPhpcs = async (root, testVersion) => {
    const r = await exec(phpcsBin, [
      '--standard=PHPCompatibility', '--runtime-set', 'testVersion', testVersion, '--report=json', '--extensions=php',
      '--ignore=*/vendor/*,*/node_modules/*,*/assets/*,*/_legacy/*', '--parallel=4', '-q', root,
    ], { timeout: PHPCS_TIMEOUT });
    return { r, j: parseJsonLoose(r.stdout) };
  };
  const flat = (root, j) => {
    const list = [];
    for (const [file, v] of Object.entries((j && j.files) || {})) {
      for (const m of v.messages || []) list.push({ type: m.type, file: path.relative(root, file), line: m.line, source: m.source, message: m.message, ext: extFromPhpcs(m.message) });
    }
    return list;
  };
  const sig = (e) => `${e.file}|${e.source}|${e.message}`;
  for (const root of rootDirs) {
    const label = path.basename(path.dirname(root));
    const { r, j } = await runPhpcs(root, mm);
    if (r.missing) { acc.riskNotes.push(`phpcs not found (${phpcsBin}): PHPCompatibility scan skipped`); break; }
    if (r.timedOut) { totals.timedOut = true; acc.riskNotes.push(`phpcs timed out after ${PHPCS_TIMEOUT / 60000} min on ${label}: scan incomplete`); }
    if (!j || !j.files) {
      if (!r.timedOut) acc.riskNotes.push(`phpcs produced no JSON for ${label} (exit ${r.code})`);
      continue;
    }
    totals.roots.push(root);
    totals.files += Object.keys(j.files).length;
    let all = flat(root, j);
    // Baseline: findings that already exist for the installed minor are not caused by this upgrade.
    if (baseMm && baseMm !== mm) {
      const b = await runPhpcs(root, baseMm);
      if (b.j && b.j.files) {
        totals.baselineVersion = baseMm;
        const known = new Set(flat(root, b.j).map(sig));
        const fresh = all.filter((e) => !known.has(sig(e)));
        totals.preExistingErrors += all.filter((e) => e.type === 'ERROR').length - fresh.filter((e) => e.type === 'ERROR').length;
        all = fresh;
      } else {
        acc.riskNotes.push(`phpcs baseline for ${baseMm} unavailable: results include findings that already exist on the installed version`);
      }
    }
    for (const e of all) (e.type === 'ERROR' ? phpcsErrors : phpcsWarnings).push(e);
  }
  totals.errors = phpcsErrors.length;
  totals.warnings = phpcsWarnings.length;
  details.phpcs = totals;
  if (totals.preExistingErrors) acc.riskNotes.push(`${totals.preExistingErrors} phpcs error(s) are pre-existing on PHP ${baseMm} (identical on ${mm}) and are not counted against the upgrade`);

  // Errors about an extension that IS loaded in the target binary are downgraded to notes.
  const demoted = new Map();
  for (const e of phpcsErrors) {
    if (e.ext && loaded.has(e.ext)) {
      if (!demoted.has(e.ext)) demoted.set(e.ext, []);
      demoted.get(e.ext).push(e);
    } else {
      acc.codeChanges.push({ file: e.file, line: e.line, what: `phpcs ${e.source}: ${e.message}` });
    }
  }
  for (const [ext, list] of demoted) {
    const st = await pkgStatus(ext);
    details.extensions[ext] = { loadedInTarget: true, ...st };
    acc.riskNotes.push(`PHPCompatibility flags ${list.length} ${ext} usage(s) as removed, but ${bin} loads ${ext} (${st.installed ? `${st.package} ${st.version} installed (PECL build)` : 'package status unknown'}): ${list.slice(0, 4).map((x) => `${x.file}:${x.line}`).join(', ')}`);
  }
  if (phpcsWarnings.length) {
    const bySrc = {};
    for (const w of phpcsWarnings) bySrc[w.message] = (bySrc[w.message] || 0) + 1;
    const top = Object.entries(bySrc).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([m, n]) => `${n}× ${m}`);
    acc.riskNotes.push(`phpcs: ${phpcsWarnings.length} deprecation warning(s) for PHP ${mm}; top: ${top.join(' | ')}`);
  }

  // Syntax lint with the target binary.
  if (details.binary.present) {
    const lint = { errors: [], warnings: 0 };
    for (const root of rootDirs) {
      const script = 'find "$1" \\( -name vendor -o -name node_modules -o -name assets -o -name _legacy \\) -prune -o -name "*.php" -print0 | xargs -0 -r -P4 -n40 "$2" -l 2>&1 | grep -v "^No syntax errors detected"';
      const r = await exec('sh', ['-c', script, 'lint', root, bin], { timeout: PHPCS_TIMEOUT });
      for (const l of r.stdout.split('\n')) {
        const m = /^(?:PHP\s+)?(Parse error|Fatal error)[:\s]+(.*) in (.*) on line (\d+)/.exec(l);
        if (m) lint.errors.push({ file: path.relative(root, m[3]), line: Number(m[4]), what: `${bin} -l: ${m[1]}: ${m[2]}` });
        else if (/^(PHP\s+)?Deprecated/.test(l)) lint.warnings++;
      }
    }
    details.lint = { binary: bin, errors: lint.errors.length, deprecations: lint.warnings };
    for (const e of lint.errors) acc.codeChanges.push(e);
    if (lint.warnings) acc.riskNotes.push(`${bin} -l reports ${lint.warnings} deprecation notice(s) at compile time`);
  }

  // Extension usage patterns from the profile (e.g. imap_* when the extension left core).
  const extPatterns = (patterns.php && patterns.php.extensions) || {};
  for (const [ext, spec] of Object.entries(extPatterns)) {
    const regex = typeof spec === 'string' ? spec : spec.pattern;
    const hits = await grepRoots(ctx, { patterns: [regex], roots: rootDirs, includes: ['*.php'], maxHits: 300 });
    const files = [...new Set(hits.map((h) => h.file))];
    const st = await pkgStatus(ext);
    const isLoaded = loaded.has(ext);
    details.extensions[ext] = { ...(details.extensions[ext] || {}), loadedInTarget: isLoaded, ...st, usageFiles: files, usageHits: hits.length };
    if (!hits.length) continue;
    const where = files.map((f) => `${f} (${hits.filter((h) => h.file === f).length}×)`).join(', ');
    if (!isLoaded && details.binary.present) {
      for (const h of hits.slice(0, 40)) acc.codeChanges.push({ file: h.file, line: h.line, what: `${ext} extension is not loaded in ${bin}: ${h.text}` });
    } else {
      acc.riskNotes.push(`${ext}_* functions are used in ${files.length} file(s): ${where}. ${ext} is no longer bundled with PHP ${mm}; ${bin} ${isLoaded ? `loads it (${st.installed ? `${st.package} ${st.version} installed, PECL build` : 'status unknown'})` : 'could not be checked'} — keep the PECL package installed on every host and in FPM before switching`);
    }
  }

  // Removed/deprecated identifiers listed in the changelog.
  await identifierGrep(item, changelog, ctx, acc, rootDirs, ['*.php'], loaded);
  log.info(`php ${mm}: phpcs ${totals.errors}E/${totals.warnings}W`);
}

// grep our code for identifiers the changelog calls removed/deprecated.
async function identifierGrep(item, changelog, ctx, acc, roots, includes, loadedExts = new Set()) {
  const ids = extractIdentifiers(changelog && changelog.text);
  acc.details.changelogIdentifiers = { total: ids.length, removed: ids.filter((i) => i.kind === 'removed').length, deprecated: ids.filter((i) => i.kind === 'deprecated').length };
  const want = ids.filter((i) => i.kind !== 'changed');
  if (!want.length || !roots.length) return;
  const dir = ctx.run && ctx.run.dir ? ctx.run.dir : os.tmpdir();
  const pf = path.join(dir, `.ids-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(pf, want.map((i) => i.id).join('\n') + '\n');
  const exec = execOf(ctx);
  const hitsAll = [];
  try {
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      const args = ['-rnIwF', '-f', pf, ...includes.map((i) => `--include=${i}`), ...EXCLUDE_DIRS.map((d) => `--exclude-dir=${d}`), '--exclude-dir=assets', '--', root];
      const r = await exec('grep', args, { timeout: 5 * 60 * 1000 });
      for (const line of r.stdout.split('\n').slice(0, 2000)) {
        const m = /^(.*?):(\d+):(.*)$/.exec(line);
        if (m) hitsAll.push({ file: path.relative(root, m[1]), line: Number(m[2]), text: m[3] });
      }
    }
  } finally { try { fs.unlinkSync(pf); } catch { /* ignore */ } }
  const byId = new Map();
  for (const h of hitsAll) {
    for (const i of want) {
      if (!h.text.includes(i.id.replace(/^\\/, '').split('::').pop())) continue;
      const prefix = i.id.split('_')[0].toLowerCase();
      if (loadedExts.has(prefix)) continue; // extension still available in target
      if (!byId.has(i.id)) byId.set(i.id, { def: i, hits: [] });
      byId.get(i.id).hits.push(h);
    }
  }
  for (const { def, hits } of byId.values()) {
    if (def.kind === 'removed') {
      for (const h of hits.slice(0, 5)) acc.codeChanges.push({ file: h.file, line: h.line, what: `uses \`${def.id}\` — changelog: ${def.line}` });
    } else {
      acc.riskNotes.push(`deprecated \`${def.id}\` used in ${hits.length} place(s), e.g. ${hits[0].file}:${hits[0].line}`);
    }
  }
}

// ------------------------------------------------------------------ library usage patterns
function libraryPatterns(patterns, name) {
  const libs = (patterns && patterns.libraries) || {};
  const n = String(name).toLowerCase().replace(/^@[^/]+\//, '');
  for (const [k, v] of Object.entries(libs)) {
    if (k.toLowerCase() === n || (v.aliases || []).some((a) => String(a).toLowerCase() === n)) return { key: k, ...v };
  }
  return null;
}

async function usageImpact(item, changelog, ctx, acc, lib) {
  const roots = testRoots(ctx).map((r) => r.dir).filter((d) => fs.existsSync(d));
  const includes = lib.include || ['*.js', '*.php', '*.html'];
  const usage = {};
  const lines = String((changelog && changelog.text) || '').split('\n');
  let headingKind = null;
  const classified = lines.map((l) => { if (isHeading(l)) headingKind = headingKindOf(l); return { l, kind: classifyLine(l, headingKind) }; });
  for (const [key, spec] of Object.entries(lib.patterns || {})) {
    const regex = typeof spec === 'string' ? spec : spec.pattern;
    const keywords = (typeof spec === 'object' && spec.keywords) || [key.replace(/\*$/, '')];
    const hits = await grepRoots(ctx, { patterns: [regex], roots, includes, maxHits: 400 });
    usage[key] = { hits: hits.length, files: [...new Set(hits.map((h) => h.file))].length };
    if (!hits.length) continue;
    const rel = classified.filter(({ l, kind }) => kind && keywords.some((k) => l.toLowerCase().includes(String(k).toLowerCase())));
    if (!rel.length) continue;
    const worst = rel.find((r) => r.kind === 'removed') || rel.find((r) => r.kind === 'deprecated') || rel[0];
    if (worst.kind === 'removed') {
      for (const h of hits.slice(0, 8)) acc.codeChanges.push({ file: h.file, line: h.line, what: `uses \`${key}\` — changelog: ${worst.l.trim().slice(0, 200)}` });
    } else {
      acc.riskNotes.push(`changelog mentions \`${key}\` (${worst.kind}) and we use it in ${usage[key].files} file(s): ${worst.l.trim().slice(0, 160)}`);
    }
  }
  acc.details.libraryUsage = { library: lib.key, usage };
}

// ------------------------------------------------------------------ lock diff (dry-run only)
async function lockDiff(item, ctx, acc) {
  const exec = execOf(ctx);
  const env = { COMPOSER_ALLOW_SUPERUSER: '1', COMPOSER_NO_INTERACTION: '1', NO_COLOR: '1' };
  let r;
  let changes = [];
  if (item.ecosystem === 'composer') {
    const root = rootForScope(ctx, item.scope);
    if (!root || !fs.existsSync(path.join(root.dir, 'composer.lock'))) return;
    r = await exec('composer', ['update', item.name, '--dry-run', '--no-scripts', '--no-plugins', '--no-interaction', '--no-progress', '--no-ansi'], { cwd: root.dir, env, timeout: 5 * 60 * 1000 });
    const text = `${r.stdout}\n${r.stderr}`;
    for (const m of text.matchAll(/^\s*-\s+(Upgrading|Downgrading|Installing|Removing)\s+(\S+)\s+\(([^)]*)\)/gm)) {
      const [from, to] = m[3].split('=>').map((s) => s.trim());
      changes.push({ action: m[1].toLowerCase(), name: m[2], from: to ? from : null, to: to || from });
    }
    if (r.code !== 0 && !changes.length) {
      acc.blockers.push(`composer update ${item.name} --dry-run failed: ${text.split('\n').filter((l) => /conflict|Problem|requires|error/i.test(l)).slice(0, 3).join(' | ').slice(0, 300) || `exit ${r.code}`}`);
    }
  } else if (item.ecosystem === 'npm') {
    const dir = ctx.repoPath ? ctx.repoPath(item.scope) : item.scope;
    if (!dir || !fs.existsSync(path.join(dir, 'package-lock.json'))) return;
    r = await exec('npm', ['update', item.name, '--dry-run', '--json', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', dir], { cwd: dir, timeout: 5 * 60 * 1000 });
    const j = parseJsonLoose(r.stdout);
    if (j && typeof j === 'object') {
      for (const x of j.updated || j.changed || []) changes.push({ action: 'upgrading', name: x.name, from: x.from || null, to: x.to || x.version || null });
      for (const x of j.added || []) changes.push({ action: 'installing', name: x.name, from: null, to: x.version || null });
      for (const x of j.removed || []) changes.push({ action: 'removing', name: x.name, from: x.version || null, to: null });
    }
    if (r.code !== 0 && !changes.length) acc.blockers.push(`npm update ${item.name} --dry-run failed (exit ${r.code}): ${(r.stderr || '').split('\n').slice(0, 2).join(' ').slice(0, 250)}`);
  } else return;
  acc.details.lockDiff = { changes, dryRun: true, ms: r.ms };
  const others = changes.filter((c) => c.name !== item.name);
  if (others.length) acc.riskNotes.push(`dry-run lock diff also touches ${others.length} other package(s): ${others.slice(0, 6).map((c) => `${c.name} ${c.from || '∅'}→${c.to || '∅'}`).join(', ')}`);
  if (!changes.length && !acc.blockers.length) acc.riskNotes.push('dry-run produced no lockfile change (target may be blocked by constraints in composer.json/package.json)');
}

// ------------------------------------------------------------------ entry point
async function analyzeImpact(item, changelog, ctx) {
  const acc = { codeChanges: [], riskNotes: [], blockers: [], details: {} };
  const patterns = (ctx.analyst && ctx.analyst.patterns) || {};
  try {
    if (item.ecosystem === 'php-runtime') {
      await phpImpact(item, changelog, ctx, acc);
    } else {
      const lib = libraryPatterns(patterns, item.name);
      if (lib) await usageImpact(item, changelog, ctx, acc, lib);
      if (item.ecosystem === 'composer') {
        const root = rootForScope(ctx, item.scope);
        if (!lib && root) await identifierGrep(item, changelog, ctx, acc, [root.dir], ['*.php']);
        await lockDiff(item, ctx, acc);
      } else if (item.ecosystem === 'npm') {
        const dir = ctx.repoPath ? ctx.repoPath(item.scope) : item.scope;
        if (!lib && dir) await identifierGrep(item, changelog, ctx, acc, [dir], ['*.js', '*.mjs', '*.cjs']);
        await lockDiff(item, ctx, acc);
      }
    }
  } catch (e) {
    acc.riskNotes.push(`impact analysis error: ${e.message}`);
  }
  const total = acc.codeChanges.length;
  if (total > MAX_CODE_CHANGES) {
    acc.riskNotes.push(`${total - MAX_CODE_CHANGES} more code change entries truncated`);
    acc.codeChanges = acc.codeChanges.slice(0, MAX_CODE_CHANGES);
  }
  acc.details.codeChangeCount = total;
  return acc;
}

module.exports = {
  helper: true, analyzeImpact, extractIdentifiers, defaultExec, libraryPatterns, testRoots, mmOf, parseJsonLoose,
};
