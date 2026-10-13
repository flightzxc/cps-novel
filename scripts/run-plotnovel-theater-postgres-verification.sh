#!/usr/bin/env bash
# v0.6.0 接入畅读 PlotNovel 剧场（口令码模式）的真实库验证。
#
# 一次性 postgres:16.14（tmpfs、随机口令）+ 真实 infra/postgres/roles.sql + 全部迁移 + 真实
# infra/postgres/grants.sql，五个真实角色（migration_owner / web_app / worker_app / scheduler_app /
# analyst_ro）各自的连接串传给用例。tests/integration/plotnovel/*.test.ts 必须全部通过且 skipped=0：
#   1) catalog-routing：目录扫描按机构分流（真实 persistCatalogPage 事务）+ 口令码模式只写码；
#   2) rehome：存量改挂脚本（成功 / 数量不符拒绝 / 有未完成任务拒绝 / 重复执行改挂 0 行 / 唯一键冲突）；
#   3) readiness：口令码模式就绪规则 JS 与 SQL 逐字符等价、MoboReader 防误伤、公开列表 / 站点地图预筛、
#      web_app 读 upstream_code 的列级授权、scheduler_app 的 queryActiveLocales 不被拒、
#      领取批次能挑到 PlotNovel 剧场的书；
#   4) 真实角色：web_app / worker_app / scheduler_app 全程无 permission denied。
# 最后重放 grants 之后跑数据字典漂移检查（drift 必须为 0）。
# 最后一行：PLOTNOVEL_THEATER_POSTGRES_VERIFICATION=PASS
set -euo pipefail
set +x

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$"
container_name="cps-novel-plotnovel-pg16-${run_id}"
database_name="cps_novel_plotnovel_${run_id//-/_}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-plotnovel-secrets.XXXXXX")"
cleanup_complete="no"
verification_passed="no"

cleanup() {
  local status=$?
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -rf "$secret_dir"
  if ! docker ps -a --format '{{.Names}}' | grep -Fx "$container_name" >/dev/null 2>&1; then
    cleanup_complete="yes"
  fi
  echo "PLOTNOVEL_DISPOSABLE_DATABASE_CLEANED=${cleanup_complete}"
  # 最后一行：只有所有断言都过、且一次性库已清理，才打印 PASS（失败时这一行绝不出现）
  if [ "$status" -eq 0 ] && [ "$verification_passed" = "yes" ] && [ "$cleanup_complete" = "yes" ]; then
    echo "PLOTNOVEL_THEATER_POSTGRES_VERIFICATION=PASS"
  fi
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
openssl rand 32 | openssl base64 -A >"$secret_dir/credential-v1.key"
openssl rand 32 | openssl base64 -A >"$secret_dir/credential-fingerprint.key"
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
  --mount "type=bind,src=${secret_dir},dst=/run/plotnovel-secrets,readonly" \
  -e POSTGRES_USER=plotnovel_admin \
  -e POSTGRES_PASSWORD_FILE=/run/plotnovel-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U plotnovel_admin -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container_name" pg_isready -U plotnovel_admin -d postgres >/dev/null
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

docker exec -i "$container_name" psql --no-psqlrc -U plotnovel_admin -d postgres \
  <"$project_root/infra/postgres/roles.sql" >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -U plotnovel_admin -d postgres \
  <"$secret_dir/role-passwords.sql" >/dev/null
docker exec "$container_name" createdb -U plotnovel_admin -O migration_owner "$database_name"

owner_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
web_url="postgresql://web_app:${web_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
worker_url="postgresql://worker_app:${worker_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
scheduler_url="postgresql://scheduler_app:${scheduler_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
analyst_url="postgresql://analyst_ro:${analyst_password}@127.0.0.1:${host_port}/${database_name}?schema=public"

expected_migrations="$(find prisma/migrations -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d '[:space:]')"
DATABASE_URL="$owner_url" npm exec prisma migrate deploy
applied_migrations="$(docker exec -e PGPASSWORD="$migration_password" "$container_name" psql --no-psqlrc -h 127.0.0.1 -U migration_owner -d "$database_name" -Atqc \
  'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL' | tr -d '[:space:]')"
if [ "$applied_migrations" != "$expected_migrations" ]; then
  echo "PLOTNOVEL_MIGRATION_COUNT=FAIL applied=${applied_migrations} expected=${expected_migrations}" >&2
  exit 1
fi
echo "PLOTNOVEL_MIGRATION_COUNT=PASS applied=${applied_migrations}"
docker exec \
  -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$database_name" \
  -e PGUSER=migration_owner -e PGPASSWORD="$migration_password" \
  "$container_name" psql --no-psqlrc --file=/workspace/infra/postgres/grants.sql >/dev/null

PLOTNOVEL_DATABASE_TEST=1 \
PLOTNOVEL_OWNER_DATABASE_URL="$owner_url" \
PLOTNOVEL_WEB_DATABASE_URL="$web_url" \
PLOTNOVEL_WORKER_DATABASE_URL="$worker_url" \
PLOTNOVEL_SCHEDULER_DATABASE_URL="$scheduler_url" \
PLOTNOVEL_ANALYST_DATABASE_URL="$analyst_url" \
CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION=1 \
CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE="$secret_dir/credential-v1.key" \
CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE="$secret_dir/credential-fingerprint.key" \
npm exec vitest run -- --project node \
  tests/integration/plotnovel/catalog-routing-postgres.test.ts \
  tests/integration/plotnovel/rehome-postgres.test.ts \
  tests/integration/plotnovel/readiness-postgres.test.ts \
  --no-file-parallelism --reporter=default --reporter=json --outputFile="$secret_dir/integration-result.json"

# 硬断言（B-31 共用断言）：不允许任何文件被整文件跳过；通过数不得低于下限（= 该文件当前用例数）。
# 用 if ! ...; then ...; exit 1; fi 书写，不依赖 set -e 对单独成行断言的行为（macOS bash 3.2）。
if ! node scripts/lib/assert-vitest-no-skipped-files.mjs PLOTNOVEL "$secret_dir/integration-result.json" \
  tests/integration/plotnovel/catalog-routing-postgres.test.ts=8 \
  tests/integration/plotnovel/rehome-postgres.test.ts=13 \
  tests/integration/plotnovel/readiness-postgres.test.ts=12; then
  exit 1
fi

DATABASE_URL="$owner_url" node scripts/check-database-dictionary-drift.mjs

echo "PLOTNOVEL_DICTIONARY_DRIFT=0"
verification_passed="yes"
