#!/usr/bin/env bash
# nginx-channel-stable.sh — switch nginx from the nginx.org MAINLINE repo to the STABLE repo
# (downgrade to a stable build) and back. Idempotent. Invoked through the profile plugin
# plugins/adapters/nginx-channel-stable.js when an approval names adapter "nginx-channel-stable".
#
#   nginx-channel-stable.sh plan     [--target DEB] [--simulate]
#   nginx-channel-stable.sh backup   --backup-dir DIR [--dry-run]
#   nginx-channel-stable.sh apply    --target DEB --backup-dir DIR [--dry-run]
#   nginx-channel-stable.sh verify   --target DEB
#   nginx-channel-stable.sh rollback --backup-dir DIR [--dry-run]
#
# plan      prints the exact apt source line, pin file content and commands. No side effects
#           (reads dpkg/apt state; without --target it reads the stable Packages index over HTTP).
#           --simulate additionally resolves the install in a throw-away apt state under /tmp
#           (own sources/preferences/lists/cache; the system apt config is not touched).
# backup    dpkg-repack nginx (installed build) + copy of the apt source list (+ pin if present).
# apply     write stable source + pin, apt-get update, install nginx=<DEB> --allow-downgrades,
#           nginx -t, graceful reload (nginx -t && nginx -s reload, as lib/backup/apt.js).
# verify    nginx -v == target, nginx -t ok, running master runs the new binary, HTTP smoke on
#           profile.smokeUrls (the core's http-smoke verifier runs again after the adapter).
# rollback  restore the saved source list, remove the pin, dpkg -i the repacked .deb, nginx -t, reload.
#
# Pin: the nginx.org MAINLINE repo also publishes "Suite: stable" (apt shows a=stable for it), so
# "Pin: release o=nginx,a=stable" would also match mainline. The pin therefore selects stable by
# version (nginx.org: even minor = stable): "Pin: version /^[0-9]+\.[0-9]*[02468]\./".
#
# Output lines: "PLAN key=value", "PIN <line>", "CMD <command>", "OK ...", "SKIP ...", "FAIL ...".
# Env overrides (tests): NGINX_LIST, PIN_FILE, KEYRING, STABLE_URL, MAINLINE_URL, SUITE, ARCH,
#   PROFILE_JSON, NGINX_BIN, APT_GET, DPKG, DPKG_REPACK, DPKG_QUERY, CURL_BIN, NGINX_PID_FILE.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE_JSON="${PROFILE_JSON:-$HERE/../profile.json}"
NGINX_LIST="${NGINX_LIST:-/etc/apt/sources.list.d/nginx.list}"
PIN_FILE="${PIN_FILE:-/etc/apt/preferences.d/99-nginx-stable}"
KEYRING="${KEYRING:-/usr/share/keyrings/nginx-keyring.gpg}"
STABLE_URL="${STABLE_URL:-https://nginx.org/packages/ubuntu/}"
MAINLINE_URL="${MAINLINE_URL:-https://nginx.org/packages/mainline/ubuntu/}"
NGINX_BIN="${NGINX_BIN:-nginx}"
APT_GET="${APT_GET:-apt-get}"
DPKG="${DPKG:-dpkg}"
DPKG_REPACK="${DPKG_REPACK:-dpkg-repack}"
DPKG_QUERY="${DPKG_QUERY:-dpkg-query}"
CURL_BIN="${CURL_BIN:-curl}"
NGINX_PID_FILE="${NGINX_PID_FILE:-/run/nginx.pid}"
PKG=nginx
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1

usage() { sed -n '6,10p' "$0" | sed 's/^# *//' >&2; exit 2; }
CMD="${1:-}"; [ -n "$CMD" ] || usage; shift
TARGET=""; BDIR=""; DRY=0; SIM=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --backup-dir) BDIR="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --simulate) SIM=1; shift ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
case "$TARGET" in *[!A-Za-z0-9.+~:-]*) echo "invalid --target" >&2; exit 2 ;; esac

SUITE="${SUITE:-$(. /etc/os-release 2>/dev/null && echo "${VERSION_CODENAME:-}")}"
ARCH="${ARCH:-$($DPKG --print-architecture 2>/dev/null || echo amd64)}"
[ -n "$SUITE" ] || { echo "FAIL cannot determine the distribution codename" >&2; exit 3; }
STABLE_LINE="deb [arch=$ARCH signed-by=$KEYRING] $STABLE_URL $SUITE nginx"
MAINLINE_LINE="deb [arch=$ARCH signed-by=$KEYRING] $MAINLINE_URL $SUITE nginx"
PIN_CONTENT="# managed by stack-updater adapter nginx-channel-stable: keep nginx on the nginx.org STABLE channel
# (even minor). The mainline repo also reports Suite: stable, so the pin selects by version.
Package: nginx*
Pin: version /^[0-9]+\.[0-9]*[02468]\./
Pin-Priority: 1001"

installed_deb() { "$DPKG_QUERY" -W -f='${Version}\t${db:Status-Abbrev}' "$PKG" 2>/dev/null | awk -F'\t' '$2 ~ /^ii/ {print $1}'; }
upstream() { local v="${1#*:}"; echo "${v%-*}"; }
run() { if [ "$DRY" = 1 ]; then echo "DRY: $*"; else "$@"; fi; }
is_held() { apt-mark showhold 2>/dev/null | grep -qx "$PKG"; }
install_cmd() { echo "$APT_GET install -y --allow-downgrades -o Dpkg::Options::=--force-confold $PKG=$1"; }
update_cmd() { echo "$APT_GET update -o Dir::Etc::sourcelist=$NGINX_LIST -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0"; }

newest_stable() { # newest nginx build in the stable Packages index (read-only HTTP)
  "$CURL_BIN" -fsS --max-time 60 "${STABLE_URL%/}/dists/$SUITE/nginx/binary-$ARCH/Packages" \
    | awk -v p="$PKG" '/^Package: /{n=$2} /^Version: /{ if (n==p) print $2 }' | sort -V | tail -1
}

graceful_reload() { # same sequence as lib/backup/apt.js gracefulReload('nginx')
  run "$NGINX_BIN" -t
  run "$NGINX_BIN" -s reload
}

master_binary_current() { # running master uses the installed binary (not a "(deleted)" old one)
  local pid; pid="$(cat "$NGINX_PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  ! readlink "/proc/$pid/exe" 2>/dev/null | grep -q '(deleted)'
}

cmd_plan() {
  local inst cur=""; inst="$(installed_deb)"
  [ -n "$TARGET" ] || TARGET="$(newest_stable || true)"
  [ -n "$TARGET" ] || { echo "FAIL no --target and the stable index could not be read" >&2; exit 3; }
  [ -f "$NGINX_LIST" ] && cur="$(grep -v '^\s*#' "$NGINX_LIST" | grep -m1 . || true)"
  echo "PLAN adapter=nginx-channel-stable"
  echo "PLAN installed=${inst:-none}"
  echo "PLAN target=$TARGET"
  echo "PLAN direction=$([ -n "$inst" ] && $DPKG --compare-versions "$TARGET" lt "$inst" && echo downgrade || echo upgrade-or-same)"
  echo "PLAN source.file=$NGINX_LIST"
  echo "PLAN source.current=${cur:-<missing>}"
  echo "PLAN source.new=$STABLE_LINE"
  echo "PLAN source.rollback=$MAINLINE_LINE"
  echo "PLAN pin.file=$PIN_FILE"
  echo "PLAN pin.present=$([ -f "$PIN_FILE" ] && echo yes || echo no)"
  echo "PLAN held=$(is_held && echo yes || echo no)"
  echo "PLAN init.d.upgrade=$([ -x /etc/init.d/nginx ] && echo yes || echo no)"
  while IFS= read -r l; do echo "PIN $l"; done <<< "$PIN_CONTENT"
  echo "CMD backup: (cd <run>/backup/nginx-channel-stable && $DPKG_REPACK $PKG && dpkg-deb -I ${PKG}_*.deb) ; cp $NGINX_LIST <dir>/nginx.list.orig"
  echo "CMD write $NGINX_LIST <- source.new ; write $PIN_FILE <- PIN lines"
  echo "CMD $(update_cmd)"
  echo "CMD $(install_cmd "$TARGET")"
  echo "CMD $NGINX_BIN -t && $NGINX_BIN -s reload"
  echo "CMD verify: $NGINX_BIN -v == $(upstream "$TARGET") ; $NGINX_BIN -t ; master /proc/<pid>/exe not deleted ; HTTP smoke"
  echo "CMD rollback: cp <dir>/nginx.list.orig $NGINX_LIST ; rm -f $PIN_FILE ; $APT_GET update ; $DPKG -i <dir>/${PKG}_${inst:-<installed>}_$ARCH.deb ; $NGINX_BIN -t && $NGINX_BIN -s reload"
  [ "$SIM" = 1 ] && simulate
  return 0
}

simulate() { # resolve the install against a throw-away apt state (system config untouched)
  local T; T="$(mktemp -d /tmp/nginx-channel-sim.XXXXXX)"
  mkdir -p "$T/lists/partial" "$T/cache/archives/partial" "$T/prefs" "$T/parts"
  printf '%s\n' "$STABLE_LINE" > "$T/sources.list"
  printf '%s\n' "$MAINLINE_LINE" >> "$T/sources.list" # prove the pin keeps stable even with mainline present
  printf '%s\n' "$PIN_CONTENT" > "$T/prefs/99-nginx-stable"
  local O=(-o "Dir::Etc::sourcelist=$T/sources.list" -o "Dir::Etc::sourceparts=$T/parts" -o "Dir::Etc::preferencesparts=$T/prefs"
           -o "Dir::Etc::preferences=$T/none" -o "Dir::State::Lists=$T/lists" -o "Dir::Cache=$T/cache" -o "Debug::NoLocking=1")
  if apt-get "${O[@]}" update -qq >/dev/null 2>"$T/update.err"; then
    echo "SIM apt-cache policy $PKG (stable + mainline sources, pin):"
    apt-cache "${O[@]}" policy "$PKG" | sed -n '1,12p' | sed 's/^/SIM   /'
    echo "SIM apt-get -s $(install_cmd "$TARGET" | sed "s/^$APT_GET //")"
    apt-get "${O[@]}" -s install -y --allow-downgrades "$PKG=$TARGET" 2>&1 | grep -E '^(Inst|Conf|E:|The following)|downgrade' | sed 's/^/SIM   /' || true
    local cand; cand="$(apt-cache "${O[@]}" policy "$PKG" | sed -n 's/^ *Candidate: *//p')"
    if [ -n "$cand" ] && ! printf '%s' "$cand" | grep -qE '^[0-9]+\.[0-9]*[13579]\.'; then
      echo "SIM OK   candidate with stable + mainline sources = $cand (stable; no mainline creep)"
    else
      echo "SIM FAIL candidate with stable + mainline sources = ${cand:-none} (mainline creep)"
    fi
  else
    echo "SIM FAIL apt-get update in sandbox: $(tail -2 "$T/update.err" | tr '\n' ' ')"
  fi
  rm -rf "$T"
}

need_bdir() { [ -n "$BDIR" ] || { echo "FAIL --backup-dir is required" >&2; exit 2; }; }

cmd_backup() {
  need_bdir
  local inst; inst="$(installed_deb)"; [ -n "$inst" ] || { echo "FAIL $PKG not installed" >&2; exit 3; }
  local deb="$BDIR/${PKG}_${inst#*:}_$ARCH.deb"
  if [ "$DRY" = 1 ]; then
    echo "DRY: mkdir -p $BDIR ; (cd $BDIR && $DPKG_REPACK $PKG) ; dpkg-deb -I $deb ; cp $NGINX_LIST $BDIR/nginx.list.orig"
    echo "BACKUP deb=$deb list=$BDIR/nginx.list.orig installed=$inst"
    return 0
  fi
  mkdir -p "$BDIR"
  if [ -f "$deb" ] && dpkg-deb -I "$deb" >/dev/null 2>&1; then echo "OK   repack exists: $deb"
  else (cd "$BDIR" && "$DPKG_REPACK" "$PKG" >/dev/null); dpkg-deb -I "$deb" >/dev/null; echo "OK   repacked $PKG $inst -> $deb"; fi
  [ -f "$BDIR/nginx.list.orig" ] || cp -p "$NGINX_LIST" "$BDIR/nginx.list.orig"
  if [ -f "$PIN_FILE" ]; then [ -f "$BDIR/pin.orig" ] || cp -p "$PIN_FILE" "$BDIR/pin.orig"; else : > "$BDIR/pin.absent"; fi
  printf 'installed=%s\nheld=%s\ncreated=%s\n' "$inst" "$(is_held && echo yes || echo no)" "$(date -u +%FT%TZ)" > "$BDIR/state.env"
  ( cd "$BDIR" && sha256sum "$(basename "$deb")" nginx.list.orig > SHA256SUMS )
  echo "BACKUP deb=$deb list=$BDIR/nginx.list.orig installed=$inst"
}

cmd_apply() {
  [ -n "$TARGET" ] || { echo "FAIL --target is required" >&2; exit 2; }
  need_bdir
  local inst; inst="$(installed_deb)"
  if [ "$inst" = "$TARGET" ] && [ -f "$PIN_FILE" ] && grep -qxF "$STABLE_LINE" "$NGINX_LIST" 2>/dev/null; then
    echo "OK   already at $TARGET on the stable channel"; graceful_reload; return 0
  fi
  if [ "$DRY" = 0 ]; then
    [ -f "$BDIR/state.env" ] && [ -f "$BDIR/nginx.list.orig" ] && (cd "$BDIR" && sha256sum -c --quiet SHA256SUMS) \
      || { echo "FAIL no verified backup in $BDIR; refusing to apply" >&2; exit 4; }
  fi
  if [ "$DRY" = 1 ]; then echo "DRY: write $NGINX_LIST: $STABLE_LINE"; echo "DRY: write $PIN_FILE"
  else
    printf '%s\n' "$STABLE_LINE" > "$NGINX_LIST.tmp" && mv "$NGINX_LIST.tmp" "$NGINX_LIST"
    printf '%s\n' "$PIN_CONTENT" > "$PIN_FILE.tmp" && mv "$PIN_FILE.tmp" "$PIN_FILE"
  fi
  if is_held; then run apt-mark unhold "$PKG"; fi
  # shellcheck disable=SC2046
  run $(update_cmd)
  # shellcheck disable=SC2046
  run $(install_cmd "$TARGET")
  graceful_reload
  if [ "$DRY" = 0 ] && ! master_binary_current; then
    # the package's postinst normally hot-swaps the binary (init.d upgrade); fall back to it here
    if [ -x /etc/init.d/nginx ]; then /etc/init.d/nginx upgrade; else systemctl restart nginx; fi
  fi
  if [ "$DRY" = 0 ] && grep -q '^held=yes' "$BDIR/state.env" 2>/dev/null; then apt-mark hold "$PKG" >/dev/null; fi
  echo "APPLIED $PKG $inst -> $TARGET"
}

cmd_verify() {
  [ -n "$TARGET" ] || { echo "FAIL --target is required" >&2; exit 2; }
  local fail=0 v want; want="$(upstream "$TARGET")"
  v="$("$NGINX_BIN" -v 2>&1 | sed -n 's|.*nginx/\([0-9.]*\).*|\1|p')"
  if [ "$v" = "$want" ]; then echo "OK   nginx -v $v"; else echo "FAIL nginx -v ${v:-?} != $want"; fail=1; fi
  if "$NGINX_BIN" -t >/dev/null 2>&1; then echo "OK   nginx -t"; else echo "FAIL nginx -t"; fail=1; fi
  if master_binary_current; then echo "OK   master runs the installed binary"; else echo "FAIL master still runs a replaced binary"; fail=1; fi
  if [ -f "$PROFILE_JSON" ]; then
    while IFS=$'\t' read -r url expect; do
      [ -n "$url" ] || continue
      code="$("$CURL_BIN" -s -o /dev/null -w '%{http_code}' --max-time 20 "$url" || echo 000)"
      if printf '%s\n' $expect | grep -qx "$code"; then echo "OK   $code $url"; else echo "FAIL $code $url (expect $expect)"; fail=1; fi
    done < <(jq -r '.smokeUrls[]? | [.url, ((.expect // 200) | if type=="array" then map(tostring)|join(" ") else tostring end)] | @tsv' "$PROFILE_JSON")
  fi
  return $fail
}

cmd_rollback() {
  need_bdir
  local deb; deb="$(ls "$BDIR"/${PKG}_*.deb 2>/dev/null | head -1 || true)"
  [ -n "$deb" ] && [ -f "$BDIR/nginx.list.orig" ] || { echo "FAIL no backup in $BDIR" >&2; exit 4; }
  local want; want="$(sed -n 's/^installed=//p' "$BDIR/state.env" 2>/dev/null)"
  if [ "$(installed_deb)" = "$want" ] && cmp -s "$BDIR/nginx.list.orig" "$NGINX_LIST" && { [ -f "$BDIR/pin.orig" ] || [ ! -f "$PIN_FILE" ]; }; then
    echo "OK   already rolled back ($want)"; return 0
  fi
  run cp -p "$BDIR/nginx.list.orig" "$NGINX_LIST"
  if [ -f "$BDIR/pin.orig" ]; then run cp -p "$BDIR/pin.orig" "$PIN_FILE"; else run rm -f "$PIN_FILE"; fi
  # shellcheck disable=SC2046
  run $(update_cmd)
  if is_held; then run apt-mark unhold "$PKG"; fi
  run "$DPKG" -i "$deb"
  graceful_reload
  if [ "$DRY" = 0 ] && ! master_binary_current; then
    if [ -x /etc/init.d/nginx ]; then /etc/init.d/nginx upgrade; else systemctl restart nginx; fi
  fi
  if [ "$DRY" = 0 ] && grep -q '^held=yes' "$BDIR/state.env" 2>/dev/null; then apt-mark hold "$PKG" >/dev/null; fi
  echo "ROLLEDBACK $PKG -> ${want:-$(basename "$deb")}"
}

case "$CMD" in
  plan) cmd_plan ;;
  backup) cmd_backup ;;
  apply) cmd_apply ;;
  verify) cmd_verify ;;
  rollback) cmd_rollback ;;
  *) usage ;;
esac
