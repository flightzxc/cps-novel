#!/usr/bin/env bash
# Gate 5-Dev alert ④: WAL-retention health -- the RC-7 minimal chain
# (check-health.sh / check-worker-locks.sh / check-backup-freshness.sh) never
# looked at the WAL archive itself. Per WAL_RETENTION_X8_ROLLOUT_PLAN_2026-09-17.md
# §4 Gate 5 risk 6: anchored retention has a silent failure direction -- if
# nobody takes a fresh physical base backup on schedule, the retention
# anchor never advances and nothing else notices. This check must be wired
# into run-all.sh before the first real `wal-gc-x8.sh --apply` is ever run
# (see that doc section) precisely so that direction has a watcher.
#
# Four independent, fail-closed judgements, same structure as every other
# check-*.sh in this directory (source alert-lib.sh, fail_closed_run/
# alert_fire/alert_recover, a standalone-execution guard):
#   1. WAL archive directory capacity (OK/WARN/DEGRADED/OVER, the same
#      70%/85%/100% thresholds as wal-retention.sh --max-bytes).
#   2. pg_stat_archiver health -- the exact predicate
#      wal-retention.sh --require-archiver-healthy uses (last_failed_time
#      newer than last_archived_time), copied verbatim rather than
#      reinvented.
#   3. Physical base backup freshness -- newest VERIFIED marker's
#      verified_epoch under ALERT_BASE_BACKUP_DIR, same VERIFIED format and
#      YYYYMMDDTHHMMSSZ directory-name contract backup-timer.sh and
#      wal-retention.sh both already use. This is a *different* freshness
#      signal from check-backup-freshness.sh's 26h logical-dump marker (that
#      one reads /tmp/x8-backup-last-success inside the backup-timer
#      container); this one reads the physical-backup VERIFIED marker
#      directly from the host bind mount, so it works without a docker
#      dependency at all.
#   4. pg_wal directory size -- a sustained runaway here (nothing archiving,
#      or archiving but retention never reclaiming) is exactly what judgement
#      1 above would eventually also catch, but this catches it earlier and
#      independently, from inside the data directory itself rather than the
#      archive.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/production-like/alerts/alert-lib.sh
source "${SCRIPT_DIR}/alert-lib.sh"

: "${ALERT_COMPOSE_PROJECT:=cps-novel-x8-local}"
: "${ALERT_POSTGRES_CONTAINER_NAME:=${ALERT_COMPOSE_PROJECT}-postgres-1}"
: "${ALERT_WAL_ARCHIVE_MAX_BYTES:=21474836480}"
: "${ALERT_PG_WAL_MAX_BYTES:=2147483648}"
# Host path to the base-backups directory (the same one
# infra/production-like/docker-compose.yml binds as X8_BASE_BACKUP_DIR into
# both the postgres and backup-timer containers). Reading it directly off
# the host means this judgement needs no docker dependency at all, unlike
# judgements 1/2/4 above.
#
# Gate 5 review fix (P1-5): NO hard-coded worktree-relative fallback here
# anymore -- the old default (`<repo root>/.tmp/x8-production-like/base-backups`)
# silently resolved to whatever worktree happened to run this check, which
# is correct only by coincidence (it is the same trap
# x8_assert_worktree_stack_binding() exists to catch for the operator
# commands: the container this checks against and the worktree running the
# check can drift). When ALERT_BASE_BACKUP_DIR is left unset,
# alert_resolve_base_backup_dir_from_mounts() below resolves it from the
# ACTUAL running container's own mount table instead (the one source of
# truth that cannot drift from what the container has mounted) -- and if
# that resolution itself fails, judgement 3 fails closed with
# base_backup_dir_unresolved rather than silently falling back to a path
# that may not even belong to this container.
: "${ALERT_BASE_BACKUP_DIR:=}"
: "${ALERT_BASE_BACKUP_MAX_AGE_SECONDS:=93600}"
: "${ALERT_PSQL_TIMEOUT_SECONDS:=15}"

# ---- judgement 1: WAL archive directory capacity ---------------------------
check_wal_archive_capacity() {
  local out rc bytes
  set +e
  out="$(docker exec "${ALERT_POSTGRES_CONTAINER_NAME}" du -sb /var/lib/postgresql/wal-archive 2>&1)"
  rc=$?
  set -e

  if [[ ${rc} -ne 0 ]]; then
    alert_fire "wal_archive_capacity_unreadable" "critical" \
      "cps-novel WAL archive capacity unreadable (docker exec)" \
      "docker exec du failed (exit=${rc}) against container=${ALERT_POSTGRES_CONTAINER_NAME}: ${out}"
    return 1
  fi

  bytes="$(printf '%s' "${out}" | awk '{print $1}' | head -1)"
  if ! [[ "${bytes}" =~ ^[0-9]+$ ]]; then
    alert_fire "wal_archive_capacity_unreadable" "critical" \
      "cps-novel WAL archive capacity output unparsable" \
      "raw du output: ${out}"
    return 1
  fi

  # Gate 5 review fix (P2): these three tiers are mutually exclusive
  # judgements of the same byte count -- whichever one fires this run,
  # recover the OTHER two tier keys (plus _unreadable, since a `du` that
  # just succeeded proves this run is not the "can't tell" case), so a
  # previously-open alert for a tier this run has moved away from is not
  # left stuck open forever (it would otherwise only ever clear via the
  # single fully-healthy branch at the bottom, which a persistently
  # over-threshold archive may never reach again).
  if (( bytes >= ALERT_WAL_ARCHIVE_MAX_BYTES )); then
    alert_fire "wal_archive_capacity_over" "critical" \
      "cps-novel WAL archive at/over capacity" \
      "bytes=${bytes} max=${ALERT_WAL_ARCHIVE_MAX_BYTES} (>=100%) container=${ALERT_POSTGRES_CONTAINER_NAME}."
    alert_recover "wal_archive_capacity_degraded"
    alert_recover "wal_archive_capacity_warn"
    alert_recover "wal_archive_capacity_unreadable"
    return 1
  elif (( bytes * 100 >= ALERT_WAL_ARCHIVE_MAX_BYTES * 85 )); then
    alert_fire "wal_archive_capacity_degraded" "critical" \
      "cps-novel WAL archive capacity degraded" \
      "bytes=${bytes} max=${ALERT_WAL_ARCHIVE_MAX_BYTES} (>=85%) container=${ALERT_POSTGRES_CONTAINER_NAME}."
    alert_recover "wal_archive_capacity_over"
    alert_recover "wal_archive_capacity_warn"
    alert_recover "wal_archive_capacity_unreadable"
    return 1
  elif (( bytes * 100 >= ALERT_WAL_ARCHIVE_MAX_BYTES * 70 )); then
    alert_fire "wal_archive_capacity_warn" "warning" \
      "cps-novel WAL archive capacity warning" \
      "bytes=${bytes} max=${ALERT_WAL_ARCHIVE_MAX_BYTES} (>=70%) container=${ALERT_POSTGRES_CONTAINER_NAME}."
    alert_recover "wal_archive_capacity_over"
    alert_recover "wal_archive_capacity_degraded"
    alert_recover "wal_archive_capacity_unreadable"
    return 1
  fi

  alert_recover "wal_archive_capacity_over"
  alert_recover "wal_archive_capacity_degraded"
  alert_recover "wal_archive_capacity_warn"
  alert_recover "wal_archive_capacity_unreadable"
  alert_log "check-wal-archive: archive capacity OK (bytes=${bytes} max=${ALERT_WAL_ARCHIVE_MAX_BYTES})"
  return 0
}

# ---- judgement 2: pg_stat_archiver health -----------------------------------
# Predicate copied verbatim from scripts/db/wal-retention.sh's own
# --require-archiver-healthy second query -- not reinvented here.
check_wal_archiver_health() {
  if [[ -z "${ALERT_DATABASE_URL:-}" ]]; then
    alert_fire "wal_archiver_unreadable" "critical" \
      "ALERT_DATABASE_URL not configured" \
      "check-wal-archive.sh requires ALERT_DATABASE_URL (read-only analyst_ro role) to query pg_stat_archiver; see docs/operations/ALERTS_RUNBOOK_2026-09-03.md."
    return 1
  fi

  local raw rc flag
  set +e
  raw="$(PGCONNECT_TIMEOUT="${ALERT_PSQL_TIMEOUT_SECONDS}" psql "${ALERT_DATABASE_URL}" -X --no-psqlrc -tAc \
    "SELECT (last_failed_time IS NOT NULL AND (last_archived_time IS NULL OR last_failed_time > last_archived_time)) FROM pg_stat_archiver" 2>&1)"
  rc=$?
  set -e

  if [[ ${rc} -ne 0 ]]; then
    alert_fire "wal_archiver_unreadable" "critical" \
      "cps-novel pg_stat_archiver probe failed" \
      "psql exit=${rc} against ALERT_DATABASE_URL. output: ${raw}"
    return 1
  fi

  flag="$(printf '%s' "${raw}" | tr -d '[:space:]')"
  case "${flag}" in
    t)
      alert_fire "wal_archiver_failing" "critical" \
        "cps-novel WAL archiver is failing" \
        "pg_stat_archiver reports last_failed_time newer than last_archived_time (or a failure with no success recorded yet) -- same predicate wal-retention.sh --require-archiver-healthy uses."
      return 1
      ;;
    f)
      alert_recover "wal_archiver_failing"
      alert_recover "wal_archiver_unreadable"
      alert_log "check-wal-archive: archiver healthy"
      return 0
      ;;
    *)
      alert_fire "wal_archiver_unreadable" "critical" \
        "cps-novel pg_stat_archiver output unparsable" \
        "raw value: ${raw}"
      return 1
      ;;
  esac
}

# Gate 5 review fix (P1-5): resolves the host path bound as
# /var/lib/postgresql/base-backups inside ALERT_POSTGRES_CONTAINER_NAME,
# straight off that container's own mount table -- the one source of truth
# that cannot drift from what the container actually has mounted (same
# technique scripts/x8-production-like.sh's base_backup_now() already uses
# to print X8_BASE_BACKUP_HOST_DIR). Only called when the caller has not
# already set ALERT_BASE_BACKUP_DIR explicitly. Docker Desktop for macOS is
# known to report some mount sources with a /host_mnt/ prefix that is only
# meaningful inside the Docker Desktop VM, not on the host filesystem the
# rest of this script (and every other file reader in it) runs against, so
# a /host_mnt/-prefixed result that does not itself exist is retried with
# that prefix stripped. Returns non-zero (nothing printed) if `docker
# inspect` fails, yields no matching mount, or neither candidate path is an
# existing directory -- the caller fires base_backup_dir_unresolved for
# that, it is not this function's job to alert.
alert_resolve_base_backup_dir_from_mounts() {
  local raw rc candidate
  set +e
  raw="$(docker inspect "${ALERT_POSTGRES_CONTAINER_NAME}" --format \
    '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/base-backups"}}{{.Source}}{{end}}{{end}}' \
    2>/dev/null)"
  rc=$?
  set -e
  [[ ${rc} -eq 0 && -n "${raw}" ]] || return 1

  if [[ -d "${raw}" ]]; then
    printf '%s' "${raw}"
    return 0
  fi
  if [[ "${raw}" == /host_mnt/* ]]; then
    candidate="${raw#/host_mnt}"
    if [[ -d "${candidate}" ]]; then
      printf '%s' "${candidate}"
      return 0
    fi
  fi
  return 1
}

# ---- judgement 3: physical base backup freshness ----------------------------
# Newest VERIFIED marker's verified_epoch among correctly-named
# (YYYYMMDDTHHMMSSZ) subdirectories of ALERT_BASE_BACKUP_DIR -- same
# directory-name and VERIFIED-file contract as scripts/db/wal-retention.sh
# and infra/production-like/backup-timer.sh. A directory without a VERIFIED
# marker (in-flight or failed-before-verify) is silently skipped here, same
# treatment wal-retention.sh gives it.
check_physical_base_backup_freshness() {
  local dir="${ALERT_BASE_BACKUP_DIR}"
  if [[ -z "${dir}" ]]; then
    dir="$(alert_resolve_base_backup_dir_from_mounts)" || {
      alert_fire "base_backup_dir_unresolved" "critical" \
        "cps-novel base-backups directory could not be resolved" \
        "ALERT_BASE_BACKUP_DIR is not set and docker inspect ${ALERT_POSTGRES_CONTAINER_NAME} did not yield a usable host path for the /var/lib/postgresql/base-backups mount."
      return 1
    }
  fi
  if [[ ! -d "${dir}" ]]; then
    alert_fire "base_backup_missing" "critical" \
      "cps-novel physical base backup directory missing" \
      "ALERT_BASE_BACKUP_DIR=${dir} does not exist."
    alert_recover "base_backup_dir_unresolved"
    return 1
  fi

  local newest_epoch=0 newest_name="" d dname vfile ve
  for d in "${dir}"/*/; do
    [[ -d "${d}" ]] || continue
    dname="$(basename "${d}")"
    [[ "${dname}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || continue
    vfile="${d}VERIFIED"
    [[ -f "${vfile}" ]] || continue
    ve="$(grep '^verified_epoch=' "${vfile}" 2>/dev/null | head -1 | cut -d= -f2- || true)"
    [[ "${ve}" =~ ^[0-9]+$ ]] || continue
    if (( ve > newest_epoch )); then
      newest_epoch=${ve}
      newest_name=${dname}
    fi
  done

  if (( newest_epoch == 0 )); then
    alert_fire "base_backup_missing" "critical" \
      "cps-novel has no VERIFIED physical base backup" \
      "no directory under ALERT_BASE_BACKUP_DIR=${dir} has a valid VERIFIED marker."
    alert_recover "base_backup_dir_unresolved"
    return 1
  fi

  local now age
  now="$(date +%s)"
  age=$(( now - newest_epoch ))
  if (( age > ALERT_BASE_BACKUP_MAX_AGE_SECONDS )); then
    alert_fire "base_backup_stale" "critical" \
      "cps-novel physical base backup is stale" \
      "newest VERIFIED=${newest_name} verified_epoch=${newest_epoch} age_seconds=${age} threshold_seconds=${ALERT_BASE_BACKUP_MAX_AGE_SECONDS}."
    alert_recover "base_backup_dir_unresolved"
    return 1
  fi

  alert_recover "base_backup_missing"
  alert_recover "base_backup_stale"
  alert_recover "base_backup_dir_unresolved"
  alert_log "check-wal-archive: physical base backup fresh (newest=${newest_name} age=${age}s)"
  return 0
}

# ---- judgement 4: pg_wal directory size -------------------------------------
check_pg_wal_bloat() {
  local out rc bytes
  set +e
  out="$(docker exec "${ALERT_POSTGRES_CONTAINER_NAME}" du -sb /var/lib/postgresql/data/pg_wal 2>&1)"
  rc=$?
  set -e

  if [[ ${rc} -ne 0 ]]; then
    alert_fire "pg_wal_unreadable" "critical" \
      "cps-novel pg_wal size unreadable (docker exec)" \
      "docker exec du failed (exit=${rc}) against container=${ALERT_POSTGRES_CONTAINER_NAME}: ${out}"
    return 1
  fi

  bytes="$(printf '%s' "${out}" | awk '{print $1}' | head -1)"
  if ! [[ "${bytes}" =~ ^[0-9]+$ ]]; then
    alert_fire "pg_wal_unreadable" "critical" \
      "cps-novel pg_wal size output unparsable" \
      "raw du output: ${out}"
    return 1
  fi

  if (( bytes > ALERT_PG_WAL_MAX_BYTES )); then
    alert_fire "pg_wal_bloat" "critical" \
      "cps-novel pg_wal directory exceeds threshold" \
      "bytes=${bytes} max=${ALERT_PG_WAL_MAX_BYTES} container=${ALERT_POSTGRES_CONTAINER_NAME}."
    return 1
  fi

  alert_recover "pg_wal_bloat"
  alert_recover "pg_wal_unreadable"
  alert_log "check-wal-archive: pg_wal size OK (bytes=${bytes} max=${ALERT_PG_WAL_MAX_BYTES})"
  return 0
}

run_wal_archive_checks() {
  local rc=0
  check_wal_archive_capacity || rc=1
  check_wal_archiver_health || rc=1
  check_physical_base_backup_freshness || rc=1
  check_pg_wal_bloat || rc=1
  return "${rc}"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  alert_fire_total_reset
  run_wal_archive_checks
fi
