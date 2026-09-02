#!/usr/bin/env bash
# RC-7 minimal alert ②: worker expired processing locks + worker container
# health.
#
# The SQL below is copied verbatim (not rewritten) from
# docs/operations/LAUNCH_DAY_HEALTH_CHECKS.md §2 "Expired processing locks",
# which is itself identical to GROUP_2 in
# infra/production-like/launch-day-health-checks.sql. Do not hand-edit this
# query here — if the schema changes, edit the source doc first and copy
# again. Per that doc: "Any result means a lease is eligible for normal
# Worker recovery. Do not update the item manually."
#
# ALERT_DATABASE_URL must use a read-only role — analyst_ro, per the same doc
# and per scripts/x8-production-like.sh's own health-sql command, which reads
# P1_12_ANALYST_RO_PASSWORD_FILE for exactly this purpose. analyst_ro already
# has `default_transaction_read_only = on` set at the role level (confirmed by
# scripts/x8-production-like.sh:276's own SHOW check against a live grant), so
# this script does not need to wrap the query in an explicit BEGIN READ ONLY.
# Never point ALERT_DATABASE_URL at migration_owner or any writer role.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/production-like/alerts/alert-lib.sh
source "${SCRIPT_DIR}/alert-lib.sh"

: "${ALERT_COMPOSE_PROJECT:=cps-novel-x8-local}"
: "${ALERT_WORKER_CONTAINER_NAME:=${ALERT_COMPOSE_PROJECT}-worker-1}"
: "${ALERT_PSQL_TIMEOUT_SECONDS:=15}"

# Verbatim from docs/operations/LAUNCH_DAY_HEALTH_CHECKS.md §2.
read -r -d '' EXPIRED_LOCKS_SQL <<'SQL' || true
WITH expired AS (
  SELECT 'catalog_scan'::text AS family, 'catalog_scan'::text AS task_type,
         i.locked_until
  FROM catalog_scan_task_item i
  WHERE i.status = 'processing' AND i.locked_until < transaction_timestamp()
  UNION ALL
  SELECT 'channel_sync', t.task_type, i.locked_until
  FROM channel_sync_task_item i
  JOIN channel_sync_task t ON t.id = i.task_id
  WHERE i.status = 'processing' AND i.locked_until < transaction_timestamp()
  UNION ALL
  SELECT 'generic', t.task_type, i.locked_until
  FROM generic_task_item i
  JOIN generic_task t ON t.id = i.task_id
  WHERE i.status = 'processing' AND i.locked_until < transaction_timestamp()
)
SELECT family, task_type, count(*) AS expired_count,
       min(locked_until) AS oldest_expiry,
       max(transaction_timestamp() - locked_until) AS maximum_overdue
FROM expired
GROUP BY family, task_type
ORDER BY maximum_overdue DESC, family, task_type;
SQL

check_expired_locks() {
  if [[ -z "${ALERT_DATABASE_URL:-}" ]]; then
    alert_fire "worker_lock_probe_failed" "critical" \
      "ALERT_DATABASE_URL not configured" \
      "check-worker-locks.sh requires ALERT_DATABASE_URL (read-only analyst_ro role); see docs/operations/ALERTS_RUNBOOK_2026-09-03.md."
    return 1
  fi

  local out_file err_file rc row_count
  out_file="$(mktemp "${TMPDIR:-/tmp}/cps-novel-locks.XXXXXX")"
  err_file="$(mktemp "${TMPDIR:-/tmp}/cps-novel-locks-err.XXXXXX")"

  set +e
  PGCONNECT_TIMEOUT="${ALERT_PSQL_TIMEOUT_SECONDS}" \
    psql "${ALERT_DATABASE_URL}" -X --no-psqlrc -v ON_ERROR_STOP=1 -Atq \
    >"${out_file}" 2>"${err_file}" <<<"${EXPIRED_LOCKS_SQL}"
  rc=$?
  set -e

  if [[ ${rc} -ne 0 ]]; then
    alert_fire "worker_lock_probe_failed" "critical" \
      "cps-novel expired-lock SQL probe failed" \
      "psql exit=${rc} against ALERT_DATABASE_URL. stderr: $(cat "${err_file}")"
    rm -f "${out_file}" "${err_file}"
    return 1
  fi

  row_count="$(wc -l < "${out_file}" | tr -d '[:space:]')"
  rm -f "${out_file}" "${err_file}"

  if [[ "${row_count}" -gt 0 ]]; then
    alert_fire "worker_expired_locks" "critical" \
      "cps-novel worker has expired processing locks" \
      "expired-lock groups=${row_count} (see docs/operations/LAUNCH_DAY_HEALTH_CHECKS.md §2 for the query; re-run scripts/x8-production-like.sh health-sql for the full breakdown, do not update items manually)."
    return 1
  fi

  alert_recover "worker_expired_locks"
  alert_recover "worker_lock_probe_failed"
  alert_log "check-worker-locks: OK (0 expired-lock groups)"
  return 0
}

check_worker_container_health() {
  local status rc
  set +e
  status="$(docker inspect --format '{{.State.Health.Status}}' "${ALERT_WORKER_CONTAINER_NAME}" 2>&1)"
  rc=$?
  set -e

  if [[ ${rc} -ne 0 ]]; then
    alert_fire "worker_container_inspect_failed" "critical" \
      "cps-novel worker container not inspectable" \
      "docker inspect failed (exit=${rc}) for container=${ALERT_WORKER_CONTAINER_NAME}: ${status}"
    return 1
  fi

  if [[ "${status}" != "healthy" ]]; then
    alert_fire "worker_container_unhealthy" "critical" \
      "cps-novel worker container health != healthy" \
      "container=${ALERT_WORKER_CONTAINER_NAME} status=${status}"
    return 1
  fi

  alert_recover "worker_container_unhealthy"
  alert_recover "worker_container_inspect_failed"
  alert_log "check-worker-locks: worker container healthy (${ALERT_WORKER_CONTAINER_NAME})"
  return 0
}

run_worker_checks() {
  local rc=0
  check_expired_locks || rc=1
  check_worker_container_health || rc=1
  return "${rc}"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  alert_fire_total_reset
  run_worker_checks
fi
