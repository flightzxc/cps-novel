#!/usr/bin/env bash
set -euo pipefail
set +x

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/preproduction/lib.sh
source "$root/scripts/preproduction/lib.sh"
preprod_load_env

# 🔴 MAJOR-1 fix: --anonymous-only runs a cheap subset (the state-aware
# anonymous matrix + admin-surface-404 checks + X-Robots-Tag assertions --
# every one of them unauthenticated) so release.sh/rollback() can call this
# a SECOND time, AFTER maintenance_off, to actually exercise the 401
# expectations for real. The original single call always runs while
# maintenance is still on (deploy()/rollback() call it between maintenance_on
# and maintenance_off), so the state-aware matrix below always took its
# "maintenance_on" branch in every real deploy -- the 401 assertions for /,
# /robots.txt, /sitemap.xml, and admin /login were dead code in the only
# automated path. This flag does not require PREPROD_CURL_CONFIG or admin
# credentials, and does not re-run the authenticated health/db check or the
# verify-admin-auth.ts one-off container -- those only need to run once per
# release and already did, successfully, in the full call made earlier in
# the same deploy()/rollback() invocation.
mode="full"
case "${1:-}" in
  "") mode="full" ;;
  --anonymous-only) mode="anonymous_only" ;;
  *) echo "usage: verify-release.sh [--anonymous-only]" >&2; exit 64 ;;
esac

shared="${PREPROD_SHARED_ROOT:-/opt/cps-novel/shared}"
maintenance_marker="$shared/maintenance/enabled"
# Must match infra/preproduction/maintenance/__preprod_maintenance.html.
# Checked literally so a generic nginx/upstream error page, or business
# content leaking through, cannot be mistaken for the real maintenance page.
maintenance_needle="<h1>Maintenance in progress</h1>"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-verify-release.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT INT TERM

# probe URL [AUTH]  -- sets $code, writes body to $tmp/body, headers to $tmp/headers.
probe() {
  local url="$1" auth="${2:-0}"
  local args=(--silent --show-error --output "$tmp/body" --dump-header "$tmp/headers" --write-out '%{http_code}')
  ((auth)) && args+=(--config "$PREPROD_CURL_CONFIG")
  code="$(curl "${args[@]}" "$url")"
}

assert_robots_tag() {
  grep -qi '^X-Robots-Tag: noindex, nofollow, noarchive' "$tmp/headers" || {
    echo "RELEASE_VERIFY=FAIL reason=missing_robots_tag url=$1"; exit 65;
  }
}

# --- State-aware anonymous matrix. Maintenance flips the expected code from
# 401 to 503 for business/login surfaces, but never to 200, and a 503 is
# only accepted when it is provably the real maintenance page (marker file
# present AND exact known body), not any other source of 503/502. Outside a
# maintenance window this is exactly as strict as the previous check (401
# only); during one, it additionally proves the maintenance response itself
# is correct, which the previous check could not do at all (it required
# 401|404 unconditionally and would fail during any maintenance window).
#
# Admin-only surfaces on the public host stay 404 regardless of maintenance
# state. Both blocks are anonymous-only (no --config, no credentials) and
# both are exactly what --anonymous-only mode runs. ---
run_anonymous_matrix() {
  local maintenance_on=0
  [[ -f "$maintenance_marker" ]] && maintenance_on=1

  local url
  for url in \
    https://www.bangbangji.cloud/ \
    https://www.bangbangji.cloud/robots.txt \
    https://www.bangbangji.cloud/sitemap.xml \
    https://zbcwf.bangbangji.cloud/login; do
    probe "$url"
    assert_robots_tag "$url"
    if ((maintenance_on)); then
      [[ "$code" == "503" ]] || {
        echo "RELEASE_VERIFY=FAIL reason=maintenance_expected_503 url=$url code=$code"; exit 65;
      }
      grep -qF "$maintenance_needle" "$tmp/body" || {
        echo "RELEASE_VERIFY=FAIL reason=maintenance_body_mismatch url=$url"; exit 65;
      }
    else
      [[ "$code" == "401" ]] || {
        echo "RELEASE_VERIFY=FAIL reason=anonymous_not_401 url=$url code=$code"; exit 65;
      }
    fi
  done

  for url in https://www.bangbangji.cloud/dashboard https://www.bangbangji.cloud/api/admin; do
    probe "$url"
    [[ "$code" == "404" ]] || {
      echo "RELEASE_VERIFY=FAIL reason=admin_surface_not_404 url=$url code=$code"; exit 65;
    }
    assert_robots_tag "$url"
  done
}

if [[ "$mode" == "anonymous_only" ]]; then
  run_anonymous_matrix
  echo "RELEASE_VERIFY=PASS mode=anonymous_only"
  exit 0
fi

: "${PREPROD_CURL_CONFIG:?PREPROD_CURL_CONFIG is required}"
: "${PREPROD_ADMIN_USERNAME:?PREPROD_ADMIN_USERNAME is required}"
: "${PREPROD_ADMIN_PASSWORD_FILE:?PREPROD_ADMIN_PASSWORD_FILE is required}"
[[ -r "$PREPROD_CURL_CONFIG" && -r "$PREPROD_ADMIN_PASSWORD_FILE" ]] || { echo "RELEASE_VERIFY=FAIL"; exit 66; }

# --- /api/health anonymous: must be exactly 401 on both hosts -- never 200
# (that would mean the health endpoint leaked past auth), never 503 (that
# would mean the maintenance gate is still swallowing it, which is the
# original bug this lane fixes). ---
for url in https://www.bangbangji.cloud/api/health https://zbcwf.bangbangji.cloud/api/health; do
  probe "$url"
  [[ "$code" == "401" ]] || {
    echo "RELEASE_VERIFY=FAIL reason=health_anonymous_not_401 url=$url code=$code"; exit 65;
  }
  assert_robots_tag "$url"
done

# --- /api/health authenticated: identity + database must be current, on
# both hosts (the admin host's health location was the very one carrying
# the prefix-match bug, so it is no longer enough to only check the public
# host here). ---
for url in https://www.bangbangji.cloud/api/health https://zbcwf.bangbangji.cloud/api/health; do
  health="$(curl --silent --show-error --fail --config "$PREPROD_CURL_CONFIG" "$url")" || {
    echo "RELEASE_VERIFY=FAIL reason=health_unreachable url=$url"; exit 65;
  }
  node -e '
    const h=JSON.parse(process.argv[1]); const expected=process.argv[2];
    if (!h.ok || h.build?.commit !== expected || h.database?.status !== "passed") process.exit(1);
  ' "$health" "$GIT_COMMIT" || {
    echo "RELEASE_VERIFY=FAIL reason=health_identity_db url=$url"; exit 65;
  }
done

run_anonymous_matrix

"$root/scripts/preproduction/database.sh" persistent-check >/dev/null
# 🔴 应用镜像入口:禁 pull、禁就地 build(见 lib.sh 的 preprod_compose_app_run)。
preprod_compose_app_run \
  -e DATABASE_URL="$P1_12_WEB_DATABASE_URL" \
  -e PREPROD_ADMIN_USERNAME="$PREPROD_ADMIN_USERNAME" \
  -e PREPROD_ADMIN_PASSWORD_FILE=/run/preprod-admin/password \
  -e TOTP_ENCRYPTION_KEY_FILE=/run/secrets/totp_encryption_key \
  -v "$PREPROD_ADMIN_PASSWORD_FILE:/run/preprod-admin/password:ro" \
  web tsx scripts/preproduction/verify-admin-auth.ts >/dev/null
echo "RELEASE_VERIFY=PASS"
