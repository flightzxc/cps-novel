#!/usr/bin/env bash
set -euo pipefail
set +x

# 领推广链接生命周期正式修复第 2 阶段第 4 步（界面与批次级操作）一次性
# PostgreSQL 16.14 容器验证。同 scripts/run-promo-claim-release-postgres-
# verification.sh 的既有形状：起一个全新容器、建六个最小权限角色
# （infra/postgres/roles.sql）、迁移、重放 infra/postgres/grants.sql，再用
# 真实 web_app 角色跑批次级暂停/恢复/中止/重新批准（3.1/3.3），用真实
# worker_app 角色跑"同一本书挂在另一个批次排队分片下"的枚举时阻断（3.4）。
#
# D7 结论（本步施工报告已记录）：3.1/3.3/3.4 复用的都是 generic_task /
# generic_task_item / operation_audit 这三张表既有的整表授权（web_app 的
# INSERT/UPDATE，worker_app 的 SELECT/INSERT/UPDATE，见 infra/postgres/
# grants.sql 对这三张表的既有 GRANT），没有新增列或新增表——本脚本的作用是
# 拿真实角色实测验证这一点，而不是假设"没改 grants.sql 就等于没问题"。

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$"
container_name="cps-novel-promo-claim-batch-control-pg16-${run_id}"
database_name="cps_novel_promo_claim_batch_control_${run_id//-/_}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-promo-claim-batch-control-secrets.XXXXXX")"
cleanup_complete="no"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -rf "$secret_dir"
  if ! docker ps -a --format '{{.Names}}' | grep -Fx "$container_name" >/dev/null 2>&1; then
    cleanup_complete="yes"
  fi
  echo "PROMO_CLAIM_BATCH_CONTROL_DISPOSABLE_DATABASE_CLEANED=${cleanup_complete}"
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
  --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=2g \
  --mount "type=bind,src=${project_root},dst=/workspace,readonly" \
  --mount "type=bind,src=${secret_dir},dst=/run/promo-claim-batch-control-secrets,readonly" \
  -e POSTGRES_USER=promo_claim_batch_control_admin \
  -e POSTGRES_PASSWORD_FILE=/run/promo-claim-batch-control-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U promo_claim_batch_control_admin -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container_name" pg_isready -U promo_claim_batch_control_admin -d postgres >/dev/null
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

docker exec -i "$container_name" psql --no-psqlrc -U promo_claim_batch_control_admin -d postgres \
  <"$project_root/infra/postgres/roles.sql" >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -U promo_claim_batch_control_admin -d postgres \
  <"$secret_dir/role-passwords.sql" >/dev/null
docker exec "$container_name" createdb -U promo_claim_batch_control_admin -O migration_owner "$database_name"

owner_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
web_url="postgresql://web_app:${web_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
worker_url="postgresql://worker_app:${worker_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
scheduler_url="postgresql://scheduler_app:${scheduler_password}@127.0.0.1:${host_port}/${database_name}?schema=public"

DATABASE_URL="$owner_url" npm exec prisma migrate deploy >/dev/null
docker exec \
  -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$database_name" \
  -e PGUSER=migration_owner -e PGPASSWORD="$migration_password" \
  "$container_name" psql --no-psqlrc --file=/workspace/infra/postgres/grants.sql >/dev/null

PROMO_CLAIM_BATCH_CONTROL_DATABASE_TEST=1 \
PROMO_CLAIM_BATCH_CONTROL_OWNER_DATABASE_URL="$owner_url" \
PROMO_CLAIM_BATCH_CONTROL_WEB_DATABASE_URL="$web_url" \
PROMO_CLAIM_BATCH_CONTROL_WORKER_DATABASE_URL="$worker_url" \
PROMO_CLAIM_BATCH_CONTROL_SCHEDULER_DATABASE_URL="$scheduler_url" \
npm exec vitest run -- --project node tests/integration/tasks/promo-claim-batch-control-postgres.test.ts

DATABASE_URL="$owner_url" node scripts/check-database-dictionary-drift.mjs

echo "PROMO_CLAIM_BATCH_CONTROL_DICTIONARY_DRIFT=0"
echo "PROMO_CLAIM_BATCH_CONTROL_POSTGRES_VERIFICATION=PASS"
