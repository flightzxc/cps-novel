#!/usr/bin/env bash
set -euo pipefail
set +x

project_root="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/p1-12-local-env.sh
source "$project_root/scripts/lib/p1-12-local-env.sh"
prepare_p1_12_local_environment

compose=(docker compose -p "$P1_12_COMPOSE_PROJECT" -f "$project_root/docker-compose.yml")

"${compose[@]}" config >/dev/null
if docker image inspect "$CPS_NOVEL_APP_IMAGE" >/dev/null 2>&1; then
  image_identity="$(docker image inspect "$CPS_NOVEL_APP_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.version"}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "org.opencontainers.image.created"}}')"
  [[ "$image_identity" == "$APP_VERSION|$GIT_COMMIT|$BUILD_DATE" ]] || {
    echo "ERROR: existing exact image tag has mismatched immutable metadata: $CPS_NOVEL_APP_IMAGE" >&2
    exit 1
  }
else
  "${compose[@]}" build
fi
"${compose[@]}" up -d postgres

postgres_ready=no
for _ in $(seq 1 60); do
  if "${compose[@]}" exec -T postgres pg_isready -U postgres -d cps_novel >/dev/null 2>&1; then
    postgres_ready=yes
    break
  fi
  sleep 1
done
[[ "$postgres_ready" == "yes" ]] || { echo "ERROR: PostgreSQL did not become ready" >&2; exit 1; }

for role in migration_owner web_app worker_app scheduler_app analyst_ro backup_role; do
  "${compose[@]}" exec -T postgres psql --no-psqlrc -U postgres -d cps_novel \
    --tuples-only --no-align --command="SELECT 1 FROM pg_roles WHERE rolname='${role}'" \
    | grep -Fx 1 >/dev/null || {
      echo "ERROR: required P1-06 role is missing from the persisted PostgreSQL volume: $role" >&2
      exit 1
    }
done

migration_env="$(mktemp "${TMPDIR:-/tmp}/cps-novel-p1-12-migrate.XXXXXX")"
cleanup() {
  rm -f "$migration_env"
}
trap cleanup EXIT INT TERM
chmod 600 "$migration_env"
printf 'DATABASE_URL=%s\n' "$P1_12_MIGRATION_DATABASE_URL" >"$migration_env"

docker run --rm --pull never \
  --network "${P1_12_COMPOSE_PROJECT}_network" \
  --env-file "$migration_env" \
  --entrypoint npx \
  "$CPS_NOVEL_APP_IMAGE" \
  --no-install prisma migrate deploy

"${compose[@]}" exec -T postgres psql --no-psqlrc -U migration_owner -d cps_novel \
  <"$project_root/infra/postgres/grants.sql" >/dev/null

"${compose[@]}" up -d web worker scheduler

echo "P1_12_COMPOSE_STARTED=PASS"
echo "P1_12_COMPOSE_PROJECT=$P1_12_COMPOSE_PROJECT"
echo "CPS_NOVEL_APP_IMAGE=$CPS_NOVEL_APP_IMAGE"
