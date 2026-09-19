#!/usr/bin/env bash
set -euo pipefail
set +x

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
failed=0
base_ref="${SECRET_SCAN_BASE_REF:-origin/integration/home-hero-pulsenovel}"
git rev-parse --verify "$base_ref^{commit}" >/dev/null 2>&1 || base_ref="HEAD^"
while IFS= read -r file; do
  [[ -f "$file" && "$file" != "scripts/preproduction/secret-scan.sh" ]] || continue
  while IFS= read -r matching_line; do
    [[ -n "$matching_line" ]] || continue
    # Committed examples may use only these explicit non-secret sentinels on
    # the same matching line; a placeholder elsewhere cannot mask a leak.
    if ! grep -Eiq 'REQUIRED|placeholder|example\.invalid|invalid' <<<"$matching_line"; then failed=1; fi
  done < <(grep -Ei -- \
    '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|authorization[[:space:]]*[:=][[:space:]]*bearer[[:space:]]+[A-Za-z0-9._~+/=-]{16,}|postgres(ql)?://[^:/[:space:]]+:[^@[:space:]]{8,}@' \
    "$file" || true)
done < <(
  {
    git diff --name-only --diff-filter=ACMRT "$base_ref" --
    git diff --name-only --diff-filter=ACMRT --
    git ls-files --others --exclude-standard
  } | sort -u
)
if [[ "$failed" == "1" ]]; then echo "SECRET_SCAN=FAIL"; exit 65; fi
echo "SECRET_SCAN=PASS"
