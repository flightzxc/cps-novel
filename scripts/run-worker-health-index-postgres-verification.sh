#!/usr/bin/env bash
set -euo pipefail
set +x

# Worker 健康检查冷缓存超时误报 503 的真实库验证（迁移 20261005100000_worker_health_partial_indexes）。
#
# 随机一次性 PostgreSQL 16.14 容器（tmpfs 数据目录，退出即清理）：全部迁移 + grants，
# 然后在 tests/integration/health/worker-health-indexes-postgres.test.ts 里造接近生产规模
# 的数据（默认 generic_task_item 40 万行 / channel_sync_task_item 8 万行），用 EXPLAIN
# (ANALYZE, BUFFERS) 证明发布的两条查询走部分索引、没有 Seq Scan。
#
# 规模/容量可调（接近生产 496 MB 的做法：PAYLOAD_BYTES=1200、TMPFS_SIZE=5g）：
#   WORKER_HEALTH_INDEX_GENERIC_ROWS / _SYNC_ROWS / _PAYLOAD_BYTES / _TMPFS_SIZE

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$"
container_name="cps-novel-worker-health-pg16-${run_id}"
database_name="cps_novel_worker_health_${run_id//-/_}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-worker-health-secrets.XXXXXX")"
tmpfs_size="${WORKER_HEALTH_INDEX_TMPFS_SIZE:-2g}"
cleanup_complete="no"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -rf "$secret_dir"
  if ! docker ps -a --format '{{.Names}}' | grep -Fx "$container_name" >/dev/null 2>&1; then
    cleanup_complete="yes"
  fi
  echo "WORKER_HEALTH_INDEX_DISPOSABLE_DATABASE_CLEANED=${cleanup_complete}"
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
  --tmpfs "/var/lib/postgresql/data:rw,noexec,nosuid,size=${tmpfs_size}" \
  --mount "type=bind,src=${project_root},dst=/workspace,readonly" \
  --mount "type=bind,src=${secret_dir},dst=/run/worker-health-secrets,readonly" \
  -e POSTGRES_USER=worker_health_admin \
  -e POSTGRES_PASSWORD_FILE=/run/worker-health-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U worker_health_admin -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container_name" pg_isready -U worker_health_admin -d postgres >/dev/null
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

docker exec -i "$container_name" psql --no-psqlrc -U worker_health_admin -d postgres \
  <"$project_root/infra/postgres/roles.sql" >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -U worker_health_admin -d postgres \
  <"$secret_dir/role-passwords.sql" >/dev/null
docker exec "$container_name" createdb -U worker_health_admin -O migration_owner "$database_name"

owner_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
web_url="postgresql://web_app:${web_password}@127.0.0.1:${host_port}/${database_name}?schema=public"

DATABASE_URL="$owner_url" npm exec prisma migrate deploy >/dev/null
docker exec \
  -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$database_name" \
  -e PGUSER=migration_owner -e PGPASSWORD="$migration_password" \
  "$container_name" psql --no-psqlrc --file=/workspace/infra/postgres/grants.sql >/dev/null

WORKER_HEALTH_INDEX_DATABASE_TEST=1 \
WORKER_HEALTH_INDEX_OWNER_DATABASE_URL="$owner_url" \
WORKER_HEALTH_INDEX_WEB_DATABASE_URL="$web_url" \
npm exec vitest run -- --project node tests/integration/health/worker-health-indexes-postgres.test.ts \
  --reporter=default --reporter=json --outputFile="$secret_dir/integration-result.json"

node - "$secret_dir/integration-result.json" "$project_root/tests/integration/health/worker-health-indexes-postgres.test.ts" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const expected = path.resolve(process.argv[3]);
const files = report.testResults ?? [];
const file = files[0];
const passed = file?.assertionResults?.filter((test) => test.status === "passed").length ?? 0;
const skipped = report.numPendingTests ?? -1;
// 6 条断言全部真跑：基线 / 迁移建索引 / 计划 / 等价 / 端到端 / 授权。
if (files.length !== 1 || path.resolve(file?.name ?? "") !== expected
    || file.status !== "passed" || passed < 7 || skipped !== 0
    || report.numFailedTests !== 0 || report.numPassedTests !== passed) {
  console.error(`WORKER_HEALTH_INDEX_INTEGRATION=FAIL reason=not_executed passed=${passed} skipped=${skipped}`);
  process.exit(1);
}
console.log(`WORKER_HEALTH_INDEX_INTEGRATION=PASS passed=${passed} skipped=0`);
NODE

# 测试里撤掉两个心跳索引又用迁移 SQL 原样重建，所以这里的字典 drift 检查同时核对
# "迁移 SQL 建出的物理索引 == 字典登记"。
DATABASE_URL="$owner_url" node scripts/check-database-dictionary-drift.mjs

echo "WORKER_HEALTH_INDEX_DICTIONARY_DRIFT=0"
echo "WORKER_HEALTH_INDEX_POSTGRES_VERIFICATION=PASS"
