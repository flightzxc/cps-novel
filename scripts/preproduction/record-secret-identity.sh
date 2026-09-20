#!/usr/bin/env bash
set -euo pipefail
set +x

[[ "${1:-}" == "--initialize" ]] || {
  echo "usage: record-secret-identity.sh --initialize" >&2
  exit 64
}
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
secret_root="${PREPROD_SECRET_ROOT:-/opt/cps-novel/shared/secrets}"
if [[ "$secret_root" != "/opt/cps-novel/shared/secrets" && "${PREPROD_TEST_MODE:-0}" != "1" ]]; then
  echo "SECRET_IDENTITY_RECORD=FAIL"
  exit 65
fi
manifest="$secret_root/secret-identity.sha256"
[[ ! -e "$manifest" ]] || { echo "SECRET_IDENTITY_RECORD=FAIL"; exit 73; }
umask 077
temporary="${manifest}.tmp.$$"
trap 'rm -f "$temporary"' EXIT INT TERM
(
  cd "$secret_root"
  while IFS= read -r name; do
    [[ -f "$name" && ! -L "$name" && -s "$name" ]] || exit 66
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum "$name"
    else
      shasum -a 256 "$name"
    fi
  done <"$root/scripts/preproduction/secret-identity-files.txt"
) >"$temporary" || { echo "SECRET_IDENTITY_RECORD=FAIL"; exit 66; }
mv "$temporary" "$manifest"
trap - EXIT INT TERM
echo "SECRET_IDENTITY_RECORD=PASS"
