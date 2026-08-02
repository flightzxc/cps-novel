#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: backup-logical.sh --output /absolute/path/database.dump" >&2
  exit 64
}

output=""
while (($#)); do
  case "$1" in
    --output)
      (($# >= 2)) || usage
      output="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

[[ "$output" = /* ]] || usage
[[ "${PGUSER:-}" == "backup_role" ]] || {
  echo "PGUSER must be backup_role" >&2
  exit 65
}
: "${PGHOST:?PGHOST is required}"
: "${PGPORT:?PGPORT is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGPASSFILE:?PGPASSFILE is required}"
[[ -r "$PGPASSFILE" ]] || { echo "PGPASSFILE is not readable" >&2; exit 66; }
[[ -z "${PGPASSWORD:-}" ]] || { echo "Use PGPASSFILE; PGPASSWORD is rejected" >&2; exit 65; }
[[ ! -e "$output" && ! -e "${output}.sha256" && ! -e "${output}.metadata" ]] || {
  echo "Refusing to overwrite an existing backup artifact" >&2
  exit 73
}

umask 077
mkdir -p "$(dirname "$output")"

pg_dump \
  --format=custom \
  --compress=gzip:6 \
  --no-owner \
  --no-acl \
  --file="$output"
pg_restore --list "$output" >/dev/null

if command -v sha256sum >/dev/null 2>&1; then
  checksum="$(sha256sum "$output" | awk '{print $1}')"
else
  checksum="$(shasum -a 256 "$output" | awk '{print $1}')"
fi
printf '%s  %s\n' "$checksum" "$(basename "$output")" >"${output}.sha256"

server_version="$(psql --no-psqlrc --tuples-only --no-align --command='SHOW server_version' | tr -d '\r')"
dump_version="$(pg_dump --version | tr -d '\r')"
size_bytes="$(wc -c <"$output" | tr -d ' ')"
created_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
printf 'created_at=%s\ndatabase=%s\nserver_version=%s\npg_dump_version=%s\nsize_bytes=%s\nsha256=%s\n' \
  "$created_at" "$PGDATABASE" "$server_version" "$dump_version" "$size_bytes" "$checksum" \
  >"${output}.metadata"

echo "LOGICAL_BACKUP=PASS"
echo "BACKUP_ARCHIVE=$output"
