#!/usr/bin/env bash
set -euo pipefail
set +x

interval="${SCHEDULER_INTERVAL_SECONDS:-60}"
if [[ ! "$interval" =~ ^[1-9][0-9]*$ ]] || (( interval > 86400 )); then
  echo "ERROR: SCHEDULER_INTERVAL_SECONDS must be an integer from 1 to 86400" >&2
  exit 1
fi

child_pid=""
stop() {
  if [[ -n "$child_pid" ]]; then
    kill -TERM "$child_pid" >/dev/null 2>&1 || true
    wait "$child_pid" >/dev/null 2>&1 || true
  fi
  exit 0
}
trap stop INT TERM

while true; do
  tsx scheduler/index.ts &
  child_pid="$!"
  wait "$child_pid"
  child_pid=""

  sleep "$interval" &
  child_pid="$!"
  wait "$child_pid"
  child_pid=""
done
