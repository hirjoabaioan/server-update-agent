#!/bin/bash
# cron-smoke.sh — SAFE smoke test of the real cron scripts listed in profile.cronSmoke[].
# For each entry: `$PHP -l <script>` (PHP = profile.appBackup.phpCli, default php). A script is EXECUTED only when its entry declares a
# dryFlag (e.g. --dry-run) AND the script source really contains that flag (re-checked with grep
# here). Everything else is lint-only: nothing is run that could send invoices, e-mail or SMS.
# profile.cronSmoke[] = { name, base: "web"|"repo", rel, envs:[...], dryFlag?: "--dry-run" }
#   base=web  -> <first webRoot of STACK_ENV>/<rel>; base=repo -> <profile.repo>/<rel>
# Output: one JSON line {ok, details, component, checks[]} (see _lib.sh).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/_lib.sh"
ENV="${STACK_ENV:-test}"
PROFILE="${STACK_PROFILE_DIR:-$DIR/..}/profile.json"
WEB="$(jq -r --arg e "$ENV" '[.webRoots[] | select(.env==$e)][0].path // empty' "$PROFILE")"
REPO="$(jq -r '.repo' "$PROFILE")"
PHP="$(jq -r '.appBackup.phpCli // "php"' "$PROFILE")"

while IFS=$'\t' read -r name base rel flag; do
  [ -z "$name" ] && continue
  if [ "$base" = "repo" ]; then script="$REPO/$rel"; else script="$WEB/$rel"; fi
  id="$name[$ENV]"
  if [ ! -f "$script" ]; then add_check "$id" false "script missing: $script"; continue; fi
  if ! lint="$("$PHP" -l "$script" 2>&1)"; then add_check "$id lint" false "$(echo "$lint" | tr '\n' ' ' | cut -c1-300)"; continue; fi
  if [ -n "$flag" ] && grep -qF -- "$flag" "$script"; then
    # the ONLY place a cron script is executed: declared safe flag present in the source
    if out="$(timeout 120 "$PHP" "$script" "$flag" 2>&1)"; then add_check "$id lint+$flag" true "lint ok; $flag run ok: $(echo "$out" | tr '\n' ' ' | cut -c1-160)"
    else add_check "$id $flag" false "exit $?: $(echo "$out" | tr '\n' ' ' | cut -c1-300)"; fi
  else
    add_check "$id lint" true "lint ok (no dry/safe flag: not executed)"
  fi
done < <(jq -r --arg e "$ENV" '.cronSmoke[]? | select((.envs // ["test","prod"]) | index($e)) | [.name, (.base // "web"), .rel, (.dryFlag // "")] | @tsv' "$PROFILE")
emit cron-smoke
exit $?
