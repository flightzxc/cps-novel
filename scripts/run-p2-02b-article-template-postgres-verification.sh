#!/usr/bin/env bash
# P2-02B 两个真实 PostgreSQL 冒烟的运行器：
#   - tests/integration/article-templates/p2-02b-postgres.test.ts（模板生命周期）
#   - tests/integration/article-templates/p2-02b-article-render-postgres.test.ts
#     （模板 → 生成文章 → 公开正文/SEO）
#
# 这两个文件落地后一直没有运行器：P2_02B_DATABASE_TEST 在 scripts/ 与 .github/ 里
# 一处都没设过，describe.skipIf 让它们在 npm test 里恒跳过。生命周期冒烟存在的理由
# 恰恰是 article_template.status CHECK 缺陷——带 fake db 的单测看不见，只有真库能看见。
#
# 一次性 PG16 容器 + roles.sql + 全量 migration + grants.sql，连接身份按各文件头：
#   - 生命周期：只给 web_app（文件头：刻意用最小权限角色，漏授权才会暴露）；
#   - 渲染：web_app 走建模板/再生成/公开读取，migration_owner 只做夹具插入。
# 两个文件各用一个库。两者都会在 en 下建启用模板，而 regenerateArticle 对未绑模板的
# 文章按"最早创建的启用 en 模板"选版；同库并行时，生命周期的 smoke-* 模板在其第 1～5
# 步之间正是一条启用的 en 模板，可能先于渲染模板被选中，渲染文件的标题断言随之失败。
# 分库后两者都以空库为前提，与执行顺序、是否并行都无关。
# template-version-selection-postgres.test.ts 要求 en/ru/ja 下没有任何模板，这两个
# 文件跑完都会留下 en 模板，所以也绝不能与它共库——它有自己的运行器和容器。
# 结束时删除容器与数据卷。
set -euo pipefail
set +x

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$"
container_name="cps-novel-p2-02b-template-pg16-${run_id}"
volume_name="cps-novel-p2-02b-template-pgdata-${run_id}"
lifecycle_database="cps_novel_p2_02b_lifecycle_${run_id//-/_}"
render_database="cps_novel_p2_02b_render_${run_id//-/_}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-p2-02b-template.XXXXXX")"
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

# 两个文件在缺连接串时都会回落到 DATABASE_URL；清掉它，门禁变量拼错只会连不上库，
# 不会悄悄连到调用者环境里的别的库。
unset DATABASE_URL

umask 077
bootstrap_password="$(openssl rand -hex 24)"
migration_password="$(openssl rand -hex 24)"
web_password="$(openssl rand -hex 24)"
printf '%s' "$bootstrap_password" >"$secret_dir/bootstrap-password"
printf "ALTER ROLE migration_owner PASSWORD '%s';\n" "$migration_password" >"$secret_dir/role-passwords.sql"
printf "ALTER ROLE web_app PASSWORD '%s';\n" "$web_password" >>"$secret_dir/role-passwords.sql"
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
  --mount "type=bind,src=${secret_dir},dst=/run/p2-02b-secrets,readonly" \
  -e POSTGRES_USER=p2_02b_admin \
  -e POSTGRES_PASSWORD_FILE=/run/p2-02b-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

ready="no"
for _ in $(seq 1 60); do
  # 走容器内 TCP 而不是 unix socket：镜像初始化期间的临时服务器 listen_addresses=''、只开
  # socket，socket 探针会在它上面提前报就绪，紧接着它被关停重启，下一条 psql 就撞上
  # "No such file or directory"。
  if docker exec "$container_name" pg_isready -h 127.0.0.1 -U p2_02b_admin -d postgres >/dev/null 2>&1; then
    ready="yes"
    break
  fi
  sleep 1
done
# macOS /bin/bash 3.2：独立成行的 `[[ ]]` 判假时 set -e 不中止，必须显式短路。
[[ "$ready" == "yes" ]] || { echo "postgres did not become ready" >&2; exit 1; }

docker exec -i "$container_name" psql --no-psqlrc -v ON_ERROR_STOP=1 -U p2_02b_admin -d postgres \
  <"$project_root/infra/postgres/roles.sql" >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -v ON_ERROR_STOP=1 -U p2_02b_admin -d postgres \
  <"$secret_dir/role-passwords.sql" >/dev/null
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

role_url() {
  local role="$1" password="$2" database="$3"
  printf 'postgresql://%s:%s@127.0.0.1:%s/%s?schema=public' "$role" "$password" "$host_port" "$database"
}

prepare_database() {
  local database="$1"
  docker exec "$container_name" createdb -U p2_02b_admin -O migration_owner "$database"
  DATABASE_URL="$(role_url migration_owner "$migration_password" "$database")" npx prisma migrate deploy
  docker exec -i "$container_name" \
    psql --no-psqlrc --single-transaction -v ON_ERROR_STOP=1 -U migration_owner -d "$database" \
    <"$project_root/infra/postgres/grants.sql" >/dev/null
}

DATABASE_URL="$(role_url migration_owner "$migration_password" "$lifecycle_database")" npx prisma validate
DATABASE_URL="$(role_url migration_owner "$migration_password" "$lifecycle_database")" npx prisma generate
prepare_database "$lifecycle_database"
prepare_database "$render_database"

# 门禁变量拼错会让整个 describe 被 skipIf 跳过而退出码仍为 0；要求摘要恰为
# "Tests N passed (N)"，N 是该文件现有的用例数——一条都不许跳过或缺席。
suite_passed() {
  local label="$1" vitest_exit="$2" log="$3" expected="$4"
  if [ "$vitest_exit" -ne 0 ]; then
    echo "${label}=FAIL reason=vitest_exit_${vitest_exit}" >&2
    return 1
  fi
  if ! grep -Eq "^ +Tests +${expected} passed \(${expected}\)\$" "$log"; then
    echo "${label}=FAIL reason=not_all_executed expected=${expected}" >&2
    grep -E '^ +(Test Files|Tests) ' "$log" >&2 || true
    return 1
  fi
  echo "${label}=PASS tests=${expected}"
}

# 两个文件都跑完再判：一个失败时另一个的结果照样留在输出里。
lifecycle_log="$secret_dir/lifecycle-vitest.log"
lifecycle_exit=0
P2_02B_DATABASE_TEST=1 \
P2_02B_WEB_DATABASE_URL="$(role_url web_app "$web_password" "$lifecycle_database")" \
npx vitest run --project node tests/integration/article-templates/p2-02b-postgres.test.ts 2>&1 \
  | tee "$lifecycle_log" || lifecycle_exit=$?

render_log="$secret_dir/render-vitest.log"
render_exit=0
P2_02B_DATABASE_TEST=1 \
P2_02B_WEB_DATABASE_URL="$(role_url web_app "$web_password" "$render_database")" \
P2_02B_OWNER_DATABASE_URL="$(role_url migration_owner "$migration_password" "$render_database")" \
npx vitest run --project node tests/integration/article-templates/p2-02b-article-render-postgres.test.ts 2>&1 \
  | tee "$render_log" || render_exit=$?

failed="no"
suite_passed P2_02B_TEMPLATE_LIFECYCLE "$lifecycle_exit" "$lifecycle_log" 7 || failed="yes"
suite_passed P2_02B_ARTICLE_RENDER "$render_exit" "$render_log" 5 || failed="yes"
if [ "$failed" != "no" ]; then
  echo "P2_02B_ARTICLE_TEMPLATE_POSTGRES_VERIFICATION=FAIL" >&2
  exit 1
fi

echo "P2_02B_ARTICLE_TEMPLATE_POSTGRES_VERIFICATION=PASS"
