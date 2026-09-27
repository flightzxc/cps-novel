#!/usr/bin/env bash
set -euo pipefail
set +x

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$"
container_name="cps-novel-p1-06-pg16-${run_id}"
volume_name="cps-novel-p1-06-pgdata-${run_id}"
source_database="cps_novel_p1_06_${run_id//-/_}"
restore_database="cps_novel_restore_${run_id//-/_}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-p1-06-secrets.XXXXXX")"
artifact_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-p1-06-artifacts.XXXXXX")"
cleanup_complete="no"
cleanup_ran="no"

cleanup() {
  [[ "$cleanup_ran" == "no" ]] || return 0
  cleanup_ran="yes"
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  docker volume rm "$volume_name" >/dev/null 2>&1 || true
  rm -rf "$secret_dir" "$artifact_dir"
  if ! docker ps -a --format '{{.Names}}' | grep -Fx "$container_name" >/dev/null 2>&1 \
    && ! docker volume ls --format '{{.Name}}' | grep -Fx "$volume_name" >/dev/null 2>&1; then
    cleanup_complete="yes"
  fi
  echo "DISPOSABLE_DATABASE_CLEANED=${cleanup_complete}"
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
printf '127.0.0.1:5432:*:migration_owner:%s\n' "$migration_password" >"$secret_dir/pgpass-container"
printf '127.0.0.1:5432:*:web_app:%s\n' "$web_password" >>"$secret_dir/pgpass-container"
printf '127.0.0.1:5432:*:worker_app:%s\n' "$worker_password" >>"$secret_dir/pgpass-container"
printf '127.0.0.1:5432:*:scheduler_app:%s\n' "$scheduler_password" >>"$secret_dir/pgpass-container"
printf '127.0.0.1:5432:*:analyst_ro:%s\n' "$analyst_password" >>"$secret_dir/pgpass-container"
printf '127.0.0.1:5432:*:backup_role:%s\n' "$backup_password" >>"$secret_dir/pgpass-container"
chmod 600 "$secret_dir"/*

cd "$project_root"
node -e '
  const p = require("./package.json");
  if (p.devDependencies?.prisma !== "6.19.2" || p.dependencies?.["@prisma/client"] !== "6.19.2") {
    throw new Error("P1-06 requires Prisma CLI and Client 6.19.2");
  }
'
npm ci

if ! docker image inspect postgres:16.14 >/dev/null 2>&1; then
  mkdir -p "$secret_dir/docker-config"
  printf '{}\n' >"$secret_dir/docker-config/config.json"
  DOCKER_CONFIG="$secret_dir/docker-config" docker pull postgres:16.14 >/dev/null
fi
docker volume create "$volume_name" >/dev/null
docker run -d \
  --name "$container_name" \
  --mount "type=volume,src=${volume_name},dst=/var/lib/postgresql/data" \
  --mount "type=bind,src=${project_root},dst=/workspace,readonly" \
  --mount "type=bind,src=${secret_dir},dst=/run/p106-secrets,readonly" \
  --mount "type=bind,src=${artifact_dir},dst=/artifacts" \
  -e POSTGRES_USER=p106_admin \
  -e POSTGRES_PASSWORD_FILE=/run/p106-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U p106_admin -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container_name" pg_isready -U p106_admin -d postgres >/dev/null
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

docker exec -i "$container_name" psql --no-psqlrc -U p106_admin -d postgres \
  <"$project_root/infra/postgres/roles.sql" >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -U p106_admin -d postgres \
  <"$secret_dir/role-passwords.sql" >/dev/null
docker exec "$container_name" createdb -U p106_admin -O migration_owner "$source_database"

owner_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${source_database}?schema=public"
web_url="postgresql://web_app:${web_password}@127.0.0.1:${host_port}/${source_database}?schema=public"
worker_url="postgresql://worker_app:${worker_password}@127.0.0.1:${host_port}/${source_database}?schema=public"
scheduler_url="postgresql://scheduler_app:${scheduler_password}@127.0.0.1:${host_port}/${source_database}?schema=public"
analyst_url="postgresql://analyst_ro:${analyst_password}@127.0.0.1:${host_port}/${source_database}?schema=public"
backup_url="postgresql://backup_role:${backup_password}@127.0.0.1:${host_port}/${source_database}?schema=public"

DATABASE_URL="$owner_url" npx prisma validate
DATABASE_URL="$owner_url" npx prisma generate
DATABASE_URL="$owner_url" npx prisma migrate deploy

docker exec \
  -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$source_database" \
  -e PGUSER=migration_owner -e PGPASSFILE=/run/p106-secrets/pgpass-container \
  "$container_name" psql --no-psqlrc --file=/workspace/infra/postgres/grants.sql >/dev/null

P1_06_DATABASE_TEST=1 \
P1_06_OWNER_DATABASE_URL="$owner_url" \
P1_06_WEB_DATABASE_URL="$web_url" \
P1_06_WORKER_DATABASE_URL="$worker_url" \
P1_06_ANALYST_DATABASE_URL="$analyst_url" \
P1_06_BACKUP_DATABASE_URL="$backup_url" \
npx vitest run --project node tests/integration/database/p1-06-postgres.test.ts

docker exec \
  -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$source_database" \
  -e PGUSER=backup_role -e PGPASSFILE=/run/p106-secrets/pgpass-container \
  "$container_name" bash /workspace/scripts/db/backup-logical.sh --output /artifacts/source.dump

docker exec "$container_name" createdb -U p106_admin -O migration_owner "$restore_database"
restore_started_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
docker exec \
  -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$restore_database" \
  -e PGUSER=migration_owner -e PGPASSFILE=/run/p106-secrets/pgpass-container \
  -e P1_06_ALLOW_DISPOSABLE_RESTORE=1 \
  "$container_name" bash /workspace/scripts/db/restore-logical.sh --archive /artifacts/source.dump
restore_finished_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
restore_duration_ms="$((restore_finished_ms - restore_started_ms))"

db_query() {
  local database_name="$1"
  local sql="$2"
  docker exec \
    -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$database_name" \
    -e PGUSER=migration_owner -e PGPASSFILE=/run/p106-secrets/pgpass-container \
    "$container_name" psql --no-psqlrc --tuples-only --no-align --command="$sql" | tr -d '\r'
}

table_sql="SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'"
row_sql="SELECT json_build_object(
  'channel',(SELECT count(*) FROM channel),
  'credential',(SELECT count(*) FROM channel_account_credential),
  'generic_task',(SELECT count(*) FROM generic_task),
  'generic_task_item',(SELECT count(*) FROM generic_task_item),
  'operation_audit',(SELECT count(*) FROM operation_audit)
)::text"
migration_sql="SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL"

# 期望表数不再写死——直接和 check-database-dictionary-drift.mjs 里
# parseSchema() 同一套规则（model 名或 @@map 物理名）现算一遍，schema 加表
# 时这里自动跟着变，不需要每次改一个魔法数字。
expected_table_count="$(node -e '
  const fs = require("node:fs");
  const schema = fs.readFileSync("prisma/schema.prisma", "utf8");
  const modelPattern = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  const tables = new Set();
  let match;
  while ((match = modelPattern.exec(schema))) {
    const [, modelName, body] = match;
    const mapMatch = body.match(/@@map\("([^"]+)"\)/);
    tables.add(mapMatch ? mapMatch[1] : modelName);
  }
  process.stdout.write(String(tables.size));
')"
# 期望迁移数同理，从 prisma/migrations 目录现数，不写死历史某一刻的条数。
expected_migration_count="$(find "$project_root/prisma/migrations" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d '[:space:]')"

# 🔴 macOS 系统 bash 是被 GPLv3 冻结在 3.2.57 的老版本，这个版本有个已知
# 坑：裸 `[[ ... ]]` 作为独立语句、判定为假时，`set -e` 不会据此中止脚本
# （`[ ]`/`test`/`false` 都正常会中止，只有 `[[ ]]` 不会——已用
# `bash -c 'set -e; [[ a == b ]]; echo should-not-print'` 实测确认，
# "should-not-print" 真的打出来了）。下面六条恢复一致性断言原来全是裸
# `[[ ]]`，B-16 复核用变异测试（把期望表数改成 99999）打过一轮，脚本从头
# 跑到尾都是 PASS——说明这些断言在这台机器上从来没真正起过作用。改成
# `if ! [[ ... ]]; then ...; exit 1; fi`，判断逻辑一个字不变，只是不再依赖
# 这个老 bash 对裸 `[[ ]]` 的 errexit 传播。
source_table_count="$(db_query "$source_database" "$table_sql" | tr -d '[:space:]')"
restore_table_count="$(db_query "$restore_database" "$table_sql" | tr -d '[:space:]')"
if ! [[ "$source_table_count" == "$expected_table_count" && "$restore_table_count" == "$expected_table_count" ]]; then
  echo "table count mismatch: source=$source_table_count restore=$restore_table_count expected=$expected_table_count" >&2
  exit 1
fi
source_rows="$(db_query "$source_database" "$row_sql")"
restore_rows="$(db_query "$restore_database" "$row_sql")"
if ! [[ "$source_rows" == "$restore_rows" ]]; then
  echo "row counts diverged between source and restore: source=$source_rows restore=$restore_rows" >&2
  exit 1
fi
# 约束 + 索引/触发器比对（第二轮定约束、第三轮把同款方法扩到索引谓词）：
# 按类型分开处理，不再要求 pg_get_constraintdef()/pg_get_indexdef() 逐字
# 相同——见 scripts/check-p1-06-constraint-parity.mjs 顶部注释里的完整理由
# 与归一化规则（只去掉三种类型转换 + 圆括号 + 空白，其它一个字符不动；非
# CHECK 约束、触发器、普通索引仍然逐字比对；部分索引只有 WHERE 谓词这段走
# 归一化，WHERE 之前的部分——索引名/表/列/唯一性/方法——逐字比对）。这里
# 先把 restore 侧连接串提前构造出来，供本检查使用；下面 dictionary drift
# 那段还会算一遍同样的 URL（历史遗留的重复定义，语义完全一致，未改动那段
# 代码）。脚本成功时在 stdout 打一行 JSON，包含按归一化后文本算出的
# constraintDigest/objectDigest，供下面 echo 尾行复用（不是原始
# pg_get_constraintdef() 的逐字 md5，而是归一化后的——同一份数据不会再因为
# 这个已知良性差异在不同环境算出两个不同摘要）。
restore_owner_url_for_constraints="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${restore_database}?schema=public"
schema_parity_json="$(P1_06_CONSTRAINT_SOURCE_URL="$owner_url" \
  P1_06_CONSTRAINT_RESTORE_URL="$restore_owner_url_for_constraints" \
  node scripts/check-p1-06-constraint-parity.mjs --show-benign-check-diffs --show-benign-index-diffs)"
echo "$schema_parity_json"
constraint_digest="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).constraintDigest)' "$(tail -n1 <<<"$schema_parity_json")")"
object_digest="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).objectDigest)' "$(tail -n1 <<<"$schema_parity_json")")"
source_migration_count="$(db_query "$source_database" "$migration_sql" | tr -d '[:space:]')"
if ! [[ "$source_migration_count" == "$expected_migration_count" ]]; then
  echo "source migration count mismatch: got=$source_migration_count expected=$expected_migration_count" >&2
  exit 1
fi
restore_migration_count="$(db_query "$restore_database" "$migration_sql" | tr -d '[:space:]')"
if ! [[ "$restore_migration_count" == "$expected_migration_count" ]]; then
  echo "restore migration count mismatch: got=$restore_migration_count expected=$expected_migration_count" >&2
  exit 1
fi

dictionary_drift_source_json="$(DATABASE_URL="$owner_url" node scripts/check-database-dictionary-drift.mjs)"
echo "$dictionary_drift_source_json"
restore_owner_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${restore_database}?schema=public"
restore_web_url="postgresql://web_app:${web_password}@127.0.0.1:${host_port}/${restore_database}?schema=public"
restore_worker_url="postgresql://worker_app:${worker_password}@127.0.0.1:${host_port}/${restore_database}?schema=public"
restore_analyst_url="postgresql://analyst_ro:${analyst_password}@127.0.0.1:${host_port}/${restore_database}?schema=public"
restore_backup_url="postgresql://backup_role:${backup_password}@127.0.0.1:${host_port}/${restore_database}?schema=public"
dictionary_drift_restore_json="$(DATABASE_URL="$restore_owner_url" node scripts/check-database-dictionary-drift.mjs)"
echo "$dictionary_drift_restore_json"
# DICTIONARY_DRIFT 的分母不再写死——从 drift 脚本刚打印的 JSON 里读
# activeCount（当前活跃字典条目数），字典条目增减时这里自动跟着变。
dictionary_active_count="$(node -e '
  const data = JSON.parse(process.argv[1]);
  process.stdout.write(String(data.activeCount));
' "$dictionary_drift_restore_json")"

P1_06_DATABASE_TEST=1 \
P1_06_OWNER_DATABASE_URL="$restore_owner_url" \
P1_06_WEB_DATABASE_URL="$restore_web_url" \
P1_06_WORKER_DATABASE_URL="$restore_worker_url" \
P1_06_ANALYST_DATABASE_URL="$restore_analyst_url" \
P1_06_BACKUP_DATABASE_URL="$restore_backup_url" \
npx vitest run --project node tests/integration/database/p1-06-postgres.test.ts

npm run typecheck
npm run lint
# 理由同 run-p1-05b-postgres-verification.sh 里同一处改动：本机并发 Agent/
# X8 栈已经占满核数，vitest 默认 worker 数在这台机器上没有余量，B-16 复核
# 时反复撞到 spawnSync/vitest 测试超时与 vitest-worker 内部 RPC 超时——都是
# 环境层面的假象失败，用例本身全绿。跟"全量 vitest 门禁"一致地把并发压到
# 4，不动任何断言、不跳过任何用例。
npm run test:backend -- --maxWorkers=4
npm test -- --maxWorkers=4

echo "ROLE_TESTS=PASS"
echo "WEB_SECRET_READ=DENIED"
echo "ANALYST_WRITE=DENIED"
echo "APP_DDL=DENIED"
echo "LOGICAL_BACKUP=PASS"
echo "LOGICAL_RESTORE=PASS"
echo "RESTORE_DURATION_MS=${restore_duration_ms}"
echo "TABLE_COUNT=${restore_table_count}"
echo "CONSTRAINT_DIGEST=${constraint_digest}"
echo "OBJECT_DIGEST=${object_digest}"
echo "DICTIONARY_DRIFT=0_OF_${dictionary_active_count}"
echo "PITR_STATUS=SCRIPT_AND_RUNBOOK_ONLY"
echo "P1_06_VERIFICATION=PASS"
