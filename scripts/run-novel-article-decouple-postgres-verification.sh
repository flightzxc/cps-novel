#!/usr/bin/env bash
# 小说/文章解耦真实 PostgreSQL 探针（T04 / T16 / T26 / T27）的运行器：
#   tests/integration/content-creation/novel-article-decouple-postgres.test.ts
#
# 这个文件落地后一直没有运行器：NOVEL_ARTICLE_DECOUPLE_DATABASE_TEST 在 scripts/ 与
# .github/ 里一处都没设过，describe.skipIf 让它在 npm test 里恒跳过。
#
# 一次性 PG16 容器 + roles.sql + 全量 migration + grants.sql，三种身份按文件头：
# migration_owner 只做夹具，worker_app 跑并发建小说/建文章，web_app 跑 T26 的 INSERT。
# 连接串变量沿用文件头的 P1_06_OWNER/WEB/WORKER_DATABASE_URL（与
# run-p1-06-postgres-verification.sh 同名，但那个运行器不设本文件的门禁开关）。文件
# 自带库名守卫：库名必须以 cps_novel_article_decouple_ 开头、不得含 p1_06 等共享库
# 片段、三个身份必须同库——所以这里的库名照这个前缀起。
# 结束时删除容器与数据卷。
set -euo pipefail
set +x

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$"
container_name="cps-novel-article-decouple-pg16-${run_id}"
volume_name="cps-novel-article-decouple-pgdata-${run_id}"
database_name="cps_novel_article_decouple_${run_id//-/_}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-article-decouple.XXXXXX")"
cleanup_ran="no"

cleanup() {
  [[ "$cleanup_ran" == "no" ]] || return 0
  cleanup_ran="yes"
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  docker volume rm "$volume_name" >/dev/null 2>&1 || true
  rm -rf "$secret_dir"
  if docker ps -a --format '{{.Names}}' | grep -Fx "$container_name" >/dev/null 2>&1 \
    || docker volume ls --format '{{.Name}}' | grep -Fx "$volume_name" >/dev/null 2>&1; then
    echo "DISPOSABLE_DATABASE_CLEANED=no"
  else
    echo "DISPOSABLE_DATABASE_CLEANED=yes"
  fi
}
trap cleanup EXIT INT TERM

umask 077
bootstrap_password="$(openssl rand -hex 24)"
migration_password="$(openssl rand -hex 24)"
web_password="$(openssl rand -hex 24)"
worker_password="$(openssl rand -hex 24)"
printf '%s' "$bootstrap_password" >"$secret_dir/bootstrap-password"
printf "ALTER ROLE migration_owner PASSWORD '%s';\n" "$migration_password" >"$secret_dir/role-passwords.sql"
printf "ALTER ROLE web_app PASSWORD '%s';\n" "$web_password" >>"$secret_dir/role-passwords.sql"
printf "ALTER ROLE worker_app PASSWORD '%s';\n" "$worker_password" >>"$secret_dir/role-passwords.sql"
chmod 600 "$secret_dir"/*

cd "$project_root"
if [[ ! -x node_modules/.bin/prisma || ! -x node_modules/.bin/vitest ]]; then
  npm ci
fi

if ! docker image inspect postgres:16.14 >/dev/null 2>&1; then
  mkdir -p "$secret_dir/docker-config"
  printf '{}\n' >"$secret_dir/docker-config/config.json"
  DOCKER_CONFIG="$secret_dir/docker-config" docker pull postgres:16.14 >/dev/null
fi

docker volume create "$volume_name" >/dev/null
docker run -d \
  --name "$container_name" \
  --mount "type=volume,src=${volume_name},dst=/var/lib/postgresql/data" \
  --mount "type=bind,src=${secret_dir},dst=/run/article-decouple-secrets,readonly" \
  -e POSTGRES_USER=article_decouple_admin \
  -e POSTGRES_PASSWORD_FILE=/run/article-decouple-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

ready="no"
for _ in $(seq 1 60); do
  # 走容器内 TCP 而不是 unix socket：镜像初始化期间的临时服务器 listen_addresses=''、只开
  # socket，socket 探针会在它上面提前报就绪，紧接着它被关停重启，下一条 psql 就撞上
  # "No such file or directory"。
  if docker exec "$container_name" pg_isready -h 127.0.0.1 -U article_decouple_admin -d postgres >/dev/null 2>&1; then
    ready="yes"
    break
  fi
  sleep 1
done
# macOS /bin/bash 3.2：独立成行的 `[[ ]]` 判假时 set -e 不中止，必须显式短路。
[[ "$ready" == "yes" ]] || { echo "postgres did not become ready" >&2; exit 1; }

docker exec -i "$container_name" psql --no-psqlrc -v ON_ERROR_STOP=1 -U article_decouple_admin -d postgres \
  <"$project_root/infra/postgres/roles.sql" >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -v ON_ERROR_STOP=1 -U article_decouple_admin -d postgres \
  <"$secret_dir/role-passwords.sql" >/dev/null
docker exec "$container_name" createdb -U article_decouple_admin -O migration_owner "$database_name"
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

owner_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
web_url="postgresql://web_app:${web_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
worker_url="postgresql://worker_app:${worker_password}@127.0.0.1:${host_port}/${database_name}?schema=public"

DATABASE_URL="$owner_url" npx prisma validate
DATABASE_URL="$owner_url" npx prisma generate
DATABASE_URL="$owner_url" npx prisma migrate deploy
docker exec -i "$container_name" \
  psql --no-psqlrc --single-transaction -v ON_ERROR_STOP=1 -U migration_owner -d "$database_name" \
  <"$project_root/infra/postgres/grants.sql" >/dev/null

vitest_log="$secret_dir/vitest.log"
NOVEL_ARTICLE_DECOUPLE_DATABASE_TEST=1 \
P1_06_OWNER_DATABASE_URL="$owner_url" \
P1_06_WEB_DATABASE_URL="$web_url" \
P1_06_WORKER_DATABASE_URL="$worker_url" \
npx vitest run --project node tests/integration/content-creation/novel-article-decouple-postgres.test.ts 2>&1 \
  | tee "$vitest_log"
# 门禁变量拼错会让整个 describe 被 skipIf 跳过而退出码仍为 0；要求摘要恰为
# "Tests 4 passed (4)"（T04/T16/T26/T27）——一条都不许跳过或缺席。
grep -Eq '^ +Tests +4 passed \(4\)$' "$vitest_log" \
  || { echo "NOVEL_ARTICLE_DECOUPLE=FAIL reason=not_all_executed expected=4" >&2; exit 1; }

echo "NOVEL_ARTICLE_DECOUPLE_POSTGRES_VERIFICATION=PASS"
