#!/usr/bin/env bash
set -euo pipefail
set +x

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$"
container_name="cps-novel-tagging-public-auto-pg16-${run_id}"
database_name="cps_novel_p2_06_5_wo7_${run_id//-/_}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-tagging-public-auto-secrets.XXXXXX")"
cleanup_complete="no"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -rf "$secret_dir"
  if ! docker ps -a --format '{{.Names}}' | grep -Fx "$container_name" >/dev/null 2>&1; then
    cleanup_complete="yes"
  fi
  echo "P2_06_5_DISPOSABLE_DATABASE_CLEANED=${cleanup_complete}"
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
  --mount "type=bind,src=${secret_dir},dst=/run/tagging-public-auto-secrets,readonly" \
  -e POSTGRES_USER=p2_06_5_wo7_admin \
  -e POSTGRES_PASSWORD_FILE=/run/tagging-public-auto-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U p2_06_5_wo7_admin -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container_name" pg_isready -U p2_06_5_wo7_admin -d postgres >/dev/null
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

docker exec -i "$container_name" psql --no-psqlrc -U p2_06_5_wo7_admin -d postgres \
  <"$project_root/infra/postgres/roles.sql" >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -U p2_06_5_wo7_admin -d postgres \
  <"$secret_dir/role-passwords.sql" >/dev/null
docker exec "$container_name" createdb -U p2_06_5_wo7_admin -O migration_owner "$database_name"

owner_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
web_url="postgresql://web_app:${web_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
scheduler_url="postgresql://scheduler_app:${scheduler_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
worker_url="postgresql://worker_app:${worker_password}@127.0.0.1:${host_port}/${database_name}?schema=public"

DATABASE_URL="$owner_url" npm exec prisma migrate deploy >/dev/null
docker exec \
  -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$database_name" \
  -e PGUSER=migration_owner -e PGPASSWORD="$migration_password" \
  "$container_name" psql --no-psqlrc --file=/workspace/infra/postgres/grants.sql >/dev/null

openssl rand -base64 32 >"$secret_dir/credential.key"
export CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION=1
export CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE="$secret_dir/credential.key"
export CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE="$secret_dir/credential.key"

P2_06_5_DATABASE_TEST=1 \
P2_06_5_OWNER_DATABASE_URL="$owner_url" \
P2_06_5_WEB_DATABASE_URL="$web_url" \
P2_06_5_WORKER_DATABASE_URL="$worker_url" \
P2_06_5_SCHEDULER_DATABASE_URL="$scheduler_url" \
npm exec vitest run -- --project node tests/integration/tagging/p2-06-5-postgres.test.ts tests/integration/tagging/public-auto-postgres.test.ts \
  --no-file-parallelism --reporter=default --reporter=json --outputFile="$secret_dir/integration-result.json"

node - "$secret_dir/integration-result.json" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const files = report.testResults ?? [];
const skipped = report.numPendingTests ?? -1;
if (files.length !== 2 || files.some(f => f.status !== "passed" || !f.assertionResults?.length)
    || skipped !== 0 || report.numFailedTests !== 0 || report.numPassedTests < 20) {
  throw new Error(`WO7_INTEGRATION=FAIL passed=${report.numPassedTests} skipped=${skipped}`);
}
console.log(`WO7_INTEGRATION=PASS passed=${report.numPassedTests} skipped=${skipped}`);
NODE

DATABASE_URL="$owner_url" node scripts/check-database-dictionary-drift.mjs

echo "P2_06_5_DICTIONARY_DRIFT=0"
echo "P2_06_5_POSTGRES_VERIFICATION=PASS"
