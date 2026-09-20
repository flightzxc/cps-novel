#!/usr/bin/env bash
set -euo pipefail
set +x

usage() {
  echo "usage: account-transfer.sh export|import --file /absolute/file [--two-factor preserve|reenroll]" >&2
  exit 64
}
action="${1:-}"; shift || true
file=""; two_factor=""
while (($#)); do
  case "$1" in
    --file) file="${2:-}"; shift 2 ;;
    --two-factor) two_factor="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done
[[ "$action" == "export" || "$action" == "import" ]] || usage
[[ "$file" = /* ]] || usage
[[ "$two_factor" == "preserve" || "$two_factor" == "reenroll" ]] || usage
: "${PGHOST:?PGHOST is required}" "${PGPORT:?PGPORT is required}" "${PGDATABASE:?PGDATABASE is required}" "${PGUSER:?PGUSER is required}" "${PGPASSFILE:?PGPASSFILE is required}"
[[ -r "$PGPASSFILE" && -z "${PGPASSWORD:-}" ]] || { echo "ACCOUNT_TRANSFER=FAIL"; exit 66; }

tables=(admin_identity)
if [[ "$two_factor" == "preserve" ]]; then
  [[ "${SOURCE_TOTP_KEY_FINGERPRINT:-}" =~ ^[0-9a-f]{64}$ && "${TARGET_TOTP_KEY_FINGERPRINT:-}" == "$SOURCE_TOTP_KEY_FINGERPRINT" ]] || {
    echo "ACCOUNT_TRANSFER=REFUSED reason=totp_key_identity_mismatch"; exit 65;
  }
  tables+=(admin_two_factor admin_recovery_code)
fi

if [[ "$action" == "export" ]]; then
  [[ ! -e "$file" ]] || { echo "ACCOUNT_TRANSFER=REFUSED reason=output_exists"; exit 73; }
  args=(--format=custom --compress=gzip:6 --data-only --no-owner --no-acl)
  for table in "${tables[@]}"; do args+=(--table="$table"); done
  umask 077
  pg_dump "${args[@]}" --file="$file"
  pg_restore --list "$file" >/dev/null
  echo "ACCOUNT_TRANSFER_EXPORT=PASS"
else
  [[ -r "$file" ]] || { echo "ACCOUNT_TRANSFER=FAIL"; exit 66; }
  pg_restore --exit-on-error --single-transaction --data-only --no-owner --no-acl \
    --dbname="$PGDATABASE" "$file"
  # Password hashes are portable because current auth verifies the complete
  # self-describing scrypt$v1$N$r$p$salt$hash string stored in each row.
  invalid="$(psql --no-psqlrc -Atqc \"SELECT count(*) FROM admin_identity WHERE password_hash !~ '^scrypt\\\\$v1\\\\$[0-9]+\\\\$[0-9]+\\\\$[0-9]+\\\\$[^$]+\\\\$[^$]+$'\")"
  [[ "$invalid" == "0" ]] || { echo "ACCOUNT_TRANSFER=FAIL reason=password_hash_contract"; exit 65; }
  if [[ "$two_factor" == "reenroll" ]]; then
    echo "ACCOUNT_TRANSFER_IMPORT=PASS two_factor=REENROLL_REQUIRED enforcement=UNCHANGED"
  else
    echo "ACCOUNT_TRANSFER_IMPORT=PASS two_factor=PRESERVED"
  fi
fi
