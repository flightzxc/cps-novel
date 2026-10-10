#!/usr/bin/env bash
# B-38 第二段：公开列表改数据库分页的真实库验证。
#
# 一次性 postgres:16.14（tmpfs、随机口令）+ 真实 infra/postgres/roles.sql + 全部迁移（含
# 20261009120000_b38_novel_effective_tag）+ 真实 infra/postgres/grants.sql，五个真实角色
# （migration_owner / web_app / worker_app / scheduler_app / analyst_ro）各自的连接串传给用例。
# 七个真实库用例文件（tests/integration/site/*-postgres.test.ts）必须全部通过且 skipped=0：
#   1) promo-ready-sql-equivalence：promoReadySql 与 isPromoReady 对 Unicode 基本平面每个字符逐个等价；
#   2) list-equivalence：数据库分页的全部作品页 / 分类页 === 改造前逻辑去掉上限（开关组合各一遍）；
#   3) consistency-invariants：站点地图 / 页脚 / hreflang / 分页 / 作品数同源（每个语种）；
#   4) card-taxonomy-from-table：卡片标签读归属表 === 冻结旧实现；
#   5) blog-pagination：博客列表数据库分页 === 不设上限的参照；
#   6) real-roles：web_app / worker_app 全程无 permission denied；
#   7) scale-trigger：规模触发器的告警日志与 scale-check 退出码（含 60,001 本的真实库）。
# 最后重放 grants 之后跑数据字典漂移检查（drift 必须为 0）。
# 最后一行：B38_PUBLIC_LIST_POSTGRES_VERIFICATION=PASS
set -euo pipefail
set +x

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$"
container_name="cps-novel-b38-public-list-pg16-${run_id}"
database_name="cps_novel_b38_${run_id//-/_}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-b38-public-list-secrets.XXXXXX")"
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
    echo "B38_PUBLIC_LIST_POSTGRES_VERIFICATION=PASS"
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
  --mount "type=bind,src=${secret_dir},dst=/run/b38-public-list-secrets,readonly" \
  -e POSTGRES_USER=b38_admin \
  -e POSTGRES_PASSWORD_FILE=/run/b38-public-list-secrets/bootstrap-password \
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

# 站点地图（分类网址）用例要 SITE_URL 绝对地址；用例自己设置，这里不需要。
B38_DATABASE_TEST=1 \
B38_OWNER_DATABASE_URL="$owner_url" \
B38_WEB_DATABASE_URL="$web_url" \
B38_WORKER_DATABASE_URL="$worker_url" \
B38_SCHEDULER_DATABASE_URL="$scheduler_url" \
B38_ANALYST_DATABASE_URL="$analyst_url" \
npm exec vitest run -- --project node \
  tests/integration/site/promo-ready-sql-equivalence-postgres.test.ts \
  tests/integration/site/list-equivalence-postgres.test.ts \
  tests/integration/site/consistency-invariants-postgres.test.ts \
  tests/integration/site/card-taxonomy-from-table-postgres.test.ts \
  tests/integration/site/blog-pagination-postgres.test.ts \
  tests/integration/site/real-roles-postgres.test.ts \
  tests/integration/site/scale-trigger-postgres.test.ts \
  --no-file-parallelism --reporter=default --reporter=json --outputFile="$secret_dir/integration-result.json"

# 硬断言（B-31 共用断言）：不允许任何文件被整文件跳过；通过数不得低于下限（= 该文件当前用例数）。
# 用 if ! ...; then ...; exit 1; fi 书写，不依赖 set -e 对单独成行断言的行为（macOS bash 3.2）。
if ! node scripts/lib/assert-vitest-no-skipped-files.mjs B38_PUBLIC_LIST "$secret_dir/integration-result.json" \
  tests/integration/site/promo-ready-sql-equivalence-postgres.test.ts=6 \
  tests/integration/site/list-equivalence-postgres.test.ts=34 \
  tests/integration/site/consistency-invariants-postgres.test.ts=71 \
  tests/integration/site/card-taxonomy-from-table-postgres.test.ts=11 \
  tests/integration/site/blog-pagination-postgres.test.ts=9 \
  tests/integration/site/real-roles-postgres.test.ts=5 \
  tests/integration/site/scale-trigger-postgres.test.ts=4; then
  exit 1
fi

DATABASE_URL="$owner_url" node scripts/check-database-dictionary-drift.mjs

echo "B38_DICTIONARY_DRIFT=0"
verification_passed="yes"
