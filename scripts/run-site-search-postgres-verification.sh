#!/usr/bin/env bash
# PN-15 站内搜索：真实库验证。
#
# 一次性 postgres:16.14（tmpfs、随机口令）+ 真实 infra/postgres/roles.sql + 全部迁移 + 真实 infra/postgres/grants.sql，
# 五个真实角色（migration_owner / web_app / worker_app / scheduler_app / analyst_ro）各自的连接串传给用例；
# 搜索全程用 web_app 连接（公开站读路径的真实身份），scheduler_app 用来证明最小权限没有被放宽。
# 真实库用例 tests/integration/site/site-search-postgres.test.ts 必须全部通过且 skipped=0（按文件写死期望用例数）：
#   搜索结果 ⊆ 列表可见集合（逐类反例 + 与独立参照逐 id 相等）、LIKE 元字符字面匹配、两边 NFKC + 小写折叠、
#   分档次序与同档排序、分页总数 / 最后一页 / 越界页 / 巨大页码、只搜书名。
# 只有全部通过且一次性库已清理，才在最后一行打印：PN15_SITE_SEARCH_POSTGRES_VERIFICATION=PASS
#
# 用法：
#   bash scripts/run-site-search-postgres-verification.sh            # 验证（默认）
#   bash scripts/run-site-search-postgres-verification.sh --bench    # 本机规模测量（约 1.4 万本英语列表可见书；
#                                                                      打印 PN15_SEARCH_BENCH ... 行，最后一行
#                                                                      PN15_SITE_SEARCH_BENCH=DONE；不打印 PASS 行）
set -euo pipefail
set +x

mode="verify"
case "${1:-}" in
  "") ;;
  --bench) mode="bench" ;;
  *) echo "usage: $0 [--bench]" >&2; exit 2 ;;
esac

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$"
container_name="cps-novel-pn15-search-pg16-${run_id}"
# 夹具的守卫要求库名以 cps_novel_b38_ 开头（assertIsolatedDatabase）。
database_name="cps_novel_b38_pn15_${run_id//-/_}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-pn15-search-secrets.XXXXXX")"
cleanup_complete="no"
verification_passed="no"

cleanup() {
  local status=$?
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -rf "$secret_dir"
  if ! docker ps -a --format '{{.Names}}' | grep -Fx "$container_name" >/dev/null 2>&1; then
    cleanup_complete="yes"
  fi
  echo "PN15_DISPOSABLE_DATABASE_CLEANED=${cleanup_complete}"
  # 最后一行：只有所有断言都过、且一次性库已清理，才打印结论行（失败时这一行绝不出现）
  if [ "$status" -eq 0 ] && [ "$verification_passed" = "yes" ] && [ "$cleanup_complete" = "yes" ]; then
    if [ "$mode" = "bench" ]; then
      echo "PN15_SITE_SEARCH_BENCH=DONE"
    else
      echo "PN15_SITE_SEARCH_POSTGRES_VERIFICATION=PASS"
    fi
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
  --mount "type=bind,src=${secret_dir},dst=/run/pn15-search-secrets,readonly" \
  -e POSTGRES_USER=pn15_admin \
  -e POSTGRES_PASSWORD_FILE=/run/pn15-search-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U pn15_admin -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container_name" pg_isready -U pn15_admin -d postgres >/dev/null
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

docker exec -i "$container_name" psql --no-psqlrc -U pn15_admin -d postgres \
  <"$project_root/infra/postgres/roles.sql" >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -U pn15_admin -d postgres \
  <"$secret_dir/role-passwords.sql" >/dev/null
docker exec "$container_name" createdb -U pn15_admin -O migration_owner "$database_name"

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
  echo "PN15_MIGRATION_COUNT=FAIL applied=${applied_migrations} expected=${expected_migrations}" >&2
  exit 1
fi
echo "PN15_MIGRATION_COUNT=PASS applied=${applied_migrations}"
docker exec \
  -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$database_name" \
  -e PGUSER=migration_owner -e PGPASSWORD="$migration_password" \
  "$container_name" psql --no-psqlrc --file=/workspace/infra/postgres/grants.sql >/dev/null

if [ "$mode" = "bench" ]; then
  # 规模测量：只跑基准文件，不做用例数断言；基准文件自己在数据库耗时异常时报错。
  B38_DATABASE_TEST=1 \
  PN15_SEARCH_BENCH=1 \
  B38_OWNER_DATABASE_URL="$owner_url" \
  B38_WEB_DATABASE_URL="$web_url" \
  B38_WORKER_DATABASE_URL="$worker_url" \
  B38_SCHEDULER_DATABASE_URL="$scheduler_url" \
  B38_ANALYST_DATABASE_URL="$analyst_url" \
  npm exec vitest run -- --project node \
    tests/integration/site/site-search-bench-postgres.test.ts \
    --no-file-parallelism --reporter=default
  verification_passed="yes"
else
  B38_DATABASE_TEST=1 \
  B38_OWNER_DATABASE_URL="$owner_url" \
  B38_WEB_DATABASE_URL="$web_url" \
  B38_WORKER_DATABASE_URL="$worker_url" \
  B38_SCHEDULER_DATABASE_URL="$scheduler_url" \
  B38_ANALYST_DATABASE_URL="$analyst_url" \
  npm exec vitest run -- --project node \
    tests/integration/site/site-search-postgres.test.ts \
    --no-file-parallelism --reporter=default --reporter=json --outputFile="$secret_dir/integration-result.json"

  # 硬断言（B-31 共用断言）：不允许任何文件被整文件跳过；通过数不得低于下限（= 该文件当前用例数）。
  # 用 if ! ...; then ...; exit 1; fi 书写，不依赖 set -e 对单独成行断言的行为（macOS bash 3.2）。
  if ! node scripts/lib/assert-vitest-no-skipped-files.mjs PN15_SITE_SEARCH "$secret_dir/integration-result.json" \
    tests/integration/site/site-search-postgres.test.ts=30; then
    exit 1
  fi
  verification_passed="yes"
fi
