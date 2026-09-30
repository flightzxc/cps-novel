#!/usr/bin/env bash
# 模板选版（后台新建版本后新版本生效）真实 PostgreSQL 验证。
# 一次性 PG16 容器 + roles.sql + 全量 migration + grants.sql，以 web_app 走真实的
# createArticleTemplate/setArticleTemplateStatus，以 web_app/worker_app 各读一遍
# selectActiveArticleTemplate。结束时删除容器与数据卷。
set -euo pipefail
set +x

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$"
container_name="cps-novel-template-version-pg16-${run_id}"
volume_name="cps-novel-template-version-pgdata-${run_id}"
database_name="cps_novel_template_version_${run_id//-/_}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-template-version.XXXXXX")"
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
  --mount "type=bind,src=${secret_dir},dst=/run/template-version-secrets,readonly" \
  -e POSTGRES_USER=template_version_admin \
  -e POSTGRES_PASSWORD_FILE=/run/template-version-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

ready="no"
for _ in $(seq 1 60); do
  # 走容器内 TCP 而不是 unix socket：镜像初始化期间的临时服务器 listen_addresses=''、只开
  # socket，socket 探针会在它上面提前报就绪，紧接着它被关停重启，下一条 psql 就撞上
  # "No such file or directory"（变异轮实测撞到过一次）。
  if docker exec "$container_name" pg_isready -h 127.0.0.1 -U template_version_admin -d postgres >/dev/null 2>&1; then
    ready="yes"
    break
  fi
  sleep 1
done
# macOS /bin/bash 3.2：独立成行的 `[[ ]]` 判假时 set -e 不中止，必须显式短路。
[[ "$ready" == "yes" ]] || { echo "postgres did not become ready" >&2; exit 1; }

docker exec -i "$container_name" psql --no-psqlrc -v ON_ERROR_STOP=1 -U template_version_admin -d postgres \
  <"$project_root/infra/postgres/roles.sql" >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -v ON_ERROR_STOP=1 -U template_version_admin -d postgres \
  <"$secret_dir/role-passwords.sql" >/dev/null
docker exec "$container_name" createdb -U template_version_admin -O migration_owner "$database_name"
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
ARTICLE_TEMPLATE_VERSION_DATABASE_TEST=1 \
ARTICLE_TEMPLATE_VERSION_OWNER_DATABASE_URL="$owner_url" \
ARTICLE_TEMPLATE_VERSION_WEB_DATABASE_URL="$web_url" \
ARTICLE_TEMPLATE_VERSION_WORKER_DATABASE_URL="$worker_url" \
npx vitest run --project node tests/integration/article-templates/template-version-selection-postgres.test.ts 2>&1 \
  | tee "$vitest_log"
# 门禁变量拼错会让整个 describe 被 skipIf 跳过而退出码仍为 0；要求用例确实执行且全部通过。
grep -Eq '^ +Tests +[1-9][0-9]* passed \([1-9][0-9]*\)$' "$vitest_log" \
  || { echo "template version selection tests did not all execute" >&2; exit 1; }

echo "ARTICLE_TEMPLATE_VERSION_POSTGRES_VERIFICATION=PASS"
