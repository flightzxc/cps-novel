#!/usr/bin/env bash
set -euo pipefail
set +x

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$-$RANDOM"
database_run_id="$(date +%H%M%S)-$$-$RANDOM"
container_name="cps-novel-p1-13-pg16-${run_id}"
volume_name="cps-novel-p1-13-pgdata-${run_id}"
network_name="cps-novel-p1-13-net-${run_id}"
database_name="p1_05b_p1_06_p1_07_p1_08b_p1_13_${database_run_id//-/_}"
shadow_database_name="${database_name}_shadow"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-p1-13-secrets.XXXXXX")"
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
    printf 'P1_13_POSTGRES_CLEANUP=PASS\n'
  else
    printf 'P1_13_POSTGRES_CLEANUP=FAIL\n' >&2
  fi
}
trap cleanup EXIT INT TERM
trap 'status=$?; printf "P1_13_POSTGRES_ERROR line=%s status=%s\n" "$LINENO" "$status" >&2; exit "$status"' ERR

umask 077
bootstrap_password="$(openssl rand -hex 24)"
migration_password="$(openssl rand -hex 24)"
web_password="$(openssl rand -hex 24)"
worker_password="$(openssl rand -hex 24)"
scheduler_password="$(openssl rand -hex 24)"
analyst_password="$(openssl rand -hex 24)"
backup_password="$(openssl rand -hex 24)"
credential_encryption_key="$(openssl rand -base64 32)"
credential_fingerprint_key="$(openssl rand -base64 32)"

printf '%s' "$bootstrap_password" >"$secret_dir/bootstrap-password"
for role_password in \
  "migration_owner:${migration_password}" \
  "web_app:${web_password}" \
  "worker_app:${worker_password}" \
  "scheduler_app:${scheduler_password}" \
  "analyst_ro:${analyst_password}" \
  "backup_role:${backup_password}"; do
  role_name="${role_password%%:*}"
  password="${role_password#*:}"
  printf "ALTER ROLE %s PASSWORD '%s';\n" "$role_name" "$password" >>"$secret_dir/role-passwords.sql"
done
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
  --mount "type=bind,src=${project_root},dst=/workspace,readonly" \
  --mount "type=bind,src=${secret_dir},dst=/run/p113-secrets,readonly" \
  -e POSTGRES_USER=p113_admin \
  -e POSTGRES_PASSWORD_FILE=/run/p113-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U p113_admin -d postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$container_name" pg_isready -U p113_admin -d postgres >/dev/null
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

docker exec -i "$container_name" psql --no-psqlrc -U p113_admin -d postgres \
  <infra/postgres/roles.sql >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -U p113_admin -d postgres \
  <"$secret_dir/role-passwords.sql" >/dev/null
docker exec "$container_name" createdb -U p113_admin -O migration_owner "$database_name"
docker exec "$container_name" createdb -U p113_admin -O migration_owner "$shadow_database_name"

owner_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
shadow_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${shadow_database_name}?schema=public"
web_url="postgresql://web_app:${web_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
worker_url="postgresql://worker_app:${worker_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
scheduler_url="postgresql://scheduler_app:${scheduler_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
analyst_url="postgresql://analyst_ro:${analyst_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
backup_url="postgresql://backup_role:${backup_password}@127.0.0.1:${host_port}/${database_name}?schema=public"

DATABASE_URL="$owner_url" npx prisma validate
DATABASE_URL="$owner_url" npx prisma generate
DATABASE_URL="$owner_url" npx prisma migrate deploy
DATABASE_URL="$owner_url" npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$shadow_url" \
  --exit-code
docker exec -i "$container_name" psql --no-psqlrc -U p113_admin -d "$database_name" \
  <infra/postgres/grants.sql >/dev/null

export DATABASE_URL="$owner_url"
export P1_05B_DATABASE_TEST=1
export P1_06_DATABASE_TEST=1
export P1_06_OWNER_DATABASE_URL="$owner_url"
export P1_06_WEB_DATABASE_URL="$web_url"
export P1_06_WORKER_DATABASE_URL="$worker_url"
export P1_06_ANALYST_DATABASE_URL="$analyst_url"
export P1_06_BACKUP_DATABASE_URL="$backup_url"
export P1_07_DATABASE_TEST=1
export P1_08B_DATABASE_TEST=1
export P1_08B_OWNER_DATABASE_URL="$owner_url"
export P1_08B_WEB_DATABASE_URL="$web_url"
export P1_08B_WORKER_DATABASE_URL="$worker_url"
export P1_08B_SCHEDULER_DATABASE_URL="$scheduler_url"
export P1_08B_ANALYST_DATABASE_URL="$analyst_url"
export P1_13_DATABASE_TEST=1
export CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1="$credential_encryption_key"
export CHANNEL_CREDENTIAL_FINGERPRINT_KEY="$credential_fingerprint_key"

server_version="$(docker exec "$container_name" psql --no-psqlrc -U p113_admin -d "$database_name" -Atc "SHOW server_version")"
printf 'POSTGRES_VERSION=%s\n' "$server_version"
printf 'TEST_DB_ISOLATION=UNIQUE_DATABASE_PER_RUN\n'

npm run test:integration -- --no-file-parallelism
printf 'INTEGRATION_TESTS=PASS\n'
npm run build
printf 'BUILD=PASS\n'
npm run typecheck
printf 'TYPECHECK=PASS\n'
npm run lint
printf 'LINT=PASS\n'
npm run test:backend
printf 'BACKEND_TESTS=PASS\n'
npm test -- --no-file-parallelism
printf 'FULL_TESTS=PASS\n'
printf 'PG_GATED_TESTS=PASS\n'
