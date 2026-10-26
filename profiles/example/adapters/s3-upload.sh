#!/usr/bin/env bash
# s3-upload.sh — profile backup target (profile.backupTargets[]), called by the core as:
#   s3-upload.sh <bundleDir> <dest-name>
# Copies the run bundle with rclone to $STACK_UPDATES_REMOTE/<dest-name>/ (any rclone remote: S3, B2, SFTP, ...).
# Set STACK_UPDATES_REMOTE (e.g. s3remote:my-bucket/stack-updates); profile.backupTargets[].remote is passed by the core as that variable.
# The local bundle is never deleted. Exit != 0 on failure (core logs a warning, keeps local copy).
set -u
BUNDLE="${1:-}"
NAME="${2:-}"
BUCKET="${STACK_UPDATES_REMOTE:-}"
[ -n "$BUCKET" ] || { echo "STACK_UPDATES_REMOTE not set" >&2; exit 2; }
log(){ echo "$(date "+%F %T") $*"; }

if [ -z "$BUNDLE" ] || [ -z "$NAME" ] || [ ! -d "$BUNDLE" ]; then
  echo "Usage: $0 <bundleDir> <dest-name>" >&2
  exit 2
fi
case "$NAME" in *[!A-Za-z0-9._-]*) echo "invalid dest-name: $NAME" >&2; exit 2;; esac
if [ ! -f "$BUNDLE/MANIFEST.sha256" ]; then
  echo "refusing to upload: $BUNDLE/MANIFEST.sha256 missing" >&2
  exit 1
fi

log "upload $BUNDLE -> $BUCKET/$NAME/"
if ! rclone copy "$BUNDLE" "$BUCKET/$NAME/" --transfers 4 -q; then
  log "upload FAILED"
  exit 1
fi
LOCAL=$(find "$BUNDLE" -type f | wc -l)
REMOTE=$(rclone ls "$BUCKET/$NAME/" 2>/dev/null | wc -l)
log "upload OK: $REMOTE remote files / $LOCAL local files"
[ "$REMOTE" -ge "$LOCAL" ] || { log "remote file count lower than local"; exit 1; }
