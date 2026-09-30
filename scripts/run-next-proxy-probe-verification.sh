#!/usr/bin/env bash
set -euo pipefail
set +x

# Next.js proxy-bypass probe runner (2026-09-30, Next 16.1.6 -> 16.3.3 security upgrade).
#
# Builds the app (unless NEXT_PROBE_SKIP_BUILD=1), starts a disposable
# Postgres (brand-new container/volume/network, real migrations + grants, same
# discipline as scripts/run-phase-d-postgres-verification.sh), starts
# `next start` against it with a distinct public host and admin host, and runs
# scripts/security/next-proxy-probe.mjs against the live server. Everything is
# torn down on exit. It never touches cps-novel-x8-local or any other running
# stack, and only binds 127.0.0.1 on random ports.
#
# Knobs (all optional):
#   NEXT_PROBE_SKIP_BUILD=1     reuse the existing .next build (must match the installed next)
#   NEXT_PROBE_LABEL=<name>     tag for the JSON evidence file (default: next-<installed version>)
#   NEXT_PROBE_OUT_DIR=<dir>    where probe JSON + server log land (default: .tmp/next-proxy-probe)
#   NEXT_PROBE_ALLOW_FAIL=1     record probe failures but exit 0 (used to capture the *pre-upgrade* evidence;
#                               the printed NEXT_PROXY_PROBE= line still says FAIL)
#
# Acceptance: prints NEXT_PROXY_PROBE=PASS and NEXT_PROXY_PROBE_VERIFICATION=PASS.
# On a vulnerable Next it is expected to print NEXT_PROXY_PROBE=FAIL (see the
# GHSA-3g8h-86w9-wvmq probes) — that is what makes it a real regression guard.

project_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_root"

run_id="$(date +%Y%m%d%H%M%S)-$$-$RANDOM"
database_run_id="$(date +%H%M%S)-$$-$RANDOM"
container_name="cps-novel-next-probe-pg16-${run_id}"
volume_name="cps-novel-next-probe-pgdata-${run_id}"
network_name="cps-novel-next-probe-net-${run_id}"
database_name="next_probe_${database_run_id//-/_}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-next-probe-secrets.XXXXXX")"
out_dir="${NEXT_PROBE_OUT_DIR:-$project_root/.tmp/next-proxy-probe}"
mkdir -p "$out_dir"
server_log="$out_dir/next-start-${run_id}.log"
server_pid=""
cleanup_ran=no

cleanup() {
  set +e
  if [ "$cleanup_ran" != no ]; then return 0; fi
  cleanup_ran=yes
  if [ -n "$server_pid" ]; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" >/dev/null 2>&1 || true
  fi
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  docker volume rm "$volume_name" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
  rm -rf "$secret_dir"
  if ! docker ps -a --format '{{.Names}}' | grep -Fx "$container_name" >/dev/null 2>&1 \
    && ! docker volume ls --format '{{.Name}}' | grep -Fx "$volume_name" >/dev/null 2>&1 \
    && ! docker network ls --format '{{.Name}}' | grep -Fx "$network_name" >/dev/null 2>&1; then
    printf 'NEXT_PROBE_CLEANUP=PASS\n'
  else
    printf 'NEXT_PROBE_CLEANUP=FAIL\n' >&2
  fi
}
trap cleanup EXIT INT TERM
trap 'status=$?; printf "NEXT_PROBE_ERROR line=%s status=%s\n" "$LINENO" "$status" >&2; exit "$status"' ERR

next_version="$(node -p 'require("next/package.json").version')"
label="${NEXT_PROBE_LABEL:-next-${next_version}}"
printf 'NEXT_VERSION_UNDER_TEST=%s\n' "$next_version"

umask 077
bootstrap_password="$(openssl rand -hex 24)"
migration_password="$(openssl rand -hex 24)"
web_password="$(openssl rand -hex 24)"
worker_password="$(openssl rand -hex 24)"
scheduler_password="$(openssl rand -hex 24)"
analyst_password="$(openssl rand -hex 24)"
backup_password="$(openssl rand -hex 24)"
totp_key="$(openssl rand -base64 32 | tr -d '\r\n')"
tracking_salt="$(openssl rand -base64 32 | tr -d '\r\n')"

printf '%s' "$bootstrap_password" >"$secret_dir/bootstrap-password"
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
  --mount "type=bind,src=${secret_dir},dst=/run/next-probe-secrets,readonly" \
  -e POSTGRES_USER=next_probe_admin \
  -e POSTGRES_PASSWORD_FILE=/run/next-probe-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U next_probe_admin -d postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$container_name" pg_isready -U next_probe_admin -d postgres >/dev/null
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

docker exec -i "$container_name" psql --no-psqlrc -U next_probe_admin -d postgres \
  <infra/postgres/roles.sql >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -U next_probe_admin -d postgres \
  <"$secret_dir/role-passwords.sql" >/dev/null
docker exec "$container_name" createdb -U next_probe_admin -O migration_owner "$database_name"

owner_url="postgresql://migration_owner:${migration_password}@127.0.0.1:${host_port}/${database_name}?schema=public"
web_url="postgresql://web_app:${web_password}@127.0.0.1:${host_port}/${database_name}?schema=public"

DATABASE_URL="$owner_url" npx prisma migrate deploy >"$out_dir/prisma-migrate-${run_id}.log" 2>&1
docker exec -i "$container_name" psql --no-psqlrc -U next_probe_admin -d "$database_name" \
  <infra/postgres/grants.sql >/dev/null
# Minimal data: public pages refuse to render (500) without a default OG image, and
# the brand name comes from the site_setting singleton row created by the migrations.
docker exec -i "$container_name" psql --no-psqlrc -v ON_ERROR_STOP=1 -U next_probe_admin -d "$database_name" >/dev/null <<SQL
UPDATE site_setting
   SET site_name = 'Probe Site',
       default_og_image = 'https://${PROBE_PUBLIC_HOST:-novel.test}/brand/og-default.png'
 WHERE id = 1;
SQL
printf 'PROBE_DATABASE=READY name=%s port=%s\n' "$database_name" "$host_port"

if [ "${NEXT_PROBE_SKIP_BUILD:-0}" != "1" ]; then
  NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_BUILD_VERSION="v$(node -p 'require("./package.json").version')" \
    npm run build >"$out_dir/build-${run_id}.log" 2>&1
  printf 'PROBE_BUILD=PASS next=%s\n' "$next_version"
else
  printf 'PROBE_BUILD=SKIPPED next=%s\n' "$next_version"
fi
if ! test -f .next/BUILD_ID; then echo 'PROBE_ERROR: .next/BUILD_ID missing (no build)' >&2; exit 1; fi

server_port="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
public_host="${PROBE_PUBLIC_HOST:-novel.test}"
admin_host="zbcwf.${PROBE_PUBLIC_HOST:-novel.test}"

DATABASE_URL="$web_url" \
SITE_URL="https://${public_host}" \
ADMIN_CANONICAL_ORIGIN="https://${admin_host}" \
TOTP_ENCRYPTION_KEY="$totp_key" \
TRACKING_HASH_SALT="$tracking_salt" \
NEXT_TELEMETRY_DISABLED=1 \
NODE_ENV=production \
  node_modules/.bin/next start -H 127.0.0.1 -p "$server_port" >"$server_log" 2>&1 &
server_pid=$!

ready=0
for _ in $(seq 1 90); do
  if curl --noproxy '*' --silent --output /dev/null --max-time 3 -H "Host: ${public_host}" "http://127.0.0.1:${server_port}/api/health"; then
    ready=1
    break
  fi
  if ! kill -0 "$server_pid" >/dev/null 2>&1; then break; fi
  sleep 1
done
if [ "$ready" != 1 ]; then
  echo "PROBE_ERROR: next start did not become ready; last log lines:" >&2
  tail -n 30 "$server_log" >&2 || true
  exit 1
fi
printf 'PROBE_SERVER=READY port=%s next=%s\n' "$server_port" "$next_version"

probe_json="$out_dir/probe-${label}.json"
probe_status=0
node scripts/security/next-proxy-probe.mjs \
  --port "$server_port" \
  --public-host "$public_host" \
  --admin-host "$admin_host" \
  --build-id-file .next/BUILD_ID \
  --next-version "$next_version" \
  --json-out "$probe_json" || probe_status=$?
printf 'PROBE_EVIDENCE=%s\n' "$probe_json"

# A crashed server would turn every later probe into a socket error; make that loud.
if ! kill -0 "$server_pid" >/dev/null 2>&1; then
  echo "PROBE_ERROR: next start died during the probe run; last log lines:" >&2
  tail -n 30 "$server_log" >&2 || true
  exit 1
fi

if [ "$probe_status" -ne 0 ]; then
  if [ "${NEXT_PROBE_ALLOW_FAIL:-0}" = "1" ] && [ "$probe_status" -eq 1 ]; then
    printf 'NEXT_PROXY_PROBE_VERIFICATION=RECORDED_FAIL next=%s (NEXT_PROBE_ALLOW_FAIL=1)\n' "$next_version"
    exit 0
  fi
  printf 'NEXT_PROXY_PROBE_VERIFICATION=FAIL next=%s probe_exit=%s\n' "$next_version" "$probe_status"
  exit "$probe_status"
fi
printf 'NEXT_PROXY_PROBE_VERIFICATION=PASS next=%s\n' "$next_version"
