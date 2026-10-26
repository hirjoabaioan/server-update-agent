#!/bin/bash
# services-health.sh — probes the local services listed in profile.services[].
#   { name, url, probePath (default /health), probe: "health" | "any" }
#   probe=health (default): GET url+probePath must return 200.
#   probe=any: for services without a health endpoint; accept any HTTP response < 500
#   (a 404 from the app proves the process is up and answering).
# Output: one JSON line {ok, details, component, checks[]} (see _lib.sh).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/_lib.sh"
PROFILE="${STACK_PROFILE_DIR:-$DIR/..}/profile.json"

probe() { # id url path expectMode(health|any)
  local code ms
  read -r code ms < <(curl -s -o /dev/null -m 10 -w '%{http_code} %{time_total}' "$2$3" 2>/dev/null)
  code="${code:-000}"
  if [ "$4" = "health" ]; then
    if [ "$code" = "200" ]; then add_check "$1 $3" true "200 in ${ms}s"; else add_check "$1 $3" false "got $code (expect 200)"; fi
  else
    if [ "$code" != "000" ] && [ "$code" -lt 500 ]; then add_check "$1 $3 (no /health; root probe)" true "$code in ${ms}s"; else add_check "$1 $3" false "got $code"; fi
  fi
}

while IFS=$'\t' read -r name url path mode; do
  [ -z "$name" ] && continue
  probe "$name" "$url" "$path" "$mode"
done < <(jq -r '.services[]? | [.name, .url, (.probePath // "/health"), (.probe // "health")] | @tsv' "$PROFILE")

emit services-health
exit $?
