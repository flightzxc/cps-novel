#!/usr/bin/env bash
set -euo pipefail
set +x

: "${X8_BACKUP_OUTPUT_DIR:?X8_BACKUP_OUTPUT_DIR is required}"
: "${X8_BACKUP_PGPASS_SOURCE:?X8_BACKUP_PGPASS_SOURCE is required}"
: "${X8_BACKUP_INTERVAL_SECONDS:=86400}"
: "${X8_BACKUP_RUN_ON_START:=true}"

[[ "$X8_BACKUP_OUTPUT_DIR" = /* ]] || {
  echo "ERROR: X8_BACKUP_OUTPUT_DIR must be absolute" >&2
  exit 65
}
[[ "$X8_BACKUP_INTERVAL_SECONDS" =~ ^[1-9][0-9]*$ ]] || {
  echo "ERROR: X8_BACKUP_INTERVAL_SECONDS must be a positive integer" >&2
  exit 65
}
[[ "$X8_BACKUP_RUN_ON_START" == "true" || "$X8_BACKUP_RUN_ON_START" == "false" ]] || {
  echo "ERROR: X8_BACKUP_RUN_ON_START must be true or false" >&2
  exit 65
}

umask 077
PGPASSFILE=/tmp/x8-backup.pgpass
export PGPASSFILE
cp "$X8_BACKUP_PGPASS_SOURCE" "$PGPASSFILE"
chmod 600 "$PGPASSFILE"

run_backup() {
  local stamp output
  stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
  output="$X8_BACKUP_OUTPUT_DIR/cps-novel-x8-${stamp}.dump"
  /bin/bash /opt/cps-novel-x8/backup-logical.sh --output "$output"
  touch /tmp/x8-backup-last-success
}

if [[ "${1:-}" == "--once" ]]; then
  run_backup
  exit 0
fi
[[ $# -eq 0 ]] || {
  echo "usage: backup-timer.sh [--once]" >&2
  exit 64
}

if [[ "$X8_BACKUP_RUN_ON_START" == "true" ]]; then
  run_backup
fi

while true; do
  sleep "$X8_BACKUP_INTERVAL_SECONDS"
  run_backup
done
