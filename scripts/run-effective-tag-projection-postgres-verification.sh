#!/usr/bin/env bash
# B-38 第一段：小说分类归属投影（novel_effective_tag）的真实库验证。
#
# 一次性 postgres:16.14（tmpfs、随机口令）+ 真实 infra/postgres/roles.sql + 全部迁移（含
# 20261009120000_b38_novel_effective_tag）+ 真实 infra/postgres/grants.sql，五个真实角色
# （migration_owner / web_app / worker_app / scheduler_app / analyst_ro）各自的连接串传给用例。
# 三个真实库用例文件（tests/integration/tagging/effective-tag-*-postgres.test.ts）必须全部通过且
# skipped=0：
#   1) projection-equivalence：与改造前现场计算（tests/fixtures/public-taxonomy-before-b38.ts）逐行等价、
#      迁移首建段与全量对账逐行一致、稳定状态零写入、检查命令、权限、事务闸；
#   2) write-points：每个写入点用真实角色走真实服务函数 / 处理器；
#   3) concurrency：咨询锁 50212 与书行锁、锁顺序。
# 最后重放 grants 之后跑数据字典漂移检查（drift 必须为 0）。
# 最后一行：B38_EFFECTIVE_TAG_POSTGRES_VERIFICATION=PASS
set -euo pipefail
set +x

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$"
container_name="cps-novel-b38-effective-tag-pg16-${run_id}"
database_name="cps_novel_b38_${run_id//-/_}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-b38-effective-tag-secrets.XXXXXX")"
cleanup_complete="no"
verification_passed="no"

cleanup() {
  local status=$?
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -rf "$secret_dir"
  if ! docker ps -a --format '{{.Names}}' | grep -Fx "$container_name" >/dev/null 2>&1; then
    cleanup_complete="yes"
  fi
  echo "B38_DISPOSABLE_DATABASE_CLEANED=${cleanup_complete}"
  # 最后一行：只有所有断言都过、且一次性库已清理，才打印 PASS（失败时这一行绝不出现）
  if [ "$status" -eq 0 ] && [ "$verification_passed" = "yes" ] && [ "$cleanup_complete" = "yes" ]; then
    echo "B38_EFFECTIVE_TAG_POSTGRES_VERIFICATION=PASS"
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
  --mount "type=bind,src=${secret_dir},dst=/run/b38-effective-tag-secrets,readonly" \
  -e POSTGRES_USER=b38_admin \
  -e POSTGRES_PASSWORD_FILE=/run/b38-effective-tag-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U b38_admin -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container_name" pg_isready -U b38_admin -d postgres >/dev/null
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

docker exec -i "$container_name" psql --no-psqlrc -U b38_admin -d postgres \
  <"$project_root/infra/postgres/roles.sql" >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -U b38_admin -d postgres \
  <"$secret_dir/role-passwords.sql" >/dev/null
docker exec "$container_name" createdb -U b38_admin -O migration_owner "$database_name"

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
  echo "B38_MIGRATION_COUNT=FAIL applied=${applied_migrations} expected=${expected_migrations}" >&2
  exit 1
fi
echo "B38_MIGRATION_COUNT=PASS applied=${applied_migrations}"
docker exec \
  -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$database_name" \
  -e PGUSER=migration_owner -e PGPASSWORD="$migration_password" \
  "$container_name" psql --no-psqlrc --file=/workspace/infra/postgres/grants.sql >/dev/null

# 目录同步写入点用例要加密一条真实凭证（worker/credentials/crypto）。密钥只存在一次性目录里。
openssl rand -base64 32 >"$secret_dir/credential.key"
export CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION=1
export CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE="$secret_dir/credential.key"
export CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE="$secret_dir/credential.key"

B38_DATABASE_TEST=1 \
B38_OWNER_DATABASE_URL="$owner_url" \
B38_WEB_DATABASE_URL="$web_url" \
B38_WORKER_DATABASE_URL="$worker_url" \
B38_SCHEDULER_DATABASE_URL="$scheduler_url" \
B38_ANALYST_DATABASE_URL="$analyst_url" \
npm exec vitest run -- --project node \
  tests/integration/tagging/effective-tag-projection-equivalence-postgres.test.ts \
  tests/integration/tagging/effective-tag-write-points-postgres.test.ts \
  tests/integration/tagging/effective-tag-concurrency-postgres.test.ts \
  --no-file-parallelism --reporter=default --reporter=json --outputFile="$secret_dir/integration-result.json"

node - "$secret_dir/integration-result.json" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const files = report.testResults ?? [];
const skipped = report.numPendingTests ?? -1;
if (files.length !== 3 || files.some(f => f.status !== "passed" || !f.assertionResults?.length)
    || skipped !== 0 || report.numFailedTests !== 0 || report.numPassedTests < 32) {
  throw new Error(`B38_EFFECTIVE_TAG_INTEGRATION=FAIL files=${files.length} passed=${report.numPassedTests} skipped=${skipped} failed=${report.numFailedTests}`);
}
console.log(`B38_EFFECTIVE_TAG_INTEGRATION=PASS files=${files.length} passed=${report.numPassedTests} skipped=${skipped} failed=${report.numFailedTests}`);
NODE

DATABASE_URL="$owner_url" node scripts/check-database-dictionary-drift.mjs

echo "B38_DICTIONARY_DRIFT=0"
verification_passed="yes"
