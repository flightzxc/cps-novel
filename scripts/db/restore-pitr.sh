#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: restore-pitr.sh --base-backup /absolute/dir --pgdata /absolute/empty/dir --target-time 'ISO-8601'" >&2
  exit 64
}

base_backup=""
pgdata=""
target_time=""
while (($#)); do
  case "$1" in
    --base-backup) base_backup="${2:-}"; shift 2 ;;
    --pgdata) pgdata="${2:-}"; shift 2 ;;
    --target-time) target_time="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ "${P1_06_ALLOW_DISPOSABLE_PITR:-}" == "1" ]] || {
  echo "Set P1_06_ALLOW_DISPOSABLE_PITR=1 for isolated PITR preparation" >&2
  exit 65
}
: "${P1_06_WAL_ARCHIVE_DIR:?P1_06_WAL_ARCHIVE_DIR is required}"
[[ "$base_backup" = /* && -r "$base_backup/base.tar.gz" ]] || usage
[[ "$pgdata" = /* && "$pgdata" == *p1-06-pitr* ]] || {
  echo "PGDATA must be an absolute disposable path containing p1-06-pitr" >&2
  exit 65
}
[[ "$P1_06_WAL_ARCHIVE_DIR" = /* ]] || { echo "WAL archive directory must be absolute" >&2; exit 65; }
[[ -n "$target_time" && "$target_time" != *"'"* ]] || usage
[[ "$P1_06_WAL_ARCHIVE_DIR" != *"'"* ]] || { echo "Archive path cannot contain a single quote" >&2; exit 65; }
[[ ! -e "$pgdata" ]] || {
  [[ -d "$pgdata" && -z "$(find "$pgdata" -mindepth 1 -maxdepth 1 -print -quit)" ]] || {
    echo "Disposable PGDATA must not exist or must be empty" >&2
    exit 73
  }
}

umask 077
mkdir -p "$pgdata"
tar -xzf "$base_backup/base.tar.gz" -C "$pgdata"
mkdir -p "$pgdata/pg_wal"
if [[ -r "$base_backup/pg_wal.tar.gz" ]]; then
  tar -xzf "$base_backup/pg_wal.tar.gz" -C "$pgdata/pg_wal"
fi
touch "$pgdata/recovery.signal"
{
  printf "restore_command = 'cp %s/%%f %%p'\n" "$P1_06_WAL_ARCHIVE_DIR"
  printf "recovery_target_time = '%s'\n" "$target_time"
  printf "recovery_target_action = 'pause'\n"
} >>"$pgdata/postgresql.auto.conf"

echo "PITR_PREPARED=YES"
echo "PITR_STARTED=NO"
