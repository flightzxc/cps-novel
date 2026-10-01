#!/usr/bin/env bash
# B-21：自动标签"建任务"内存峰值测量与前后等价性对拍的一键编排。
#
# 起一个一次性 postgres:16.14（tmpfs 数据目录，退出必清理），迁移 + 授权后按
# 生产语种规模造数，再在**独立子进程**里分别用"修改前"（legacy，冻结在
# scripts/lib/tagging-legacy-task-creation.ts）与"修改后"（current）建任务，输出各自的 RSS 峰值；
# 最后对拍两种实现落库的任务行/条目集合/审计行是否逐条一致。
#
# 用法：
#   scripts/measure-tagging-task-memory.sh                  # es 7,918 / fr 7,367 / en 43,431 全流程
#   scripts/measure-tagging-task-memory.sh --en 5000 --es 500 --fr 500   # 缩小规模冒烟
#   scripts/measure-tagging-task-memory.sh --skip-compare   # 只测内存
#   scripts/measure-tagging-task-memory.sh --skip-measure   # 只对拍
#   scripts/measure-tagging-task-memory.sh --desc-median-chars 2000       # 更长的简介
#   scripts/measure-tagging-task-memory.sh --limit-mib 1024               # 修改后 en 峰值上限（默认 1024，即 1 GiB）
#
# 输出每个步骤一行 JSON（前缀 MEASURE= / COMPARE=），末行 B21_MEASUREMENT=PASS|FAIL。
# 只连本机一次性容器，不碰 X8 栈、不碰任何服务器。
#
# 注意：macOS 自带 bash 3.2，这里不用关联数组等 4.x 特性。
set -euo pipefail
set +x

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$"
container_name="cps-novel-b21-measure-pg16-${run_id}"
database_name="cps_novel_b21_${run_id//-/_}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-b21-measure-secrets.XXXXXX")"

n_es=7918
n_fr=7367
n_en=43431
desc_median=700
limit_mib=1024
skip_compare="no"
skip_measure="no"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --es) n_es="$2"; shift 2 ;;
    --fr) n_fr="$2"; shift 2 ;;
    --en) n_en="$2"; shift 2 ;;
    --desc-median-chars) desc_median="$2"; shift 2 ;;
    --limit-mib) limit_mib="$2"; shift 2 ;;
    --skip-compare) skip_compare="yes"; shift ;;
    --skip-measure) skip_measure="yes"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

cleanup_complete="no"
cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -rf "$secret_dir"
  if ! docker ps -a --format '{{.Names}}' | grep -Fx "$container_name" >/dev/null 2>&1; then
    cleanup_complete="yes"
  fi
  echo "B21_DISPOSABLE_DATABASE_CLEANED=${cleanup_complete}"
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
  --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=6g \
  --shm-size=512m \
  --mount "type=bind,src=${project_root},dst=/workspace,readonly" \
  --mount "type=bind,src=${secret_dir},dst=/run/b21-secrets,readonly" \
  -e POSTGRES_USER=b21_admin \
  -e POSTGRES_PASSWORD_FILE=/run/b21-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -h 127.0.0.1 -U b21_admin -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container_name" pg_isready -h 127.0.0.1 -U b21_admin -d postgres >/dev/null
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

docker exec -i "$container_name" psql --no-psqlrc -U b21_admin -d postgres \
  <"$project_root/infra/postgres/roles.sql" >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -U b21_admin -d postgres \
  <"$secret_dir/role-passwords.sql" >/dev/null
docker exec "$container_name" createdb -U b21_admin -O migration_owner "$database_name"

owner_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
web_url="postgresql://web_app:${web_password}@127.0.0.1:${host_port}/${database_name}?schema=public"

DATABASE_URL="$owner_url" npm exec prisma migrate deploy >/dev/null
docker exec \
  -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$database_name" \
  -e PGUSER=migration_owner -e PGPASSWORD="$migration_password" \
  "$container_name" psql --no-psqlrc --file=/workspace/infra/postgres/grants.sql >/dev/null

owner_psql() {
  docker exec \
    -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$database_name" \
    -e PGUSER=migration_owner -e PGPASSWORD="$migration_password" \
    "$container_name" psql --no-psqlrc -tA -c "$1"
}

tool="scripts/measure-tagging-task-creation-memory.ts"
status="PASS"

echo "B21_SEEDING es=${n_es} fr=${n_fr} en=${n_en} desc_median_chars=${desc_median}"
DATABASE_URL="$owner_url" npx tsx "$tool" seed --locale es --count "$n_es" --desc-median-chars "$desc_median" --seed 11 | sed 's/^/SEED=/'
DATABASE_URL="$owner_url" npx tsx "$tool" seed --locale fr --count "$n_fr" --desc-median-chars "$desc_median" --seed 12 | sed 's/^/SEED=/'
DATABASE_URL="$owner_url" npx tsx "$tool" seed --locale en --count "$n_en" --desc-median-chars "$desc_median" --seed 13 | sed 's/^/SEED=/'
owner_psql "SELECT 'NOVELS_BY_LOCALE=' || string_agg(locale || ':' || n, ',') FROM (SELECT locale, count(*) n FROM novel GROUP BY locale ORDER BY locale) t"
owner_psql "SELECT 'DB_SIZE_MB=' || (pg_database_size(current_database()) / 1048576)"

if [ "$skip_compare" != "yes" ]; then
  for locale in es fr en; do
    for lifecycle in initialize_missing reclassify_existing; do
      if ! DATABASE_URL="$owner_url" npx tsx "$tool" compare --locale "$locale" --lifecycle "$lifecycle" | sed 's/^/COMPARE=/'; then
        status="FAIL"
      fi
    done
  done
  owner_psql "TRUNCATE generic_task CASCADE" >/dev/null
fi

if [ "$skip_measure" != "yes" ]; then
  for impl in legacy current; do
    for locale in es fr en; do
      owner_psql "TRUNCATE generic_task CASCADE" >/dev/null
      if ! line="$(DATABASE_URL="$web_url" npx tsx "$tool" measure --impl "$impl" --locale "$locale" --lifecycle reclassify_existing \
        --request-id "b21-measure-${impl}-${locale}-${run_id}")"; then
        status="FAIL"
        continue
      fi
      echo "MEASURE=${line}"
      # 判据：修改后（current）的每个语种峰值不得超过上限；legacy 只做对照，不判定。
      if [ "$impl" = "current" ]; then
        peak="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).peakRssMiB))' "$line")"
        echo "PEAK_RSS_MIB impl=${impl} locale=${locale} peak=${peak} limit=${limit_mib}"
        if ! awk -v p="$peak" -v l="$limit_mib" 'BEGIN { exit !(p <= l) }'; then
          status="FAIL"
        fi
      fi
    done
  done
fi

echo "B21_MEASUREMENT=${status}"
[ "$status" = "PASS" ]
