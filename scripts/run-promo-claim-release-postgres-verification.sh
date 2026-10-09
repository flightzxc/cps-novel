#!/usr/bin/env bash
set -euo pipefail
set +x

# 领推广链接生命周期正式修复第 2 阶段第 3 步（scheduler 放行/暂停）一次性
# PostgreSQL 16.14 容器验证。仿 scripts/run-catalog-batch-postgres-
# verification.sh / scripts/run-x6-site-setting-postgres-verification.sh 的
# 既有形状：起一个全新容器、建六个最小权限角色（infra/postgres/roles.sql）、
# 迁移、重放 infra/postgres/grants.sql，再用真实 scheduler_app 角色跑
# tests/integration/tasks/promo-claim-release-postgres.test.ts——D7 硬要求
# "scheduler 角色实际能完成放行"的真实数据库验证,不是只读 Prisma schema 猜测。
#
# B-1（v0.5.14）：同一次运行还会跑 tests/integration/tasks/promo-claim-credential-
# replacement-postgres.test.ts——"后台替换凭据 → 批次停在 credential_not_ready →
# scheduler 自动恢复放行"的端到端验收。那个用例要用真实的 web_app 角色调用
# addOrReplaceCredential（需要凭据加密钥匙与指纹钥匙文件，运行器在 secret_dir 里
# 现生成，只存在于本次一次性运行，脚本不会打印钥匙内容）、用 worker_app 角色跑
# credential.validate.v1，所以这里额外传 web/worker 连接串（测试专用变量，不是应用配置）。
#
# scheduler_app 连接串额外带 connection_limit/pool_timeout：并发测试对同一个
# 渠道账号发出 100 次并发放行,每次都要在 Postgres 里排队等同一把咨询锁,默认
# 连接池大小可能不够,把等锁的请求先卡在 Prisma 自己的池排队超时上,而不是卡
# 在真正的锁等待上。

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$"
container_name="cps-novel-promo-claim-release-pg16-${run_id}"
database_name="cps_novel_promo_claim_release_${run_id//-/_}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-promo-claim-release-secrets.XXXXXX")"
cleanup_complete="no"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -rf "$secret_dir"
  if ! docker ps -a --format '{{.Names}}' | grep -Fx "$container_name" >/dev/null 2>&1; then
    cleanup_complete="yes"
  fi
  echo "PROMO_CLAIM_RELEASE_DISPOSABLE_DATABASE_CLEANED=${cleanup_complete}"
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
# B-1 端到端用例需要的凭据加密钥匙 / 指纹钥匙（一次性、32 字节随机、标准 base64），
# 写文件不 echo；键名与文件名约定同 scripts/run-p1-08b-postgres-verification.sh。
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
  --mount "type=bind,src=${secret_dir},dst=/run/promo-claim-release-secrets,readonly" \
  -e POSTGRES_USER=promo_claim_release_admin \
  -e POSTGRES_PASSWORD_FILE=/run/promo-claim-release-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U promo_claim_release_admin -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container_name" pg_isready -U promo_claim_release_admin -d postgres >/dev/null
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

docker exec -i "$container_name" psql --no-psqlrc -U promo_claim_release_admin -d postgres \
  <"$project_root/infra/postgres/roles.sql" >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -U promo_claim_release_admin -d postgres \
  <"$secret_dir/role-passwords.sql" >/dev/null
docker exec "$container_name" createdb -U promo_claim_release_admin -O migration_owner "$database_name"

owner_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
scheduler_url="postgresql://scheduler_app:${scheduler_password}@127.0.0.1:${host_port}/${database_name}?schema=public&connection_limit=50&pool_timeout=60"
web_url="postgresql://web_app:${web_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
worker_url="postgresql://worker_app:${worker_password}@127.0.0.1:${host_port}/${database_name}?schema=public"

DATABASE_URL="$owner_url" npm exec prisma migrate deploy >/dev/null
docker exec \
  -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$database_name" \
  -e PGUSER=migration_owner -e PGPASSWORD="$migration_password" \
  "$container_name" psql --no-psqlrc --file=/workspace/infra/postgres/grants.sql >/dev/null

# 两个测试文件一次性跑完并输出 JSON 报告。CHANNEL_CREDENTIAL_* 只有 B-1 端到端用例会读
# （经 loadCredentialKeyring 读文件）；promo-claim-release-postgres.test.ts 与 scheduler 的
# env 对象都不含它们。
PROMO_CLAIM_RELEASE_DATABASE_TEST=1 \
PROMO_CLAIM_RELEASE_OWNER_DATABASE_URL="$owner_url" \
PROMO_CLAIM_RELEASE_WEB_DATABASE_URL="$web_url" \
PROMO_CLAIM_RELEASE_WORKER_DATABASE_URL="$worker_url" \
PROMO_CLAIM_RELEASE_SCHEDULER_DATABASE_URL="$scheduler_url" \
CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION=1 \
CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE="$secret_dir/credential-v1.key" \
CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE="$secret_dir/credential-fingerprint.key" \
npm exec vitest run -- --project node \
  tests/integration/tasks/promo-claim-release-postgres.test.ts \
  tests/integration/tasks/promo-claim-credential-replacement-postgres.test.ts \
  --no-file-parallelism --reporter=default --reporter=json --outputFile="$secret_dir/integration-result.json"

# 硬断言（B-31 共用断言）：不允许任何文件被整文件跳过；通过数不得低于下限（= 该文件当前用例数）。
# 用 if ! ...; then ...; exit 1; fi 书写，不依赖 set -e 对单独成行断言的行为（macOS bash 3.2）。
if ! node scripts/lib/assert-vitest-no-skipped-files.mjs PROMO_CLAIM_RELEASE "$secret_dir/integration-result.json" \
  tests/integration/tasks/promo-claim-release-postgres.test.ts=24 \
  tests/integration/tasks/promo-claim-credential-replacement-postgres.test.ts=4; then
  exit 1
fi

DATABASE_URL="$owner_url" node scripts/check-database-dictionary-drift.mjs

echo "PROMO_CLAIM_RELEASE_DICTIONARY_DRIFT=0"
echo "PROMO_CLAIM_RELEASE_POSTGRES_VERIFICATION=PASS"
