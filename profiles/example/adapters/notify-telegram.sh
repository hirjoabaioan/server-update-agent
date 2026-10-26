#!/usr/bin/env bash
# Notify adapter (Bot API). Reads the message from stdin; config comes from the env set by the core:
#   NOTIFY_TOKEN_FILE  file with the bot token (mode 0400)
#   NOTIFY_ENV_FILE    env file; TELEGRAM_BOT_TOKEN used if the token file is unreadable,
#                      TELEGRAM_CHAT_ID used if present
#   NOTIFY_CHAT_ID     fallback chat id (profile.notify.chatId; not a secret)
# POSTs sendMessage with parse_mode=HTML (<,>,& escaped), 10 s timeout. The token never reaches argv
# (curl config on stdin) nor the output (masked). Prints the API response; exit 0 only if ok:true.
set -u
umask 077
TOKEN=""
if [ -n "${NOTIFY_TOKEN_FILE:-}" ] && [ -r "$NOTIFY_TOKEN_FILE" ]; then TOKEN=$(tr -d '[:space:]' < "$NOTIFY_TOKEN_FILE"); fi
CHAT="${NOTIFY_CHAT_ID:-}"
if [ -n "${NOTIFY_ENV_FILE:-}" ] && [ -r "$NOTIFY_ENV_FILE" ]; then
  [ -z "$TOKEN" ] && TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$NOTIFY_ENV_FILE" | head -1 | cut -d= -f2- | tr -d "\"' \r")
  ENVCHAT=$(grep -E '^TELEGRAM_CHAT_ID=' "$NOTIFY_ENV_FILE" | head -1 | cut -d= -f2- | tr -d "\"' \r")
  [ -n "$ENVCHAT" ] && CHAT="$ENVCHAT"
fi
[ -z "$TOKEN" ] && { echo "notify: no bot token available" >&2; exit 2; }
[ -z "$CHAT" ] && { echo "notify: no chat id available" >&2; exit 2; }

TMP=$(mktemp); trap 'rm -f "$TMP"' EXIT
sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' > "$TMP"
mask() { sed -e "s|$TOKEN|***|g"; }

RESP=$(printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$TOKEN" | curl -sS --max-time 10 -K - \
  --data-urlencode "chat_id=$CHAT" -d parse_mode=HTML -d disable_web_page_preview=true \
  --data-urlencode "text@$TMP" 2>&1 | mask)
RC=$?
echo "$RESP"
case "$RESP" in *'"ok":true'*) exit 0 ;; esac
exit 1
