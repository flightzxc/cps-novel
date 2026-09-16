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
#
# WAL-retention rollout work order 2026-09-17, P2-7: the three
# X8_WAL_ARCHIVE_DIR / X8_BASE_BACKUP_DIR_IN_CONTAINER / X8_WAL_ARCHIVE_MAX_BYTES
# env-var overrides below exist ONLY so tests/backend/database/wal-gc-x8.test.ts
# can point this script at a throwaway directory pair without Docker. The
# formal entry point -- scripts/x8-production-like.sh's wal_gc(), the only
# supported way to reach this script against a real stack -- always invokes
# it via `x8_compose exec` with no `-e` at all, so none of these three
# variables is reachable from a real run; production/rehearsal traffic
# always gets the hard-coded defaults on the right of each `:-`.

usage() {
  echo "usage: wal-gc-x8.sh [--apply] [--keep-base N] [--json] [--force]" >&2
  exit 64
}

args=()
force_requested=0
while (($#)); do
  case "$1" in
    --apply) args+=(--apply); shift ;;
    --keep-base)
      (($# >= 2)) || usage
      args+=(--keep-base "$2")
      shift 2
      ;;
    --json) args+=(--json); shift ;;
    --force) args+=(--force); force_requested=1; shift ;;
    *) usage ;;
  esac
done

# WAL-retention rollout work order 2026-09-17, P2-9: printed on stdout
# before wal-retention.sh ever runs, so it lands in the same log/evidence
# stream as every WAL_RETENTION*= judgment line below it, whether or not
# delete_surge_guard actually ends up firing this run -- --force disarms
# that guard unconditionally for the whole invocation, not only when it
# would otherwise have refused.
if [[ "$force_requested" == "1" ]]; then
  echo "WAL_GC_X8_NOTICE=delete_surge_guard_disabled_for_this_run"
fi

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
