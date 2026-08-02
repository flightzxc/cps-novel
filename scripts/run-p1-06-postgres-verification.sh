#!/usr/bin/env bash
set -euo pipefail
set +x

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$"
container_name="cps-novel-p1-06-pg16-${run_id}"
volume_name="cps-novel-p1-06-pgdata-${run_id}"
source_database="cps_novel_p1_06_${run_id//-/_}"
restore_database="cps_novel_restore_${run_id//-/_}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-p1-06-secrets.XXXXXX")"
artifact_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-p1-06-artifacts.XXXXXX")"
cleanup_complete="no"
cleanup_ran="no"

cleanup() {
  [[ "$cleanup_ran" == "no" ]] || return 0
  cleanup_ran="yes"
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  docker volume rm "$volume_name" >/dev/null 2>&1 || true
  rm -rf "$secret_dir" "$artifact_dir"
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
analyst_password="$(openssl rand -hex 24)"
backup_password="$(openssl rand -hex 24)"
printf '%s' "$bootstrap_password" >"$secret_dir/bootstrap-password"
printf "ALTER ROLE migration_owner PASSWORD '%s';\n" "$migration_password" >"$secret_dir/role-passwords.sql"
printf "ALTER ROLE web_app PASSWORD '%s';\n" "$web_password" >>"$secret_dir/role-passwords.sql"
printf "ALTER ROLE worker_app PASSWORD '%s';\n" "$worker_password" >>"$secret_dir/role-passwords.sql"
printf "ALTER ROLE analyst_ro PASSWORD '%s';\n" "$analyst_password" >>"$secret_dir/role-passwords.sql"
printf "ALTER ROLE backup_role PASSWORD '%s';\n" "$backup_password" >>"$secret_dir/role-passwords.sql"
printf '127.0.0.1:5432:*:migration_owner:%s\n' "$migration_password" >"$secret_dir/pgpass-container"
printf '127.0.0.1:5432:*:web_app:%s\n' "$web_password" >>"$secret_dir/pgpass-container"
printf '127.0.0.1:5432:*:worker_app:%s\n' "$worker_password" >>"$secret_dir/pgpass-container"
printf '127.0.0.1:5432:*:analyst_ro:%s\n' "$analyst_password" >>"$secret_dir/pgpass-container"
printf '127.0.0.1:5432:*:backup_role:%s\n' "$backup_password" >>"$secret_dir/pgpass-container"
chmod 600 "$secret_dir"/*

cd "$project_root"
node -e '
  const p = require("./package.json");
  if (p.devDependencies?.prisma !== "6.19.2" || p.dependencies?.["@prisma/client"] !== "6.19.2") {
    throw new Error("P1-06 requires Prisma CLI and Client 6.19.2");
  }
'
npm ci

if ! docker image inspect postgres:16 >/dev/null 2>&1; then
  mkdir -p "$secret_dir/docker-config"
  printf '{}\n' >"$secret_dir/docker-config/config.json"
  DOCKER_CONFIG="$secret_dir/docker-config" docker pull postgres:16 >/dev/null
fi
docker volume create "$volume_name" >/dev/null
docker run -d \
  --name "$container_name" \
  --mount "type=volume,src=${volume_name},dst=/var/lib/postgresql/data" \
  --mount "type=bind,src=${project_root},dst=/workspace,readonly" \
  --mount "type=bind,src=${secret_dir},dst=/run/p106-secrets,readonly" \
  --mount "type=bind,src=${artifact_dir},dst=/artifacts" \
  -e POSTGRES_USER=p106_admin \
  -e POSTGRES_PASSWORD_FILE=/run/p106-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U p106_admin -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container_name" pg_isready -U p106_admin -d postgres >/dev/null
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

docker exec -i "$container_name" psql --no-psqlrc -U p106_admin -d postgres \
  <"$project_root/infra/postgres/roles.sql" >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -U p106_admin -d postgres \
  <"$secret_dir/role-passwords.sql" >/dev/null
docker exec "$container_name" createdb -U p106_admin -O migration_owner "$source_database"

owner_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${source_database}?schema=public"
web_url="postgresql://web_app:${web_password}@127.0.0.1:${host_port}/${source_database}?schema=public"
worker_url="postgresql://worker_app:${worker_password}@127.0.0.1:${host_port}/${source_database}?schema=public"
analyst_url="postgresql://analyst_ro:${analyst_password}@127.0.0.1:${host_port}/${source_database}?schema=public"
backup_url="postgresql://backup_role:${backup_password}@127.0.0.1:${host_port}/${source_database}?schema=public"

DATABASE_URL="$owner_url" npx prisma validate
DATABASE_URL="$owner_url" npx prisma generate
DATABASE_URL="$owner_url" npx prisma migrate deploy

docker exec \
  -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$source_database" \
  -e PGUSER=migration_owner -e PGPASSFILE=/run/p106-secrets/pgpass-container \
  "$container_name" psql --no-psqlrc --file=/workspace/infra/postgres/grants.sql >/dev/null

P1_06_DATABASE_TEST=1 \
P1_06_OWNER_DATABASE_URL="$owner_url" \
P1_06_WEB_DATABASE_URL="$web_url" \
P1_06_WORKER_DATABASE_URL="$worker_url" \
P1_06_ANALYST_DATABASE_URL="$analyst_url" \
P1_06_BACKUP_DATABASE_URL="$backup_url" \
npx vitest run --project node tests/integration/database/p1-06-postgres.test.ts

docker exec \
  -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$source_database" \
  -e PGUSER=backup_role -e PGPASSFILE=/run/p106-secrets/pgpass-container \
  "$container_name" bash /workspace/scripts/db/backup-logical.sh --output /artifacts/source.dump

docker exec "$container_name" createdb -U p106_admin -O migration_owner "$restore_database"
restore_started_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
docker exec \
  -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$restore_database" \
  -e PGUSER=migration_owner -e PGPASSFILE=/run/p106-secrets/pgpass-container \
  -e P1_06_ALLOW_DISPOSABLE_RESTORE=1 \
  "$container_name" bash /workspace/scripts/db/restore-logical.sh --archive /artifacts/source.dump
restore_finished_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
restore_duration_ms="$((restore_finished_ms - restore_started_ms))"

db_query() {
  local database_name="$1"
  local sql="$2"
  docker exec \
    -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$database_name" \
    -e PGUSER=migration_owner -e PGPASSFILE=/run/p106-secrets/pgpass-container \
    "$container_name" psql --no-psqlrc --tuples-only --no-align --command="$sql" | tr -d '\r'
}

table_sql="SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'"
row_sql="SELECT json_build_object(
  'channel',(SELECT count(*) FROM channel),
  'credential',(SELECT count(*) FROM channel_account_credential),
  'generic_task',(SELECT count(*) FROM generic_task),
  'generic_task_item',(SELECT count(*) FROM generic_task_item),
  'operation_audit',(SELECT count(*) FROM operation_audit)
)::text"
constraint_sql="SELECT md5(coalesce(string_agg(
  c.conname || '|' || c.contype::text || '|' || pg_get_constraintdef(c.oid), E'\n'
  ORDER BY c.conname), ''))
FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'"
index_trigger_sql="SELECT md5(coalesce(string_agg(value, E'\n' ORDER BY value), '')) FROM (
  SELECT indexname || '|' || indexdef AS value FROM pg_indexes WHERE schemaname='public'
  UNION ALL
  SELECT tgname || '|' || pg_get_triggerdef(t.oid) FROM pg_trigger t
  JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND NOT t.tgisinternal
) objects"
migration_sql="SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL"

source_table_count="$(db_query "$source_database" "$table_sql" | tr -d '[:space:]')"
restore_table_count="$(db_query "$restore_database" "$table_sql" | tr -d '[:space:]')"
[[ "$source_table_count" == "37" && "$restore_table_count" == "37" ]]
source_rows="$(db_query "$source_database" "$row_sql")"
restore_rows="$(db_query "$restore_database" "$row_sql")"
[[ "$source_rows" == "$restore_rows" ]]
source_constraints="$(db_query "$source_database" "$constraint_sql" | tr -d '[:space:]')"
restore_constraints="$(db_query "$restore_database" "$constraint_sql" | tr -d '[:space:]')"
[[ -n "$source_constraints" && "$source_constraints" == "$restore_constraints" ]]
source_objects="$(db_query "$source_database" "$index_trigger_sql" | tr -d '[:space:]')"
restore_objects="$(db_query "$restore_database" "$index_trigger_sql" | tr -d '[:space:]')"
[[ -n "$source_objects" && "$source_objects" == "$restore_objects" ]]
[[ "$(db_query "$source_database" "$migration_sql" | tr -d '[:space:]')" == "1" ]]
[[ "$(db_query "$restore_database" "$migration_sql" | tr -d '[:space:]')" == "1" ]]

DATABASE_URL="$owner_url" node scripts/check-database-dictionary-drift.mjs
restore_owner_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${restore_database}?schema=public"
restore_web_url="postgresql://web_app:${web_password}@127.0.0.1:${host_port}/${restore_database}?schema=public"
restore_worker_url="postgresql://worker_app:${worker_password}@127.0.0.1:${host_port}/${restore_database}?schema=public"
restore_analyst_url="postgresql://analyst_ro:${analyst_password}@127.0.0.1:${host_port}/${restore_database}?schema=public"
restore_backup_url="postgresql://backup_role:${backup_password}@127.0.0.1:${host_port}/${restore_database}?schema=public"
DATABASE_URL="$restore_owner_url" node scripts/check-database-dictionary-drift.mjs

P1_06_DATABASE_TEST=1 \
P1_06_OWNER_DATABASE_URL="$restore_owner_url" \
P1_06_WEB_DATABASE_URL="$restore_web_url" \
P1_06_WORKER_DATABASE_URL="$restore_worker_url" \
P1_06_ANALYST_DATABASE_URL="$restore_analyst_url" \
P1_06_BACKUP_DATABASE_URL="$restore_backup_url" \
npx vitest run --project node tests/integration/database/p1-06-postgres.test.ts

npm run typecheck
npm run lint
npm run test:backend
npm test

echo "ROLE_TESTS=PASS"
echo "WEB_SECRET_READ=DENIED"
echo "ANALYST_WRITE=DENIED"
echo "APP_DDL=DENIED"
echo "LOGICAL_BACKUP=PASS"
echo "LOGICAL_RESTORE=PASS"
echo "RESTORE_DURATION_MS=${restore_duration_ms}"
echo "TABLE_COUNT=${restore_table_count}"
echo "CONSTRAINT_DIGEST=${restore_constraints}"
echo "OBJECT_DIGEST=${restore_objects}"
echo "DICTIONARY_DRIFT=0_OF_825"
echo "PITR_STATUS=SCRIPT_AND_RUNBOOK_ONLY"
echo "P1_06_VERIFICATION=PASS"
