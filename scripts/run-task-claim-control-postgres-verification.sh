#!/usr/bin/env bash
set -euo pipefail
set +x

# B-31（待办登记 2026-10-06）：任务领取 / 任务控制两个从未被任何运行器打开过的真实库测试文件。
# 同 scripts/run-promo-claim-batch-control-postgres-verification.sh 的既有形状：起一个全新
# PostgreSQL 16.14 容器、建六个最小权限角色（infra/postgres/roles.sql）、迁移、重放
# infra/postgres/grants.sql，再跑两个文件。
#
#   - tests/integration/tasks/task-claim-skip-ineligible-parents-postgres.test.ts
#       开关 TASK_CLAIM_SKIP_INELIGIBLE_DATABASE_TEST；库名守卫要求含 "claimtest"
#   - tests/integration/tasks/x10-task-control-postgres.test.ts
#       开关 X10_TASK_CONTROL_DATABASE_TEST；库名守卫要求含 "taskctl"，并要求 PostgreSQL 16.14
#
# 两个文件都用无参 `new PrismaClient()`（读 DATABASE_URL），且 beforeEach 都 TRUNCATE 整库，
# 所以：DATABASE_URL 指向一次性库的 owner 连接串（TRUNCATE 需要属主权限）；库名同时含两个守卫
# 关键字；用 --no-file-parallelism 串行，避免互相清表。
#
# 缺任何一个开关，对应文件就会整文件静默跳过（vitest 对"整文件全跳过"仍退出 0），
# 所以跑完后用 scripts/lib/assert-vitest-no-skipped-files.mjs 解析 JSON 报告做硬断言。

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$"
container_name="cps-novel-task-claim-control-pg16-${run_id}"
database_name="cps_novel_claimtest_taskctl_${run_id//-/_}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-task-claim-control-secrets.XXXXXX")"
cleanup_complete="no"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -rf "$secret_dir"
  if ! docker ps -a --format '{{.Names}}' | grep -Fx "$container_name" >/dev/null 2>&1; then
    cleanup_complete="yes"
  fi
  echo "TASK_CLAIM_CONTROL_DISPOSABLE_DATABASE_CLEANED=${cleanup_complete}"
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
  --mount "type=bind,src=${secret_dir},dst=/run/task-claim-control-secrets,readonly" \
  -e POSTGRES_USER=task_claim_control_admin \
  -e POSTGRES_PASSWORD_FILE=/run/task-claim-control-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U task_claim_control_admin -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container_name" pg_isready -U task_claim_control_admin -d postgres >/dev/null
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

docker exec -i "$container_name" psql --no-psqlrc -U task_claim_control_admin -d postgres \
  <"$project_root/infra/postgres/roles.sql" >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -U task_claim_control_admin -d postgres \
  <"$secret_dir/role-passwords.sql" >/dev/null
docker exec "$container_name" createdb -U task_claim_control_admin -O migration_owner "$database_name"

owner_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${database_name}?schema=public"

DATABASE_URL="$owner_url" npm exec prisma migrate deploy >/dev/null
docker exec \
  -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$database_name" \
  -e PGUSER=migration_owner -e PGPASSWORD="$migration_password" \
  "$container_name" psql --no-psqlrc --file=/workspace/infra/postgres/grants.sql >/dev/null

TASK_CLAIM_SKIP_INELIGIBLE_DATABASE_TEST=1 \
X10_TASK_CONTROL_DATABASE_TEST=1 \
DATABASE_URL="$owner_url" \
npm exec vitest run -- --project node \
  tests/integration/tasks/task-claim-skip-ineligible-parents-postgres.test.ts \
  tests/integration/tasks/x10-task-control-postgres.test.ts \
  --no-file-parallelism --reporter=default --reporter=json --outputFile="$secret_dir/integration-result.json"

# 硬断言：不允许任何文件被整文件跳过；通过数不得低于下限（= 该文件当前 it( 用例数）。
# 用 if ! ...; then ...; exit 1; fi 书写，不依赖 set -e 对单独成行断言的行为
# （macOS bash 3.2 下单独成行的 [[ ]] 不触发 set -e）。
if ! node scripts/lib/assert-vitest-no-skipped-files.mjs TASK_CLAIM_CONTROL "$secret_dir/integration-result.json" \
  tests/integration/tasks/task-claim-skip-ineligible-parents-postgres.test.ts=12 \
  tests/integration/tasks/x10-task-control-postgres.test.ts=7
then
  echo "TASK_CLAIM_CONTROL_POSTGRES_VERIFICATION=FAIL (whole-file skip or not-executed assertion failed)" >&2
  exit 1
fi

DATABASE_URL="$owner_url" node scripts/check-database-dictionary-drift.mjs

echo "TASK_CLAIM_CONTROL_DICTIONARY_DRIFT=0"
echo "TASK_CLAIM_CONTROL_POSTGRES_VERIFICATION=PASS"
