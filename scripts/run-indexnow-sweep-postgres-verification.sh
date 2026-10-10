#!/usr/bin/env bash
set -euo pipefail
set +x

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$"
container_name="cps-novel-wo6-pg16-${run_id}"
database_name="cps_novel_wo6_${run_id//-/_}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-wo6-secrets.XXXXXX")"
cleanup_complete="no"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -rf "$secret_dir"
  if ! docker ps -a --format '{{.Names}}' | grep -Fx "$container_name" >/dev/null 2>&1; then
    cleanup_complete="yes"
  fi
  echo "WO6_DISPOSABLE_DATABASE_CLEANED=${cleanup_complete}"
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
  --mount "type=bind,src=${secret_dir},dst=/run/wo6-secrets,readonly" \
  -e POSTGRES_USER=wo6_admin \
  -e POSTGRES_PASSWORD_FILE=/run/wo6-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U wo6_admin -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container_name" pg_isready -U wo6_admin -d postgres >/dev/null
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

docker exec -i "$container_name" psql --no-psqlrc -U wo6_admin -d postgres \
  <"$project_root/infra/postgres/roles.sql" >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -U wo6_admin -d postgres \
  <"$secret_dir/role-passwords.sql" >/dev/null
docker exec "$container_name" createdb -U wo6_admin -O migration_owner "$database_name"

owner_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
web_url="postgresql://web_app:${web_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
scheduler_url="postgresql://scheduler_app:${scheduler_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
worker_url="postgresql://worker_app:${worker_password}@127.0.0.1:${host_port}/${database_name}?schema=public"

DATABASE_URL="$owner_url" npm exec prisma migrate deploy >/dev/null
npm exec prisma generate >/dev/null
docker exec \
  -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$database_name" \
  -e PGUSER=migration_owner -e PGPASSWORD="$migration_password" \
  "$container_name" psql --no-psqlrc --file=/workspace/infra/postgres/grants.sql >/dev/null

# Two files, run one after the other: both reset the same tables in the shared disposable database,
# so they must never run in parallel.
#   indexnow-sweep-postgres   — WO6 scheduler / lanes / HTTP behaviour (adapted to batch delivery)
#   indexnow-batch-postgres   — B-41: 500+1 batch, breaker/resume, 429 wait, bisect, control-plane
#                               concurrency (28–34), backfill on real tables, 7.11 query plan on ≥750k rows
for test_file in indexnow-sweep-postgres indexnow-batch-postgres; do
  WO6_DATABASE_TEST=1 \
  WO6_OWNER_DATABASE_URL="$owner_url" \
  WO6_WEB_DATABASE_URL="$web_url" \
  WO6_WORKER_DATABASE_URL="$worker_url" \
  WO6_SCHEDULER_DATABASE_URL="$scheduler_url" \
  npm exec vitest run -- --project node "tests/integration/tasks/${test_file}.test.ts" \
    --reporter=default --reporter=json --outputFile="$secret_dir/integration-result-${test_file}.json"
done

# Minimum passed counts: sweep file 20, batch file 20. Never "0 files ran" and never a skipped test.
node - "$secret_dir" "$project_root" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [secretDir, projectRoot] = process.argv.slice(2);
const expectations = [
  ["indexnow-sweep-postgres", 20],
  ["indexnow-batch-postgres", 20],
];
let totalPassed = 0;
for (const [name, minimum] of expectations) {
  const report = JSON.parse(fs.readFileSync(path.join(secretDir, `integration-result-${name}.json`), "utf8"));
  const expected = path.resolve(projectRoot, "tests/integration/tasks", `${name}.test.ts`);
  const files = report.testResults ?? [];
  const file = files[0];
  const passed = file?.assertionResults?.filter((test) => test.status === "passed").length ?? 0;
  const skipped = report.numPendingTests ?? -1;
  if (files.length !== 1 || path.resolve(file?.name ?? "") !== expected
      || file.status !== "passed" || passed < minimum || skipped !== 0
      || report.numFailedTests !== 0 || report.numPassedTests !== passed) {
    console.error(`WO6_INTEGRATION=FAIL file=${name} reason=not_executed passed=${passed} minimum=${minimum} skipped=${skipped}`);
    process.exit(1);
  }
  totalPassed += passed;
}
console.log(`WO6_INTEGRATION=PASS passed=${totalPassed} skipped=0`);
NODE

DATABASE_URL="$owner_url" node scripts/check-database-dictionary-drift.mjs

echo "WO6_DICTIONARY_DRIFT=0"
echo "WO6_POSTGRES_VERIFICATION=PASS"
