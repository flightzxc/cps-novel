#!/usr/bin/env bash
# RC-7 minimal alerts — drill script.
#
# Ports CPS 短剧's "keyword-flip" rehearsal method (per user-memory record of
# the 2026-08 CPS alert-chain verification: flip what the monitor expects to
# see, confirm the alert fires, without touching production) to a fully local,
# self-contained form: every scenario below points the real check functions
# at deliberately-unreachable or deliberately-stale *local* targets (an
# unbound TCP port, a nonexistent docker container name, a temp file this
# script creates and deletes itself) and asserts alert-lib.sh's alert_fire was
# actually invoked. Nothing here calls a real service, and DRY_RUN is forced
# to 1 so alert-lib.sh never issues a real curl POST regardless of what the
# caller's environment has set.
#
# Usage: DRY_RUN=1 bash infra/production-like/alerts/drill.sh
set -uo pipefail

if [[ "${DRY_RUN:-1}" != "1" ]]; then
  echo "REFUSING: drill.sh only ever runs with DRY_RUN=1 (RC-7 hard constraint: no real pushes). See docs/operations/ALERTS_RUNBOOK_2026-09-03.md." >&2
  exit 64
fi
export DRY_RUN=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Isolated state dir so this drill never reads or writes the real operational
# debounce state under /tmp/cps-novel-alerts, and never leaves anything
# behind.
DRILL_STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-alerts-drill.XXXXXX")"
export ALERT_STATE_DIR="${DRILL_STATE_DIR}"
cleanup() { rm -rf "${DRILL_STATE_DIR}"; }
trap cleanup EXIT INT TERM

# shellcheck source=infra/production-like/alerts/alert-lib.sh
source "${SCRIPT_DIR}/alert-lib.sh"
# shellcheck source=infra/production-like/alerts/check-health.sh
source "${SCRIPT_DIR}/check-health.sh"
# shellcheck source=infra/production-like/alerts/check-worker-locks.sh
source "${SCRIPT_DIR}/check-worker-locks.sh"
# shellcheck source=infra/production-like/alerts/check-backup-freshness.sh
source "${SCRIPT_DIR}/check-backup-freshness.sh"

# NOTE (RC-7 review, verified empirically): errexit is effectively ON from here
# on, despite the `set -uo pipefail` above. Sourcing alert-lib.sh re-enables it
# (that file sets `-euo pipefail`), and every check-*.sh both sets it at load
# and restores `set -e` on the way out of its own `set +e; ...; set -e` probe
# blocks. So "one failing check never stops the others" is delivered by the
# `|| ...` guard on each call below, NOT by the absence of -e. Keep every check
# invocation guarded; an unguarded command here would abort the whole batch.

pass_count=0
fail_count=0

expect_alert_fired() {
  local label="$1" before="$2" after="$3"
  if [[ "${after}" -gt "${before}" ]]; then
    printf 'PASS  %s (alerts %d -> %d)\n' "${label}" "${before}" "${after}"
    pass_count=$(( pass_count + 1 ))
  else
    printf 'FAIL  %s (alert count unchanged: %d)\n' "${label}" "${before}"
    fail_count=$(( fail_count + 1 ))
  fi
}

expect_bool() {
  local label="$1" got="$2" want="$3"
  if [[ "${got}" == "${want}" ]]; then
    printf 'PASS  %s\n' "${label}"
    pass_count=$(( pass_count + 1 ))
  else
    printf 'FAIL  %s (got=%s want=%s)\n' "${label}" "${got}" "${want}"
    fail_count=$(( fail_count + 1 ))
  fi
}

echo "=== drill: is_health_body_ok keyword-flip (no network) ==="
r1=false; is_health_body_ok '{"ok":true,"status":"healthy"}' && r1=true
expect_bool "is_health_body_ok true-case" "${r1}" "true"
r2=false; is_health_body_ok '{"ok":false,"status":"unhealthy","reasons":["database_unreachable"]}' && r2=true
expect_bool "is_health_body_ok false-case" "${r2}" "false"
r3=false; is_health_body_ok '{"status":"healthy"}' && r3=true
expect_bool "is_health_body_ok missing-ok-key" "${r3}" "false"

echo
echo "=== drill A: check-health.sh against an unbound local port (fail-closed) ==="
before="$(alert_fire_total)"
HEALTH_URL="http://127.0.0.1:1/__rc7_drill_unreachable__" HEALTH_CURL_TIMEOUT_SECONDS=2 check_health || true
after="$(alert_fire_total)"
expect_alert_fired "check_health unreachable -> health_probe_unreachable" "${before}" "${after}"

echo
echo "=== drill B: check-worker-locks.sh SQL probe against an unreachable database (fail-closed) ==="
before="$(alert_fire_total)"
ALERT_DATABASE_URL="postgresql://drill:drill@127.0.0.1:1/drill" ALERT_PSQL_TIMEOUT_SECONDS=2 check_expired_locks || true
after="$(alert_fire_total)"
expect_alert_fired "check_expired_locks unreachable db -> worker_lock_probe_failed" "${before}" "${after}"

echo
echo "=== drill C: check-worker-locks.sh container inspect against a nonexistent container (read-only docker inspect, no state change) ==="
before="$(alert_fire_total)"
ALERT_WORKER_CONTAINER_NAME="cps-novel-x8-drill-nonexistent-container" check_worker_container_health || true
after="$(alert_fire_total)"
expect_alert_fired "check_worker_container_health missing container -> worker_container_inspect_failed" "${before}" "${after}"

echo
echo "=== drill D: check-backup-freshness.sh against a missing marker file ==="
before="$(alert_fire_total)"
ALERT_BACKUP_MARKER_HOST_PATH="${DRILL_STATE_DIR}/does-not-exist" check_backup_freshness || true
after="$(alert_fire_total)"
expect_alert_fired "check_backup_freshness missing marker -> backup_marker_missing" "${before}" "${after}"

echo
echo "=== drill E: check-backup-freshness.sh against a stale marker file (30h old, threshold 26h) ==="
stale_marker="${DRILL_STATE_DIR}/stale-marker"
: > "${stale_marker}"
stale_stamp="$(date -v -30H +%Y%m%d%H%M 2>/dev/null || date -d '30 hours ago' +%Y%m%d%H%M)"
touch -t "${stale_stamp}" "${stale_marker}"
before="$(alert_fire_total)"
ALERT_BACKUP_MARKER_HOST_PATH="${stale_marker}" ALERT_BACKUP_MAX_AGE_SECONDS=93600 check_backup_freshness || true
after="$(alert_fire_total)"
expect_alert_fired "check_backup_freshness stale marker (30h > 26h) -> backup_marker_stale" "${before}" "${after}"

echo
echo "drill summary: pass=${pass_count} fail=${fail_count} total_alerts_fired=$(alert_fire_total)"
if [[ ${fail_count} -gt 0 ]]; then
  exit 1
fi
exit 0
