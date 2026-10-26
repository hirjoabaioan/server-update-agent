# Profile: example

A fully fictional site adapter used as a template and as the fixture for the test suite. It models
a single host that serves `example.com` and `example.org` (prod) plus `test.example.com` and
`test.example.org` (test) on nginx, PHP 8.3-FPM, MariaDB and Node with pm2, plus a Docker
monitoring stack. Copy the directory to `profiles/<yours>/` and edit.

```bash
export STACK_UPDATER_PROFILE=$PWD/profiles/example   # or: --profile example
bin/stack-update --dry-run
```

| key | meaning |
|---|---|
| `stateDir` `/var/lib/stack-updater` | runs, backups, `config/mode`, `run.lock` (outside the repo) |
| `pkgRollbackDir` | cached `.deb`s used to downgrade apt packages |
| `repo` / `branch` | checkout of the site code; relative paths in the profile resolve here |
| `syncScript` | script that syncs repo to the web roots |
| `webRoots` | `{domain, env, path, repoPath, url}`; `env` is `test` or `prod` |
| `excluded` | `[{domain, path, reason}]` generic exclude list (here: `legacy.example.com`, not in the repo). Honoured by collectors, backup, http-smoke and the reporter. `composerExcluded` is a deprecated alias folded into it by `loadConfig` |
| `phpFpmService`, `phpErrorLogs`, `nginxJsonLogDir` | used by the log-diff and nginx-5xx verifiers |
| `npmApps` | `path` (repo) -> `runtimePath` (deployed) -> `pm2Name`/`pm2User` (`null` = no pm2 process) |
| `dockerCompose` | versioned copy; `dockerComposeLive` is the file the host runs |
| `backupDbScript` | script that dumps the DB before any MariaDB change |
| `backupTargets` | off-site upload adapters; `adapters/s3-upload.sh` uses rclone, the remote comes from `remote` (passed as `STACK_UPDATES_REMOTE`) |
| `notify` | `type` selects `adapters/notify-<type>.sh`; the token is read from `tokenFile`/`envFile` at send time and never put on argv |
| `deployLocks` | a lock younger than 2h skips the run; an older one is stale and only reported |
| `maintenanceWindow` | Saturday 22:00 UTC (`dow` 6) |
| `reportDir` | where Markdown reports are written (relative to `repo`) |
| `frontend.manifest` | vendor-libs manifest; `frontend/check-manifest.mjs <vendor-dir>` validates it |
| `cronSmoke`, `services` | inputs of `verify/cron-smoke.sh` and `verify/services-health.sh` |
| `analyst` | optional LLM summaries: `llmUrl`, `llmEnvFile`, `llmKeyVar`, `llmModel`, `summaryLanguage`, Anthropic fallback via `anthropicEnvFile` |
| `appBackup` | `phpCli`, `keepPrev`, `pm2RestartScript`, `mariadbTestDb`, `snapshotConfirmFlag` |
| `securityWatch` | reserved extension point: `{enabled:false, hook:null}` |

## Layout

- `adapters/` shell adapters called by the core: `notify-telegram.sh`, `s3-upload.sh`,
  `pm2-restart.sh`, `nginx-channel-stable.sh`.
- `plugins/adapters/`, `plugins/backup/` the JS side of approval adapters (nginx mainline to stable switch).
- `verify/` external verifier hooks (`_lib.sh`, `services-health.sh`, `cron-smoke.sh`).
- `frontend/check-manifest.mjs` vendor manifest checker.
- `systemd/` + `install.sh` weekly update timer and daily advisories timer (paths assume the
  checkout in `/opt/server-update-agent`).
- `analyst-patterns.json` per-library usage patterns for the impact analyst.

## Site-specific adapters

Anything tied to one control panel or one hosting layout belongs in your own profile, not in the
core. For example, a profile for a HestiaCP server could ship an `adapters/php-backend.sh` that
switches each domain's PHP backend template (`v-change-web-domain-backend-tpl`) test first, and
register it in `profile.adapterScripts` together with a matching `plugins/adapters/<name>.js`
and `plugins/backup/<name>.js` so the core backs it up and rolls it back. Site-only plugins go in
`profiles/<yours>/plugins/<kind>/*.js` (see `../../lib/INTERFACES.md`).
