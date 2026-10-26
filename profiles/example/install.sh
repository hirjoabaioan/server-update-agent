#!/usr/bin/env bash
# Installs the stack-updater systemd units for the example profile. Idempotent; safe to re-run.
#   - state dirs /var/lib/stack-updater/{config,runs}
#   - config/mode = report-only ONLY if absent (never overwrites an operator's choice)
#   - copies systemd/*.{service,timer} to /etc/systemd/system/, daemon-reload,
#     enable --now stack-updater.timer + stack-advisories.timer (timers only; services are NOT started)
set -euo pipefail
HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
STATE=${STACK_UPDATER_STATE:-/var/lib/stack-updater}
UNITS=(stack-updater.service stack-updater.timer stack-advisories.service stack-advisories.timer)

mkdir -p "$STATE/config" "$STATE/runs"
chmod 700 "$STATE"
if [ ! -e "$STATE/config/mode" ]; then
  echo report-only > "$STATE/config/mode"
  echo "mode file created: $STATE/config/mode = report-only"
else
  echo "mode file kept: $STATE/config/mode = $(cat "$STATE/config/mode")"
fi

chmod 755 "$HERE/../../bin/stack-update"
for u in "${UNITS[@]}"; do
  src="$HERE/systemd/$u"
  [ -f "$src" ] || { echo "missing $src" >&2; exit 1; }
  install -m 0644 "$src" "/etc/systemd/system/$u"
done
systemd-analyze verify "${UNITS[@]/#//etc/systemd/system/}" || true
systemctl daemon-reload
systemctl enable --now stack-updater.timer stack-advisories.timer
systemctl list-timers --all --no-pager stack-updater.timer stack-advisories.timer
