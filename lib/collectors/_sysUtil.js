'use strict';
// Shared helpers for collectors (ignored by the plugin loader: leading underscore).
// Read-only: HTTP GET + local read-only commands. Every network call has a 15 s timeout.
const { execFile } = require('child_process');

const HTTP_TIMEOUT_MS = 15000;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

async function httpGet(url, { json = false, timeoutMs = HTTP_TIMEOUT_MS, headers = {} } = {}) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'stack-updater/1 (read-only collector)', accept: json ? 'application/json' : '*/*', ...headers },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return json ? res.json() : res.text();
}

// Never rejects with a bare error: returns { ok, stdout, stderr, code, error }.
function run(cmd, args, { timeoutMs = 120000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, {
      timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C', DEBIAN_FRONTEND: 'noninteractive' },
    }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), code: err ? (err.code === undefined ? null : err.code) : 0, error: err ? err.message : null });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

// "21 Oct 2026" | "2026-10-21" | ISO datetime -> "YYYY-MM-DD" | null
function isoDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = str.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

module.exports = { httpGet, run, isoDate, HTTP_TIMEOUT_MS };
