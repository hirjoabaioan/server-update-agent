# server-update-agent

![ci](https://github.com/hirjoabaioan/server-update-agent/actions/workflows/ci.yml/badge.svg)

A weekly update agent for a single Linux web server. It inventories the whole stack: OS packages,
PHP/Node/MariaDB/nginx, Composer and npm dependencies, vendored frontend libraries and Docker images.
A written policy decides what is safe. The agent backs up, applies to **test**, verifies, then
**prod**, verifies again, and rolls back on its own if a check fails. An LLM reads changelogs and
writes the human summary. **It never decides what gets installed.**

It runs on my production host (two PHP SaaS brands, a test environment, and Node workers on pm2).
I extracted the core from there and publish it here with an example profile.

## Why it exists

In October 2026 I found that the PHP runtime on that server had not been patched for 11 weeks.
`unattended-upgrades` only covered the Ubuntu archive. PHP, nginx, MariaDB, Node and Docker all came
from third-party apt repositories, and nothing watched them. Composer/npm dependencies and
CDN-loaded JS libraries were not tracked at all; some were loaded without a pinned version.

"Upgrade everything to the newest" is not the fix, because newest is not the same as stable. The
rule I wanted is **latest stable *and* compatible**, applied on a schedule, with a way back.

## How a decision is made

| Change | Rule | Applied |
|---|---|---|
| Pre-release (alpha, beta, rc, nightly…) | never | — |
| Patch inside the installed minor (tier A) | released ≥ 7 days ago (soak); CVSS ≥ 7 skips the soak | automatically, in the maintenance window |
| New minor / major, or a runtime switch (tier B) | line ≥ 30 days old **and** a follow-up patch exists (x.y.1+, PHP x.y.2+) **and** a compatibility pre-check | only after an explicit approval (`stack-update approve`) |
| OS release (tier C) | — | never by the agent |
| Node.js, MariaDB | LTS lines only | — |
| nginx | stable channel only; a mainline build gets a channel-switch proposal | tier B |

The core enforces the tier rules even if a policy plugin says otherwise. Everything else lives in
[`policy.json`](policy.json) and can be overridden per site.

## Pipeline

```
inventory ─▶ policy ─▶ analyze ─▶ backup ─▶ apply(test) ─▶ verify(test) ─▶ apply(prod) ─▶ verify(prod) ─▶ report + notify
                         │           │            │ fail                          │ fail
                     LLM summary   bundle       restore test,                 restore prod
                     (optional)    off-site     prod untouched                from the same backups
```

- **Backups.** Every changed component is captured before any change. apt packages are repacked with `dpkg-repack`,
  `composer.lock`/`vendor/`, `package-lock.json`/`node_modules/` and the frontend manifest are snapshotted, and nginx
  config is included. Everything is bundled with a SHA-256 manifest and uploaded off-site through a profile script
  (`s3-upload.sh`, rclone). `stack-rollback <run-id> [component]` restores one run, and `stack-restore-bundle` restores
  from the off-site bundle.
- **Verifiers.** HTTP smoke on every site, nginx 5xx count during the switch window, a PHP error-log diff, service
  health, and any command or external hook the profile defines.
- **Analyst.** For each candidate it fetches the changelog and searches the code for usages of APIs the changelog
  touches. An OpenAI-compatible model (optional Anthropic fallback) writes the summary and risk
  notes. If the model is down or not configured, the run continues with a deterministic summary.
- **Window and locks.** It runs once a week from a systemd timer (Saturday 22:00 UTC in the example) under `flock`. It
  skips the run when a fresh deploy lock exists.

## Results so far

On the production host, Ubuntu 22.04 with a hosting control panel, PHP 8.3, nginx, MariaDB 11.4, Node 22 and Docker:

- **Rollback drill on the live test environment**, five primitives, each one applied, verified and then rolled back:

  | primitive | change | apply + verify | rollback | state after rollback |
  |---|---|---|---|---|
  | composer | tiptap-php 2.1.0 → 2.1.2 | 457 s | 1 s | lock hash and `vendor/` identical |
  | npm | js-yaml 4.1.0 → 4.1.1 | 421 s | 1 s | lock hash and `node_modules/` identical |
  | frontend | bootstrap-icons 1.11.4 → 1.11.3 | 447 s | 1 s | manifest hash identical |
  | apt | nano 6.2-1ubuntu0.2 → 0.3 | 565 s | 1 s | dpkg version restored, hold released |
  | bundle | off-site bundle of the apt run | upload ok | staging restore | 0 diffs against live |

  nginx returned **0 HTTP 5xx** during every verify window. Most of the run time is inventory plus analysis (about
  4 min) and the 3-minute 5xx watch.
- **Report-only runs:** the first one (2026-10-23) took 3 min 59 s end to end and collected 154 security
  advisories, 0 critical. The one on 2026-10-26 took 4 min 9 s and listed 88 tier-B proposals, each with the
  rule that blocks or allows it (age, follow-up patch, compatibility).
- **nginx mainline → stable:** the agent proposed a downgrade from 1.31.3 mainline to 1.30.6 stable. Before approving
  it, the stable binary was extracted to a temp prefix and `nginx -t` passed against the full live configuration.
  The running nginx was not touched.
- **Tests:** 158, `node --test`, no npm dependencies.

**Status:** report-only runs since 2026-10-23. Automatic tier-A apply starts with the 2026-10-31 maintenance window,
and the first applied run will be added here.

## Quick start

```bash
git clone https://github.com/hirjoabaioan/server-update-agent /opt/server-update-agent
cd /opt/server-update-agent
cp -r profiles/example profiles/mysite        # edit profile.json: web roots, apps, services, notify, backups
npm test
bin/stack-update --profile profiles/mysite --mode report-only     # changes nothing, writes a report
sudo profiles/mysite/install.sh                                     # systemd units (weekly update + daily advisories)
```

Requirements: Node ≥ 22, bash, `flock`, `jq`, `dpkg-repack` for apt rollbacks, `rclone` for off-site bundles. It is
built for Debian/Ubuntu with nginx. Composer, npm, Docker and the frontend manifest are optional collectors.

## Limits

- One host, apt-based. Containers and other package managers are inventoried; only the listed ecosystems are applied.
- Databases are backed up, but restoring one is a manual step. The agent never auto-restores a database.
- Tested on one production server. The example profile is fictional and its adapters are untested elsewhere.
- Planned: a security-watch module (auth.log / fail2ban / attack patterns) on the existing `advisories` hook.

## Layout

```
bin/        stack-update, stack-rollback, stack-restore-bundle (thin entrypoints)
lib/core/   config, lock, log, run, pipeline, window, approvals, semver (no npm deps)
lib/{collectors,policy,analyst,backup,appliers,verifiers,reporter}/   one file per plugin
lib/INTERFACES.md   plugin contracts and the inventory item shape
policy.json         default policy
profiles/example/   site adapter: profile.json, adapter scripts, verify scripts, systemd units
tests/              node --test
```

## Reference

### Usage

```bash
export STACK_UPDATER_PROFILE=$PWD/profiles/example
bin/stack-update --help
bin/stack-update                                 # mode from <stateDir>/config/mode, fallback report-only
bin/stack-update --mode apply-tier-a --dry-run
bin/stack-update --mode propose --env test
bin/stack-update approve apt::nginx --target 1.28.0   # explicit tier-B approval (<stateDir>/config/approvals.json)
bin/stack-update approvals                          # active / pending / consumed approvals
node lib/cli.js inventory | policy | analyze | backup | verify --env prod | report --from <run-id> | advisories
bin/stack-rollback 20261024-2200-apply-tier-a php8.3-fpm
```

Pipeline for `update`: `inventory → policy → analyze → backup → apply(test) → verify(test) →
apply(prod) → verify(prod) → report`. A failed test verification restores the test backups
and leaves prod untouched. `report-only` and `propose` stop after `analyze` and go to `report`.

Modes: `report-only` (default), `propose` (analysts write upgrade proposals), `apply-tier-a`
(applies only tier-A decisions marked `auto`). Tier B (minor/major/runtime switch) and tier C
(OS release) are never applied automatically. The core enforces this even if a policy
plugin says otherwise.

Locking: `flock` on `<stateDir>/run.lock`. The run is also skipped (exit 0, logged in
`<stateDir>/skipped.jsonl`) when any `profile.deployLocks` file exists and is younger than
2h. Older lock files count as stale: they are logged as warnings and do not block the run.

State: `<stateDir>/runs/<run-id>/` (`run.jsonl`, `manifest.json`, `inventory.json`,
`decisions.json`, `analysis.json`, `backup.json`, `apply-<env>.json`, `verify-<env>.json`,
`summary.json`, `report.md`). Run id = `YYYYMMDD-HHMM-<mode>` (UTC).

### policy.json `nginx.channel`

`"nginx": { "channel": "stable" }` sets the nginx.org release channel (stable = even minor,
mainline = odd minor). With `stable`:

- mainline candidates (`1.31.x`) are never proposed for `apt::nginx` or `eol::nginx`, including
  tier-A patches and the endoflife.date "latest";
- the apt collector reads the stable repo `Packages` index over HTTP (read-only), derived from
  the installed mainline origin or set by `nginx.stableIndexUrl`. Release dates come from
  `nginx.org/en/CHANGES-<series>`;
- if a mainline build is installed, the engine emits a tier-B `channel-switch` decision on
  `apt::nginx`. The target is the newest stable `.deb` past `patchSoakDays`. It is applied
  only with an approval that names the profile adapter, for example
  `approve apt::nginx --target 1.30.6-1~jammy --adapter nginx-channel-stable`.

Without the key, the legacy informational `mainline->stable` question is emitted.

Approval adapters: if an approval sets `adapter: <name>`, the profile plugin
`plugins/adapters/<name>.js` applies that target instead of the generic applier. The matching
`plugins/backup/<name>.js` does backup and restore, and `lib/backup/apt.js` skips targets an
adapter owns. Each adapter script is registered in `profile.adapterScripts`. For the example profile:
`adapters/nginx-channel-stable.sh plan|backup|apply|verify|rollback`, where
`plan [--simulate]` has no side effects.

### Runtime decision: bash entrypoints + Node 22, zero npm dependencies

- **Node 22 is commonly already on the host**, so it adds no new runtime.
- **JSON-native.** Profile, policy, inventory, `npm outdated --json`, `composer outdated --format=json`, `docker inspect` and registry APIs are all JSON. Bash + jq would turn every stage into string plumbing.
- **Built-in tests.** `node --test` ships with Node 22, so no test framework is needed. Run `node --test tests/`.
- **No npm dependencies in the core.** Nothing to `npm install`,. Semver comparison is the ~100-line `lib/core/semver.js`, and `flock` comes from util-linux through an inherited fd.
- **Thin bash entrypoints.** They make cron lines, `systemd` units and muscle memory simple (`stack-update`, `stack-rollback`). All logic stays in Node.
- **Where it runs.** Run it from a checkout (for example `/opt/server-update-agent`), not from a web root.

### Server-agnostic rule

`lib/` and `bin/` must not contain hostnames, domains, site paths, DB names or secrets.
`tests/core-agnostic.test.js` enforces this. Everything site-specific goes in
`profiles/<site>/`. Secrets stay in the files the profile points to and are never copied
into state or logs.
