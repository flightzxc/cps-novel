#!/usr/bin/env bash
# B-38 第二段：公开列表的规模 / 性能基准（接近生产规模的合成数据）。
#
# 一次性 postgres:16.14（tmpfs、随机口令；shared_buffers 512MB / work_mem 16MB / random_page_cost 1.1，
# 与方案附录 D 的本机实测环境一致）+ 真实 roles.sql + 全部迁移 + 真实 grants.sql，然后灌合成数据
# （tests/integration/site/fixtures/scale-seed.ts：英语约 4 万本、约 1.3 万本列表可见，4 个小语种，映射边 200 条）、
# 算归属表、ANALYZE，最后跑基准用例 tests/integration/site/public-list-bench-postgres.test.ts（B38_BENCH=1）。
#
# 输出：`B38_BENCH name=<名字> median_ms=<毫秒>`（每个被测函数 6 次取后 5 次中位数）和
# `B38_PLAN name=<名字> top=<顶层计划类型> seq_scans=<被顺序扫描的表>`。
# 旧代码（v0.5.12）的对比：把 scale-seed.ts 拷进旧 worktree，在同样配置的一次性库里用
# `B38_SEED_RUN=1 B38_SEED_DATABASE_URL=… npx vite-node tests/integration/site/fixtures/scale-seed.ts` 灌同一份数据
# （种子只写表、不依赖新函数，不碰归属表），再用旧代码的函数跑同样的查询。
# 最后一行：B38_PUBLIC_LIST_BENCH=PASS
set -euo pipefail
set +x

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$"
container_name="cps-novel-b38-public-list-bench-pg16-${run_id}"
database_name="cps_novel_b38_${run_id//-/_}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-b38-public-list-bench-secrets.XXXXXX")"
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
    echo "B38_PUBLIC_LIST_BENCH=PASS"
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
  --shm-size=1g \
  --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=4g \
  --mount "type=bind,src=${project_root},dst=/workspace,readonly" \
  --mount "type=bind,src=${secret_dir},dst=/run/b38-public-list-bench-secrets,readonly" \
  -e POSTGRES_USER=b38_admin \
  -e POSTGRES_PASSWORD_FILE=/run/b38-public-list-bench-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 \
  -c shared_buffers=512MB -c work_mem=16MB -c random_page_cost=1.1 >/dev/null

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

B38_BENCH=1 \
B38_DATABASE_TEST=1 \
B38_OWNER_DATABASE_URL="$owner_url" \
B38_WEB_DATABASE_URL="$web_url" \
B38_WORKER_DATABASE_URL="$worker_url" \
B38_SCHEDULER_DATABASE_URL="$scheduler_url" \
B38_ANALYST_DATABASE_URL="$analyst_url" \
npm exec vitest run -- --project node \
  tests/integration/site/public-list-bench-postgres.test.ts \
  --no-file-parallelism --reporter=default --reporter=json --outputFile="$secret_dir/bench-result.json"

# 基准用例不允许被跳过（缺 B38_BENCH 时 skipIf 会整文件跳过且退出 0）。
if ! node scripts/lib/assert-vitest-no-skipped-files.mjs B38_BENCH "$secret_dir/bench-result.json" \
  tests/integration/site/public-list-bench-postgres.test.ts=4; then
  exit 1
fi

verification_passed="yes"
