'use strict';
// --only filter + drill version pins (lib/cli.js selectTargets) and the app appliers wiring.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const cli = require('../lib/cli');

const D = (o) => ({ ecosystem: 'composer', scope: 'test.example', name: 'a/b', installed: '1.2.0', target: '1.2.3', tier: 'A', action: 'auto', reasons: [], ...o });
const cfg = (flags) => ({ mode: 'apply-tier-a', flags, policy: { componentsNeverAuto: ['ubuntu-release'] } });

test('parseOnly keeps scoped npm names and splits the version on the last @', () => {
  assert.deepStrictEqual(cli.parseOnly('npm:apps/x:@scope/pkg@1.0.1,composer:site, jq'), [
    { sel: 'npm:apps/x:@scope/pkg', version: '1.0.1' }, { sel: 'composer:site', version: null }, { sel: 'jq', version: null },
  ]);
});

test('--only filters tier-A auto targets by component / item key / eco:name / name', () => {
  const ds = [D(), D({ name: 'c/d' }), D({ scope: 'other', name: 'a/b' }), D({ name: 'e/f', action: 'hold', target: '1.3.0', tier: 'B' })];
  assert.strictEqual(cli.selectTargets(cfg({}), ds).length, 3);
  assert.deepStrictEqual(cli.selectTargets(cfg({ only: 'composer:test.example:a/b' }), ds).map((d) => `${d.scope}:${d.name}`), ['test.example:a/b']);
  assert.strictEqual(cli.selectTargets(cfg({ only: 'composer:test.example' }), ds).length, 2);
  assert.strictEqual(cli.selectTargets(cfg({ only: 'a/b' }), ds).length, 2);
  assert.throws(() => cli.selectTargets(cfg({ only: 'e/f' }), ds), /no tier-A auto target/);
});

test('version pins need --force --reason and stay within major.minor', () => {
  const ds = [D({ ecosystem: 'npm', scope: 'apps/x', name: 'js-yaml', installed: '4.1.0', target: null, tier: null, action: 'skip' })];
  assert.throws(() => cli.selectTargets(cfg({ only: 'npm:js-yaml@4.1.1' }), ds), /requires --force --reason/);
  const ok = cli.selectTargets(cfg({ only: 'npm:js-yaml@4.1.1', force: true, reason: 'drill' }), ds);
  assert.strictEqual(ok.length, 1);
  assert.strictEqual(ok[0].target, '4.1.1');
  assert.strictEqual(ok[0].tier, 'A');
  assert.throws(() => cli.selectTargets(cfg({ only: 'npm:js-yaml@4.2.0', force: true, reason: 'drill' }), ds), /major\.minor/);
  assert.throws(() => cli.selectTargets(cfg({ only: 'npm:js-yaml@5.0.0', force: true, reason: 'drill' }), ds), /major\.minor/);
  assert.ok(cli.pinAllowed('6.2-1ubuntu0.2', '6.2-1ubuntu0.3'));
  assert.ok(cli.pinAllowed('1:3.0.7-1build1', '1:3.0.7-1ubuntu0.1'));
  const never = [D({ ecosystem: 'os', name: 'ubuntu-release', installed: '22.04', action: 'propose' })];
  assert.throws(() => cli.selectTargets(cfg({ only: 'ubuntu-release@22.04.5', force: true, reason: 'drill' }), never), /core rails/);
});

test('composer / npm / frontend appliers are wired to the backup plugins', () => {
  for (const n of ['composer', 'npm', 'frontend']) {
    const a = require(path.join('..', 'lib', 'appliers', `${n}.js`));
    assert.strictEqual(a.name, n);
    assert.strictEqual(typeof a.apply, 'function');
  }
});

test('cli accepts --only as a valued flag', () => {
  assert.strictEqual(cli.parseArgs(['update', '--only', 'apt:nano@6.2-1ubuntu0.3']).flags.only, 'apt:nano@6.2-1ubuntu0.3');
});
