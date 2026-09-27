#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$"
container_name="cps-novel-p1-05b-pg16-${run_id}"
volume_name="cps-novel-p1-05b-pgdata-${run_id}"
database_name="cps_novel_p1_05b_${run_id//-/_}"
shadow_database_name="${database_name}_shadow"
database_user="p105b"
database_password="$(openssl rand -hex 24)"
cleanup_complete="no"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  docker volume rm "$volume_name" >/dev/null 2>&1 || true
  cleanup_complete="yes"
  echo "P1_05B_DATABASE_CLEANED=${cleanup_complete}"
}
trap cleanup EXIT INT TERM

cd "$project_root"

node -e '
  const p = require("./package.json");
  if (p.devDependencies?.prisma !== "6.19.2" || p.dependencies?.["@prisma/client"] !== "6.19.2") {
    throw new Error("P1-05B requires prisma and @prisma/client exactly 6.19.2");
  }
'

npm ci
prisma_version="$(npx prisma --version)"
echo "$prisma_version" | grep -F "prisma                  : 6.19.2" >/dev/null
echo "$prisma_version" | grep -F "@prisma/client          : 6.19.2" >/dev/null

docker pull postgres:16 >/dev/null
docker volume create "$volume_name" >/dev/null
docker run -d \
  --name "$container_name" \
  --mount "type=volume,src=${volume_name},dst=/var/lib/postgresql/data" \
  -e "POSTGRES_USER=${database_user}" \
  -e "POSTGRES_PASSWORD=${database_password}" \
  -e "POSTGRES_DB=${database_name}" \
  -p 127.0.0.1::5432 \
  postgres:16 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U "$database_user" -d "$database_name" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container_name" pg_isready -U "$database_user" -d "$database_name" >/dev/null
docker exec "$container_name" createdb -U "$database_user" "$shadow_database_name"

host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"
export DATABASE_URL="postgresql://${database_user}:${database_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
shadow_url="postgresql://${database_user}:${database_password}@127.0.0.1:${host_port}/${shadow_database_name}?schema=public"
export P1_05B_DATABASE_TEST=1

npx prisma validate
npx prisma generate
npx prisma migrate deploy
reapply_output="$(npx prisma migrate deploy)"
echo "$reapply_output"
echo "$reapply_output" | grep -F "No pending migrations to apply." >/dev/null
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$shadow_url" \
  --exit-code
npx prisma migrate diff \
  --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --exit-code

node scripts/check-database-dictionary-drift.mjs
npm run typecheck
npm run lint
# 本机常驻好几个并行 worktree/Agent 会话再加 X8 本地栈，vitest 默认按 CPU
# 核数（18）开 worker 早就没有余量——B-16 复核里连续三次全量跑，分别在不同
# 用例上撞到 spawnSync 自身超时、vitest 测试超时、以及 vitest-worker 内部
# "onTaskUpdate" RPC 超时（跑完的 4325 条用例全绿，纯粹是 worker 汇报超时
# 拖垮整体退出码）。跟"全量 vitest 门禁"那条一样，把并发压到 4，不动任何
# 断言、不跳过任何用例。
npm run test:backend -- --maxWorkers=4
npm run test:integration -- --maxWorkers=4
npm test -- --maxWorkers=4

# 本机没有装 ripgrep（bash 子进程里 `rg`/`grep` 也没有交互 shell 里那层
# Claude Code 注入的别名）——`rg: command not found` 在 `if rg ...; then` 里
# 退出码非 0，会被 bash 当成"没匹配"直接放过，三条残留检查全部静默失效
# （lint 挡住这个脚本之前从没跑到这里，B-16 复核才第一次发现）。改成不依赖
# 任何外部 CLI、只用 Node 内置 fs + 原生正则（比 BSD grep 更能表达
# `\s`/`\b`）自己实现同样的递归扫描，检查强度一个字没削弱。
grep_like() {
  local pattern="$1" flags="$2" ext_filter="$3"
  shift 3
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [patternSrc, flags, extFilter, ...targets] = process.argv.slice(1);
    const pattern = new RegExp(patternSrc, flags);
    const extRe = extFilter ? new RegExp(extFilter) : null;
    let matched = false;
    function walk(target) {
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(target)) walk(path.join(target, entry));
        return;
      }
      if (!stat.isFile()) return;
      if (extRe && !extRe.test(target)) return;
      const lines = fs.readFileSync(target, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (pattern.test(line)) {
          matched = true;
          console.log(`${target}:${index + 1}:${line}`);
        }
      });
    }
    for (const target of targets) walk(target);
    process.exit(matched ? 0 : 1);
  ' "$pattern" "$flags" "$ext_filter" "$@"
}

if grep_like 'provider\s*=\s*"sqlite"|PRAGMA|busy_timeout|BEGIN\s+IMMEDIATE|file:' i "" \
  prisma/schema.prisma prisma/migrations src/domain src/lib/db; then
  echo "SQLite-specific residue detected" >&2
  exit 1
fi

# Prisma's provider-neutral @default(autoincrement()) is valid for PostgreSQL;
# only raw SQL AUTOINCREMENT is a SQLite residue.
if grep_like 'AUTOINCREMENT' "" "" prisma/migrations src/domain src/lib/db; then
  echo "SQLite-specific residue detected" >&2
  exit 1
fi

if grep_like '\bAS\s+[a-z][a-z0-9_]*[A-Z][A-Za-z0-9_]*\b' "" '\.(sql|ts|mjs)$' \
  prisma/migrations src/lib/db; then
  echo "Unquoted camelCase SQL alias detected" >&2
  exit 1
fi

docker exec "$container_name" psql -U "$database_user" -d "$database_name" -Atc \
  "SELECT current_setting('server_version');"
echo "P1_05B_VERIFICATION=PASS"
