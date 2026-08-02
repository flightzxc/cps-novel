#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/../.." && pwd)"

usage() {
  echo "usage: restore-logical.sh --archive /absolute/path/database.dump" >&2
  exit 64
}

archive=""
while (($#)); do
  case "$1" in
    --archive)
      (($# >= 2)) || usage
      archive="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

[[ "$archive" = /* && -r "$archive" ]] || usage
[[ "${P1_06_ALLOW_DISPOSABLE_RESTORE:-}" == "1" ]] || {
  echo "Set P1_06_ALLOW_DISPOSABLE_RESTORE=1 for an isolated restore" >&2
  exit 65
}
[[ "${PGUSER:-}" == "migration_owner" ]] || {
  echo "PGUSER must be migration_owner" >&2
  exit 65
}
: "${PGHOST:?PGHOST is required}"
: "${PGPORT:?PGPORT is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGPASSFILE:?PGPASSFILE is required}"
[[ "$PGDATABASE" == cps_novel_restore_* ]] || {
  echo "Restore target must start with cps_novel_restore_" >&2
  exit 65
}
[[ -r "$PGPASSFILE" ]] || { echo "PGPASSFILE is not readable" >&2; exit 66; }
[[ -z "${PGPASSWORD:-}" ]] || { echo "Use PGPASSFILE; PGPASSWORD is rejected" >&2; exit 65; }

table_count="$(psql --no-psqlrc --tuples-only --no-align --command="
  SELECT count(*) FROM pg_tables
  WHERE schemaname NOT IN ('pg_catalog', 'information_schema');
" | tr -d '[:space:]')"
[[ "$table_count" == "0" ]] || {
  echo "Restore target is not empty" >&2
  exit 65
}

pg_restore \
  --exit-on-error \
  --single-transaction \
  --no-owner \
  --no-acl \
  --dbname="$PGDATABASE" \
  "$archive"

psql --no-psqlrc --file="$project_root/infra/postgres/grants.sql" >/dev/null
echo "LOGICAL_RESTORE=PASS"
