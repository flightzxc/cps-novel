#!/usr/bin/env bash
set -euo pipefail
set +x

# Phase B entity-fix -- disposable Postgres verification for
# `tests/integration/entity-fix/moboreader-foundation-swap.test.ts`
# (施工工单_PhaseB_实体订正与运营表单Parity_2026-09-06.md §二).
#
# Follows the exact same disposable-container discipline as
# `scripts/p1-13-postgres-verification.sh`: a brand-new, uniquely-named
# container/volume/network, `infra/postgres/roles.sql` + `grants.sql` to
# provision the same least-privilege roles the real schema expects, a
# random host port (`-p 127.0.0.1::5432`, resolved after the container
# starts -- never a fixed port squatting on something else already
# running), and a full teardown on exit. This NEVER touches
# `cps-novel-x8-local` or any other already-running stack -- see the
# module doc on `applyFoundationSwap`/`rollbackFoundationSwap` in
# `scripts/entity-fix/moboreader-foundation-swap.ts` for why that boundary
# matters for this specific script.

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$-$RANDOM"
container_name="cps-novel-phase-b-entity-fix-pg16-${run_id}"
volume_name="cps-novel-phase-b-entity-fix-pgdata-${run_id}"
network_name="cps-novel-phase-b-entity-fix-net-${run_id}"
database_name="phase_b_entity_fix_${run_id//[-.]/_}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-phase-b-entity-fix-secrets.XXXXXX")"
cleanup_ran=no

cleanup() {
  set +e
  [[ "$cleanup_ran" == no ]] || return 0
  cleanup_ran=yes
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  docker volume rm "$volume_name" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
  rm -rf "$secret_dir"
  if ! docker ps -a --format '{{.Names}}' | grep -Fx "$container_name" >/dev/null 2>&1 \
    && ! docker volume ls --format '{{.Name}}' | grep -Fx "$volume_name" >/dev/null 2>&1 \
    && ! docker network ls --format '{{.Name}}' | grep -Fx "$network_name" >/dev/null 2>&1; then
    printf 'PHASE_B_ENTITY_FIX_POSTGRES_CLEANUP=PASS\n'
  else
    printf 'PHASE_B_ENTITY_FIX_POSTGRES_CLEANUP=FAIL\n' >&2
  fi
}
trap cleanup EXIT INT TERM
trap 'status=$?; printf "PHASE_B_ENTITY_FIX_POSTGRES_ERROR line=%s status=%s\n" "$LINENO" "$status" >&2; exit "$status"' ERR

umask 077
bootstrap_password="$(openssl rand -hex 24)"
migration_password="$(openssl rand -hex 24)"

printf '%s' "$bootstrap_password" >"$secret_dir/bootstrap-password"
printf "ALTER ROLE migration_owner PASSWORD '%s';\n" "$migration_password" >"$secret_dir/role-passwords.sql"
chmod 600 "$secret_dir"/*

cd "$project_root"
if ! docker image inspect postgres:16.14 >/dev/null 2>&1; then
  docker pull postgres:16.14 >/dev/null
fi
docker network create "$network_name" >/dev/null
docker volume create "$volume_name" >/dev/null
docker run -d \
  --name "$container_name" \
  --network "$network_name" \
  --network-alias postgres \
  --mount "type=volume,src=${volume_name},dst=/var/lib/postgresql/data" \
  --mount "type=bind,src=${secret_dir},dst=/run/phase-b-secrets,readonly" \
  -e POSTGRES_USER=phase_b_admin \
  -e POSTGRES_PASSWORD_FILE=/run/phase-b-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U phase_b_admin -d postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$container_name" pg_isready -U phase_b_admin -d postgres >/dev/null
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

docker exec -i "$container_name" psql --no-psqlrc -U phase_b_admin -d postgres \
  <infra/postgres/roles.sql >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -U phase_b_admin -d postgres \
  <"$secret_dir/role-passwords.sql" >/dev/null
docker exec "$container_name" createdb -U phase_b_admin -O migration_owner "$database_name"

owner_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${database_name}?schema=public"

DATABASE_URL="$owner_url" npx prisma validate
DATABASE_URL="$owner_url" npx prisma generate
DATABASE_URL="$owner_url" npx prisma migrate deploy
docker exec -i "$container_name" psql --no-psqlrc -U phase_b_admin -d "$database_name" \
  <infra/postgres/grants.sql >/dev/null

export PHASE_B_ENTITY_FIX_DATABASE_TEST=1
export PHASE_B_ENTITY_FIX_DATABASE_URL="$owner_url"

server_version="$(docker exec "$container_name" psql --no-psqlrc -U phase_b_admin -d "$database_name" -Atc "SHOW server_version")"
printf 'POSTGRES_VERSION=%s\n' "$server_version"
printf 'TEST_DB_ISOLATION=UNIQUE_DATABASE_PER_RUN name=%s port=%s\n' "$database_name" "$host_port"

npx vitest run --project node tests/integration/entity-fix/moboreader-foundation-swap.test.ts --no-file-parallelism
printf 'PHASE_B_ENTITY_FIX_INTEGRATION_TESTS=PASS\n'
