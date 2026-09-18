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
#
# Opus review fixup 2026-09-18 (P2-3/P2-4/P2-5/P2-6/P2-13): three changes to
# this file's own bookkeeping, none of which touch the retention judgment
# logic above:
#   * anchor extraction from WAL_RETENTION_SUMMARY_JSON no longer shells out
#     to `node -e` (see parse_summary_anchor below) -- a plain grep/cut is
#     enough for one JSON field and removes a Node-runtime dependency this
#     script otherwise has zero need for.
#   * the post (third) dry-run step is now checked for its own
#     REFUSED/LOCKED/non-zero-exit before it is read for a residual plan --
#     previously a post-stage refusal was silently misreported as
#     "residual_plan" instead of the distinct failure it actually is.
#   * history.log's `result=` token now distinguishes whether the actual
#     `pg_archivecleanup -d` delete step had already run when a given stop
#     happened (`_BEFORE_DELETE` vs `_AFTER_DELETE` suffixes) -- an operator
#     scanning history.log needs to know, without opening evidence files,
#     whether "STOPPED" means "nothing touched" or "some WAL was actually
#     removed, go look". The stdout `LOCAL_WAL_GC=...` banner text itself is
#     UNCHANGED (still exactly `STOPPED`/`WARN`/etc, no suffix) -- only the
#     history.log `result=` field gained the finer-grained tokens, so no
#     existing consumer of the stdout banner needs to change.
#   * the runtime dir + history.log now exist before the hard gates run, and
#     a hard-gate refusal (not_darwin / x8_local_worktree_* /
#     not_local_project) now also writes a `result=REFUSED` line -- before
#     this fix a hard-gate refusal left literally no trace in history.log.
#   * evidence pruning (prune_old_evidence) now runs from the EXIT trap
#     instead of only being called explicitly on the two success exit paths
#     -- a STOPPED/WARN run used to leave its own evidence group behind
#     forever without ever counting toward (or being trimmed by) the
#     30-group cap.

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

# ---- runtime dir + history log (created before any gate can refuse, so a
# hard-gate refusal is never silently trace-less) ----------------------------
# Not gated behind X8_LOCAL_TEST_MODE -- a path override here is no more
# safety-relevant than X8_RUNTIME_DIR's own always-overridable default in
# scripts/lib/x8-production-like-env.sh; it only changes where this
# operator's OWN lock/log files live, never which stack it talks to.
X8_LOCAL_RUNTIME_DIR="${X8_LOCAL_RUNTIME_DIR:-$HOME/Library/Application Support/CPSNovelX8WalGc}"
mkdir -p "$X8_LOCAL_RUNTIME_DIR/logs"

# Appends one line to history.log. $1 is the result token (APPLIED /
# NOTHING_TO_DO / SKIPPED / REFUSED / STOPPED_BEFORE_DELETE /
# STOPPED_AFTER_DELETE / WARN_AFTER_DELETE); $2, if given, is a short reason
# tag appended as `reason=<...>`. HEAD is read defensively -- this must never
# be the reason a history line fails to get written (a hard-gate refusal can
# fire before X8_LOCAL_WORKTREE is even known to be a real directory), so
# both the `cd` and the unset-variable case (bash 3.2, `set -u`) are guarded.
log_history() {
  local result="$1"
  local reason="${2:-}"
  local head_short
  set +e
  head_short="$(cd "${X8_LOCAL_WORKTREE:-}" 2>/dev/null && git rev-parse --short HEAD 2>/dev/null)"
  set -e
  [[ -n "$head_short" ]] || head_short="UNKNOWN"
  if [[ -n "$reason" ]]; then
    printf '%s HEAD=%s result=%s reason=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$head_short" "$result" "$reason" \
      >>"$X8_LOCAL_RUNTIME_DIR/logs/history.log"
  else
    printf '%s HEAD=%s result=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$head_short" "$result" \
      >>"$X8_LOCAL_RUNTIME_DIR/logs/history.log"
  fi
}

# By-count (not age) retention, same technique as backup-timer.sh's own
# wal-gc-dry-run-*.txt pruning: list, sort, remove the oldest excess ONE AT A
# TIME with plain `rm -f` -- never `find -delete` (see red-line notes). A
# run's three files share one <stamp> prefix; "-preflight.txt" is the marker
# used to enumerate groups, since every run that reaches this point always
# writes one (a SKIPPED/locked run never gets here at all, so it never
# creates a group to begin with). Runs from the EXIT trap now (below), so it
# must tolerate EVIDENCE_DIR being unset/empty -- a hard-gate refusal exits
# long before EVIDENCE_DIR is ever computed.
prune_old_evidence() {
  [[ -n "${EVIDENCE_DIR:-}" ]] || return 0
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
  log_history REFUSED not_darwin
  echo "LOCAL_WAL_GC=REFUSED reason=not_darwin"
  exit 65
fi

# ---- hard gate 2: X8_LOCAL_WORKTREE required, absolute, real entry point ---
if [[ -z "${X8_LOCAL_WORKTREE:-}" ]]; then
  log_history REFUSED x8_local_worktree_required
  echo "LOCAL_WAL_GC=REFUSED reason=x8_local_worktree_required"
  exit 65
fi
if [[ "$X8_LOCAL_WORKTREE" != /* ]]; then
  log_history REFUSED x8_local_worktree_not_absolute
  echo "LOCAL_WAL_GC=REFUSED reason=x8_local_worktree_not_absolute"
  exit 65
fi
if [[ ! -f "$X8_LOCAL_WORKTREE/scripts/x8-production-like.sh" ]]; then
  log_history REFUSED x8_local_worktree_missing_entrypoint
  echo "LOCAL_WAL_GC=REFUSED reason=x8_local_worktree_missing_entrypoint"
  exit 65
fi

# ---- hard gate 3: X8_LEVEL is fixed, never caller-supplied -----------------
export X8_LEVEL=uat

# ---- hard gate 4: refuse a caller pointed at a different compose project ---
if [[ -n "${P1_12_COMPOSE_PROJECT:-}" && "$P1_12_COMPOSE_PROJECT" != "cps-novel-x8-local" ]]; then
  log_history REFUSED not_local_project
  echo "LOCAL_WAL_GC=REFUSED reason=not_local_project"
  exit 65
fi

# ---- mutex lock --------------------------------------------------------------
LOCK_DIR="$X8_LOCAL_RUNTIME_DIR/run.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log_history SKIPPED locked
  echo "LOCAL_WAL_GC=SKIPPED reason=locked"
  exit 0
fi

EVIDENCE_DIR="$X8_LOCAL_WORKTREE/.tmp/x8-production-like/wal-gc-daily"
mkdir -p "$EVIDENCE_DIR"

# Lock release and evidence pruning both happen on every exit from this point
# on -- including STOPPED (exit 65) and WARN (exit 62) paths, not only the
# two success paths (NOTHING_TO_DO / APPLIED) this used to be called from
# explicitly.
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true; prune_old_evidence' EXIT INT TERM

STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"

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

# Pulls the "anchor" field out of a WAL_RETENTION_SUMMARY_JSON=<one-line-json>
# line without a JSON parser -- wal-retention.sh's own emit_json_summary()
# always writes it as a plain `"anchor":"<24-hex>"` member with no nested
# object/array before it that could contain a decoy `"anchor":"..."`
# substring (see that function: keepCount/retireList/deleteCount/anchor/
# capacity, in that fixed order, and retireList is a list of bare backup
# directory NAMES, never JSON objects that could themselves have an "anchor"
# key). A single grep -oE + cut is exact for this one shape and, unlike the
# `node -e` this used to shell out to, has no runtime dependency beyond the
# coreutils every other helper in this file already needs -- this operator
# must keep working on a PATH that happens not to have a Node install on it
# (LaunchAgent PATHs are minimal by default; see the plist template).
# `|| true` inside AND on the call site below: under `set -e -o pipefail`,
# grep finding no match makes the pipeline's exit status 1 even though `cut`
# itself exits 0, and a plain (unguarded) `anchor="$(...)"` assignment
# statement would abort the whole script on that -- the anchor is
# best-effort bookkeeping, never something worth failing an already-APPLIED
# run over.
parse_summary_anchor() {
  printf '%s\n' "$1" | grep -oE '"anchor":"[0-9A-F]{24}"' | cut -d'"' -f4 || true
}

# ---- step 1: preflight (dry-run) -------------------------------------------
run_step preflight --json
preflight_out="$STEP_OUTPUT"

refused_line="$(printf '%s\n' "$preflight_out" | grep -m1 -E '^WAL_RETENTION=(REFUSED|LOCKED)' || true)"
if [[ -n "$refused_line" ]]; then
  # Preflight is always a dry-run -- nothing has been deleted yet no matter
  # which guard fired.
  log_history STOPPED_BEFORE_DELETE "$refused_line"
  echo "LOCAL_WAL_GC=STOPPED stage=preflight reason=\"$refused_line\""
  exit 65
fi

if printf '%s\n' "$preflight_out" | grep -qE '^WAL_RETENTION=NOOP' \
  || printf '%s\n' "$preflight_out" | grep -qE '^WAL_RETENTION=DRY_RUN planned_delete=0$'; then
  log_history NOTHING_TO_DO
  echo "LOCAL_WAL_GC=NOTHING_TO_DO"
  exit 0
fi

planned_delete="$(parse_planned_delete "$preflight_out")"
if [[ -z "$planned_delete" ]]; then
  log_history STOPPED_BEFORE_DELETE preflight_unparseable
  echo "LOCAL_WAL_GC=STOPPED stage=preflight reason=unparseable_preflight_output"
  exit 65
fi

max_delete="${X8_LOCAL_WAL_GC_MAX_DELETE:-3000}"
if [[ "$planned_delete" -gt "$max_delete" ]]; then
  log_history STOPPED_BEFORE_DELETE planned_delete_exceeds_local_cap
  echo "LOCAL_WAL_GC=STOPPED stage=preflight reason=planned_delete_exceeds_local_cap"
  exit 65
fi

# ---- step 2: apply ----------------------------------------------------------
run_step apply --apply --json
apply_out="$STEP_OUTPUT"
apply_rc="$STEP_RC"

# Refused/locked before ever reaching wal-retention.sh's own delete step
# (pg_archivecleanup -d) -- every REFUSED/LOCKED guard in wal-retention.sh
# fires strictly before that step (archiver health, anchor/timeline/staleness
# checks, delete_surge_guard, ...). Nothing was deleted.
apply_refused_line="$(printf '%s\n' "$apply_out" | grep -m1 -E '^WAL_RETENTION=(REFUSED|LOCKED)' || true)"
if [[ -n "$apply_refused_line" ]]; then
  log_history STOPPED_BEFORE_DELETE "$apply_refused_line"
  echo "LOCAL_WAL_GC=STOPPED stage=apply reason=\"$apply_refused_line\""
  exit 65
fi

# reconcile_mismatch fires AFTER pg_archivecleanup -d has already run (see
# wal-retention.sh's own step 2b comment) -- the delete has already happened
# at this point, this only flags that the count diverged from the plan.
apply_reconcile_line="$(printf '%s\n' "$apply_out" | grep -m1 -E '^WAL_RETENTION_WARN=reconcile_mismatch' || true)"
if [[ -n "$apply_reconcile_line" ]]; then
  log_history STOPPED_AFTER_DELETE "$apply_reconcile_line"
  echo "LOCAL_WAL_GC=STOPPED stage=apply reason=\"$apply_reconcile_line\""
  exit 65
fi

if [[ "$apply_rc" -ne 0 ]]; then
  # No REFUSED/LOCKED/reconcile_mismatch token to pin this to a stage -- an
  # unclassified non-zero exit could in principle have happened either side
  # of the delete step. Fail-closed assumes the worse of the two (delete may
  # already have happened) rather than guess BEFORE_DELETE from silence.
  reason="apply_command_exit_${apply_rc}"
  log_history STOPPED_AFTER_DELETE "$reason"
  echo "LOCAL_WAL_GC=STOPPED stage=apply reason=\"$reason\""
  exit 65
fi

applied_line="$(printf '%s\n' "$apply_out" | grep -m1 -E '^WAL_RETENTION=APPLIED deleted=[0-9]+' || true)"
if [[ -z "$applied_line" ]]; then
  # apply_rc was 0 here -- wal-retention.sh's only rc=0 exit in --apply mode
  # is after the delete step has fully completed and it printed its own
  # APPLIED line, so a 0 exit with no recognizable APPLIED line is itself
  # evidence the delete almost certainly already ran, just in an
  # unparseable/unexpected shape.
  log_history STOPPED_AFTER_DELETE apply_unparseable_output
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
  log_history STOPPED_AFTER_DELETE deleted_ne_planned
  echo "LOCAL_WAL_GC=STOPPED stage=apply reason=\"deleted_ne_planned deleted=$deleted planned=$planned_delete (deletion already occurred; see ${STAMP}-apply.txt)\""
  exit 65
fi

# ---- step 3: post (dry-run) -------------------------------------------------
run_step post --json
post_out="$STEP_OUTPUT"
post_rc="$STEP_RC"

# The apply step above already succeeded (deletion already happened) -- any
# problem with the post step itself (a refusal, a lock, or a non-zero exit)
# is a DIFFERENT failure from "there is still a residual plan" and must not
# be reported as one; distinguish it first.
post_bad_line="$(printf '%s\n' "$post_out" | grep -m1 -E '^WAL_RETENTION=(REFUSED|LOCKED)' || true)"
if [[ -n "$post_bad_line" || "$post_rc" -ne 0 ]]; then
  reason="${post_bad_line:-post_command_exit_${post_rc}}"
  log_history WARN_AFTER_DELETE "$reason"
  echo "LOCAL_WAL_GC=WARN stage=post reason=\"$reason\""
  exit 62
fi

post_planned="$(parse_planned_delete "$post_out")"
post_is_noop=0
printf '%s\n' "$post_out" | grep -qE '^WAL_RETENTION=NOOP' && post_is_noop=1

if [[ "$post_planned" != "0" && "$post_is_noop" -ne 1 ]]; then
  log_history WARN_AFTER_DELETE residual_plan
  echo "LOCAL_WAL_GC=WARN stage=post reason=residual_plan"
  exit 62
fi

anchor="$(parse_summary_anchor "$apply_out")" || true
[[ -n "$anchor" ]] || anchor="UNKNOWN"
log_history APPLIED
echo "LOCAL_WAL_GC=APPLIED deleted=$deleted anchor=$anchor"
exit 0
