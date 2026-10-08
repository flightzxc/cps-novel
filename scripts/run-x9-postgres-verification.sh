#!/usr/bin/env bash
set -euo pipefail
set +x

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$"
container_name="cps-novel-x9-pg16-${run_id}"
database_name="cps_novel_x9_${run_id//-/_}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-x9-secrets.XXXXXX")"
cleanup_complete="no"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -rf "$secret_dir"
  if ! docker ps -a --format '{{.Names}}' | grep -Fx "$container_name" >/dev/null 2>&1; then
    cleanup_complete="yes"
  fi
  echo "X9_DISPOSABLE_DATABASE_CLEANED=${cleanup_complete}"
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
printf '%s' "$bootstrap_password" >"$secret_dir/bootstrap-password"
printf "ALTER ROLE migration_owner PASSWORD '%s';\n" "$migration_password" >"$secret_dir/role-passwords.sql"
printf "ALTER ROLE web_app PASSWORD '%s';\n" "$web_password" >>"$secret_dir/role-passwords.sql"
printf "ALTER ROLE worker_app PASSWORD '%s';\n" "$worker_password" >>"$secret_dir/role-passwords.sql"
printf "ALTER ROLE scheduler_app PASSWORD '%s';\n" "$scheduler_password" >>"$secret_dir/role-passwords.sql"
printf "ALTER ROLE analyst_ro PASSWORD '%s';\n" "$analyst_password" >>"$secret_dir/role-passwords.sql"
printf "ALTER ROLE backup_role PASSWORD '%s';\n" "$backup_password" >>"$secret_dir/role-passwords.sql"

cd "$project_root"
docker image inspect postgres:16.14 >/dev/null
docker run -d \
  --name "$container_name" \
  --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=1g \
  --mount "type=bind,src=${project_root},dst=/workspace,readonly" \
  --mount "type=bind,src=${secret_dir},dst=/run/x9-secrets,readonly" \
  -e POSTGRES_USER=x9_admin \
  -e POSTGRES_PASSWORD_FILE=/run/x9-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U x9_admin -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container_name" pg_isready -U x9_admin -d postgres >/dev/null
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

docker exec -i "$container_name" psql --no-psqlrc -U x9_admin -d postgres \
  <"$project_root/infra/postgres/roles.sql" >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -U x9_admin -d postgres \
  <"$secret_dir/role-passwords.sql" >/dev/null
# Keep an independent old-schema migration directory for the populated upgrade.
# 旧库基线 = 守卫迁移"之前"的全部迁移：守卫迁移本身以及时间戳晚于它的迁移（例如运营 V2 的
# 20260930100000_site_setting_yandex）都不属于这次升级演练的旧基线，之后再新增迁移也不必再改这里。
guard_migration=20260927090000_side_effect_manual_review_guard
mkdir -p "$secret_dir/upgrade/migrations"
cp prisma/schema.prisma "$secret_dir/upgrade/schema.prisma"
cp prisma/migrations/migration_lock.toml "$secret_dir/upgrade/migrations/"
for migration in prisma/migrations/*/; do
  migration_name="$(basename "${migration%/}")"
  # 显式 if：本机 /bin/bash 3.2 下单独成行的 `[[ ]]` 判假不会触发 set -e。
  if [ "${migration_name%%_*}" -ge "${guard_migration%%_*}" ]; then
    continue
  fi
  cp -R "${migration%/}" "$secret_dir/upgrade/migrations/"
done
expected_total_migrations="$(find prisma/migrations -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d '[:space:]')"
expected_baseline_migrations="$(find "$secret_dir/upgrade/migrations" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d '[:space:]')"

db_query() {
  docker exec "$container_name" psql --no-psqlrc -v ON_ERROR_STOP=1 -U x9_admin -d "$database_name" -Atqc "$1"
}

migration_digest_sql="SELECT md5(string_agg(migration_name || ':' || checksum || ':' || finished_at::text, ',' ORDER BY migration_name)) FROM _prisma_migrations WHERE migration_name < '20260927090000_side_effect_manual_review_guard' AND finished_at IS NOT NULL AND rolled_back_at IS NULL"
fixture_digest_sql="SELECT md5(json_build_object('intents',(SELECT json_agg(s ORDER BY id) FROM side_effect_intent s WHERE operation_type='x9.upgrade_probe'),'schedule',(SELECT json_agg(s ORDER BY id) FROM schedule_run s WHERE schedule_key='x9.upgrade_probe'))::text)"

for scenario in empty upgrade; do
  database_name="cps_novel_x9_${scenario}_${run_id//-/_}"
  docker exec "$container_name" createdb -U x9_admin -O migration_owner "$database_name"
  owner_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
  web_url="postgresql://web_app:${web_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
  worker_url="postgresql://worker_app:${worker_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
  bootstrap_url="postgresql://x9_admin:${bootstrap_password}@127.0.0.1:${host_port}/${database_name}?schema=public"

  if [[ "$scenario" == upgrade ]]; then
    DATABASE_URL="$owner_url" npx prisma migrate deploy --schema "$secret_dir/upgrade/schema.prisma"
    [[ "$(db_query 'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" == "$expected_baseline_migrations" ]] || { echo 'X9_UPGRADE_BASELINE_COUNT=FAIL'; exit 1; }
    docker exec -i "$container_name" psql --no-psqlrc -v ON_ERROR_STOP=1 -U migration_owner -d "$database_name" <<'SQL'
INSERT INTO side_effect_intent (id,effect_key,operation_type,idempotency_key,target_type,target_id,status,request_summary,response_shape)
SELECT gen_random_uuid(), md5(status)||md5(status), 'x9.upgrade_probe', md5(status)||md5(status),
  'probe', status, status, '{"preserve":true}'::jsonb, '{"evidence":"before-migration"}'::jsonb
FROM unnest(ARRAY['prepared','confirmed','failed','claim_retry_blocked','manual_review_required']) AS status;
INSERT INTO schedule_run (id,schedule_key,schedule_revision,scheduled_for,timezone,status,skip_reason,updated_at)
VALUES (gen_random_uuid(),'x9.upgrade_probe',1,now(),'UTC','skipped','previous_scan_in_flight',now());
SQL
    before_migrations="$(db_query "$migration_digest_sql")"
    before_fixture="$(db_query "$fixture_digest_sql")"
  fi

  DATABASE_URL="$owner_url" npx prisma migrate deploy
  [[ "$(db_query 'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" == "$expected_total_migrations" ]] || { echo 'X9_MIGRATION_COUNT=FAIL'; exit 1; }
  [[ "$(db_query "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'")" == 57 ]] || { echo 'X9_TABLE_COUNT=FAIL'; exit 1; }
  if [[ "$scenario" == upgrade ]]; then
    [[ "$(db_query "$migration_digest_sql")" == "$before_migrations" ]] || { echo "X9_OLD_MIGRATION_DIGEST=FAIL"; exit 1; }
    [[ "$(db_query "$fixture_digest_sql")" == "$before_fixture" ]] || { echo "X9_UPGRADE_DATA_DIGEST=FAIL"; exit 1; }
    echo "X9_UPGRADE_OLD_MIGRATIONS_AND_DATA=UNCHANGED"
  fi
  echo "X9_MIGRATION_${scenario}=PASS migrations=${expected_total_migrations} tables=57"

  for replay in 1 2; do
    docker exec -i "$container_name" psql --no-psqlrc --single-transaction -v ON_ERROR_STOP=1 \
      -U migration_owner -d "$database_name" < infra/postgres/grants.sql >/dev/null
    X9_DATABASE_TEST=1 \
    X9_OWNER_DATABASE_URL="$owner_url" \
    X9_WEB_DATABASE_URL="$web_url" \
    X9_WORKER_DATABASE_URL="$worker_url" \
    X9_BOOTSTRAP_DATABASE_URL="$bootstrap_url" \
    npx vitest run --project node tests/integration/task-admin/x9-postgres.test.ts
    echo "X9_GRANTS_REPLAY_${scenario}_${replay}=PASS"
  done
  DATABASE_URL="$owner_url" node scripts/check-database-dictionary-drift.mjs
  echo "X9_DICTIONARY_DRIFT_${scenario}=0"
  reapply_output="$(DATABASE_URL="$owner_url" npx prisma migrate deploy)"
  echo "$reapply_output"
  [[ "$reapply_output" == *"No pending migrations to apply."* ]] || { echo "X9_MIGRATION_REAPPLY=FAIL"; exit 1; }
done

echo "X9_WEB_INTENT_COLUMN_GRANT=PASS"
echo "X9_MANUAL_REVIEW_CAS_AND_AUDIT=PASS"
echo "X9_WORKER_MANUAL_REVIEW_OUT_EDGES=DENIED"
echo "X9_POSTGRES_VERIFICATION=PASS"
