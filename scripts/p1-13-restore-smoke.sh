#!/usr/bin/env bash
set -euo pipefail
set +x

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$-$RANDOM"
container_name="cps-novel-p1-13-restore-pg16-${run_id}"
volume_name="cps-novel-p1-13-restore-pgdata-${run_id}"
network_name="cps-novel-p1-13-restore-net-${run_id}"
source_database="cps_novel_p1_13_source_${run_id//-/_}"
restore_database="cps_novel_restore_p1_13_${run_id//-/_}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-p1-13-restore-secrets.XXXXXX")"
artifact_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-p1-13-restore-artifacts.XXXXXX")"
run_log="$artifact_dir/smoke.log"
cleanup_ran=no

now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }

cleanup() {
  set +e
  [[ "$cleanup_ran" == no ]] || return 0
  cleanup_ran=yes
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  docker volume rm "$volume_name" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
  rm -rf "$secret_dir" "$artifact_dir"
  if ! docker ps -a --format '{{.Names}}' | grep -Fx "$container_name" >/dev/null 2>&1 \
    && ! docker volume ls --format '{{.Name}}' | grep -Fx "$volume_name" >/dev/null 2>&1 \
    && ! docker network ls --format '{{.Name}}' | grep -Fx "$network_name" >/dev/null 2>&1; then
    printf 'P1_13_RESTORE_CLEANUP=PASS\n'
  else
    printf 'P1_13_RESTORE_CLEANUP=FAIL\n' >&2
  fi
}
trap cleanup EXIT INT TERM
trap 'status=$?; printf "P1_13_RESTORE_ERROR line=%s status=%s\n" "$LINENO" "$status" >&2; exit "$status"' ERR

total_started_ms="$(now_ms)"
umask 077
bootstrap_password="$(openssl rand -hex 24)"
migration_password="$(openssl rand -hex 24)"
web_password="$(openssl rand -hex 24)"
worker_password="$(openssl rand -hex 24)"
scheduler_password="$(openssl rand -hex 24)"
analyst_password="$(openssl rand -hex 24)"
backup_password="$(openssl rand -hex 24)"
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
  printf '127.0.0.1:5432:*:%s:%s\n' "$role_name" "$password" >>"$secret_dir/pgpass-container"
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
  --mount "type=bind,src=${secret_dir},dst=/run/p113-restore-secrets,readonly" \
  --mount "type=bind,src=${artifact_dir},dst=/artifacts" \
  -e POSTGRES_USER=p113_restore_admin \
  -e POSTGRES_PASSWORD_FILE=/run/p113-restore-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U p113_restore_admin -d postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$container_name" pg_isready -U p113_restore_admin -d postgres >/dev/null
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"
docker exec -i "$container_name" psql --no-psqlrc -U p113_restore_admin -d postgres \
  <infra/postgres/roles.sql >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -U p113_restore_admin -d postgres \
  <"$secret_dir/role-passwords.sql" >/dev/null
docker exec "$container_name" createdb -U p113_restore_admin -O migration_owner "$source_database"
docker exec "$container_name" createdb -U p113_restore_admin -O migration_owner "$restore_database"

owner_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${source_database}?schema=public"
DATABASE_URL="$owner_url" npx prisma migrate deploy >"$run_log" 2>&1
docker exec \
  -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$source_database" \
  -e PGUSER=migration_owner -e PGPASSFILE=/run/p113-restore-secrets/pgpass-container \
  "$container_name" psql --no-psqlrc --file=/workspace/infra/postgres/grants.sql >>"$run_log" 2>&1

docker exec -i \
  -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$source_database" \
  -e PGUSER=migration_owner -e PGPASSFILE=/run/p113-restore-secrets/pgpass-container \
  "$container_name" psql --no-psqlrc --set=ON_ERROR_STOP=1 >>"$run_log" 2>&1 <<'SQL'
INSERT INTO channel (id, code, name, updated_at)
VALUES ('13131313-0000-4000-8000-000000000001', 'p1-13-restore', 'P1-13 Restore', now());
INSERT INTO source_app (id, code, name, updated_at)
VALUES ('13131313-0000-4000-8000-000000000002', 'p1-13-source', 'P1-13 Source', now());
INSERT INTO channel_app (id, channel_id, source_app_id, external_app_id, project_type, updated_at)
VALUES ('13131313-0000-4000-8000-000000000003', '13131313-0000-4000-8000-000000000001', '13131313-0000-4000-8000-000000000002', 'restore-app', 2, now());
INSERT INTO channel_account (id, channel_id, business_id, account_name, status, updated_at)
VALUES ('13131313-0000-4000-8000-000000000004', '13131313-0000-4000-8000-000000000001', 'restore-account', 'Restore Account', 'active', now());
INSERT INTO channel_account_credential (
  id, channel_account_id, encrypted_secret, key_version, secret_fingerprint,
  fingerprint_prefix, status, updated_at
) VALUES (
  '13131313-0000-4000-8000-000000000005', '13131313-0000-4000-8000-000000000004',
  convert_to('P113_CIPHERTEXT_SENTINEL', 'UTF8'), 1, repeat('a', 64), 'aaaaaaaaaaaa', 'active', now()
);
INSERT INTO generic_task (
  id, task_type, operation_scope_hash, request_token, mode, status, total_count, updated_at
) VALUES (
  '13131313-0000-4000-8000-000000000006', 'p1-13.restore', repeat('b', 64),
  'p1-13-restore-task', 'apply', 'pending', 1, now()
);
INSERT INTO generic_task_item (id, task_id, target_type, target_id, status, updated_at)
VALUES ('13131313-0000-4000-8000-000000000007', '13131313-0000-4000-8000-000000000006', 'restore', 'row-1', 'pending', now());
INSERT INTO novel (
  id, business_id, title, description, locale, slug, total_chapter_count, status, updated_at
) VALUES (
  '13131313-0000-4000-8000-000000000008', 'restore-novel', 'Restore Novel',
  'Deterministic restore smoke novel', 'en-US', 'restore-novel', 1, 'ready', now()
);
INSERT INTO novel_chapter (id, novel_id, canonical_chapter_number, title, status, updated_at)
VALUES ('13131313-0000-4000-8000-000000000009', '13131313-0000-4000-8000-000000000008', 1, 'Chapter One', 'preview', now());
INSERT INTO novel_chapter_content (
  id, novel_chapter_id, body, char_count, content_hash, materialized_at, updated_at
) VALUES (
  '13131313-0000-4000-8000-000000000010', '13131313-0000-4000-8000-000000000009',
  'Deterministic chapter body', 26, repeat('c', 64), now(), now()
);
INSERT INTO side_effect_intent (
  id, effect_key, operation_type, idempotency_key, target_type, target_id, status
) VALUES (
  '13131313-0000-4000-8000-000000000011', repeat('d', 64), 'p1-13.restore',
  repeat('e', 64), 'novel', '13131313-0000-4000-8000-000000000008', 'prepared'
);
INSERT INTO operation_audit (actor_type, actor_id, action, entity_type, entity_id, task_type, task_id)
VALUES ('test', 'p1-13', 'restore.seeded', 'novel', '13131313-0000-4000-8000-000000000008', 'p1-13.restore', '13131313-0000-4000-8000-000000000006');
SQL

backup_started_ms="$(now_ms)"
docker exec \
  -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$source_database" \
  -e PGUSER=backup_role -e PGPASSFILE=/run/p113-restore-secrets/pgpass-container \
  "$container_name" bash /workspace/scripts/db/backup-logical.sh \
  --output /artifacts/source.dump >>"$run_log" 2>&1
backup_finished_ms="$(now_ms)"

restore_started_ms="$(now_ms)"
docker exec \
  -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$restore_database" \
  -e PGUSER=migration_owner -e PGPASSFILE=/run/p113-restore-secrets/pgpass-container \
  -e P1_06_ALLOW_DISPOSABLE_RESTORE=1 \
  "$container_name" bash /workspace/scripts/db/restore-logical.sh \
  --archive /artifacts/source.dump >>"$run_log" 2>&1
restore_finished_ms="$(now_ms)"

query() {
  local database="$1"
  local sql="$2"
  docker exec \
    -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$database" \
    -e PGUSER=migration_owner -e PGPASSFILE=/run/p113-restore-secrets/pgpass-container \
    "$container_name" psql --no-psqlrc --tuples-only --no-align --command="$sql" | tr -d '\r'
}

verification_started_ms="$(now_ms)"
migration_sql="SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL"
row_sql="SELECT json_build_object(
  'channel',(SELECT count(*) FROM channel),
  'account',(SELECT count(*) FROM channel_account),
  'credential',(SELECT count(*) FROM channel_account_credential),
  'task',(SELECT count(*) FROM generic_task),
  'item',(SELECT count(*) FROM generic_task_item),
  'novel',(SELECT count(*) FROM novel),
  'chapter',(SELECT count(*) FROM novel_chapter),
  'content',(SELECT count(*) FROM novel_chapter_content),
  'audit',(SELECT count(*) FROM operation_audit),
  'intent',(SELECT count(*) FROM side_effect_intent)
)::text"
relation_sql="SELECT
  (SELECT count(*) FROM channel_account a LEFT JOIN channel c ON c.id=a.channel_id WHERE c.id IS NULL) +
  (SELECT count(*) FROM channel_app a LEFT JOIN channel c ON c.id=a.channel_id LEFT JOIN source_app s ON s.id=a.source_app_id WHERE c.id IS NULL OR s.id IS NULL) +
  (SELECT count(*) FROM channel_account_credential x LEFT JOIN channel_account a ON a.id=x.channel_account_id WHERE a.id IS NULL) +
  (SELECT count(*) FROM generic_task_item i LEFT JOIN generic_task t ON t.id=i.task_id WHERE t.id IS NULL) +
  (SELECT count(*) FROM novel_chapter c LEFT JOIN novel n ON n.id=c.novel_id WHERE n.id IS NULL) +
  (SELECT count(*) FROM novel_chapter_content x LEFT JOIN novel_chapter c ON c.id=x.novel_chapter_id WHERE c.id IS NULL)"

source_migrations="$(query "$source_database" "$migration_sql" | tr -d '[:space:]')"
restore_migrations="$(query "$restore_database" "$migration_sql" | tr -d '[:space:]')"
[[ "$source_migrations" -gt 0 && "$source_migrations" == "$restore_migrations" ]]
source_rows="$(query "$source_database" "$row_sql")"
restore_rows="$(query "$restore_database" "$row_sql")"
[[ "$source_rows" == "$restore_rows" ]]
[[ "$(query "$restore_database" "$relation_sql" | tr -d '[:space:]')" == 0 ]]

expect_restore_denied() {
  local sql="$1"
  if query "$restore_database" "$sql" >>"$run_log" 2>&1; then
    printf 'Expected restored PostgreSQL constraint to reject statement\n' >&2
    exit 1
  fi
}
expect_restore_denied "UPDATE channel SET status='not_frozen' WHERE id='13131313-0000-4000-8000-000000000001'"
expect_restore_denied "INSERT INTO channel (id,code,name,updated_at) VALUES ('13131313-0000-4000-8000-000000000099','p1-13-restore','Duplicate',now())"

role_query() {
  local role="$1"
  local database="$2"
  local sql="$3"
  docker exec \
    -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$database" \
    -e PGUSER="$role" -e PGPASSFILE=/run/p113-restore-secrets/pgpass-container \
    "$container_name" psql --no-psqlrc --tuples-only --no-align --command="$sql"
}
role_query worker_app "$restore_database" "SELECT encrypted_secret FROM channel_account_credential LIMIT 1" >/dev/null
for denied_role in web_app scheduler_app analyst_ro; do
  if role_query "$denied_role" "$restore_database" "SELECT encrypted_secret FROM channel_account_credential LIMIT 1" >>"$run_log" 2>&1; then
    printf 'Restored role %s unexpectedly read encrypted_secret\n' "$denied_role" >&2
    exit 1
  fi
done
verification_finished_ms="$(now_ms)"

for forbidden in \
  "$bootstrap_password" "$migration_password" "$web_password" "$worker_password" \
  "$scheduler_password" "$analyst_password" "$backup_password" \
  P113_CIPHERTEXT_SENTINEL 'postgresql://'; do
  if grep -F -- "$forbidden" "$run_log" >/dev/null 2>&1; then
    printf 'Sensitive restore output detected\n' >&2
    exit 1
  fi
done

total_finished_ms="$(now_ms)"
printf 'RESTORE_SMOKE=PASS\n'
printf 'POSTGRES_VERSION=%s\n' "$(query "$restore_database" 'SHOW server_version' | tr -d '[:space:]')"
printf 'MIGRATION_COUNT=%s\n' "$restore_migrations"
printf 'REPRESENTATIVE_ROWS=%s\n' "$restore_rows"
printf 'RELATIONSHIP_CHECK=PASS\n'
printf 'RESTORED_CONSTRAINTS=PASS\n'
printf 'RESTORED_ROLE_PERMISSIONS=PASS\n'
printf 'SENSITIVE_OUTPUT=NONE\n'
printf 'BACKUP_DURATION_MS=%d\n' "$((backup_finished_ms - backup_started_ms))"
printf 'RESTORE_DURATION_MS=%d\n' "$((restore_finished_ms - restore_started_ms))"
printf 'VERIFY_DURATION_MS=%d\n' "$((verification_finished_ms - verification_started_ms))"
printf 'TOTAL_DURATION_MS=%d\n' "$((total_finished_ms - total_started_ms))"
