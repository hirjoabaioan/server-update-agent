#!/usr/bin/env node
// Validates <vendor-dir>/manifest.json (frontend vendor libs manifest)
//  - every referenced file exists and is non-empty
//  - SRI (sha384) matches file content
//  - "active" is a key of "versions"
//  - no prerelease version, except whitelisted libs (select2)
// Usage: node check-manifest.mjs <path/to/vendor-dir>    exit 0 = OK, 1 = problems
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

if (!process.argv[2]) { console.error('usage: node check-manifest.mjs <vendor-dir>'); process.exit(2); }
const vendorDir = path.resolve(process.argv[2]);
const PRERELEASE_WHITELIST = new Set(['select2']);

const errors = [];
const err = (m) => errors.push(m);
let files = 0;

let manifest;
try { manifest = JSON.parse(fs.readFileSync(path.join(vendorDir, 'manifest.json'), 'utf8')); }
catch (e) { console.error('FAIL cannot read/parse manifest.json: ' + e.message); process.exit(1); }

const libs = manifest.libs || {};
if (!Object.keys(libs).length) err('manifest has no libs');

for (const [name, lib] of Object.entries(libs)) {
  const versions = lib.versions || {};
  if (!lib.active) err(`${name}: missing "active"`);
  else if (!(lib.active in versions)) err(`${name}: active "${lib.active}" not in versions`);
  if (Object.keys(versions).length < 1) err(`${name}: no versions`);
  for (const [ver, spec] of Object.entries(versions)) {
    if (/-/.test(ver) && !PRERELEASE_WHITELIST.has(name)) err(`${name}@${ver}: prerelease not allowed`);
    const isCdn = spec.type === 'cdn';
    if (isCdn) {
      if (!/^https:\/\//.test(spec.cdnBase || '')) err(`${name}@${ver}: cdn entry needs https cdnBase`);
      if (spec.cdnBase && spec.cdnBase.includes('@') && !spec.cdnBase.includes('@' + ver)) err(`${name}@${ver}: cdnBase not pinned to this version`);
    }
    for (const kind of ['css', 'js', 'assets']) {
      for (const item of spec[kind] || []) {
        if (!item.path) { err(`${name}@${ver}/${kind}: item without path`); continue; }
        if (isCdn) {
          if (item.sri && !/^sha384-[A-Za-z0-9+/]+=*$/.test(item.sri)) err(`${name}@${ver}: bad SRI format for ${item.path}`);
          if (!item.sri) err(`${name}@${ver}: cdn script ${item.path} lacks SRI`);
          continue;
        }
        const abs = path.join(vendorDir, item.path);
        let buf;
        try { buf = fs.readFileSync(abs); } catch { err(`${name}@${ver}: missing file ${item.path}`); continue; }
        if (!buf.length) { err(`${name}@${ver}: empty file ${item.path}`); continue; }
        files++;
        if (!item.sri) { err(`${name}@${ver}: no SRI for ${item.path}`); continue; }
        const sri = 'sha384-' + crypto.createHash('sha384').update(buf).digest('base64');
        if (sri !== item.sri) err(`${name}@${ver}: SRI mismatch for ${item.path}`);
      }
    }
  }
}

console.log(`check-manifest: ${Object.keys(libs).length} libs, ${files} local files verified`);
if (errors.length) { console.error(errors.map((e) => 'FAIL ' + e).join('\n')); process.exit(1); }
console.log('OK');
