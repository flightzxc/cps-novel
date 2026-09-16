#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: wal-retention.sh --archive-dir /absolute/dir --base-backup-dir /absolute/dir --keep-base N [--max-bytes B] [--apply] [--force] [--json] [--max-backup-age-seconds S] [--archive-ext EXT]" >&2
  exit 64
}

archive_dir=""
base_backup_dir=""
keep_base=""
max_bytes=""
apply=0
force=0
json=0
max_backup_age_seconds=93600
archive_ext=""

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
# developer's own macOS host running this by hand) take the file-size flag
# differently; probe once instead of guessing from uname.
stat_size_flag="-c%s"
stat -c%s "$0" >/dev/null 2>&1 || stat_size_flag="-f%z"

read_kv() {
  # First "key=value" line in a flat marker/state file; empty if absent.
  grep "^${2}=" "$1" 2>/dev/null | head -1 | cut -d= -f2- || true
}

# ---- mutual exclusion: one retention run at a time per base-backup-dir ----
lock_dir="$base_backup_dir/.wal-retention.lock"
if ! mkdir "$lock_dir" 2>/dev/null; then
  echo "WAL_RETENTION=LOCKED"
  exit 75
fi
trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT INT TERM

# ---- enumerate the valid set: has VERIFIED, has no RETIRED ----------------
# Directory names are expected to sort lexically in creation order (a
# timestamp stamp in production; the rehearsal's B1/B2/B3 satisfy the same
# property). Only members of this set count toward --keep-base.
valid_dirs=()
while IFS= read -r d; do
  name="$(basename "$d")"
  if [[ -f "$d/VERIFIED" && ! -f "$d/RETIRED" ]]; then
    valid_dirs+=("$name")
  fi
done < <(find "$base_backup_dir" -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2>/dev/null | sort)

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
  echo "WAL_RETENTION=REFUSED reason=anchor_verified_missing" >&2
  exit 65
}
anchor="$(read_kv "$anchor_verified" start_wal)"
anchor_timeline="$(read_kv "$anchor_verified" start_timeline)"
[[ -n "$anchor" && -n "$anchor_timeline" ]] || {
  echo "WAL_RETENTION=REFUSED reason=anchor_verified_malformed" >&2
  exit 65
}

latest_dir="${valid_dirs[$((total - 1))]}"
latest_verified="$base_backup_dir/$latest_dir/VERIFIED"
latest_verified_at="$(read_kv "$latest_verified" verified_at)"

# ---- refusal: stale_base_backup (only gates --apply) -----------------------
if [[ "$apply" == "1" ]]; then
  [[ -n "$latest_verified_at" ]] || {
    echo "WAL_RETENTION=REFUSED reason=stale_base_backup" >&2
    exit 65
  }
  now_epoch="$(date -u '+%s')"
  latest_epoch="$(date -u -d "$latest_verified_at" '+%s' 2>/dev/null || true)"
  if [[ -z "$latest_epoch" ]]; then
    echo "WAL_RETENTION=REFUSED reason=stale_base_backup" >&2
    exit 65
  fi
  age_seconds=$((now_epoch - latest_epoch))
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
  echo "WAL_RETENTION=REFUSED reason=timeline_unsupported" >&2
  exit 65
}
manifest_flat="$(tr -d '\n' <"$anchor_manifest")"
wal_ranges_section="$(printf '%s' "$manifest_flat" | grep -oE '"WAL-Ranges"[[:space:]]*:[[:space:]]*\[[^]]*\]' || true)"
wal_ranges_count=0
if [[ -n "$wal_ranges_section" ]]; then
  wal_ranges_count="$(printf '%s' "$wal_ranges_section" | grep -oE '"Timeline"' | wc -l | tr -d ' ')"
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

# ---- compute the plan: which archived WAL files are now reclaimable -------
archivecleanup_args=("$archive_dir" "$anchor")
if [[ -n "$archive_ext" ]]; then
  archivecleanup_args=(-x "$archive_ext" "$archive_dir" "$anchor")
fi
planned_files=()
while IFS= read -r f; do
  [[ -n "$f" ]] && planned_files+=("$f")
done < <(pg_archivecleanup -n "${archivecleanup_args[@]}")
planned_delete_count="${#planned_files[@]}"

# ---- refusal: delete_surge_guard (apply-only; --force bypasses) -----------
state_file="$base_backup_dir/.wal-retention.state"
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
  elif [[ $((capacity_bytes * 100)) -ge $((max_bytes * 70)) ]]; then
    capacity_status=WARN
  else
    capacity_status=OK
  fi
  echo "WAL_RETENTION_CAPACITY=$capacity_status bytes=$capacity_bytes max=$max_bytes"
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
# 3) only now remove the directories THIS run marked RETIRED in step 1 --
#    never a glob, never anything not explicitly listed above.
if [[ "${#retire_set[@]}" -gt 0 ]]; then
  for d in "${retire_set[@]}"; do
    rm -rf "$base_backup_dir/$d"
  done
fi
# 4) persist state for the next run's delete_surge_guard.
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
