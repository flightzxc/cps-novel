#!/usr/bin/env bash
# 收益看板（账号级每日汇总）的真实库验收运行器。
#
# 一次性 postgres:16.14 + 真实迁移 + `infra/postgres/grants.sql` + 真实角色：
#   - worker_app 跑 handler 的 protectedWrite 全链路（scope / 批次 / 原始行 / 日统计 / 审计 upsert，含重复同步幂等）
#     以及经真实 `processOneWorkerCycle` 的领取 / 执行 / 终态；
#   - web_app 跑 `loadRevenueDashboard` 与入队函数，并证明它对四表 INSERT / UPDATE / DELETE 全部被拒；
#   - analyst_ro 只读、scheduler_app 无权限；唯一约束 / CHECK / 外键删除策略在真实库上生效。
# 这个项目出过两次“单测与复核都测不出来的角色权限缺口”事故，所以这里不用 owner 角色代跑任何业务路径。
#
# 先做迁移自检：`migrate deploy` 两次（第二次必须“无待迁移”）、`migrate diff` 两个方向都无差异、
# grants 重放两次；跑完做字典 drift 复核；skipped=0 由共用断言
# `scripts/lib/assert-vitest-no-skipped-files.mjs` 硬卡。
set -euo pipefail
set +x

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$"
container_name="cps-novel-revenue-dashboard-pg16-${run_id}"
database_name="cps_novel_revenue_dashboard_${run_id//-/_}"
shadow_database_name="cps_novel_revenue_dashboard_shadow_${run_id//-/_}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-revenue-dashboard-secrets.XXXXXX")"
cleanup_complete="no"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -rf "$secret_dir"
  if ! docker ps -a --format '{{.Names}}' | grep -Fx "$container_name" >/dev/null 2>&1; then
    cleanup_complete="yes"
  fi
  echo "REVENUE_DASHBOARD_DISPOSABLE_DATABASE_CLEANED=${cleanup_complete}"
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
  --mount "type=bind,src=${secret_dir},dst=/run/revenue-dashboard-secrets,readonly" \
  -e POSTGRES_USER=revenue_dashboard_admin \
  -e POSTGRES_PASSWORD_FILE=/run/revenue-dashboard-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U revenue_dashboard_admin -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container_name" pg_isready -U revenue_dashboard_admin -d postgres >/dev/null
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

docker exec -i "$container_name" psql --no-psqlrc -U revenue_dashboard_admin -d postgres \
  <"$project_root/infra/postgres/roles.sql" >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -U revenue_dashboard_admin -d postgres \
  <"$secret_dir/role-passwords.sql" >/dev/null
docker exec "$container_name" createdb -U revenue_dashboard_admin -O migration_owner "$database_name"
docker exec "$container_name" createdb -U revenue_dashboard_admin -O migration_owner "$shadow_database_name"

owner_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
shadow_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${shadow_database_name}?schema=public"
web_url="postgresql://web_app:${web_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
worker_url="postgresql://worker_app:${worker_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
scheduler_url="postgresql://scheduler_app:${scheduler_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
analyst_url="postgresql://analyst_ro:${analyst_password}@127.0.0.1:${host_port}/${database_name}?schema=public"

# --- 迁移自检：应用两次、migrate diff 两个方向都无差异 ----------------------------------
DATABASE_URL="$owner_url" npm exec prisma migrate deploy >/dev/null
reapply_output="$(DATABASE_URL="$owner_url" npm exec prisma migrate deploy)"
if ! grep -F "No pending migrations to apply." <<<"$reapply_output" >/dev/null; then
  echo "REVENUE_DASHBOARD_MIGRATE_REAPPLY=FAIL" >&2
  exit 1
fi
DATABASE_URL="$owner_url" npm exec prisma migrate diff -- \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$shadow_url" \
  --exit-code >/dev/null
DATABASE_URL="$owner_url" npm exec prisma migrate diff -- \
  --from-url "$owner_url" \
  --to-schema-datamodel prisma/schema.prisma \
  --exit-code >/dev/null
echo "REVENUE_DASHBOARD_MIGRATION_DIFF=0"

# grants 回放两次（原子 + 幂等）。
for replay in 1 2; do
  docker exec \
    -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$database_name" \
    -e PGUSER=migration_owner -e PGPASSWORD="$migration_password" \
    "$container_name" psql --no-psqlrc --single-transaction -v ON_ERROR_STOP=1 \
    --file=/workspace/infra/postgres/grants.sql >/dev/null
  echo "REVENUE_DASHBOARD_GRANTS_REPLAY_${replay}=PASS"
done

# 夹具要加密 / 解密一个本地假凭证（同 article-publish-batch 运行器）。
openssl rand -base64 32 >"$secret_dir/credential.key"
export CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION=1
export CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE="$secret_dir/credential.key"
export CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE="$secret_dir/credential.key"

# 开发迭代用：设了 REVENUE_DASHBOARD_TEST_PATTERN 只跑名字匹配的用例，并且**不**打印 PASS
# 取证行（过滤后的运行不是验收证据；正式验收一律不设这个变量）。
pattern_args=()
if [ -n "${REVENUE_DASHBOARD_TEST_PATTERN:-}" ]; then
  pattern_args=(--testNamePattern "$REVENUE_DASHBOARD_TEST_PATTERN")
fi

REVENUE_DASHBOARD_DATABASE_TEST=1 \
REVENUE_DASHBOARD_OWNER_DATABASE_URL="$owner_url" \
REVENUE_DASHBOARD_WEB_DATABASE_URL="$web_url" \
REVENUE_DASHBOARD_WORKER_DATABASE_URL="$worker_url" \
REVENUE_DASHBOARD_SCHEDULER_DATABASE_URL="$scheduler_url" \
REVENUE_DASHBOARD_ANALYST_DATABASE_URL="$analyst_url" \
npm exec vitest run -- --project node \
  tests/integration/revenue/revenue-dashboard-postgres.test.ts \
  ${pattern_args[@]+"${pattern_args[@]}"} \
  --no-file-parallelism --reporter=default --reporter=json --outputFile="$secret_dir/integration-result.json"

if [ -n "${REVENUE_DASHBOARD_TEST_PATTERN:-}" ]; then
  echo "REVENUE_DASHBOARD_FILTERED_RUN=1 (not acceptance evidence; floors and drift check skipped)"
  exit 0
fi

# 硬断言：不允许整文件跳过；通过数不得低于下限（= 该文件当前 it( 用例数）。
# 用 if ! ...; then ...; exit 1; fi 书写，不依赖 set -e 对单独成行断言的行为
# （macOS bash 3.2 下单独成行的 [[ ]] 不触发 set -e）。
if ! node scripts/lib/assert-vitest-no-skipped-files.mjs REVENUE_DASHBOARD "$secret_dir/integration-result.json" \
  tests/integration/revenue/revenue-dashboard-postgres.test.ts=24
then
  echo "REVENUE_DASHBOARD_POSTGRES_VERIFICATION=FAIL (whole-file skip or not-executed assertion failed)" >&2
  exit 1
fi

DATABASE_URL="$owner_url" node scripts/check-database-dictionary-drift.mjs

echo "REVENUE_DASHBOARD_DICTIONARY_DRIFT=0"
echo "REVENUE_DASHBOARD_POSTGRES_VERIFICATION=PASS"
