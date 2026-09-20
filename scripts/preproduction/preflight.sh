#!/usr/bin/env bash
set -euo pipefail
set +x

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${PREPROD_ENV_FILE:=/opt/cps-novel/shared/env/preprod.env}"
[[ "$PREPROD_ENV_FILE" = /* && -r "$PREPROD_ENV_FILE" ]] || {
  echo "PREPROD_PREFLIGHT=FAIL reason=env_file"; exit 66;
}
set -a
# shellcheck disable=SC1090
source "$PREPROD_ENV_FILE"
set +a

fail() { echo "PREPROD_PREFLIGHT=FAIL reason=$1"; exit "${2:-65}"; }
[[ "${P1_12_COMPOSE_PROJECT:-}" == "cps-novel" ]] || fail compose_project
[[ "${SITE_URL:-}" == "https://www.bangbangji.cloud" ]] || fail site_url
[[ "${ADMIN_CANONICAL_ORIGIN:-}" == "https://zbcwf.bangbangji.cloud" ]] || fail admin_origin
[[ "${PUBLIC_TRACKING_WRITE_DISABLED:-}" == "1" ]] || fail tracking_write_gate
[[ "${ADMIN_TWO_FACTOR_ENFORCEMENT:-}" == "true" ]] || fail two_factor_enforcement
[[ "${FEATURE_INDEXNOW_OUTBOX:-}" == "false" && "${INDEXNOW_OUTBOX_ALLOW_WRITE:-}" == "false" ]] || fail indexnow_outbox
[[ "${FEATURE_INDEXNOW_DELIVERY:-}" == "false" && "${INDEXNOW_DELIVERY_ALLOW_WRITE:-}" == "false" ]] || fail indexnow_delivery
[[ "${FEATURE_NOVEL_CATALOG_SYNC:-}" == "false" && "${NOVEL_CATALOG_SYNC_ALLOW_WRITE:-}" == "false" ]] || fail catalog_write
[[ "${FEATURE_PROMO_LINK_CLAIM:-}" == "false" && "${PROMO_LINK_CLAIM_ALLOW_WRITE:-}" == "false" ]] || fail promo_write
[[ "${FEATURE_NOVEL_TAG_AUTO:-}" == "false" && "${AUTO_WRITE_AUTHORIZED:-}" == "NO" ]] || fail auto_tagging
[[ "${ARTICLE_BLOG_ALLOW_WRITE:-}" == "false" && "${ARTICLE_NOVEL_REBIND_ALLOW_WRITE:-}" == "false" ]] || fail article_writes
[[ "${GIT_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || fail git_commit
[[ "${CPS_NOVEL_APP_IMAGE:-}" =~ @sha256:[0-9a-f]{64}$ ]] || fail immutable_image
[[ -z "${EXPECTED_RELEASE_COMMIT:-}" || "$GIT_COMMIT" == "$EXPECTED_RELEASE_COMMIT" ]] || fail release_commit_mismatch
[[ -z "${EXPECTED_RELEASE_IMAGE:-}" || "$CPS_NOVEL_APP_IMAGE" == "$EXPECTED_RELEASE_IMAGE" ]] || fail release_image_mismatch

drain="${WORKER_SHUTDOWN_DRAIN_TIMEOUT_MS:-30000}"
grace="${WORKER_STOP_GRACE_PERIOD:-45s}"
[[ "$drain" =~ ^[1-9][0-9]*$ && "$grace" =~ ^[1-9][0-9]*s$ ]] || fail worker_shutdown_format
grace_ms=$((10#${grace%s} * 1000))
(( grace_ms >= drain + 10000 )) || fail worker_shutdown_margin

"$root/scripts/preproduction/secrets-preflight.sh"
docker compose --env-file "$PREPROD_ENV_FILE" -p cps-novel \
  -f "$root/docker-compose.yml" -f "$root/infra/preproduction/docker-compose.yml" \
  config --quiet || fail compose_config
echo "PREPROD_PREFLIGHT=PASS"
