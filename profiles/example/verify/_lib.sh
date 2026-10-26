#!/bin/bash
# Shared helpers for the verify adapters (sourced). Contract (lib/verifiers/external-hook.js):
# the adapter prints ONE JSON line {ok, details, component, checks[]} on stdout and exits 0/1.
# Env: STACK_ENV (test|prod), STACK_PROFILE_DIR (set by the core).
CHECKS_FILE="$(mktemp)"
trap 'rm -f "$CHECKS_FILE"' EXIT

# add_check <id> <ok:true|false> <detail>
add_check() { jq -cn --arg id "$1" --argjson ok "$2" --arg d "$3" '{id:$id,ok:$ok,detail:$d}' >> "$CHECKS_FILE"; }

# emit <component>  -> prints the final JSON line, exit 1 when any check failed
emit() {
  local comp="$1"
  jq -cs --arg c "$comp" '{ok: (all(.[]; .ok)), component: $c, checks: ., details: ([.[] | select(.ok|not) | "\(.id): \(.detail)"] | join("; "))}' "$CHECKS_FILE"
  jq -es 'all(.[]; .ok)' "$CHECKS_FILE" >/dev/null
}
