#!/bin/sh
# Installs crontab entries that call POST /sync every 10 minutes,
# Mon-Fri 08:00-18:50 (08:00, 08:10, ... 18:40, 18:50), and every 20 minutes
# outside that window (weekday nights/early mornings and all weekend).
# Times follow the system timezone. Re-running replaces the previous entries.
# Usage: scripts/setup-cron.sh [install|remove]   (default: install)
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Same port as the server: PORT env > PORT in .env > 3001.
PORT="${PORT:-$(grep -E '^PORT=' "$ROOT/.env" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '"' || true)}"
SYNC_URL="${SYNC_URL:-http://localhost:${PORT:-3001}/sync}"
LOG_DIR="$ROOT/logs"
MARKER="# claude-state sync"
CMD="/usr/bin/curl -sS -m 120 -X POST $SYNC_URL >> $LOG_DIR/sync.log 2>&1; echo >> $LOG_DIR/sync.log"

current="$(crontab -l 2>/dev/null | grep -v "$MARKER" || true)"

if [ "${1:-install}" = "remove" ]; then
  printf '%s\n' "$current" | crontab -
  echo "Removed claude-state sync entries."
  exit 0
fi

mkdir -p "$LOG_DIR"
{
  [ -n "$current" ] && printf '%s\n' "$current"
  echo "*/10 8-18 * * 1-5 $CMD $MARKER"
  echo "*/20 0-7,19-23 * * 1-5 $CMD $MARKER"
  echo "*/20 * * * 0,6 $CMD $MARKER"
} | crontab -

echo "Installed:"
crontab -l | grep "$MARKER"
