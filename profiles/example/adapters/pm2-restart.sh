#!/usr/bin/env bash
# pm2-restart.sh <pm2Name> <pm2User> [--dry-run]
# Restart one pm2 process under the pm2 daemon of its owning user (root or e.g. automation),
# then wait until it reports "online". Used by lib/backup/npm.js after an npm apply/restore.
# Env overrides (tests): PM2_BIN (default pm2), SUDO_BIN (default sudo), PM2_WAIT_SECS (default 20).
set -euo pipefail
NAME="${1:-}"; USER_="${2:-root}"; DRY=0
[ "${3:-}" = "--dry-run" ] && DRY=1
if [ -z "$NAME" ]; then echo "usage: $0 <pm2Name> <pm2User> [--dry-run]" >&2; exit 2; fi
case "$NAME$USER_" in *[!A-Za-z0-9._-]*) echo "invalid name/user" >&2; exit 2;; esac
PM2="${PM2_BIN:-pm2}"; SUDO="${SUDO_BIN:-sudo}"; WAIT="${PM2_WAIT_SECS:-20}"

pm2u() {
  if [ "$USER_" = "$(id -un)" ]; then "$PM2" "$@"; else "$SUDO" -n -u "$USER_" -H "$PM2" "$@"; fi
}

if [ "$DRY" = 1 ]; then
  if [ "$USER_" = "$(id -un)" ]; then echo "$PM2 restart $NAME --update-env"; else echo "$SUDO -n -u $USER_ -H $PM2 restart $NAME --update-env"; fi
  exit 0
fi

pm2u describe "$NAME" >/dev/null 2>&1 || { echo "pm2 process '$NAME' not found for user $USER_" >&2; exit 3; }
pm2u restart "$NAME" --update-env >/dev/null
for _ in $(seq 1 "$WAIT"); do
  st=$(pm2u jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s).find(x=>x.name===process.argv[1]);process.stdout.write(p?p.pm2_env.status:"missing")}catch{process.stdout.write("unknown")}})' "$NAME" || true)
  [ "$st" = "online" ] && { echo "pm2 $NAME ($USER_): online"; exit 0; }
  sleep 1
done
echo "pm2 $NAME ($USER_): not online after ${WAIT}s (status: ${st:-unknown})" >&2
exit 4
