# stack-updater plugin contracts

Every plugin is **one CommonJS file** exporting a plain object with a `name` and the
stage method below. Files are loaded by `lib/core/plugins.js` from:

1. `lib/<kind>/*.js` — core plugins (must stay server-agnostic: no hostnames, domains,
   site paths, DB names or secrets — enforced by `tests/core-agnostic.test.js`);
2. `<profileDir>/plugins/<kind>/*.js` — site adapter plugins.

Files starting with `_` are ignored (helpers). Same `name` in the profile overrides the core
plugin. `profile.plugins.<kind>.disabled = [names]` / `.only = [names]` filter the list.
All methods may be `async`. A thrown error is caught by the core, logged, and recorded as a
stage error — it never crashes the run (except: a failed backup blocks every apply).

## Shared context (`ctx`)

```js
{
  profile,      // parsed profile.json (site facts)
  policy,       // policy.json merged with profile.policyOverrides
  profileDir, stateDir,
  mode,         // 'report-only' | 'apply-tier-a' | 'propose'
  dryRun,       // true => the plugin MUST NOT change anything on the host
  env,          // 'test' | 'prod' | null (set for apply/verify/restore)
  repoPath(p),  // resolve a profile-relative path against profile.repo
  run,          // { id, dir, backupDir } — write artifacts under run.dir / run.backupDir
  log,          // { info(msg, data), warn, error, debug } — JSONL into run.jsonl
  semver,       // lib/core/semver.js
}
```

## Inventory item (collector output)

```json
{
  "ecosystem": "apt | npm | composer | docker | node-runtime | php-runtime | mariadb | os | vendor-js | ...",
  "name": "php8.3-fpm",
  "scope": "optional — where it lives (app path, web root, compose service); part of the item key",
  "installed": "8.3.12",
  "candidates": [
    { "version": "8.3.13", "releaseDate": "2026-10-01", "source": "apt:ppa:ondrej/php", "security": false,
      "cvss": null, "advisories": [] }
  ],
  "source": "how `installed` was detected (e.g. dpkg-query, package-lock.json, docker inspect)",
  "envs": ["test", "prod"],
  "meta": {}
}
```

Required: `ecosystem`, `name`, `installed`, `candidates[]` (may be empty), `source`.
`candidates[].version|releaseDate|source|security` are required; `releaseDate` is ISO
`YYYY-MM-DD` or `null` when unknown (unknown date => soak rules cannot be satisfied).
Item key = `ecosystem:scope:name`.

## 1. Collector — `lib/collectors/*.js`

```js
module.exports = { name: 'apt', async collect(ctx) { return [/* inventory items */]; } };
```

Read-only. Must not change the host even when `dryRun` is false.

## 2. Verifier — `lib/verifiers/*.js`

```js
module.exports = {
  name: 'http-smoke',
  async verify(ctx) {            // ctx.env = 'test' | 'prod'
    return { ok: true, skipped: false, checks: [{ id: 'GET /', ok: true, detail: '200 in 180ms' }] };
  },
};
```

`ok:false` (or a throw) fails the env: the core restores that env's backups and does not
touch later envs. A verifier irrelevant for the env returns `{ ok: true, skipped: true }`.

## 3. Backup — `lib/backup/*.js`

```js
module.exports = {
  name: 'pkg-rollback',
  async backup(targets, ctx) {   // targets = decisions selected for apply
    return { entries: [{ component: 'php8.3-fpm', ecosystem: 'apt', scope: null, env: null,
      artifact: '<path under ctx.run.backupDir or remote URI>', restoreHint: 'human-readable',
      meta: {} }] };
  },
  async restore(entry, ctx) {    // entry = one object from backup.json (plus `plugin`)
    return { ok: true, detail: 'reinstalled 8.3.12' };
  },
};
```

`env: null` = host-wide (restored on any env failure); `'test'|'prod'` = env-specific.
With `dryRun` the plugin returns the entries it *would* create, without writing them.
The core writes `backup.json` = `{ dryRun, entries[], errors[] }`; `stack-rollback <run-id>
[component]` replays `restore()` in reverse order, filtered by `component`/`name`/item key.

## 4. Analyst — `lib/analyst/*.js`

```js
module.exports = {
  name: 'changelog',
  async analyze(decisions, ctx) {
    return {
      findings: [{ severity: 'info|warn|critical', component: 'npm::express', message: '...' }],
      proposals: [{ component: 'php-runtime::php', from: '8.3', to: '8.4', tier: 'B',
                    summary: '...', steps: ['...'], risks: ['...'] }],
    };
  },
};
```

Read-only. In `propose` mode proposals are the main output of the run.

## Supporting kinds

| kind | dir | method | returns |
|---|---|---|---|
| policy | `lib/policy/` | `evaluate(items, ctx)` | `decision[]` |
| appliers | `lib/appliers/` | `apply(targets, ctx)` | `{ applied[], failed[] }` (never called with `dryRun`) |
| reporter | `lib/reporter/` | `report(summary, ctx)` | `{ files[] }` |

Decision shape (policy output, one per inventory item; later plugins override earlier ones
for the same item key):

```json
{ "ecosystem": "apt", "scope": null, "name": "php8.3-fpm", "installed": "8.3.12",
  "target": "8.3.13", "tier": "A|B|C|null", "action": "auto|propose|hold|skip",
  "reasons": ["patch within 8.3", "soaked 9 days >= 7"], "envs": ["test", "prod"] }
```

Core safety rails run after every policy plugin and cannot be bypassed by plugins:
`componentsNeverAuto` and any tier other than `A` downgrade `auto` to `propose`;
a `knownRegressions` hit (`{"name@version": "reason"}` or `{"name": {"version": "reason"}}`)
forces `hold`. Only `apply-tier-a` mode applies anything, and only `auto` + tier `A`.
