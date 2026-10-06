#!/usr/bin/env bash
# 文章「全选 → 后台批量发布」任务的真实库验收运行器（开发单 §四 场景 A–F）。
#
# 一次性 postgres:16.14 + 真实迁移 + `infra/postgres/grants.sql` + 真实角色：入队/任务控制用
# web_app，枚举/逐篇发布/试读合并派发/站点地图触发用 worker_app——发布核心原本只在 web 进程里跑，
# 挪到 worker-light 之后必须以 worker_app 跑通整条路径（缺授权 = permission denied）。
# 跑完做字典 drift 复核；skipped=0 由共用断言 `scripts/lib/assert-vitest-no-skipped-files.mjs` 硬卡。
#
# 2026-10-07 起同一个运行器还跑第二个文件：
#   tests/integration/publish-gate/withdraw-zero-chapter-novels-postgres.test.ts
# 一次性运维脚本 `scripts/ops/withdraw-zero-chapter-novels-20261007.ts`（上游零章节 236 本切换前下线）
# 的真实库验收——脚本核心与后台「撤回」按钮的服务函数（`withdrawNovel`）都用这里的真实 web_app 连接串，
# 夹具与整库快照用 owner 连接串。选这个运行器的理由：它已经同时备好 owner / web_app / worker_app 三条
# 真实角色连接（脚本生产上就以 web_app 跑，列级授权如 novel_source_item 只能走真实角色才测得出），
# 一次性库、库名守卫、skipped=0 硬断言与字典 drift 复核俱全，且属于发布生命周期这一族。
# 两个文件共用同一个一次性库、串行（--no-file-parallelism），各自开头整库 TRUNCATE，互不依赖。
set -euo pipefail
set +x

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$"
container_name="cps-novel-article-publish-batch-pg16-${run_id}"
database_name="cps_novel_article_publish_batch_${run_id//-/_}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-article-publish-batch-secrets.XXXXXX")"
cleanup_complete="no"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -rf "$secret_dir"
  if ! docker ps -a --format '{{.Names}}' | grep -Fx "$container_name" >/dev/null 2>&1; then
    cleanup_complete="yes"
  fi
  echo "ARTICLE_PUBLISH_BATCH_DISPOSABLE_DATABASE_CLEANED=${cleanup_complete}"
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
  --mount "type=bind,src=${secret_dir},dst=/run/article-publish-batch-secrets,readonly" \
  -e POSTGRES_USER=article_publish_batch_admin \
  -e POSTGRES_PASSWORD_FILE=/run/article-publish-batch-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U article_publish_batch_admin -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container_name" pg_isready -U article_publish_batch_admin -d postgres >/dev/null
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

docker exec -i "$container_name" psql --no-psqlrc -U article_publish_batch_admin -d postgres \
  <"$project_root/infra/postgres/roles.sql" >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -U article_publish_batch_admin -d postgres \
  <"$secret_dir/role-passwords.sql" >/dev/null
docker exec "$container_name" createdb -U article_publish_batch_admin -O migration_owner "$database_name"

owner_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
web_url="postgresql://web_app:${web_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
worker_url="postgresql://worker_app:${worker_password}@127.0.0.1:${host_port}/${database_name}?schema=public"

DATABASE_URL="$owner_url" npm exec prisma migrate deploy >/dev/null
docker exec \
  -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$database_name" \
  -e PGUSER=migration_owner -e PGPASSWORD="$migration_password" \
  "$container_name" psql --no-psqlrc --file=/workspace/infra/postgres/grants.sql >/dev/null

# 试读任务夹具要加密一个本地假凭据（同 publication-preview 运行器）。
openssl rand -base64 32 >"$secret_dir/credential.key"
export CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION=1
export CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE="$secret_dir/credential.key"
export CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE="$secret_dir/credential.key"

# 开发迭代用：设了 ARTICLE_PUBLISH_BATCH_TEST_PATTERN 只跑名字匹配的用例，并且**不**打印 PASS
# 取证行（过滤后的运行不是验收证据；正式验收一律不设这个变量）。
pattern_args=()
if [ -n "${ARTICLE_PUBLISH_BATCH_TEST_PATTERN:-}" ]; then
  pattern_args=(--testNamePattern "$ARTICLE_PUBLISH_BATCH_TEST_PATTERN")
fi

ARTICLE_PUBLISH_BATCH_DATABASE_TEST=1 \
ARTICLE_PUBLISH_BATCH_OWNER_DATABASE_URL="$owner_url" \
ARTICLE_PUBLISH_BATCH_WEB_DATABASE_URL="$web_url" \
ARTICLE_PUBLISH_BATCH_WORKER_DATABASE_URL="$worker_url" \
npm exec vitest run -- --project node \
  tests/integration/tasks/article-publish-batch-postgres.test.ts \
  tests/integration/publish-gate/withdraw-zero-chapter-novels-postgres.test.ts \
  ${pattern_args[@]+"${pattern_args[@]}"} \
  --no-file-parallelism --reporter=default --reporter=json --outputFile="$secret_dir/integration-result.json"

if [ -n "${ARTICLE_PUBLISH_BATCH_TEST_PATTERN:-}" ]; then
  echo "ARTICLE_PUBLISH_BATCH_FILTERED_RUN=1 (not acceptance evidence; floors and drift check skipped)"
  exit 0
fi

# 硬断言：不允许整文件跳过；通过数不得低于下限（= 该文件当前 it( 用例数）。
# 用 if ! ...; then ...; exit 1; fi 书写，不依赖 set -e 对单独成行断言的行为
# （macOS bash 3.2 下单独成行的 [[ ]] 不触发 set -e）。
if ! node scripts/lib/assert-vitest-no-skipped-files.mjs ARTICLE_PUBLISH_BATCH "$secret_dir/integration-result.json" \
  tests/integration/tasks/article-publish-batch-postgres.test.ts=9 \
  tests/integration/publish-gate/withdraw-zero-chapter-novels-postgres.test.ts=19
then
  echo "ARTICLE_PUBLISH_BATCH_POSTGRES_VERIFICATION=FAIL (whole-file skip or not-executed assertion failed)" >&2
  exit 1
fi

DATABASE_URL="$owner_url" node scripts/check-database-dictionary-drift.mjs

echo "ARTICLE_PUBLISH_BATCH_DICTIONARY_DRIFT=0"
echo "ARTICLE_PUBLISH_BATCH_POSTGRES_VERIFICATION=PASS"
