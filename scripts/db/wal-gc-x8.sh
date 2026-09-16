#!/usr/bin/env bash
set -euo pipefail

# Formal X8 entry point for WAL retention GC. Unlike a raw wal-retention.sh
# invocation, this wrapper's --require-archiver-healthy is not optional --
# no caller of this wrapper can turn it off, and --archive-dir/--base-
# backup-dir are fixed in-container paths, not caller-supplied. --force
# below still only reaches wal-retention.sh's own --force, which (see that
# script's header) bypasses exactly ONE guard, delete_surge_guard -- it does
# NOT bypass archiver_unreadable/archiver_failing, anchor_not_in_archive,
# verified_malformed, plan_failed, or any other refusal.

usage() {
  echo "usage: wal-gc-x8.sh [--apply] [--keep-base N] [--json] [--force]" >&2
  exit 64
}

args=()
while (($#)); do
  case "$1" in
    --apply) args+=(--apply); shift ;;
    --keep-base)
      (($# >= 2)) || usage
      args+=(--keep-base "$2")
      shift 2
      ;;
    --json) args+=(--json); shift ;;
    --force) args+=(--force); shift ;;
    *) usage ;;
  esac
done

script_dir="$(dirname "$0")"
target=("$script_dir/wal-retention.sh"
  --archive-dir "${X8_WAL_ARCHIVE_DIR:-/var/lib/postgresql/wal-archive}"
  --base-backup-dir "${X8_BASE_BACKUP_DIR_IN_CONTAINER:-/var/lib/postgresql/base-backups}"
  --require-archiver-healthy
  --max-bytes "${X8_WAL_ARCHIVE_MAX_BYTES:-21474836480}")
# bash 3.2 (macOS system bash, this repo's dev/rehearsal host) raises
# "unbound variable" under `set -u` on `"${args[@]}"` when args is a
# perfectly ordinary zero-element array (e.g. a plain dry-run with no
# flags at all) -- guard the append instead of referencing it unconditionally.
if [[ "${#args[@]}" -gt 0 ]]; then
  target+=("${args[@]}")
fi
exec "${target[@]}"
