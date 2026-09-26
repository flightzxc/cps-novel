#!/usr/bin/env bash
set -euo pipefail
set +x

# B-17: `tests/integration/tasks/preview-account-hold-postgres.test.ts` existed
# with no runner at all -- `PREVIEW_HOLD_DATABASE_URL` was never set anywhere
# in this repo, so `describe.skipIf(!enabled)` always skipped it and it never
# ran against a real database. This is that runner, following the exact same
# disposable-Postgres-in-Docker shape every other `run-*-postgres-
# verification.sh` in this directory already uses (see
# `run-publication-preview-postgres-verification.sh`).
#
# One role only: the test file's own header says "Run from the worker tier:
# `channel_account_hold` is granted to `worker_app`, and the pre-flight needs
# the worker's keyring" -- and every raw INSERT the test performs (channel,
# source_app, channel_app, channel_account, novel, novel_source_item,
# channel_sync_task, channel_sync_task_item, channel_account_hold,
# channel_account_credential) plus every write `releaseAccountHold`
# (`scripts/preview-account-hold.ts`) itself performs (channel_account_hold,
# channel_sync_task, operation_audit) is already granted to `worker_app` in
# `infra/postgres/grants.sql` -- confirmed against that file rather than
# assumed. `web_app` is NOT sufficient here (it has no INSERT on
# `channel_account_hold` at all), which is why this runner is deliberately
# not shaped like `run-preview-opening-postgres-verification.sh`'s web_app-only
# connection.

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$"
container_name="cps-novel-preview-hold-pg16-${run_id}"
database_name="cps_novel_preview_hold_${run_id//-/_}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-preview-hold-secrets.XXXXXX")"
cleanup_complete="no"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -rf "$secret_dir"
  if ! docker ps -a --format '{{.Names}}' | grep -Fx "$container_name" >/dev/null 2>&1; then
    cleanup_complete="yes"
  fi
  echo "PREVIEW_HOLD_DISPOSABLE_DATABASE_CLEANED=${cleanup_complete}"
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
  --mount "type=bind,src=${secret_dir},dst=/run/preview-hold-secrets,readonly" \
  -e POSTGRES_USER=preview_hold_admin \
  -e POSTGRES_PASSWORD_FILE=/run/preview-hold-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U preview_hold_admin -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container_name" pg_isready -U preview_hold_admin -d postgres >/dev/null
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

docker exec -i "$container_name" psql --no-psqlrc -U preview_hold_admin -d postgres \
  <"$project_root/infra/postgres/roles.sql" >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -U preview_hold_admin -d postgres \
  <"$secret_dir/role-passwords.sql" >/dev/null
docker exec "$container_name" createdb -U preview_hold_admin -O migration_owner "$database_name"

owner_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
worker_url="postgresql://worker_app:${worker_password}@127.0.0.1:${host_port}/${database_name}?schema=public"

DATABASE_URL="$owner_url" npm exec prisma migrate deploy >/dev/null
docker exec \
  -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE="$database_name" \
  -e PGUSER=migration_owner -e PGPASSWORD="$migration_password" \
  "$container_name" psql --no-psqlrc --file=/workspace/infra/postgres/grants.sql >/dev/null

# Non-empty array is compatible with macOS Bash 3 + nounset.
test_args=(--testNamePattern "${PREVIEW_HOLD_TEST_PATTERN:-.}")

PREVIEW_HOLD_DATABASE_TEST=1 \
PREVIEW_HOLD_DATABASE_URL="$worker_url" \
npm exec vitest run -- --project node tests/integration/tasks/preview-account-hold-postgres.test.ts \
  "${test_args[@]}" --reporter=default --reporter=json --outputFile="$secret_dir/integration-result.json"

node - "$secret_dir/integration-result.json" "$project_root/tests/integration/tasks/preview-account-hold-postgres.test.ts" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const expected = path.resolve(process.argv[3]);
const filtered = Boolean(process.env.PREVIEW_HOLD_TEST_PATTERN);
const files = report.testResults ?? [];
const file = files[0];
const passed = file?.assertionResults?.filter((test) => test.status === "passed").length ?? 0;
const skipped = report.numPendingTests ?? -1;
if (files.length !== 1 || path.resolve(file?.name ?? "") !== expected
    || file.status !== "passed" || passed < (filtered ? 1 : 5) || (!filtered && skipped !== 0)
    || report.numFailedTests !== 0 || report.numPassedTests !== passed) {
  console.error(`PREVIEW_HOLD_INTEGRATION=FAIL reason=not_executed passed=${passed} skipped=${skipped}`);
  process.exit(1);
}
console.log(`PREVIEW_HOLD_INTEGRATION=PASS passed=${passed} skipped=${skipped} filtered=${filtered}`);
NODE

DATABASE_URL="$owner_url" node scripts/check-database-dictionary-drift.mjs

echo "PREVIEW_HOLD_DICTIONARY_DRIFT=0"
echo "PREVIEW_HOLD_POSTGRES_VERIFICATION=PASS"
