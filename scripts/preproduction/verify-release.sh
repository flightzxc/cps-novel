#!/usr/bin/env bash
set -euo pipefail
set +x

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/preproduction/lib.sh
source "$root/scripts/preproduction/lib.sh"
preprod_load_env
: "${PREPROD_CURL_CONFIG:?PREPROD_CURL_CONFIG is required}"
: "${PREPROD_ADMIN_USERNAME:?PREPROD_ADMIN_USERNAME is required}"
: "${PREPROD_ADMIN_PASSWORD_FILE:?PREPROD_ADMIN_PASSWORD_FILE is required}"
[[ -r "$PREPROD_CURL_CONFIG" && -r "$PREPROD_ADMIN_PASSWORD_FILE" ]] || { echo "RELEASE_VERIFY=FAIL"; exit 66; }

for url in \
  https://www.bangbangji.cloud/ \
  https://www.bangbangji.cloud/api/health \
  https://www.bangbangji.cloud/robots.txt \
  https://www.bangbangji.cloud/sitemap.xml \
  https://zbcwf.bangbangji.cloud/login; do
  code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "$url")"
  [[ "$code" == "401" || "$code" == "404" ]] || { echo "RELEASE_VERIFY=FAIL reason=anonymous_access"; exit 65; }
done

health="$(curl --silent --show-error --fail --config "$PREPROD_CURL_CONFIG" https://www.bangbangji.cloud/api/health)"
node -e '
  const h=JSON.parse(process.argv[1]); const expected=process.argv[2];
  if (!h.ok || h.build?.commit !== expected || h.database?.status !== "passed") process.exit(1);
' "$health" "$GIT_COMMIT" || { echo "RELEASE_VERIFY=FAIL reason=health_identity_db"; exit 65; }

"$root/scripts/preproduction/database.sh" persistent-check >/dev/null
preprod_compose run --rm --no-deps \
  -e DATABASE_URL="$P1_12_WEB_DATABASE_URL" \
  -e PREPROD_ADMIN_USERNAME="$PREPROD_ADMIN_USERNAME" \
  -e PREPROD_ADMIN_PASSWORD_FILE=/run/preprod-admin/password \
  -e TOTP_ENCRYPTION_KEY_FILE=/run/secrets/totp_encryption_key \
  -v "$PREPROD_ADMIN_PASSWORD_FILE:/run/preprod-admin/password:ro" \
  web tsx scripts/preproduction/verify-admin-auth.ts >/dev/null
echo "RELEASE_VERIFY=PASS"
