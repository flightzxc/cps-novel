#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: wal-retention.sh --archive-dir /absolute/dir --base-backup-dir /absolute/dir [--keep-base N] [--max-bytes B] [--apply] [--force] [--json] [--max-backup-age-seconds S] [--archive-ext EXT] [--require-archiver-healthy]" >&2
  exit 64
}

archive_dir=""
base_backup_dir=""
keep_base="2"
max_bytes=""
apply=0
force=0
json=0
max_backup_age_seconds=93600
archive_ext=""
require_archiver_healthy=0

while (($#)); do
  case "$1" in
    --archive-dir) (($# >= 2)) || usage; archive_dir="$2"; shift 2 ;;
    --base-backup-dir) (($# >= 2)) || usage; base_backup_dir="$2"; shift 2 ;;
    --keep-base) (($# >= 2)) || usage; keep_base="$2"; shift 2 ;;
    --max-bytes) (($# >= 2)) || usage; max_bytes="$2"; shift 2 ;;
    --apply) apply=1; shift ;;
    --force) force=1; shift ;;
    --json) json=1; shift ;;
    --max-backup-age-seconds) (($# >= 2)) || usage; max_backup_age_seconds="$2"; shift 2 ;;
    --archive-ext) (($# >= 2)) || usage; archive_ext="$2"; shift 2 ;;
    --require-archiver-healthy) require_archiver_healthy=1; shift ;;
    *) usage ;;
  esac
done

[[ "$archive_dir" = /* && -d "$archive_dir" ]] || usage
[[ "$base_backup_dir" = /* && -d "$base_backup_dir" ]] || usage
[[ "$keep_base" =~ ^[1-9][0-9]*$ ]] || usage
[[ -z "$max_bytes" || "$max_bytes" =~ ^[1-9][0-9]*$ ]] || usage
[[ "$max_backup_age_seconds" =~ ^[1-9][0-9]*$ ]] || usage
[[ -z "$archive_ext" || "$archive_ext" =~ ^\.[A-Za-z0-9]+$ ]] || usage

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "required command not found: $1" >&2
    exit 69
  }
}
require_command pg_archivecleanup
require_command find
require_command stat
require_command date

# GNU stat (the rehearsal's Debian rig, and production) vs. BSD stat (a
# developer's own macOS host running this by hand) take the file flags
# differently; probe once instead of guessing from uname.
stat_size_flag="-c%s"
stat -c%s "$0" >/dev/null 2>&1 || stat_size_flag="-f%z"
stat_mtime_flag="-c%Y"
stat -c%Y "$0" >/dev/null 2>&1 || stat_mtime_flag="-f%m"

read_kv() {
  # First "key=value" line in a flat marker/state file; empty if absent.
  grep "^${2}=" "$1" 2>/dev/null | head -1 | cut -d= -f2- || true
}

# ---- mutual exclusion: one retention run at a time per base-backup-dir ----
lock_dir="$base_backup_dir/.wal-retention.lock"
plan_tmp=""
plan_err=""
trap 'rm -f "$plan_tmp" "$plan_err"; rmdir "$lock_dir" 2>/dev/null || true' EXIT INT TERM
if ! mkdir "$lock_dir" 2>/dev/null; then
  lock_mtime="$(stat "$stat_mtime_flag" "$lock_dir" 2>/dev/null || true)"
  now_epoch_lock="$(date -u '+%s')"
  hint="if you have confirmed no wal-retention.sh process is running against this base-backup-dir, you may manually: rmdir $lock_dir"
  if [[ "$lock_mtime" =~ ^[0-9]+$ ]]; then
    lock_age_seconds=$((now_epoch_lock - lock_mtime))
    echo "WAL_RETENTION=LOCKED lock_age_seconds=$lock_age_seconds hint=\"$hint\""
  else
    echo "WAL_RETENTION=LOCKED hint=\"$hint\""
  fi
  # The EXIT trap's rmdir must not fire here -- this process never created
  # the lock, so it must never remove it. Clear the trap before exiting.
  trap - EXIT INT TERM
  exit 75
fi
state_file="$base_backup_dir/.wal-retention.state"

# ---- enumerate the valid set: has VERIFIED, has no RETIRED ----------------
# Every non-dot directory directly under base-backup-dir must look like one
# WE created (a bounded, conservative name charset) -- an unrecognized
# directory might be a hand-placed backup from someone else, so this refuses
# outright rather than silently skip it.
# Ordering is by each candidate's own VERIFIED start_wal (ascending), not by
# directory name -- within a single timeline, WAL segment names already sort
# in time order, and start_wal is the fact that actually matters; directory
# name is only a tie-breaker.
valid_pairs=()
while IFS= read -r d; do
  name="$(basename "$d")"
  if [[ ! "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
    echo "WAL_RETENTION=REFUSED reason=unexpected_directory name=$name"
    exit 65
  fi
  if [[ -f "$d/VERIFIED" && ! -f "$d/RETIRED" ]]; then
    sw="$(read_kv "$d/VERIFIED" start_wal)"
    st="$(read_kv "$d/VERIFIED" start_timeline)"
    ve="$(read_kv "$d/VERIFIED" verified_epoch)"
    # A VERIFIED marker missing/malformed any of these three fields must
    # never be silently sorted as though start_wal were empty (which sorts
    # FIRST, i.e. oldest -- it would then be picked for retirement, marked
    # RETIRED and rm -rf'd, without ever having a real position). Refuse
    # instead, and touch nothing.
    if [[ ! "$sw" =~ ^[0-9A-F]{24}$ || ! "$st" =~ ^[0-9]+$ || ! "$ve" =~ ^[0-9]+$ ]]; then
      echo "WAL_RETENTION=REFUSED reason=verified_malformed name=$name"
      exit 65
    fi
    valid_pairs+=("${sw}|${name}")
  elif [[ ! -f "$d/VERIFIED" && ! -f "$d/RETIRED" ]]; then
    # WAL-retention rollout work order 2026-09-17, P2-5: a legally-named
    # directory with neither marker is not a refusal (an in-flight
    # backup-physical-base.sh run, or one that failed before
    # verify-physical-base.sh ever wrote VERIFIED, are both ordinary and
    # must not block retention) -- but it is also invisible to every count
    # and log line above without this, silently never entering the valid
    # set or the retire set either. Warn-only, stdout, never counted toward
    # anything -- purely so an operator scanning output notices a backup
    # attempt that never finished.
    echo "WAL_RETENTION_WARN=unverified_backup_dir name=$name"
  fi
done < <(find "$base_backup_dir" -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2>/dev/null | sort)

valid_dirs=()
if [[ "${#valid_pairs[@]}" -gt 0 ]]; then
  while IFS='|' read -r sw name; do
    [[ -n "$name" ]] || continue
    valid_dirs+=("$name")
    echo "WAL_RETENTION_BASE_START_WAL=$name start_wal=${sw:-UNKNOWN}"
  done < <(printf '%s\n' "${valid_pairs[@]}" | sort -t'|' -k1,1 -k2,2)
fi

if [[ "${#valid_dirs[@]}" -lt "$keep_base" ]]; then
  # Cold start / not enough verified history yet is a normal, expected
  # state -- never a refusal, and never a reason to delete anything.
  echo "WAL_RETENTION=NOOP reason=insufficient_verified_backups"
  exit 0
fi

# ---- split into keep (most recent N) / retire (the rest) ------------------
total="${#valid_dirs[@]}"
recent_start=$((total - keep_base))
recent_set=("${valid_dirs[@]:recent_start:keep_base}")
retire_set=()
if [[ "$recent_start" -gt 0 ]]; then
  retire_set=("${valid_dirs[@]:0:recent_start}")
fi

# Anchor = the Nth-newest valid backup, i.e. the oldest one still being
# kept. Everything at or after its start_wal must survive; everything
# strictly before it is safe to reclaim.
anchor_dir="${recent_set[0]}"
anchor_verified="$base_backup_dir/$anchor_dir/VERIFIED"
[[ -f "$anchor_verified" ]] || {
  echo "WAL_RETENTION=REFUSED reason=anchor_verified_missing"
  exit 65
}
anchor="$(read_kv "$anchor_verified" start_wal)"
anchor_timeline="$(read_kv "$anchor_verified" start_timeline)"
[[ -n "$anchor" && -n "$anchor_timeline" ]] || {
  echo "WAL_RETENTION=REFUSED reason=anchor_verified_malformed"
  exit 65
}

# ---- refusal: anchor_not_in_archive ----------------------------------------
# Offline and mandatory: if the archive doesn't actually hold the segment
# every kept backup depends on, nothing below can be trusted -- refuse
# before computing or touching anything else.
anchor_archive_path="$archive_dir/$anchor$archive_ext"
[[ -f "$anchor_archive_path" ]] || {
  echo "WAL_RETENTION=REFUSED reason=anchor_not_in_archive"
  exit 65
}

latest_dir="${valid_dirs[$((total - 1))]}"
latest_verified="$base_backup_dir/$latest_dir/VERIFIED"
latest_verified_epoch="$(read_kv "$latest_verified" verified_epoch)"

# ---- refusal: stale_base_backup (only gates --apply) -----------------------
if [[ "$apply" == "1" ]]; then
  [[ "$latest_verified_epoch" =~ ^[0-9]+$ ]] || {
    echo "WAL_RETENTION=REFUSED reason=stale_base_backup"
    exit 65
  }
  now_epoch="$(date -u '+%s')"
  age_seconds=$((now_epoch - latest_verified_epoch))
  if [[ "$age_seconds" -gt "$max_backup_age_seconds" ]]; then
    echo "WAL_RETENTION=REFUSED reason=stale_base_backup"
    exit 65
  fi
fi

# ---- refusal: timeline_unsupported -----------------------------------------
# This tool only understands a single, unbroken timeline. A promoted
# (multi-timeline) anchor, or a manifest recording more than one WAL range,
# is outside what pg_archivecleanup's single OLDESTKEPTWALFILE argument can
# safely express, so it refuses rather than guess.
anchor_manifest="$base_backup_dir/$anchor_dir/backup_manifest"
[[ -f "$anchor_manifest" ]] || {
  echo "WAL_RETENTION=REFUSED reason=timeline_unsupported"
  exit 65
}
manifest_tail="$(sed -n '/WAL-Ranges/,$p' "$anchor_manifest" | tr -d '\n')"
wal_ranges_section="$(printf '%s' "$manifest_tail" | grep -oE '"WAL-Ranges"[[:space:]]*:[[:space:]]*\[[^]]*\]' || true)"
wal_ranges_count=0
if [[ -n "$wal_ranges_section" ]]; then
  # `grep -oE` exits 1 (no match) when the section has zero "Timeline" keys.
  # Under `set -euo pipefail` that non-zero status propagates through the
  # rest of this pipe (pipefail keeps the *first* non-zero, even though
  # wc/tr both still succeed) and kills the whole script right here --
  # before the timeline_unsupported refusal below ever gets a chance to
  # run. The trailing `|| true` only forces the pipeline's exit status to
  # 0; it does not touch what wc/tr already captured (still a correct "0"
  # count when grep found nothing), so the refusal check after this stays
  # exact.
  wal_ranges_count="$(printf '%s' "$wal_ranges_section" | grep -oE '"Timeline"' | wc -l | tr -d ' ' || true)"
fi
if [[ "$anchor_timeline" != "1" || "$wal_ranges_count" != "1" ]]; then
  echo "WAL_RETENTION=REFUSED reason=timeline_unsupported"
  exit 65
fi

# ---- refusal: archive_not_writable -----------------------------------------
write_probe="$archive_dir/.wal-retention.writetest.$$"
if ! { touch "$write_probe" 2>/dev/null && rm -f "$write_probe" 2>/dev/null; }; then
  echo "WAL_RETENTION=REFUSED reason=archive_not_writable"
  exit 65
fi

# ---- refusal: archiver_failing (opt-in via --require-archiver-healthy) ----
# Off by default; a timer/operator wiring this script into automation MUST
# turn it on (see docs).
#
# This is a time-based predicate, not a failed_count baseline/delta compare
# against the previous run's state -- a baseline can wedge forever: once
# failed_count has risen past whatever was last persisted, it never falls
# back down on its own (pg_stat_archiver only resets on server restart or
# pg_stat_reset_shared), so every subsequent run keeps refusing even after
# archiving has actually recovered. Instead this asks pg_stat_archiver
# directly "is the most recent failure newer than the most recent success" --
# that self-heals the moment archiving resumes, with no state file involved.
# An unreadable/malformed pg_stat_archiver is treated as unhealthy either
# way -- fail closed.
archiver_failed_count=""
archiver_last_failed_time=""
archiver_last_archived_time=""
if [[ "$require_archiver_healthy" == "1" ]]; then
  command -v psql >/dev/null 2>&1 || {
    echo "WAL_RETENTION=REFUSED reason=archiver_unreadable"
    exit 65
  }
  export PGCONNECT_TIMEOUT=10
  # `|| true` here for the same set -e/pipefail reason as the manifest
  # parsing above: a psql connection/query failure must fall through to the
  # numeric-format check below and refuse cleanly, not kill the script
  # silently before the refusal line ever prints.
  archiver_row="$(psql --no-psqlrc -tAc "SELECT coalesce(failed_count,0), coalesce(last_failed_time::text,''), coalesce(last_archived_time::text,'') FROM pg_stat_archiver" 2>/dev/null || true)"
  IFS='|' read -r archiver_failed_count archiver_last_failed_time archiver_last_archived_time <<<"$archiver_row"
  if [[ ! "$archiver_failed_count" =~ ^[0-9]+$ ]]; then
    echo "WAL_RETENTION=REFUSED reason=archiver_unreadable"
    exit 65
  fi
  # Second, independent query: let Postgres itself do the timestamp compare
  # (NULL-safe) and hand back a single t/f -- the script only ever trusts
  # exactly those two literal values, anything else (empty, error, garbage)
  # is unreadable.
  archiver_failing_flag="$(psql --no-psqlrc -tAc "SELECT (last_failed_time IS NOT NULL AND (last_archived_time IS NULL OR last_failed_time > last_archived_time)) FROM pg_stat_archiver" 2>/dev/null | tr -d '[:space:]' || true)"
  case "$archiver_failing_flag" in
    t)
      echo "WAL_RETENTION=REFUSED reason=archiver_failing failed_count=$archiver_failed_count last_failed_time=$archiver_last_failed_time last_archived_time=$archiver_last_archived_time"
      exit 65
      ;;
    f)
      : # healthy -- last success is not older than last failure (or there has never been a failure)
      ;;
    *)
      echo "WAL_RETENTION=REFUSED reason=archiver_unreadable"
      exit 65
      ;;
  esac
fi

# ---- compute the plan: which archived WAL files are now reclaimable -------
archivecleanup_args=("$archive_dir" "$anchor")
if [[ -n "$archive_ext" ]]; then
  archivecleanup_args=(-x "$archive_ext" "$archive_dir" "$anchor")
fi
plan_tmp="$(mktemp "${TMPDIR:-/tmp}/wal-retention-plan.XXXXXX")"
plan_err="$(mktemp "${TMPDIR:-/tmp}/wal-retention-plan-err.XXXXXX")"
plan_rc=0
pg_archivecleanup -n "${archivecleanup_args[@]}" >"$plan_tmp" 2>"$plan_err" || plan_rc=$?
if [[ "$plan_rc" -ne 0 ]]; then
  echo "WAL_RETENTION=REFUSED reason=plan_failed"
  cat "$plan_err" >&2
  exit 65
fi
planned_files=()
while IFS= read -r f; do
  [[ -n "$f" ]] && planned_files+=("$f")
done <"$plan_tmp"
planned_delete_count="${#planned_files[@]}"

# ---- refusal: would_empty_archive ------------------------------------------
# If applying the plan above would leave zero surviving 24-hex segment files
# in the archive (i.e. nothing at or after the anchor), that means the plan
# disagrees with what anchor_not_in_archive just confirmed -- refuse rather
# than delete everything and print APPLIED anyway.
# End-anchored, at most one simple extension -- this deliberately excludes
# pg_basebackup's two-extension "<24hex>.<8hex>.backup" history files (which
# pg_archivecleanup never touches either) so both counts below only ever
# reflect real/restorable WAL segments.
current_segment_count="$(find "$archive_dir" -maxdepth 1 -type f -exec basename {} \; 2>/dev/null | grep -cE '^[0-9A-F]{24}(\.[A-Za-z0-9]+)?$' || true)"
planned_segment_count=0
# Guard the iteration itself, not just skip the body: under `set -u`, bash
# < 4.4 (including macOS system bash 3.2, the rehearsal/dev environment --
# see red-line notes) raises "unbound variable" on `"${arr[@]}"` when arr
# has zero elements, even though `arr=()` was a perfectly normal empty
# array. A zero-file plan (nothing reclaimable) is a completely ordinary,
# frequent outcome -- e.g. every healthy dry-run right after a prior apply
# -- so this is not a corner case to leave unguarded.
if [[ "${#planned_files[@]}" -gt 0 ]]; then
  for f in "${planned_files[@]}"; do
    bn="$(basename "$f")"
    [[ "$bn" =~ ^[0-9A-F]{24}(\.[A-Za-z0-9]+)?$ ]] && planned_segment_count=$((planned_segment_count + 1))
  done
fi
if [[ "$current_segment_count" -gt 0 && $((current_segment_count - planned_segment_count)) -le 0 ]]; then
  echo "WAL_RETENTION=REFUSED reason=would_empty_archive"
  exit 65
fi

# ---- refusal: delete_surge_guard (apply-only; --force bypasses) -----------
last_deleted_count=0
if [[ -f "$state_file" ]]; then
  v="$(read_kv "$state_file" last_deleted_count)"
  [[ "$v" =~ ^[0-9]+$ ]] && last_deleted_count="$v"
fi
if [[ "$apply" == "1" && "$force" == "0" && "$last_deleted_count" -gt 0 \
  && "$planned_delete_count" -gt $((last_deleted_count * 10)) ]]; then
  echo "WAL_RETENTION=REFUSED reason=delete_surge_guard"
  exit 65
fi

# ---- print the plan (both dry-run and apply print the same plan lines) ----
if [[ "${#retire_set[@]}" -gt 0 ]]; then
  for d in "${retire_set[@]}"; do
    echo "WAL_RETENTION_RETIRE_BASE=$d"
  done
fi
k=1
for d in "${recent_set[@]}"; do
  echo "WAL_RETENTION_KEEP_BASE=$d reason=recent_${k}_of_${keep_base}"
  k=$((k + 1))
done
if [[ "$planned_delete_count" -gt 0 ]]; then
  for f in "${planned_files[@]}"; do
    echo "WAL_RETENTION_DELETE=$f"
  done
fi

# ---- capacity: report-only, never changes N or the plan above -------------
capacity_status=""
capacity_bytes=""
if [[ -n "$max_bytes" ]]; then
  capacity_bytes=0
  while IFS= read -r sz; do
    [[ -n "$sz" ]] && capacity_bytes=$((capacity_bytes + sz))
  done < <(find "$archive_dir" -maxdepth 1 -type f -exec stat "$stat_size_flag" {} \; 2>/dev/null)
  if [[ "$capacity_bytes" -ge "$max_bytes" ]]; then
    capacity_status=OVER
  elif [[ $((capacity_bytes * 100)) -ge $((max_bytes * 85)) ]]; then
    capacity_status=DEGRADED
  elif [[ $((capacity_bytes * 100)) -ge $((max_bytes * 70)) ]]; then
    capacity_status=WARN
  else
    capacity_status=OK
  fi
  echo "WAL_RETENTION_CAPACITY=$capacity_status bytes=$capacity_bytes max=$max_bytes"
fi

# ---- warn-only: compressed archive files present without --archive-ext ----
# (or the reverse: --archive-ext given but nothing compressed is there).
# Never a refusal -- purely a hint that the two may be out of sync.
compressed_count="$(find "$archive_dir" -maxdepth 1 -type f -exec basename {} \; 2>/dev/null | grep -cE '^[0-9A-F]{24}\.(gz|lz4|zst)$' || true)"
if [[ -z "$archive_ext" && "$compressed_count" -gt 0 ]]; then
  echo "WAL_RETENTION_WARN=compressed_files_without_archive_ext"
elif [[ -n "$archive_ext" && "$compressed_count" -eq 0 ]]; then
  echo "WAL_RETENTION_WARN=compressed_files_without_archive_ext"
fi

emit_json_summary() {
  local retire_json="[" item first=1
  if [[ "${#retire_set[@]}" -gt 0 ]]; then
    for item in "${retire_set[@]}"; do
      [[ "$first" == "1" ]] || retire_json+=","
      retire_json+="\"$item\""
      first=0
    done
  fi
  retire_json+="]"
  local capacity_json="null"
  if [[ -n "$max_bytes" ]]; then
    capacity_json="{\"status\":\"$capacity_status\",\"bytes\":$capacity_bytes,\"max\":$max_bytes}"
  fi
  echo "WAL_RETENTION_SUMMARY_JSON={\"keepCount\":${#recent_set[@]},\"retireList\":$retire_json,\"deleteCount\":$planned_delete_count,\"anchor\":\"$anchor\",\"capacity\":$capacity_json}"
}

if [[ "$apply" == "0" ]]; then
  [[ "$json" == "1" ]] && emit_json_summary
  echo "WAL_RETENTION=DRY_RUN planned_delete=$planned_delete_count"
  exit 0
fi

# ---- apply: fixed order is the safety invariant ----------------------------
# 1) mark retirees FIRST (moves them out of the valid set before anything
#    is actually removed, so a crash here just leaves stray RETIRED files
#    -- the retiree directories themselves, and every WAL segment, are
#    still fully intact and the next run recomputes the same plan).
if [[ "${#retire_set[@]}" -gt 0 ]]; then
  for d in "${retire_set[@]}"; do
    touch "$base_backup_dir/$d/RETIRED"
  done
fi
# 2) remove the WAL segments now provably unreachable from any kept backup.
pg_archivecleanup -d "${archivecleanup_args[@]}"

# 2b) reconcile: every path the plan named must actually be gone now. A
#     mismatch means pg_archivecleanup's -d run diverged from its own -n
#     plan (or something else touched the archive mid-run) -- warn loudly
#     and stop before touching the RETIRED directories or persisting state,
#     rather than claim a clean APPLIED that isn't true.
deleted_actual=0
# Same bash 3.2 `set -u` empty-array guard as the would_empty_archive block
# above -- an apply with nothing reclaimable (planned_delete_count=0) is
# ordinary, not exceptional, and must not crash the reconcile step.
if [[ "${#planned_files[@]}" -gt 0 ]]; then
  for f in "${planned_files[@]}"; do
    [[ -e "$f" ]] || deleted_actual=$((deleted_actual + 1))
  done
fi
if [[ "$deleted_actual" -ne "$planned_delete_count" ]]; then
  echo "WAL_RETENTION_WARN=reconcile_mismatch deleted=$deleted_actual planned=$planned_delete_count"
  # This does not self-heal and is not meant to: the retirees' RETIRED
  # markers are deliberately left in place (step 3 below never runs), and
  # nothing about their WAL is re-verified automatically. An operator must
  # look at the actual archive state before deciding whether those backups
  # are still trustworthy.
  retired_dirs_csv=""
  if [[ "${#retire_set[@]}" -gt 0 ]]; then
    retired_dirs_csv="$(IFS=,; echo "${retire_set[*]}")"
  fi
  echo "WAL_RETENTION_HINT=retired_markers_kept dirs=$retired_dirs_csv action=\"确认这些目录的 WAL 是否仍完整；若要恢复为有效集合成员，人工删除其 RETIRED 标记\""
  exit 62
fi

# 3) only now remove the directories THIS run marked RETIRED in step 1 --
#    never a glob, never anything not explicitly listed above.
if [[ "${#retire_set[@]}" -gt 0 ]]; then
  for d in "${retire_set[@]}"; do
    rm -rf "$base_backup_dir/$d"
  done
fi
# 4) persist state for the next run's delete_surge_guard. archiver_failing
#    (above) is now a time-based predicate against pg_stat_archiver itself,
#    not a baseline compared across runs, so no archiver-related key is
#    written here any more; if an older state file still has a
#    last_failed_count= line from before this change, read_kv simply never
#    looks for that key any more and it is ignored.
run_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
tmp_state="$base_backup_dir/.wal-retention.state.$$"
{
  printf 'last_deleted_count=%s\n' "$planned_delete_count"
  printf 'last_run_at=%s\n' "$run_at"
  printf 'anchor=%s\n' "$anchor"
} >"$tmp_state"
mv "$tmp_state" "$state_file"

[[ "$json" == "1" ]] && emit_json_summary
echo "WAL_RETENTION=APPLIED deleted=$planned_delete_count anchor=$anchor"
