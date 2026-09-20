#!/usr/bin/env bash
set -euo pipefail
set +x

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
secret_root="${PREPROD_SECRET_ROOT:-/opt/cps-novel/shared/secrets}"
host_only=0
[[ "${1:-}" != "--host-only" ]] || host_only=1
if [[ "$secret_root" != "/opt/cps-novel/shared/secrets" && "${PREPROD_TEST_MODE:-0}" != "1" ]]; then
  echo "SECRET_PREFLIGHT=FAIL"
  exit 65
fi

fail() { echo "SECRET_PREFLIGHT=FAIL"; exit "${1:-65}"; }
[[ -d "$secret_root" && ! -L "$secret_root" ]] || fail

files=()
while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  path="$secret_root/$name"
  [[ -f "$path" && ! -L "$path" && -s "$path" ]] || fail
  mode="$(stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path")"
  # No group write and no permissions for other users.
  (( (8#$mode & 0027) == 0 )) || fail
  files+=("$path")
done <"$root/scripts/preproduction/secret-files.txt"

manifest="$secret_root/secret-identity.sha256"
[[ -f "$manifest" && ! -L "$manifest" ]] || fail
(
  cd "$secret_root"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum --status -c secret-identity.sha256
  else
    shasum -a 256 -c secret-identity.sha256 >/dev/null
  fi
) || fail

if [[ "$host_only" == "0" ]]; then
  command -v docker >/dev/null 2>&1 || fail 69
  for path in "${files[@]}"; do
    docker run --rm --user 1001:1001 --mount "type=bind,src=$path,dst=/run/check,readonly" \
      alpine:3.20 test -r /run/check >/dev/null 2>&1 || fail 66
  done
fi
echo "SECRET_PREFLIGHT=PASS"
