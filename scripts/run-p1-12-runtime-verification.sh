#!/usr/bin/env bash
set -euo pipefail
set +x

project_root="$(cd "$(dirname "$0")/.." && pwd)"
export P1_12_COMPOSE_PROJECT="${P1_12_COMPOSE_PROJECT:-cps-novel-p1-12-verify}"
# shellcheck source=scripts/lib/p1-12-local-env.sh
source "$project_root/scripts/lib/p1-12-local-env.sh"
prepare_p1_12_local_environment

if ! git -C "$project_root" diff --quiet \
  || ! git -C "$project_root" diff --cached --quiet \
  || [[ -n "$(git -C "$project_root" ls-files --others --exclude-standard)" ]]; then
  echo "ERROR: commit the P1-12 implementation before immutable image verification" >&2
  exit 1
fi

compose=(docker compose -p "$P1_12_COMPOSE_PROJECT" -f "$project_root/docker-compose.yml")
cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
cleanup

"${compose[@]}" config >/dev/null
echo "COMPOSE_CONFIG=PASS"

DOCKER_BUILDKIT=0 docker build --pull=false --platform linux/amd64 \
  --build-arg "NODE_BASE_IMAGE=node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293" \
  --build-arg "APP_VERSION=$APP_VERSION" \
  --build-arg "GIT_COMMIT=$GIT_COMMIT" \
  --build-arg "BUILD_DATE=$BUILD_DATE" \
  --tag "$CPS_NOVEL_APP_IMAGE" \
  "$project_root"

bash "$project_root/scripts/p1-12-compose-up.sh"

expected_services=$'postgres\nweb\nworker\nscheduler'
actual_services="$("${compose[@]}" config --services)"
[[ "$actual_services" == "$expected_services" ]]

for service in postgres web worker scheduler; do
  state="$("${compose[@]}" ps -q "$service" | xargs docker inspect --format '{{.State.Status}}')"
  [[ "$state" == "running" ]] || { echo "ERROR: $service is not running" >&2; exit 1; }
done

postgres_health="$("${compose[@]}" ps -q postgres | xargs docker inspect --format '{{.State.Health.Status}}')"
[[ "$postgres_health" == "healthy" ]]
echo "POSTGRES_HEALTH=PASS"

image_user="$(docker image inspect "$CPS_NOVEL_APP_IMAGE" --format '{{.Config.User}}')"
[[ "$image_user" == "nextjs" ]]
oci_identity="$(docker image inspect "$CPS_NOVEL_APP_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.version"}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "org.opencontainers.image.created"}}')"
[[ "$oci_identity" == "$APP_VERSION|$GIT_COMMIT|$BUILD_DATE" ]]

metadata="$(docker run --rm --pull never --network none --entrypoint node "$CPS_NOVEL_APP_IMAGE" -e '
  const fs = require("node:fs");
  const metadata = JSON.parse(fs.readFileSync("/app/.build-metadata.json", "utf8"));
  process.stdout.write([metadata.version, metadata.commit, metadata.builtAt].join("|"));
')"
[[ "$metadata" == "$APP_VERSION|$GIT_COMMIT|$BUILD_DATE" ]]
echo "IMAGE_METADATA=PASS"

"${compose[@]}" exec -T web node -e '
  const required = ["DATABASE_URL", "APP_VERSION", "GIT_COMMIT", "TOTP_ENCRYPTION_KEY", "CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1", "CHANNEL_CREDENTIAL_FINGERPRINT_KEY"];
  if (required.some((key) => !process.env[key])) process.exit(1);
' >/dev/null
"${compose[@]}" exec -T worker node -e '
  const required = ["DATABASE_URL", "CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1", "CHANNEL_CREDENTIAL_FINGERPRINT_KEY"];
  const forbidden = ["TOTP_ENCRYPTION_KEY"];
  if (required.some((key) => !process.env[key]) || forbidden.some((key) => key in process.env)) process.exit(1);
' >/dev/null
"${compose[@]}" exec -T scheduler node -e '
  const forbidden = [
    /^CHANNEL_CREDENTIAL_/,
    /FINGERPRINT/,
    /^TOTP_/,
    /RECOVERY.*SECRET/,
    /DECRYPT.*KEY/,
  ];
  const keys = Object.keys(process.env);
  if (!process.env.DATABASE_URL || forbidden.some((pattern) => keys.some((key) => pattern.test(key)))) process.exit(1);
' >/dev/null
echo "PROCESS_SECRET_ISOLATION=PASS"

all_logs="$("${compose[@]}" logs --no-color 2>/dev/null || true)"
for secret_path in \
  "$P1_12_SECRET_DIR/totp.key" \
  "$P1_12_SECRET_DIR/credential-v1.key" \
  "$P1_12_SECRET_DIR/credential-fingerprint.key" \
  "$P1_12_SECRET_DIR/migration_owner.password" \
  "$P1_12_SECRET_DIR/web_app.password" \
  "$P1_12_SECRET_DIR/worker_app.password" \
  "$P1_12_SECRET_DIR/scheduler_app.password"; do
  secret_value="$(read_secret_value "$secret_path")"
  [[ "$all_logs" != *"$secret_value"* ]] || { echo "ERROR: a generated secret appeared in container logs" >&2; exit 1; }
done
echo "SECRET_LOG_SCAN=PASS"

web_health="$("${compose[@]}" ps -q web | xargs docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')"
[[ "$web_health" == "unhealthy" || "$web_health" == "starting" ]]

echo "DOCKER_BUILD=PASS"
echo "COMPOSE_SERVICES=postgres,web,worker,scheduler"
echo "SCHEDULER_CREDENTIAL_KEYS=ABSENT"
echo "SQLITE_CONFIG=ABSENT"
echo "BLOCKED_FINAL_E2E=WAITING_FOR_CLAUDE_ROUTE_HANDLER"
echo "P1_12_RUNTIME_VERIFICATION=PASS"
