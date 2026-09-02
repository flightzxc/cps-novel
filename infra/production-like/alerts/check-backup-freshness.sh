#!/usr/bin/env bash
# RC-7 minimal alert ③: backup success marker must be fresh (< 26h old).
#
# Threshold ported from CPS 短剧 (cps-admin, read-only, v8.3.6 / peeled commit
# 16f2e4cfca51f46af0dede899ecf6242a770bbd0) src/lib/health-backup-status.ts
# DEFAULT_STALE_THRESHOLD_HOURS=26 ("日备每天一次；26 小时 = 24 小时周期 + 2
# 小时余量，容忍备份窗口本身的抖动... 但仍然能在漏跑一整天之内报警"). Same
# fail-closed rule as CPS: a marker that cannot be read at all (missing file,
# unreachable container) is treated the same as a known-bad state, never as
# silently healthy — this is what CPS's own DEVLOG (2026-08 backup incident)
# calls out as the actual root cause of that incident: "备份本身早修好了...
# 但没有任何东西在读那个日志... 这从来不是检测问题，是没有信号到人。"
#
# Marker location: infra/production-like/backup-timer.sh's `run_backup()`
# does `touch /tmp/x8-backup-last-success` *inside* the backup-timer
# container's own ephemeral /tmp (confirmed by reading that script — it is
# also what the compose healthcheck for that service tests, but that
# healthcheck only proves existence, never freshness). There is no host bind
# mount for it in infra/production-like/docker-compose.yml, so the default
# path here is read via `docker exec`. If a future change bind-mounts this
# marker (or an equivalent) to the host, set ALERT_BACKUP_MARKER_HOST_PATH to
# read it directly instead — no docker dependency in that mode.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/production-like/alerts/alert-lib.sh
source "${SCRIPT_DIR}/alert-lib.sh"

: "${ALERT_COMPOSE_PROJECT:=cps-novel-x8-local}"
: "${ALERT_BACKUP_MARKER_PATH:=/tmp/x8-backup-last-success}"
: "${ALERT_BACKUP_CONTAINER_NAME:=${ALERT_COMPOSE_PROJECT}-backup-timer-1}"
# 26h = 93600s, see header comment above.
: "${ALERT_BACKUP_MAX_AGE_SECONDS:=93600}"

# Prints the marker's mtime as a Unix epoch on stdout, or returns non-zero
# after already firing the appropriate alert (host-path branch fires
# directly; the docker-exec branch fires via fail_closed_run — callers must
# not fire a second "missing" alert on a non-zero return from this function).
resolve_marker_mtime_epoch() {
  if [[ -n "${ALERT_BACKUP_MARKER_HOST_PATH:-}" ]]; then
    if [[ ! -e "${ALERT_BACKUP_MARKER_HOST_PATH}" ]]; then
      alert_fire "backup_marker_missing" "critical" \
        "cps-novel backup success marker missing" \
        "ALERT_BACKUP_MARKER_HOST_PATH=${ALERT_BACKUP_MARKER_HOST_PATH} does not exist."
      return 1
    fi
    local mtime
    mtime="$(stat -f '%m' "${ALERT_BACKUP_MARKER_HOST_PATH}" 2>/dev/null \
      || stat -c '%Y' "${ALERT_BACKUP_MARKER_HOST_PATH}" 2>/dev/null \
      || true)"
    if [[ -z "${mtime}" ]]; then
      alert_fire "backup_marker_missing" "critical" \
        "cps-novel backup success marker unreadable" \
        "stat failed for ALERT_BACKUP_MARKER_HOST_PATH=${ALERT_BACKUP_MARKER_HOST_PATH}."
      return 1
    fi
    printf '%s' "${mtime}"
    return 0
  fi

  fail_closed_run "backup_marker_missing" \
    "cps-novel backup success marker unreadable (docker exec)" -- \
    docker exec "${ALERT_BACKUP_CONTAINER_NAME}" stat -c '%Y' "${ALERT_BACKUP_MARKER_PATH}"
}

check_backup_freshness() {
  local mtime rc now age
  set +e
  mtime="$(resolve_marker_mtime_epoch)"
  rc=$?
  set -e

  if [[ ${rc} -ne 0 ]]; then
    # resolve_marker_mtime_epoch already fired backup_marker_missing.
    return 1
  fi

  if ! [[ "${mtime}" =~ ^[0-9]+$ ]]; then
    alert_fire "backup_marker_missing" "critical" \
      "cps-novel backup success marker mtime unparsable" \
      "raw value: ${mtime}"
    return 1
  fi

  now="$(date +%s)"
  age=$(( now - mtime ))
  if [[ ${age} -gt ${ALERT_BACKUP_MAX_AGE_SECONDS} ]]; then
    alert_fire "backup_marker_stale" "critical" \
      "cps-novel backup marker stale (older than threshold)" \
      "mtime_epoch=${mtime} age_seconds=${age} threshold_seconds=${ALERT_BACKUP_MAX_AGE_SECONDS} (26h, ported from CPS DEFAULT_STALE_THRESHOLD_HOURS)."
    return 1
  fi

  alert_recover "backup_marker_missing"
  alert_recover "backup_marker_stale"
  alert_log "check-backup-freshness: OK (age=${age}s <= ${ALERT_BACKUP_MAX_AGE_SECONDS}s)"
  return 0
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  alert_fire_total_reset
  check_backup_freshness
fi
