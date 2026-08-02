#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: backup-physical-base.sh --output-dir /absolute/empty/directory" >&2
  exit 64
}

output_dir=""
while (($#)); do
  case "$1" in
    --output-dir)
      (($# >= 2)) || usage
      output_dir="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

[[ "$output_dir" = /* ]] || usage
[[ "${PGUSER:-}" == "backup_role" ]] || { echo "PGUSER must be backup_role" >&2; exit 65; }
: "${PGHOST:?PGHOST is required}"
: "${PGPORT:?PGPORT is required}"
: "${PGPASSFILE:?PGPASSFILE is required}"
[[ -r "$PGPASSFILE" ]] || { echo "PGPASSFILE is not readable" >&2; exit 66; }
[[ -z "${PGPASSWORD:-}" ]] || { echo "Use PGPASSFILE; PGPASSWORD is rejected" >&2; exit 65; }
[[ ! -e "$output_dir" ]] || {
  [[ -d "$output_dir" && -z "$(find "$output_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]] || {
    echo "Base-backup output directory must not exist or must be empty" >&2
    exit 73
  }
}

umask 077
mkdir -p "$output_dir"
pg_basebackup \
  --pgdata="$output_dir" \
  --format=tar \
  --compress=gzip:6 \
  --wal-method=stream \
  --checkpoint=spread \
  --manifest-checksums=SHA256 \
  --no-password

echo "PHYSICAL_BASE_BACKUP=CREATED_NOT_PITR_VALIDATED"
