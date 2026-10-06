#!/usr/bin/env bash
set -euo pipefail
set +x

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$"
container_name="cps-novel-catalog-batch-pg16-${run_id}"
# 库名必须同时满足两个守卫：catalog-batch 三个文件要求 `cps_novel_catalog_batch_` 前缀，
# B-31 新接入的 tasks/promo-claim-lifecycle-shard-deadline-postgres.test.ts 要求库名含 `lifecycletest`
# （其 beforeAll 用 /lifecycletest/i 校验）。
database_name="cps_novel_catalog_batch_lifecycletest_${run_id//-/_}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-catalog-batch-secrets.XXXXXX")"
cleanup_complete="no"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -rf "$secret_dir"
  if ! docker ps -a --format '{{.Names}}' | grep -Fx "$container_name" >/dev/null 2>&1; then
    cleanup_complete="yes"
  fi
  echo "CATALOG_BATCH_DISPOSABLE_DATABASE_CLEANED=${cleanup_complete}"
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
  --mount "type=bind,src=${secret_dir},dst=/run/catalog-batch-secrets,readonly" \
  -e POSTGRES_USER=catalog_batch_admin \
  -e POSTGRES_PASSWORD_FILE=/run/catalog-batch-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U catalog_batch_admin -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container_name" pg_isready -U catalog_batch_admin -d postgres >/dev/null
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

docker exec -i "$container_name" psql --no-psqlrc -U catalog_batch_admin -d postgres \
  <"$project_root/infra/postgres/roles.sql" >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -U catalog_batch_admin -d postgres \
  <"$secret_dir/role-passwords.sql" >/dev/null
docker exec "$container_name" createdb -U catalog_batch_admin -O migration_owner "$database_name"

owner_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
web_url="postgresql://web_app:${web_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
worker_url="postgresql://worker_app:${worker_password}@127.0.0.1:${host_port}/${database_name}?schema=public"

DATABASE_URL="$owner_url" npm exec prisma migrate deploy >/dev/null
docker exec \
  -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$database_name" \
  -e PGUSER=migration_owner -e PGPASSWORD="$migration_password" \
  "$container_name" psql --no-psqlrc --file=/workspace/infra/postgres/grants.sql >/dev/null

# B-8（待办登记 2026-09-24）：tests/integration/catalog-batch 下三个文件各有
# 自己的开关，缺任何一个都会整文件静默跳过（vitest 对"整文件全跳过"仍退出 0）：
#   - postgres.test.ts                                           CATALOG_BATCH_DATABASE_TEST + 三个角色连接串
#   - promo-claim-lifecycle-shard-enumeration-postgres.test.ts   PROMO_CLAIM_SHARD_ENUM_DATABASE_TEST
#   - promo-claim-catalog-position-sort-postgres.test.ts         PROMO_CLAIM_CATALOG_POSITION_SORT_DATABASE_TEST
# 后两个文件用无参 `new PrismaClient()`，所以必须给 DATABASE_URL（一次性库的 owner 连接串）；
# 它们的规模旋钮显式钉成默认值（2 万 / 5 千），不受调用者环境里残留的覆盖值影响，
# 也不在常规回归里跑 8 万级（8 万级只在专项验收时手工设置）。
# 三个文件在 beforeEach 里都会 TRUNCATE 整库，所以必须串行（--no-file-parallelism），
# 否则互相清表；它们共用同一个一次性库（库名守卫 cps_novel_catalog_batch_ 前缀天然满足）。
#
# B-31（待办登记 2026-10-06）：同一条领推广生命周期线上还有第 4 个从未被任何运行器打开过的文件，
# 它在 tests/integration/tasks/ 下，不在上面那个目录里：
#   - tasks/promo-claim-lifecycle-shard-deadline-postgres.test.ts   PROMO_CLAIM_LIFECYCLE_DATABASE_TEST（6 用例）
# 同样用无参 `new PrismaClient()`（读 DATABASE_URL = owner）、beforeEach TRUNCATE 整库，
# 所以并入同一次串行运行；库名已按上面的说明含 `lifecycletest`。
#
# 2026-10-06（目录同步页上游上架时间筛选/排序）：postgres.test.ts 新增 18 例（场景 A–F：
# 列表筛选与含当天边界、全选一致性、快照绝对日期、非法输入/历史快照、排序、9.8 万本规模计时），
# 沿用本运行器已有的 CATALOG_BATCH_DATABASE_TEST 与三个角色连接串，不新增任何开关；
# 下方硬断言里 postgres.test.ts 的通过数下限相应由 24 提到 42（零跳过）。
CATALOG_BATCH_DATABASE_TEST=1 \
CATALOG_BATCH_OWNER_DATABASE_URL="$owner_url" \
CATALOG_BATCH_WEB_DATABASE_URL="$web_url" \
CATALOG_BATCH_WORKER_DATABASE_URL="$worker_url" \
PROMO_CLAIM_SHARD_ENUM_DATABASE_TEST=1 \
PROMO_CLAIM_SHARD_ENUM_SCALE_COUNT=20000 \
PROMO_CLAIM_CATALOG_POSITION_SORT_DATABASE_TEST=1 \
PROMO_CLAIM_CATALOG_POSITION_SORT_SCALE_COUNT=5000 \
PROMO_CLAIM_LIFECYCLE_DATABASE_TEST=1 \
DATABASE_URL="$owner_url" \
npm exec vitest run -- --project node tests/integration/catalog-batch \
  tests/integration/tasks/promo-claim-lifecycle-shard-deadline-postgres.test.ts \
  --no-file-parallelism --reporter=default --reporter=json --outputFile="$secret_dir/integration-result.json"

# 硬断言：不允许任何测试文件被整文件跳过。vitest 在整文件全跳过时仍退出 0，
# CLI 退出码不足以证明一次性库被真正演练过。这里解析 JSON 报告：
#   1. 目录里每个 *.test.ts 都必须出现在报告里，且必须是 passed 状态；
#   2. 每个文件至少有 1 个用例，且全部 passed（零 skipped / pending / todo / failed，
#      没有单用例白名单——本运行器的四个文件当前都是零跳过）；
#   3. 四个必需文件（含 B-31 并入的 tasks/ 下那个）各自的通过数不得低于下限
#      （防止有人删用例/删文件后仍然"全绿"）。
# 用 if ! ...; then ...; exit 1; fi 书写，不依赖 set -e 对单独成行断言的行为
# （macOS bash 3.2 下单独成行的 [[ ]] 不触发 set -e）。
if ! node - "$secret_dir/integration-result.json" "$project_root/tests/integration/catalog-batch" \
  "$project_root/tests/integration/tasks/promo-claim-lifecycle-shard-deadline-postgres.test.ts" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const reportPath = process.argv[2];
const testDir = fs.realpathSync(process.argv[3]);
const extraFile = fs.realpathSync(process.argv[4]); // B-31：目录之外并入的文件
const fail = (reason, detail) => {
  console.error(`CATALOG_BATCH_INTEGRATION=FAIL reason=${reason}`);
  for (const line of detail) console.error(`  ${line}`);
  process.exit(1);
};
if (!fs.existsSync(reportPath)) fail("report_missing", [reportPath]);
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const required = new Map([
  ["postgres.test.ts", 42],
  ["promo-claim-lifecycle-shard-enumeration-postgres.test.ts", 4],
  ["promo-claim-catalog-position-sort-postgres.test.ts", 1],
  [path.basename(extraFile), 6],
]);
const byName = new Map();
for (const file of report.testResults ?? []) {
  let resolved = path.resolve(file.name ?? "");
  try { resolved = fs.realpathSync(resolved); } catch { /* keep resolved path */ }
  if (path.dirname(resolved) === testDir || resolved === extraFile) byName.set(path.basename(resolved), file);
}
const onDisk = fs.readdirSync(testDir).filter((name) => name.endsWith(".test.ts")).sort();
const missing = [...new Set([...onDisk, ...required.keys()])].filter((name) => !byName.has(name));
if (missing.length > 0) fail("file_not_in_report", missing);
const offenders = [];
let passedTotal = 0;
for (const name of [...byName.keys()].sort()) {
  const file = byName.get(name);
  const results = file.assertionResults ?? [];
  const passed = results.filter((test) => test.status === "passed").length;
  const notPassed = results.filter((test) => test.status !== "passed");
  passedTotal += passed;
  if (file.status !== "passed" || results.length === 0 || passed === 0 || notPassed.length > 0) {
    const kinds = [...new Set(notPassed.map((test) => test.status))].join(",") || "none";
    offenders.push(`${name} file_status=${file.status} cases=${results.length} passed=${passed} not_passed=${notPassed.length}(${kinds})`);
  } else if (required.has(name) && passed < required.get(name)) {
    offenders.push(`${name} passed=${passed} < required_floor=${required.get(name)}`);
  }
}
if (offenders.length > 0) fail("file_skipped_or_not_executed", offenders);
if (report.numPendingTests !== 0 || report.numTodoTests !== 0 || report.numFailedTests !== 0
    || report.numPassedTests !== passedTotal) {
  fail("totals_mismatch", [`passed=${report.numPassedTests} pending=${report.numPendingTests} todo=${report.numTodoTests} failed=${report.numFailedTests} sum_of_files=${passedTotal}`]);
}
console.log(`CATALOG_BATCH_INTEGRATION=PASS files=${byName.size} passed=${passedTotal} skipped=0`);
NODE
then
  echo "CATALOG_BATCH_POSTGRES_VERIFICATION=FAIL (whole-file skip or not-executed assertion failed)" >&2
  exit 1
fi

DATABASE_URL="$owner_url" node scripts/check-database-dictionary-drift.mjs

echo "CATALOG_BATCH_DICTIONARY_DRIFT=0"
echo "CATALOG_BATCH_POSTGRES_VERIFICATION=PASS"
