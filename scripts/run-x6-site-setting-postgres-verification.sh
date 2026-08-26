#!/usr/bin/env bash
set -euo pipefail
set +x

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$"
container_name="cps-novel-x6-site-setting-pg16-${run_id}"
volume_name="cps-novel-x6-site-setting-pgdata-${run_id}"
database_name="cps_novel_x6_site_setting_${run_id//-/_}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-x6-site-setting.XXXXXX")"
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
  --mount "type=bind,src=${project_root},dst=/workspace,readonly" \
  --mount "type=bind,src=${secret_dir},dst=/run/x6-secrets,readonly" \
  -e POSTGRES_USER=x6_admin \
  -e POSTGRES_PASSWORD_FILE=/run/x6-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

ready="no"
for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U x6_admin -d postgres >/dev/null 2>&1; then
    ready="yes"
    break
  fi
  sleep 1
done
[[ "$ready" == "yes" ]]

docker exec -i "$container_name" psql --no-psqlrc -U x6_admin -d postgres \
  <"$project_root/infra/postgres/roles.sql" >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -U x6_admin -d postgres \
  <"$secret_dir/role-passwords.sql" >/dev/null
docker exec "$container_name" createdb -U x6_admin -O migration_owner "$database_name"
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

owner_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
web_url="postgresql://web_app:${web_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
worker_url="postgresql://worker_app:${worker_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
scheduler_url="postgresql://scheduler_app:${scheduler_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
analyst_url="postgresql://analyst_ro:${analyst_password}@127.0.0.1:${host_port}/${database_name}?schema=public"

DATABASE_URL="$owner_url" npx prisma validate
DATABASE_URL="$owner_url" npx prisma generate
DATABASE_URL="$owner_url" npx prisma migrate deploy
docker exec -i "$container_name" \
  psql --no-psqlrc -U migration_owner -d "$database_name" \
  <"$project_root/infra/postgres/grants.sql" >/dev/null

X6_SITE_SETTING_DATABASE_TEST=1 \
X6_OWNER_DATABASE_URL="$owner_url" \
X6_WEB_DATABASE_URL="$web_url" \
X6_WORKER_DATABASE_URL="$worker_url" \
X6_SCHEDULER_DATABASE_URL="$scheduler_url" \
X6_ANALYST_DATABASE_URL="$analyst_url" \
npx vitest run --project node tests/integration/database/x6-site-setting-postgres.test.ts

DATABASE_URL="$owner_url" node scripts/check-database-dictionary-drift.mjs

echo "X6_SITE_SETTING_SERVICE=PASS"
echo "X6_WEB_MINIMUM_UPDATE_GRANT=PASS"
echo "X6_WORKER_READ_ONLY=PASS"
echo "X6_ANALYST_SCHEDULER_KEY_READ=DENIED"
echo "X6_DICTIONARY_DRIFT=PASS"
echo "X6_SITE_SETTING_POSTGRES_VERIFICATION=PASS"
