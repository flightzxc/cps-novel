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

# Gate 5 review fix (env-override gate, "Opus 建议"): the five X8_TIMER_*
# variables below exist ONLY so tests can point run_backup()'s steps at
# throwaway scripts/directories, or bound the forever loop to a handful of
# cycles, without Docker (see
# tests/backend/database/backup-timer-static.test.ts). Before this fix, a
# stray X8_TIMER_* value leaking into a real environment would have silently
# redirected run_backup() at whatever path it named -- now an override only
# takes effect when the caller ALSO sets X8_TIMER_TEST_MODE=1; otherwise it
# is ignored (a BACKUP_TIMER_WARN=override_ignored line still prints, so the
# mistake is visible) and the hard-coded in-container default on the right
# of each call below is used instead. The real compose wiring never sets
# X8_TIMER_TEST_MODE (infra/production-like/docker-compose.yml and
# scripts/lib/x8-production-like-env.sh are both asserted not to contain
# that name), so production/rehearsal always gets these hard-coded
# defaults, exactly as before this fix.
x8_timer_apply_override() {
  local var_name="$1" default_value="$2"
  if [[ -n "${!var_name+x}" ]]; then
    if [[ "${X8_TIMER_TEST_MODE:-0}" == "1" ]]; then
      return 0
    fi
    echo "BACKUP_TIMER_WARN=override_ignored name=${var_name}"
  fi
  printf -v "$var_name" '%s' "$default_value"
}

x8_timer_apply_override X8_TIMER_SCRIPT_DIR /app/scripts/db
x8_timer_apply_override X8_TIMER_BASE_BACKUP_DIR /var/lib/postgresql/base-backups
x8_timer_apply_override X8_TIMER_STATE_DIR /tmp
x8_timer_apply_override X8_TIMER_LOGICAL_BACKUP_SCRIPT /opt/cps-novel-x8/backup-logical.sh
# Test-only: caps how many forever-loop cycles run before a clean `exit 0`,
# so a test never has to babysit/kill a real `while true` process. Empty
# (the default; also what any non-test-mode caller is forced back to) means
# unlimited -- the real forever loop this file has always run.
x8_timer_apply_override X8_TIMER_MAX_CYCLES ""
[[ -z "$X8_TIMER_MAX_CYCLES" || "$X8_TIMER_MAX_CYCLES" =~ ^[1-9][0-9]*$ ]] || {
  echo "ERROR: X8_TIMER_MAX_CYCLES must be a positive integer" >&2
  exit 65
}

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
# run_backup() returns non-zero if ANY step failed. The --once call site
# below still invokes it as a bare statement under this file's own
# `set -euo pipefail`, so a non-zero return still propagates exactly like
# the pre-Gate-5 single-step version did. The run-on-start and forever-loop
# call sites go through run_backup_resilient() instead (see its own comment
# below, Gate 5 review fix P1-6) -- only a step-1 (logical backup) failure
# still crashes those two.
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
#     step FAILED. Purely informational -- nothing in this repo (alert,
#     healthcheck, or otherwise) reads this marker; check-wal-archive.sh's
#     physical-base-backup-freshness judgement reads the VERIFIED marker
#     under ALERT_BASE_BACKUP_DIR directly instead, not this file.
run_backup() {
  local stamp rc_total=0
  stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
  BACKUP_TIMER_STEP1_FAILED=false
  BACKUP_TIMER_FAILED_STEPS=""

  # ---- step 1: logical backup (default path unchanged; overridable only for tests via X8_TIMER_LOGICAL_BACKUP_SCRIPT) ----
  echo "BACKUP_TIMER_STEP=1_LOGICAL_BACKUP"
  local logical_output rc1
  logical_output="$X8_BACKUP_OUTPUT_DIR/cps-novel-x8-${stamp}.dump"
  set +e
  /bin/bash "$X8_TIMER_LOGICAL_BACKUP_SCRIPT" --output "$logical_output"
  rc1=$?
  set -e
  if [[ "$rc1" -eq 0 ]]; then
    # Gate 5 review fix (F-2): the marker write is its own isolated
    # probe -- a full/read-only X8_TIMER_STATE_DIR must never look like a
    # logical-backup FAILURE (BACKUP_TIMER_STEP1_FAILED, which crashes
    # run_backup_resilient's callers) when the dump itself already
    # succeeded. It still has to be visible and it still has to make the
    # overall run non-zero (nothing downstream should believe a marker
    # exists when it does not), so it counts as its own failed step ("1")
    # instead.
    local logical_marker="$X8_TIMER_STATE_DIR/x8-backup-last-success" rc1_marker
    set +e
    touch "$logical_marker"
    rc1_marker=$?
    set -e
    if [[ "$rc1_marker" -ne 0 ]]; then
      echo "BACKUP_TIMER_WARN=marker_not_written marker=${logical_marker} step=1"
      rc_total=1
      BACKUP_TIMER_FAILED_STEPS="${BACKUP_TIMER_FAILED_STEPS}1,"
    fi
  else
    echo "LOGICAL_BACKUP=FAILED rc=$rc1"
    rc_total=1
    BACKUP_TIMER_STEP1_FAILED=true
  fi

  # Gate 5 review fix (P1-2): --logical-only stops here. scripts/x8-production-like.sh's
  # backup_now() passes exactly this flag, so an on-demand `backup-now`
  # invocation stays what it has always been -- a logical-only backup -- and
  # never becomes a back-door trigger for the physical base-backup/verify/
  # wal-gc-dry-run machinery that otherwise only ever runs on the unattended
  # daily cadence (or via the dedicated base-backup-now/wal-gc entry points).
  if [[ "${BACKUP_TIMER_LOGICAL_ONLY:-false}" == "true" ]]; then
    echo "BACKUP_TIMER_MODE=logical_only"
    return "$rc_total"
  fi

  # ---- step 2: physical base backup -----------------------------------------
  # Decision order: physical backups disabled entirely -> DISABLED. Otherwise,
  # scan X8_TIMER_BASE_BACKUP_DIR for the newest VERIFIED marker among
  # correctly-named (YYYYMMDDTHHMMSSZ) subdirectories -- a directory missing
  # VERIFIED (in-flight or failed before verification) is ignored, same as
  # wal-retention.sh's own "no marker at all" handling. A directory that DOES
  # have a VERIFIED file but no valid `verified_epoch=<digits>` line inside it
  # is a malformed marker (Gate 5 review fix, P2): warn about it (an operator
  # should know why it was never eligible as the anchor) and treat it the
  # same as "no valid backup", same fail-safe direction as before. If the
  # newest valid backup is younger than X8_BASE_BACKUP_MIN_INTERVAL_SECONDS,
  # skip today's run (SKIPPED_RECENT); otherwise take a fresh one.
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
        if [[ ! "$ve" =~ ^[0-9]+$ ]]; then
          echo "BACKUP_TIMER_WARN=verified_malformed name=${dname}"
          continue
        fi
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
        echo "PHYSICAL_BASE_BACKUP=FAILED rc=${rc2}"
        physical_decision="FAILED"
        rc_total=1
        BACKUP_TIMER_FAILED_STEPS="${BACKUP_TIMER_FAILED_STEPS}2,"
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
      echo "PHYSICAL_BASE_VERIFY=FAILED rc=${rc3}"
      rc_total=1
      BACKUP_TIMER_FAILED_STEPS="${BACKUP_TIMER_FAILED_STEPS}3,"
    fi
  else
    echo "PHYSICAL_BASE_VERIFY=SKIPPED"
  fi

  if [[ "$physical_decision" == "SKIPPED_RECENT" ]] \
    || { [[ "$physical_decision" == "CREATED" ]] && [[ "$rc3" -eq 0 ]]; }; then
    # Gate 5 review fix (F-2): same isolated-probe treatment as the logical
    # marker above -- a write failure here must not be silently swallowed,
    # but it also must not be conflated with step 3 (verification) actually
    # failing, since verification already passed by the time this runs.
    local base_marker="$X8_TIMER_STATE_DIR/x8-base-backup-last-success" rc3_marker
    set +e
    touch "$base_marker"
    rc3_marker=$?
    set -e
    if [[ "$rc3_marker" -ne 0 ]]; then
      echo "BACKUP_TIMER_WARN=marker_not_written marker=${base_marker} step=3"
      rc_total=1
      BACKUP_TIMER_FAILED_STEPS="${BACKUP_TIMER_FAILED_STEPS}3,"
    fi
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
  local walgc_out rc4 rc4_tee
  walgc_out="$X8_BACKUP_OUTPUT_DIR/wal-gc-dry-run-${stamp}.txt"
  set +e
  bash "$X8_TIMER_SCRIPT_DIR/wal-gc-x8.sh" --json 2>&1 | tee "$walgc_out"
  # Both indices must be read out of $PIPESTATUS in a single statement --
  # bash resets $PIPESTATUS to reflect its OWN (single-command) exit status
  # the moment any subsequent simple command runs, so a first `rc4=${PIPESTATUS[0]}`
  # followed by a second `rc4_tee=${PIPESTATUS[1]}` would already be reading
  # a stale/empty array (an "unbound variable" error under this file's own
  # `set -u`, confirmed against bash 3.2.57).
  local walgc_pipestatus=("${PIPESTATUS[@]}")
  set -e
  rc4="${walgc_pipestatus[0]}"
  rc4_tee="${walgc_pipestatus[1]:-0}"
  if [[ "$rc4_tee" -ne 0 ]]; then
    echo "BACKUP_TIMER_WARN=dry_run_report_not_saved"
  fi
  if [[ "$rc4" -ne 0 ]] || grep -q "WAL_RETENTION=REFUSED" "$walgc_out" 2>/dev/null; then
    echo "WAL_GC_DRY_RUN=FAILED rc=${rc4}"
    rc_total=1
    BACKUP_TIMER_FAILED_STEPS="${BACKUP_TIMER_FAILED_STEPS}4,"
  fi

  # Gate 5 review fix (P2): retain only the most recent 30
  # wal-gc-dry-run-*.txt reports, by COUNT not age -- listed (lexicographic
  # sort on the UTC-timestamped filename is also chronological order) then
  # removed one at a time. Deliberately not `find -mtime ... -delete`: mtime
  # granularity/clock skew would make an age-based rule nondeterministic,
  # while a count-based rule gives an operator a predictable, bounded number
  # of historical reports regardless of how often the timer actually runs.
  local walgc_report_total walgc_report_keep=30 walgc_report_skip
  walgc_report_total="$(find "$X8_BACKUP_OUTPUT_DIR" -maxdepth 1 -type f -name 'wal-gc-dry-run-*.txt' 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "$walgc_report_total" -gt "$walgc_report_keep" ]]; then
    walgc_report_skip=$((walgc_report_total - walgc_report_keep))
    find "$X8_BACKUP_OUTPUT_DIR" -maxdepth 1 -type f -name 'wal-gc-dry-run-*.txt' 2>/dev/null \
      | sort \
      | sed -n "1,${walgc_report_skip}p" \
      | while IFS= read -r walgc_old_report; do
          rm -f "$walgc_old_report"
        done
  fi

  BACKUP_TIMER_FAILED_STEPS="${BACKUP_TIMER_FAILED_STEPS%,}"
  return "$rc_total"
}

# Gate 5 review fix (P1-6): wraps run_backup() for the two call sites that are
# NOT --once (the run-on-start invocation and every forever-loop tick).
# Step 1 (logical backup) failing still propagates exactly like before this
# fix: non-zero return -> this file's own `set -e` -> the whole process
# exits -> compose's `restart: unless-stopped` brings it straight back,
# which is what gives an operator the existing
# `test -f /tmp/x8-backup-last-success` healthcheck failure as a visible
# signal. Steps 2-4 failing alone (logical backup itself still succeeded) no
# longer crashes the loop -- there is nothing about a stuck/failed physical
# base-backup or wal-gc-dry-run step that a container restart would fix, and
# restarting anyway would mean re-running logical backups far more often
# than X8_BACKUP_INTERVAL_SECONDS intends. Instead this prints
# BACKUP_TIMER_RUN=DEGRADED failed_steps=<subset of 2,3,4> and lets the loop
# continue to its next sleep; check-wal-archive.sh's alerts are what surface
# a *stuck* (not merely one-off-failed) step 2-4 to an operator. `--once`
# never goes through this wrapper -- it still calls run_backup() directly
# and propagates ANY step's failure as a non-zero exit (see below).
run_backup_resilient() {
  local rc=0
  # Deliberately `if run_backup; then rc=0; else rc=$?; fi`, NOT
  # `set +e; run_backup; rc=$?; set -e`. run_backup()'s own body toggles
  # `set -e`/`set +e` repeatedly (each step's own isolation block) -- since
  # those are global shell-option changes, not scoped to the function, by
  # the time run_backup() returns it can leave `-e` back ON regardless of
  # what this wrapper set right before calling it, and a bare `run_backup`
  # statement evaluated with `-e` currently on would trigger errexit on a
  # non-zero return BEFORE the next line (`rc=$?`) ever runs -- silently
  # defeating this whole wrapper. A command in `if`/`else` "tested" position
  # is exempt from errexit regardless of what it does to `-e` internally,
  # which is what this rewrite relies on (verified against this file's own
  # bash 3.2.57 target). `if run_backup` 的 errexit 豁免覆盖 run_backup 整个
  # 动态作用域，函数内部的 `set -e` 不会重新武装；步骤时序全靠显式 rc 判断，
  # 不靠 errexit。
  if run_backup; then
    rc=0
  else
    rc=$?
  fi
  if [[ "$rc" -ne 0 ]]; then
    if [[ "$BACKUP_TIMER_STEP1_FAILED" == "true" ]]; then
      return "$rc"
    fi
    echo "BACKUP_TIMER_RUN=DEGRADED failed_steps=${BACKUP_TIMER_FAILED_STEPS}"
  fi
  return 0
}

# ---- argument parsing -------------------------------------------------------
# Gate 5 review fix (F-3): BACKUP_TIMER_LOGICAL_ONLY must never drift in from
# the environment -- run_backup() reads it via `${BACKUP_TIMER_LOGICAL_ONLY:-false}`,
# but that fallback only applies when the variable is UNSET; a stray
# BACKUP_TIMER_LOGICAL_ONLY=true already exported into this process (e.g. an
# operator's shell, a leaked env file) would silently short-circuit every
# --once/run-on-start/loop invocation into logical-only mode with no flag on
# the command line to explain why. Unconditionally reset it to false here,
# before argument parsing runs -- the only thing that can set it back to true
# is --logical-only actually being present in $@ below.
BACKUP_TIMER_LOGICAL_ONLY=false
run_once=false
logical_only=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --once) run_once=true; shift ;;
    --logical-only) logical_only=true; shift ;;
    *)
      echo "usage: backup-timer.sh [--once] [--logical-only]" >&2
      exit 64
      ;;
  esac
done
if [[ "$logical_only" == "true" ]]; then
  BACKUP_TIMER_LOGICAL_ONLY=true
fi

if [[ "$run_once" == "true" ]]; then
  run_backup
  exit 0
fi

if [[ "$X8_BACKUP_RUN_ON_START" == "true" ]]; then
  run_backup_resilient
fi

x8_timer_cycle_count=0
while true; do
  sleep "$X8_BACKUP_INTERVAL_SECONDS"
  run_backup_resilient
  if [[ -n "$X8_TIMER_MAX_CYCLES" ]]; then
    x8_timer_cycle_count=$((x8_timer_cycle_count + 1))
    if [[ "$x8_timer_cycle_count" -ge "$X8_TIMER_MAX_CYCLES" ]]; then
      echo "BACKUP_TIMER_TEST_MAX_CYCLES_REACHED=${x8_timer_cycle_count}"
      exit 0
    fi
  fi
done
