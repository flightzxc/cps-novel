#!/usr/bin/env bash
set -euo pipefail
set +x

# B-31（待办登记 2026-10-06）：文章 博客 / 换绑 / 批量发布 六个从未被任何运行器打开过的真实库测试文件。
# 同 scripts/run-promo-claim-batch-control-postgres-verification.sh 的既有形状：起一个全新
# PostgreSQL 16.14 容器、建六个最小权限角色（infra/postgres/roles.sql）、迁移、重放
# infra/postgres/grants.sql，再用 owner 连接串跑下列文件（各自开关与库名守卫）：
#
#   - database/c27-blog-article-postgres.test.ts         C27_DATABASE_TEST          库名含 "c27"
#   - database/c28-blog-article-postgres.test.ts         C28_DATABASE_TEST          库名含 "c28"
#   - database/c29-blog-public-postgres.test.ts          C29_DATABASE_TEST          库名含 "c29"
#   - article-rebind/two-field-atomic.test.ts            C30_DATABASE_TEST          库名含 "c30"
#   - article-rebind/batch-200.test.ts                   C30_DATABASE_TEST          库名含 "c30"
#   - publish-gate/batch-publish-postgres.test.ts        PUBLISH_BATCH_DATABASE_TEST + PUBLISH_BATCH_DATABASE_URL
#                                                        （无库名守卫、不 TRUNCATE，只清自己造的行）
#
# 前五个文件都用无参 `new PrismaClient()`（读 DATABASE_URL），且都会 TRUNCATE 整库；
# C-30 两个文件还各自用 pg_advisory_lock 互斥（见 batch-200.test.ts 的 SUITE_LOCK_KEY 注释）。
# 所以：DATABASE_URL 指向一次性库的 owner 连接串；库名同时含 c27/c28/c29/c30 四个守卫关键字；
# 用 --no-file-parallelism 串行，避免互相清表（批量发布文件造的 operation_audit 行有只追加
# 触发器、清不掉，但后面的文件一开头就 TRUNCATE，不受影响）。
#
# 缺任何一个开关，对应文件就会整文件静默跳过（vitest 对"整文件全跳过"仍退出 0），
# 所以跑完后用 scripts/lib/assert-vitest-no-skipped-files.mjs 解析 JSON 报告做硬断言。

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$"
container_name="cps-novel-article-blog-rebind-pg16-${run_id}"
database_name="cps_novel_c27_c28_c29_c30_${run_id//-/_}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-article-blog-rebind-secrets.XXXXXX")"
cleanup_complete="no"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -rf "$secret_dir"
  if ! docker ps -a --format '{{.Names}}' | grep -Fx "$container_name" >/dev/null 2>&1; then
    cleanup_complete="yes"
  fi
  echo "ARTICLE_BLOG_REBIND_DISPOSABLE_DATABASE_CLEANED=${cleanup_complete}"
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
  --mount "type=bind,src=${secret_dir},dst=/run/article-blog-rebind-secrets,readonly" \
  -e POSTGRES_USER=article_blog_rebind_admin \
  -e POSTGRES_PASSWORD_FILE=/run/article-blog-rebind-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U article_blog_rebind_admin -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container_name" pg_isready -U article_blog_rebind_admin -d postgres >/dev/null
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

docker exec -i "$container_name" psql --no-psqlrc -U article_blog_rebind_admin -d postgres \
  <"$project_root/infra/postgres/roles.sql" >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -U article_blog_rebind_admin -d postgres \
  <"$secret_dir/role-passwords.sql" >/dev/null
docker exec "$container_name" createdb -U article_blog_rebind_admin -O migration_owner "$database_name"

owner_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${database_name}?schema=public"

DATABASE_URL="$owner_url" npm exec prisma migrate deploy >/dev/null
docker exec \
  -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$database_name" \
  -e PGUSER=migration_owner -e PGPASSWORD="$migration_password" \
  "$container_name" psql --no-psqlrc --file=/workspace/infra/postgres/grants.sql >/dev/null

C27_DATABASE_TEST=1 \
C28_DATABASE_TEST=1 \
C29_DATABASE_TEST=1 \
C30_DATABASE_TEST=1 \
PUBLISH_BATCH_DATABASE_TEST=1 \
PUBLISH_BATCH_DATABASE_URL="$owner_url" \
DATABASE_URL="$owner_url" \
npm exec vitest run -- --project node \
  tests/integration/database/c27-blog-article-postgres.test.ts \
  tests/integration/database/c28-blog-article-postgres.test.ts \
  tests/integration/database/c29-blog-public-postgres.test.ts \
  tests/integration/article-rebind/two-field-atomic.test.ts \
  tests/integration/article-rebind/batch-200.test.ts \
  tests/integration/publish-gate/batch-publish-postgres.test.ts \
  --no-file-parallelism --reporter=default --reporter=json --outputFile="$secret_dir/integration-result.json"

# 硬断言：不允许任何文件被整文件跳过；通过数不得低于下限（= 该文件当前用例数）。
# 用 if ! ...; then ...; exit 1; fi 书写，不依赖 set -e 对单独成行断言的行为
# （macOS bash 3.2 下单独成行的 [[ ]] 不触发 set -e）。
if ! node scripts/lib/assert-vitest-no-skipped-files.mjs ARTICLE_BLOG_REBIND "$secret_dir/integration-result.json" \
  tests/integration/database/c27-blog-article-postgres.test.ts=11 \
  tests/integration/database/c28-blog-article-postgres.test.ts=3 \
  tests/integration/database/c29-blog-public-postgres.test.ts=5 \
  tests/integration/article-rebind/two-field-atomic.test.ts=4 \
  tests/integration/article-rebind/batch-200.test.ts=5 \
  tests/integration/publish-gate/batch-publish-postgres.test.ts=16
then
  echo "ARTICLE_BLOG_REBIND_POSTGRES_VERIFICATION=FAIL (whole-file skip or not-executed assertion failed)" >&2
  exit 1
fi

DATABASE_URL="$owner_url" node scripts/check-database-dictionary-drift.mjs

echo "ARTICLE_BLOG_REBIND_DICTIONARY_DRIFT=0"
echo "ARTICLE_BLOG_REBIND_POSTGRES_VERIFICATION=PASS"
