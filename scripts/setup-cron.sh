#!/usr/bin/env bash
# Installs crontab entries that call POST /sync every 20 minutes,
# Mon-Fri 08:30-17:30 (08:30, 08:50, 09:10, ... 17:10, 17:30). Weekends skipped.
# Times follow the system timezone. Re-running replaces the previous entries.
# Usage: scripts/setup-cron.sh [install|remove]   (default: install)
set -euo pipefail

SYNC_URL="${SYNC_URL:-http://localhost:${PORT:-3000}/sync}"
LOG_DIR="$(cd "$(dirname "$0")/.." && pwd)/logs"
MARKER="# claude-state sync"
CMD="/usr/bin/curl -sS -m 120 -X POST $SYNC_URL >> $LOG_DIR/sync.log 2>&1; echo >> $LOG_DIR/sync.log"

current="$(crontab -l 2>/dev/null | grep -v "$MARKER" || true)"

if [[ "${1:-install}" == "remove" ]]; then
  printf '%s\n' "$current" | crontab -
  echo "Removed claude-state sync entries."
  exit 0
fi

mkdir -p "$LOG_DIR"
{
  [[ -n "$current" ]] && printf '%s\n' "$current"
  echo "30,50 8 * * 1-5 $CMD $MARKER"
  echo "10,30,50 9-16 * * 1-5 $CMD $MARKER"
  echo "10,30 17 * * 1-5 $CMD $MARKER"
} | crontab -

echo "Installed:"
crontab -l | grep "$MARKER"
