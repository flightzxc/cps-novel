#!/usr/bin/env bash
set -euo pipefail
set +x

# Phase D (施工工单_PhaseD_安全与运行态收口_2026-09-06.md) D-1 verification --
# disposable Postgres, same discipline as scripts/p1-13-postgres-verification.sh
# (brand-new container/volume/network, roles.sql + grants.sql for the same
# least-privilege roles the real schema expects, a random host port, full
# teardown on exit). Runs the D-1 dry-run zero-write tests
# (tests/integration/tasks/p2-05-postgres.test.ts), the new dry_run
# protectedWrite fail-closed backstop test
# (tests/integration/tasks/p1-07-postgres.test.ts), and the p1-13 acceptance
# regression the work order names explicitly -- never touches
# cps-novel-x8-local or any other already-running stack.

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$-$RANDOM"
database_run_id="$(date +%H%M%S)-$$-$RANDOM"
container_name="cps-novel-phase-d-pg16-${run_id}"
volume_name="cps-novel-phase-d-pgdata-${run_id}"
network_name="cps-novel-phase-d-net-${run_id}"
# p2-05-postgres.test.ts's beforeAll() refuses to run against a database
# whose name does not contain "p1_13", AND p1-07-postgres.test.ts's own
# beforeEach() separately refuses one that does not contain "p1_07" --
# inherited from the shared p1-05b/p1-06/p1-07/p1-08b/p1-13/p2-05
# database-name convention every one of these integration files was written
# against (scripts/p1-13-postgres-verification.sh's own database name
# carries all five substrings for exactly this reason). Keeping both
# substrings here is what lets both files run unmodified.
database_name="p1_07_p1_13_phase_d_${database_run_id//-/_}"
shadow_database_name="${database_name}_shadow"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-phase-d-secrets.XXXXXX")"
cleanup_ran=no

cleanup() {
  set +e
  [[ "$cleanup_ran" == no ]] || return 0
  cleanup_ran=yes
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  docker volume rm "$volume_name" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
  rm -rf "$secret_dir"
  if ! docker ps -a --format '{{.Names}}' | grep -Fx "$container_name" >/dev/null 2>&1 \
    && ! docker volume ls --format '{{.Name}}' | grep -Fx "$volume_name" >/dev/null 2>&1 \
    && ! docker network ls --format '{{.Name}}' | grep -Fx "$network_name" >/dev/null 2>&1; then
    printf 'PHASE_D_POSTGRES_CLEANUP=PASS\n'
  else
    printf 'PHASE_D_POSTGRES_CLEANUP=FAIL\n' >&2
  fi
}
trap cleanup EXIT INT TERM
trap 'status=$?; printf "PHASE_D_POSTGRES_ERROR line=%s status=%s\n" "$LINENO" "$status" >&2; exit "$status"' ERR

umask 077
bootstrap_password="$(openssl rand -hex 24)"
migration_password="$(openssl rand -hex 24)"
web_password="$(openssl rand -hex 24)"
worker_password="$(openssl rand -hex 24)"
scheduler_password="$(openssl rand -hex 24)"
analyst_password="$(openssl rand -hex 24)"
backup_password="$(openssl rand -hex 24)"

printf '%s' "$bootstrap_password" >"$secret_dir/bootstrap-password"
openssl rand 32 | openssl base64 -A >"$secret_dir/credential-v1.key"
openssl rand 32 | openssl base64 -A >"$secret_dir/credential-v2.key"
openssl rand 32 | openssl base64 -A >"$secret_dir/credential-fingerprint.key"
for role_password in \
  "migration_owner:${migration_password}" \
  "web_app:${web_password}" \
  "worker_app:${worker_password}" \
  "scheduler_app:${scheduler_password}" \
  "analyst_ro:${analyst_password}" \
  "backup_role:${backup_password}"; do
  role_name="${role_password%%:*}"
  password="${role_password#*:}"
  printf "ALTER ROLE %s PASSWORD '%s';\n" "$role_name" "$password" >>"$secret_dir/role-passwords.sql"
done
chmod 600 "$secret_dir"/*

cd "$project_root"
if ! docker image inspect postgres:16.14 >/dev/null 2>&1; then
  docker pull postgres:16.14 >/dev/null
fi
docker network create "$network_name" >/dev/null
docker volume create "$volume_name" >/dev/null
docker run -d \
  --name "$container_name" \
  --network "$network_name" \
  --network-alias postgres \
  --mount "type=volume,src=${volume_name},dst=/var/lib/postgresql/data" \
  --mount "type=bind,src=${secret_dir},dst=/run/phase-d-secrets,readonly" \
  -e POSTGRES_USER=phase_d_admin \
  -e POSTGRES_PASSWORD_FILE=/run/phase-d-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U phase_d_admin -d postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$container_name" pg_isready -U phase_d_admin -d postgres >/dev/null
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

docker exec -i "$container_name" psql --no-psqlrc -U phase_d_admin -d postgres \
  <infra/postgres/roles.sql >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -U phase_d_admin -d postgres \
  <"$secret_dir/role-passwords.sql" >/dev/null
docker exec "$container_name" createdb -U phase_d_admin -O migration_owner "$database_name"
docker exec "$container_name" createdb -U phase_d_admin -O migration_owner "$shadow_database_name"

owner_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
shadow_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${shadow_database_name}?schema=public"
web_url="postgresql://web_app:${web_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
worker_url="postgresql://worker_app:${worker_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
scheduler_url="postgresql://scheduler_app:${scheduler_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
analyst_url="postgresql://analyst_ro:${analyst_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
backup_url="postgresql://backup_role:${backup_password}@127.0.0.1:${host_port}/${database_name}?schema=public"

DATABASE_URL="$owner_url" npx prisma validate
DATABASE_URL="$owner_url" npx prisma generate
DATABASE_URL="$owner_url" npx prisma migrate deploy
# Note: deliberately no `prisma migrate diff --exit-code` shadow-database
# check here (unlike scripts/p1-13-postgres-verification.sh) -- this repo
# already carries a pre-existing, Phase-D-unrelated FK-name drift between
# prisma/migrations and prisma/schema.prisma (confirmed present before any
# Phase D change: canonical_tag_keyword/canonical_tag_translation/
# novel_canonical_tag/novel_tag_state/source_label_mapping FK renames). This
# script's only job is running the targeted vitest files against a real,
# fully-migrated database, not re-litigating that unrelated drift.
docker exec -i "$container_name" psql --no-psqlrc -U phase_d_admin -d "$database_name" \
  <infra/postgres/grants.sql >/dev/null

export DATABASE_URL="$owner_url"
export P1_07_DATABASE_TEST=1
export P2_05_DATABASE_TEST=1
export P2_05_OWNER_DATABASE_URL="$owner_url"
export P2_05_WORKER_DATABASE_URL="$worker_url"
export P1_13_DATABASE_TEST=1
export CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION=2
export CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE="$secret_dir/credential-v1.key"
export CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V2_FILE="$secret_dir/credential-v2.key"
export CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE="$secret_dir/credential-fingerprint.key"

server_version="$(docker exec "$container_name" psql --no-psqlrc -U phase_d_admin -d "$database_name" -Atc "SHOW server_version")"
printf 'POSTGRES_VERSION=%s\n' "$server_version"
printf 'TEST_DB_ISOLATION=UNIQUE_DATABASE_PER_RUN name=%s port=%s\n' "$database_name" "$host_port"

npx vitest run --project node --no-file-parallelism \
  tests/integration/tasks/p1-07-postgres.test.ts \
  tests/integration/tasks/p2-05-postgres.test.ts \
  tests/integration/tasks/p1-13-postgres-acceptance.test.ts
printf 'PHASE_D_PG_GATED_TESTS=PASS\n'
