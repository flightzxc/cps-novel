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
npm run test:backend
npm run test:integration
npm test

if rg -n -i 'provider\s*=\s*"sqlite"|PRAGMA|busy_timeout|BEGIN[[:space:]]+IMMEDIATE|file:' \
  prisma/schema.prisma prisma/migrations src/domain src/lib/db; then
  echo "SQLite-specific residue detected" >&2
  exit 1
fi

# Prisma's provider-neutral @default(autoincrement()) is valid for PostgreSQL;
# only raw SQL AUTOINCREMENT is a SQLite residue.
if rg -n 'AUTOINCREMENT' prisma/migrations src/domain src/lib/db; then
  echo "SQLite-specific residue detected" >&2
  exit 1
fi

if rg -n --pcre2 --glob '*.sql' --glob '*.ts' --glob '*.mjs' \
  '\bAS\s+[a-z][a-z0-9_]*[A-Z][A-Za-z0-9_]*\b' \
  prisma/migrations src/lib/db; then
  echo "Unquoted camelCase SQL alias detected" >&2
  exit 1
fi

docker exec "$container_name" psql -U "$database_user" -d "$database_name" -Atc \
  "SELECT current_setting('server_version');"
echo "P1_05B_VERIFICATION=PASS"
