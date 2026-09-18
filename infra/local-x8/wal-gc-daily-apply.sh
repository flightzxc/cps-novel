#!/usr/bin/env bash
set -euo pipefail

# Local-X8 daily WAL retention apply operator (macOS LaunchAgent target).
#
# This is NOT a new deletion mechanism -- it is a thin, fail-closed wrapper
# around the EXISTING formal entry point, scripts/x8-production-like.sh's
# `wal-gc` subcommand (which itself always execs scripts/db/wal-gc-x8.sh
# inside the postgres container, hard-coding --require-archiver-healthy; see
# that file's own header). This script never talks to Docker, Postgres, or
# the archive directly -- it only shells out to that one entry point three
# times (preflight dry-run -> apply -> post dry-run) and judges the exact
# stdout tokens that entry point already prints (WAL_RETENTION=..., see
# scripts/db/wal-retention.sh), never reimplementing any retention logic
# itself.
#
# This file is local/X8-only (infra/local-x8/, never infra/production-like/):
# it is what turns "an operator manually approves `wal-gc --apply` per the
# rollout plan's report template" into "a LaunchAgent runs this once a day",
# a relaxation the rollout plan explicitly scopes to the local X8 profile
# only (docs/operations/WAL_RETENTION_PROFILES.md) -- it must never be
# reachable from infra/production-like/**, docker-compose.yml, or any path a
# real production deployment would pick up.
#
# Absolutely no --force / --keep on the apply invocation: only
# `wal-gc --apply --json`, command-line-literal, every single run. A static
# test (tests/backend/local-x8/wal-gc-daily-apply.test.ts) greps this file
# for both tokens outside this header comment and fails the build if either
# appears -- so this script deliberately never mentions them again below.

umask 077

# ---- test-mode-gated overrides ---------------------------------------------
# Only two overrides exist, and both are inert unless the caller ALSO sets
# X8_LOCAL_TEST_MODE=1 -- same technique as x8_timer_apply_override() in
# infra/production-like/backup-timer.sh: a stray value leaking in from a real
# operator's shell or a leaked env file must never silently redirect this
# script at a fake entry point or a fake OS name. Neither is honored, and
# both print a visible warning, when test mode is off.
x8_local_apply_override() {
  local var_name="$1"
  if [[ -n "${!var_name+x}" ]]; then
    if [[ "${X8_LOCAL_TEST_MODE:-0}" == "1" ]]; then
      return 0
    fi
    echo "LOCAL_WAL_GC_WARN=override_ignored name=${var_name}"
    unset "$var_name"
  fi
}
x8_local_apply_override X8_LOCAL_WAL_GC_ENTRY
x8_local_apply_override X8_LOCAL_UNAME

# ---- hard gate 1: Darwin only -----------------------------------------------
# This is a LOCAL-only, explicit restriction (not something the formal entry
# point itself enforces) -- this operator's only supported home is a macOS
# LaunchAgent, and it must refuse outright rather than silently attempt to
# run somewhere its lock/log path conventions (~/Library/Application
# Support/...) were never designed for.
x8_local_uname() {
  if [[ "${X8_LOCAL_TEST_MODE:-0}" == "1" && -n "${X8_LOCAL_UNAME:-}" ]]; then
    printf '%s' "$X8_LOCAL_UNAME"
  else
    uname -s
  fi
}
if [[ "$(x8_local_uname)" != "Darwin" ]]; then
  echo "LOCAL_WAL_GC=REFUSED reason=not_darwin"
  exit 65
fi

# ---- hard gate 2: X8_LOCAL_WORKTREE required, absolute, real entry point ---
if [[ -z "${X8_LOCAL_WORKTREE:-}" ]]; then
  echo "LOCAL_WAL_GC=REFUSED reason=x8_local_worktree_required"
  exit 65
fi
if [[ "$X8_LOCAL_WORKTREE" != /* ]]; then
  echo "LOCAL_WAL_GC=REFUSED reason=x8_local_worktree_not_absolute"
  exit 65
fi
if [[ ! -f "$X8_LOCAL_WORKTREE/scripts/x8-production-like.sh" ]]; then
  echo "LOCAL_WAL_GC=REFUSED reason=x8_local_worktree_missing_entrypoint"
  exit 65
fi

# ---- hard gate 3: X8_LEVEL is fixed, never caller-supplied -----------------
export X8_LEVEL=uat

# ---- hard gate 4: refuse a caller pointed at a different compose project ---
if [[ -n "${P1_12_COMPOSE_PROJECT:-}" && "$P1_12_COMPOSE_PROJECT" != "cps-novel-x8-local" ]]; then
  echo "LOCAL_WAL_GC=REFUSED reason=not_local_project"
  exit 65
fi

# ---- runtime dir + mutex lock ----------------------------------------------
# Not gated behind X8_LOCAL_TEST_MODE -- a path override here is no more
# safety-relevant than X8_RUNTIME_DIR's own always-overridable default in
# scripts/lib/x8-production-like-env.sh; it only changes where this
# operator's OWN lock/log files live, never which stack it talks to.
X8_LOCAL_RUNTIME_DIR="${X8_LOCAL_RUNTIME_DIR:-$HOME/Library/Application Support/CPSNovelX8WalGc}"
mkdir -p "$X8_LOCAL_RUNTIME_DIR/logs"

LOCK_DIR="$X8_LOCAL_RUNTIME_DIR/run.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "LOCAL_WAL_GC=SKIPPED reason=locked"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT INT TERM

EVIDENCE_DIR="$X8_LOCAL_WORKTREE/.tmp/x8-production-like/wal-gc-daily"
mkdir -p "$EVIDENCE_DIR"

STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"

log_history() {
  local result="$1"
  local head_short
  set +e
  head_short="$(cd "$X8_LOCAL_WORKTREE" && git rev-parse --short HEAD 2>/dev/null)"
  set -e
  [[ -n "$head_short" ]] || head_short="UNKNOWN"
  printf '%s HEAD=%s result=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$head_short" "$result" \
    >>"$X8_LOCAL_RUNTIME_DIR/logs/history.log"
}

# By-count (not age) retention, same technique as backup-timer.sh's own
# wal-gc-dry-run-*.txt pruning: list, sort, remove the oldest excess ONE AT A
# TIME with plain `rm -f` -- never `find -delete` (see red-line notes). A
# run's three files share one <stamp> prefix; "-preflight.txt" is the marker
# used to enumerate groups, since every run that reaches this point always
# writes one (a SKIPPED/locked run never gets here at all, so it never
# creates a group to begin with).
prune_old_evidence() {
  local -a stamps=()
  local line
  while IFS= read -r line; do
    [[ -n "$line" ]] && stamps+=("$line")
  done < <(find "$EVIDENCE_DIR" -maxdepth 1 -type f -name '*-preflight.txt' 2>/dev/null \
    | sed -E 's#.*/([0-9]{8}T[0-9]{6}Z)-preflight\.txt$#\1#' | sort)
  local total="${#stamps[@]}"
  local keep=30
  if [[ "$total" -gt "$keep" ]]; then
    local excess=$((total - keep))
    local i=0
    for line in "${stamps[@]}"; do
      i=$((i + 1))
      [[ "$i" -le "$excess" ]] || break
      rm -f "$EVIDENCE_DIR/${line}-preflight.txt" "$EVIDENCE_DIR/${line}-apply.txt" "$EVIDENCE_DIR/${line}-post.txt"
    done
  fi
}

# Runs the formal wal-gc entry point (X8_LOCAL_WAL_GC_ENTRY only ever
# substitutes it under X8_LOCAL_TEST_MODE=1, per the gate above) and saves
# the raw combined output verbatim to this step's evidence file. Sets the
# globals STEP_OUTPUT/STEP_RC as its "return value" -- this repo's bash 3.2
# target has no nameref/local -n, so every other helper in this codebase that
# needs to hand back more than an exit code uses the same plain-global
# convention (e.g. wal-retention.sh's read_kv()/emit_json_summary()).
run_step() {
  local stepname="$1"
  shift
  local entry="$X8_LOCAL_WORKTREE/scripts/x8-production-like.sh"
  if [[ "${X8_LOCAL_TEST_MODE:-0}" == "1" && -n "${X8_LOCAL_WAL_GC_ENTRY:-}" ]]; then
    entry="$X8_LOCAL_WAL_GC_ENTRY"
  fi
  set +e
  STEP_OUTPUT="$(X8_LEVEL=uat "$entry" wal-gc "$@" 2>&1)"
  STEP_RC=$?
  set -e
  printf '%s\n' "$STEP_OUTPUT" >"$EVIDENCE_DIR/${STAMP}-${stepname}.txt"
}

parse_planned_delete() {
  printf '%s\n' "$1" | grep -oE 'WAL_RETENTION=DRY_RUN planned_delete=[0-9]+' | grep -oE '[0-9]+$' | tail -1 || true
}

parse_summary_anchor() {
  node -e '
    let data = "";
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => {
      const m = data.match(/WAL_RETENTION_SUMMARY_JSON=(\{.*\})/);
      if (!m) return;
      try {
        const parsed = JSON.parse(m[1]);
        if (typeof parsed.anchor === "string") process.stdout.write(parsed.anchor);
      } catch {}
    });
  ' <<<"$1"
}

# ---- step 1: preflight (dry-run) -------------------------------------------
run_step preflight --json
preflight_out="$STEP_OUTPUT"

refused_line="$(printf '%s\n' "$preflight_out" | grep -m1 -E '^WAL_RETENTION=(REFUSED|LOCKED)' || true)"
if [[ -n "$refused_line" ]]; then
  log_history STOPPED
  echo "LOCAL_WAL_GC=STOPPED stage=preflight reason=\"$refused_line\""
  exit 65
fi

if printf '%s\n' "$preflight_out" | grep -qE '^WAL_RETENTION=NOOP' \
  || printf '%s\n' "$preflight_out" | grep -qE '^WAL_RETENTION=DRY_RUN planned_delete=0$'; then
  log_history NOTHING_TO_DO
  echo "LOCAL_WAL_GC=NOTHING_TO_DO"
  prune_old_evidence
  exit 0
fi

planned_delete="$(parse_planned_delete "$preflight_out")"
if [[ -z "$planned_delete" ]]; then
  log_history STOPPED
  echo "LOCAL_WAL_GC=STOPPED stage=preflight reason=unparseable_preflight_output"
  exit 65
fi

max_delete="${X8_LOCAL_WAL_GC_MAX_DELETE:-3000}"
if [[ "$planned_delete" -gt "$max_delete" ]]; then
  log_history STOPPED
  echo "LOCAL_WAL_GC=STOPPED stage=preflight reason=planned_delete_exceeds_local_cap"
  exit 65
fi

# ---- step 2: apply ----------------------------------------------------------
run_step apply --apply --json
apply_out="$STEP_OUTPUT"
apply_rc="$STEP_RC"

apply_bad_line="$(printf '%s\n' "$apply_out" \
  | grep -m1 -E '^WAL_RETENTION=(REFUSED|LOCKED)|^WAL_RETENTION_WARN=reconcile_mismatch' || true)"
if [[ -n "$apply_bad_line" || "$apply_rc" -ne 0 ]]; then
  reason="${apply_bad_line:-apply_command_exit_${apply_rc}}"
  log_history STOPPED
  echo "LOCAL_WAL_GC=STOPPED stage=apply reason=\"$reason\""
  exit 65
fi

applied_line="$(printf '%s\n' "$apply_out" | grep -m1 -E '^WAL_RETENTION=APPLIED deleted=[0-9]+' || true)"
if [[ -z "$applied_line" ]]; then
  log_history STOPPED
  echo "LOCAL_WAL_GC=STOPPED stage=apply reason=unparseable_apply_output"
  exit 65
fi
# wal-retention.sh's real APPLIED line is "...deleted=<N> anchor=<hex>" (see
# its own emit_json_summary-adjacent echo) -- deleted=<N> is NOT the last
# token, and the trailing anchor is hex (can itself end in A-F), so this
# must extract the number right after "deleted=", never "the last digits in
# the line".
deleted="$(printf '%s' "$applied_line" | grep -oE 'deleted=[0-9]+' | head -1 | cut -d= -f2)"

if [[ "$deleted" != "$planned_delete" ]]; then
  # The delete has already happened at this point (WAL_RETENTION=APPLIED
  # already printed above) -- this only flags that the count diverged from
  # what preflight promised, it does not and cannot undo it. The full apply
  # evidence file (${STAMP}-apply.txt) already has the real numbers.
  log_history STOPPED
  echo "LOCAL_WAL_GC=STOPPED stage=apply reason=\"deleted_ne_planned deleted=$deleted planned=$planned_delete (deletion already occurred; see ${STAMP}-apply.txt)\""
  exit 65
fi

# ---- step 3: post (dry-run) -------------------------------------------------
run_step post --json
post_out="$STEP_OUTPUT"

post_planned="$(parse_planned_delete "$post_out")"
post_is_noop=0
printf '%s\n' "$post_out" | grep -qE '^WAL_RETENTION=NOOP' && post_is_noop=1

if [[ "$post_planned" != "0" && "$post_is_noop" -ne 1 ]]; then
  log_history WARN
  echo "LOCAL_WAL_GC=WARN stage=post reason=residual_plan"
  exit 62
fi

anchor="$(parse_summary_anchor "$apply_out")"
[[ -n "$anchor" ]] || anchor="UNKNOWN"
log_history APPLIED
echo "LOCAL_WAL_GC=APPLIED deleted=$deleted anchor=$anchor"
prune_old_evidence
exit 0
