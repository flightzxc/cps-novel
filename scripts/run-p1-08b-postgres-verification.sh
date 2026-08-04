#!/usr/bin/env bash
set -euo pipefail
set +x

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$"
container_name="cps-novel-p1-08b-pg16-${run_id}"
volume_name="cps-novel-p1-08b-pgdata-${run_id}"
database_name="cps_novel_p1_06_p1_07_p1_08b_${run_id//-/_}"
shadow_database_name="${database_name}_shadow"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-p1-08b-secrets.XXXXXX")"
cleanup_complete="no"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  docker volume rm "$volume_name" >/dev/null 2>&1 || true
  rm -rf "$secret_dir"
  if ! docker ps -a --format '{{.Names}}' | grep -Fx "$container_name" >/dev/null 2>&1 \
    && ! docker volume ls --format '{{.Name}}' | grep -Fx "$volume_name" >/dev/null 2>&1; then
    cleanup_complete="yes"
  fi
  echo "DISPOSABLE_DATABASE_CLEANED=${cleanup_complete}"
}
trap cleanup EXIT INT TERM

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
docker volume create "$volume_name" >/dev/null
docker run -d \
  --name "$container_name" \
  --mount "type=volume,src=${volume_name},dst=/var/lib/postgresql/data" \
  --mount "type=bind,src=${project_root},dst=/workspace,readonly" \
  --mount "type=bind,src=${secret_dir},dst=/run/p108b-secrets,readonly" \
  -e POSTGRES_USER=p108b_admin \
  -e POSTGRES_PASSWORD_FILE=/run/p108b-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U p108b_admin -d postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$container_name" pg_isready -U p108b_admin -d postgres >/dev/null
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

docker exec -i "$container_name" psql --no-psqlrc -U p108b_admin -d postgres <infra/postgres/roles.sql >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -U p108b_admin -d postgres <"$secret_dir/role-passwords.sql" >/dev/null
docker exec "$container_name" createdb -U p108b_admin -O migration_owner "$database_name"
docker exec "$container_name" createdb -U p108b_admin -O migration_owner "$shadow_database_name"

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
reapply_output="$(DATABASE_URL="$owner_url" npx prisma migrate deploy)"
echo "$reapply_output"
echo "$reapply_output" | grep -F "No pending migrations to apply." >/dev/null
DATABASE_URL="$owner_url" npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$shadow_url" \
  --exit-code
DATABASE_URL="$owner_url" npx prisma migrate diff \
  --from-url "$owner_url" \
  --to-schema-datamodel prisma/schema.prisma \
  --exit-code

docker exec -i "$container_name" psql --no-psqlrc -U p108b_admin -d "$database_name" <infra/postgres/grants.sql >/dev/null
DATABASE_URL="$owner_url" node scripts/check-database-dictionary-drift.mjs

P1_06_DATABASE_TEST=1 \
P1_06_OWNER_DATABASE_URL="$owner_url" \
P1_06_WEB_DATABASE_URL="$web_url" \
P1_06_WORKER_DATABASE_URL="$worker_url" \
P1_06_ANALYST_DATABASE_URL="$analyst_url" \
P1_06_BACKUP_DATABASE_URL="$backup_url" \
npx vitest run --project node tests/integration/database/p1-06-postgres.test.ts

P1_07_DATABASE_TEST=1 DATABASE_URL="$owner_url" \
npx vitest run --project node tests/integration/tasks/p1-07-postgres.test.ts

P1_08B_DATABASE_TEST=1 \
P1_08B_OWNER_DATABASE_URL="$owner_url" \
P1_08B_WEB_DATABASE_URL="$web_url" \
P1_08B_WORKER_DATABASE_URL="$worker_url" \
P1_08B_SCHEDULER_DATABASE_URL="$scheduler_url" \
P1_08B_ANALYST_DATABASE_URL="$analyst_url" \
npx vitest run --project node tests/integration/auth/p1-08b-postgres-auth.test.ts

P1_08B_DATABASE_TEST=1 \
P1_08B_OWNER_DATABASE_URL="$owner_url" \
P1_08B_WORKER_DATABASE_URL="$worker_url" \
CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1="$credential_encryption_key" \
CHANNEL_CREDENTIAL_FINGERPRINT_KEY="$credential_fingerprint_key" \
npx vitest run --project node tests/integration/credentials/p1-08b-credential-worker.test.ts

server_version="$(docker exec "$container_name" psql -U p108b_admin -d "$database_name" -Atc "SHOW server_version")"
[[ "$server_version" == 16.14* ]]
echo "POSTGRES_VERSION=${server_version}"
echo "MIGRATION_DEPLOY=PASS"
echo "MIGRATION_REAPPLY=PASS"
echo "SCHEMA_DIFF=PASS"
echo "P1_06_REGRESSION=PASS"
echo "P1_07_REGRESSION=PASS"
echo "P1_08B_POSTGRES_VERIFICATION=PASS"
