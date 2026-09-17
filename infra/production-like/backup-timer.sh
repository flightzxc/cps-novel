#!/usr/bin/env bash
set -euo pipefail
set +x

: "${X8_BACKUP_OUTPUT_DIR:?X8_BACKUP_OUTPUT_DIR is required}"
: "${X8_BACKUP_PGPASS_SOURCE:?X8_BACKUP_PGPASS_SOURCE is required}"
: "${X8_BACKUP_INTERVAL_SECONDS:=86400}"
: "${X8_BACKUP_RUN_ON_START:=true}"
# Gate 5-Dev (WAL retention daily timer): whether run_backup()'s physical
# base-backup step (2/4 below) is attempted at all. Defaulting to true keeps
# the daily loop self-sufficient once wired into compose; an operator who
# needs to pause physical backups (disk pressure, a manual base-backup-now
# already in flight) can set this to false without touching the image.
: "${X8_BACKUP_PHYSICAL_ENABLED:=true}"
# Minimum age (seconds) the newest VERIFIED physical base backup must have
# reached before this timer attempts another one. 72000s = 20h, deliberately
# under the 24h X8_BACKUP_INTERVAL_SECONDS default so a single slow/late run
# never causes two consecutive skips, but well over one interval's worth of
# jitter so a normal daily cadence produces exactly one physical backup per
# calendar day, not one per timer tick.
: "${X8_BASE_BACKUP_MIN_INTERVAL_SECONDS:=72000}"
# The following three are overridable ONLY so tests can point run_backup()'s
# steps 2-4 at throwaway directories without Docker (see
# tests/backend/database/backup-timer-static.test.ts). The real compose
# wiring never sets any of them, so production/rehearsal always gets the
# hard-coded in-container defaults on the right of each `:-`/`:=`.
: "${X8_TIMER_SCRIPT_DIR:=/app/scripts/db}"
: "${X8_TIMER_BASE_BACKUP_DIR:=/var/lib/postgresql/base-backups}"
: "${X8_TIMER_STATE_DIR:=/tmp}"

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
[[ "$X8_BACKUP_PHYSICAL_ENABLED" == "true" || "$X8_BACKUP_PHYSICAL_ENABLED" == "false" ]] || {
  echo "ERROR: X8_BACKUP_PHYSICAL_ENABLED must be true or false" >&2
  exit 65
}
[[ "$X8_BASE_BACKUP_MIN_INTERVAL_SECONDS" =~ ^[1-9][0-9]*$ ]] || {
  echo "ERROR: X8_BASE_BACKUP_MIN_INTERVAL_SECONDS must be a positive integer" >&2
  exit 65
}

umask 077
PGPASSFILE=/tmp/x8-backup.pgpass
export PGPASSFILE
cp "$X8_BACKUP_PGPASS_SOURCE" "$PGPASSFILE"
chmod 600 "$PGPASSFILE"

# Gate 5-Dev: run_backup() is now a four-step loop, each step isolated by its
# own set +e/set -e probe block (same technique alert-lib.sh's
# fail_closed_run and every check-*.sh in infra/production-like/alerts use) so
# one step's failure can never silently abort the steps after it, and a step
# that already succeeded is never rolled back by a later step's failure.
# run_backup() returns non-zero if ANY step failed. Both call sites below
# (the --once branch and the forever loop) invoke it as a bare statement
# under this file's own `set -euo pipefail`, so a non-zero return still
# propagates exactly like the pre-Gate-5 single-step version did: the whole
# process exits, and compose's `restart: unless-stopped` plus
# X8_BACKUP_RUN_ON_START=true bring it straight back for another attempt.
# That crash-and-restart is deliberately left in place rather than swallowed
# here -- the existing compose healthcheck
# (`test -f /tmp/x8-backup-last-success`) and the freshness/wal-archive
# alerts are what surface a *stuck* (not merely one-off-failed) step to an
# operator.
#
# Two independent success markers:
#   - X8_TIMER_STATE_DIR/x8-backup-last-success: unchanged semantics, touched
#     only when step 1 (logical backup) itself succeeds. This is what the
#     compose healthcheck and check-backup-freshness.sh's 26h alert already
#     read; nothing about its meaning changes here.
#   - X8_TIMER_STATE_DIR/x8-base-backup-last-success: new. Touched when the
#     physical-backup path reaches a healthy outcome -- either a fresh
#     CREATED backup that also PASSed verification, or a SKIPPED_RECENT
#     decision (an existing recent VERIFIED backup is healthy too, and
#     skipping today is the correct, expected behaviour, not a failure).
#     Deliberately NOT touched when physical backups are DISABLED (an
#     operator turned this off on purpose; nothing to attest to) or when the
#     step FAILED.
run_backup() {
  local stamp rc_total=0
  stamp="$(date -u '+%Y%m%dT%H%M%SZ')"

  # ---- step 1: logical backup (unchanged) ----------------------------------
  echo "BACKUP_TIMER_STEP=1_LOGICAL_BACKUP"
  local logical_output rc1
  logical_output="$X8_BACKUP_OUTPUT_DIR/cps-novel-x8-${stamp}.dump"
  set +e
  /bin/bash /opt/cps-novel-x8/backup-logical.sh --output "$logical_output"
  rc1=$?
  set -e
  if [[ "$rc1" -eq 0 ]]; then
    touch "$X8_TIMER_STATE_DIR/x8-backup-last-success"
  else
    echo "LOGICAL_BACKUP=FAILED rc=$rc1" >&2
    rc_total=1
  fi

  # ---- step 2: physical base backup -----------------------------------------
  # Decision order: physical backups disabled entirely -> DISABLED. Otherwise,
  # scan X8_TIMER_BASE_BACKUP_DIR for the newest VERIFIED marker among
  # correctly-named (YYYYMMDDTHHMMSSZ) subdirectories -- a directory missing
  # VERIFIED (in-flight or failed before verification) is ignored, same as
  # wal-retention.sh's own "no marker at all" handling. If that newest backup
  # is younger than X8_BASE_BACKUP_MIN_INTERVAL_SECONDS, skip today's run
  # (SKIPPED_RECENT); otherwise take a fresh one.
  echo "BACKUP_TIMER_STEP=2_PHYSICAL_BASE_BACKUP"
  local physical_decision="" rc2=0
  local base_backup_dir="$X8_TIMER_BASE_BACKUP_DIR"
  if [[ "$X8_BACKUP_PHYSICAL_ENABLED" != "true" ]]; then
    echo "PHYSICAL_BASE_BACKUP=DISABLED"
    physical_decision="DISABLED"
  else
    local newest_epoch=0 newest_stamp="" now_epoch age d dname ve
    now_epoch="$(date -u '+%s')"
    if [[ -d "$base_backup_dir" ]]; then
      for d in "$base_backup_dir"/*/; do
        [[ -d "$d" ]] || continue
        dname="$(basename "$d")"
        [[ "$dname" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || continue
        [[ -f "${d}VERIFIED" ]] || continue
        ve="$(grep '^verified_epoch=' "${d}VERIFIED" 2>/dev/null | head -1 | cut -d= -f2- || true)"
        [[ "$ve" =~ ^[0-9]+$ ]] || continue
        if [[ "$ve" -gt "$newest_epoch" ]]; then
          newest_epoch="$ve"
          newest_stamp="$dname"
        fi
      done
    fi
    age=$((now_epoch - newest_epoch))
    if [[ "$newest_epoch" -gt 0 && "$age" -lt "$X8_BASE_BACKUP_MIN_INTERVAL_SECONDS" ]]; then
      echo "PHYSICAL_BASE_BACKUP=SKIPPED_RECENT age=${age} min=${X8_BASE_BACKUP_MIN_INTERVAL_SECONDS} newest=${newest_stamp}"
      physical_decision="SKIPPED_RECENT"
    else
      set +e
      bash "$X8_TIMER_SCRIPT_DIR/backup-physical-base.sh" --output-dir "$base_backup_dir/$stamp"
      rc2=$?
      set -e
      if [[ "$rc2" -eq 0 ]]; then
        physical_decision="CREATED"
      else
        echo "PHYSICAL_BASE_BACKUP=FAILED rc=${rc2}" >&2
        physical_decision="FAILED"
        rc_total=1
      fi
    fi
  fi

  # ---- step 3: physical base backup verification ----------------------------
  # Only reachable when step 2 actually created a fresh backup this run --
  # SKIPPED_RECENT/DISABLED both mean there is nothing new to verify.
  echo "BACKUP_TIMER_STEP=3_PHYSICAL_BASE_VERIFY"
  local rc3=0
  if [[ "$physical_decision" == "CREATED" ]]; then
    set +e
    bash "$X8_TIMER_SCRIPT_DIR/verify-physical-base.sh" \
      --backup-dir "$base_backup_dir/$stamp" \
      --work-dir "$base_backup_dir/.verify-$stamp"
    rc3=$?
    set -e
    if [[ "$rc3" -ne 0 ]]; then
      echo "PHYSICAL_BASE_VERIFY=FAILED rc=${rc3}" >&2
      rc_total=1
    fi
  else
    echo "PHYSICAL_BASE_VERIFY=SKIPPED"
  fi

  if [[ "$physical_decision" == "SKIPPED_RECENT" ]] \
    || { [[ "$physical_decision" == "CREATED" ]] && [[ "$rc3" -eq 0 ]]; }; then
    touch "$X8_TIMER_STATE_DIR/x8-base-backup-last-success"
  fi

  # ---- step 4: WAL retention cleanup plan (read-only; never mutates the archive) ----
  # wal-gc-x8.sh is invoked without any flag that would let it delete
  # anything -- this step only ever prints the plan it WOULD run, so it stays
  # safe to run unattended every cycle, long before any operator has signed
  # off on a first real cleanup. Output is teed to a per-run evidence file
  # (world-unreadable: the script-level `umask 077` above covers every file
  # this process creates, including this one) as well as to this process's
  # own stdout/stderr (captured by the container's normal log driver).
  echo "BACKUP_TIMER_STEP=4_WAL_GC_DRY_RUN"
  local walgc_out rc4
  walgc_out="$X8_BACKUP_OUTPUT_DIR/wal-gc-dry-run-${stamp}.txt"
  set +e
  bash "$X8_TIMER_SCRIPT_DIR/wal-gc-x8.sh" --json 2>&1 | tee "$walgc_out"
  rc4=${PIPESTATUS[0]}
  set -e
  if [[ "$rc4" -ne 0 ]] || grep -q "WAL_RETENTION=REFUSED" "$walgc_out" 2>/dev/null; then
    echo "WAL_GC_DRY_RUN=FAILED rc=${rc4}" >&2
    rc_total=1
  fi

  return "$rc_total"
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
