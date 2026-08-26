#!/usr/bin/env bash
set -euo pipefail
set +x

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$"
container_name="cps-novel-x2-pg16-${run_id}"
volume_name="cps-novel-x2-pgdata-${run_id}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-x2-secrets.XXXXXX")"
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
printf '%s' "$bootstrap_password" >"$secret_dir/bootstrap-password"

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
  --mount "type=bind,src=${secret_dir},dst=/run/x2-secrets,readonly" \
  -e POSTGRES_USER=x2_admin \
  -e POSTGRES_PASSWORD_FILE=/run/x2-secrets/bootstrap-password \
  -e POSTGRES_DB=postgres \
  postgres:16.14 \
  -c config_file=/workspace/infra/postgres/pitr/postgresql.conf.example >/dev/null

ready="no"
for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U x2_admin -d postgres >/dev/null 2>&1; then
    ready="yes"
    break
  fi
  sleep 1
done

if [[ "$ready" != "yes" ]]; then
  docker logs "$container_name" >&2
  echo "ERROR: disposable PostgreSQL did not become ready" >&2
  exit 1
fi

docker exec -i "$container_name" psql --no-psqlrc -U x2_admin -d postgres \
  <"$project_root/infra/postgres/roles.sql" >/dev/null

role_settings() {
  local role_name="$1"
  docker exec "$container_name" \
    psql --no-psqlrc -U "$role_name" -d postgres --tuples-only --no-align \
    --command="SELECT
      extract(epoch FROM current_setting('statement_timeout')::interval)::integer || '|' ||
      extract(epoch FROM current_setting('lock_timeout')::interval)::integer || '|' ||
      extract(epoch FROM current_setting('idle_in_transaction_session_timeout')::interval)::integer" \
    | tr -d '\r[:space:]'
}

[[ "$(role_settings web_app)" == "30|5|60" ]]
[[ "$(role_settings worker_app)" == "300|15|300" ]]
[[ "$(role_settings scheduler_app)" == "60|5|60" ]]

cluster_settings="$(docker exec "$container_name" \
  psql --no-psqlrc -U x2_admin -d postgres --tuples-only --no-align \
  --command="SELECT
    current_setting('max_connections') || '|' ||
    current_setting('log_min_duration_statement') || '|' ||
    current_setting('shared_preload_libraries') || '|' ||
    current_setting('compute_query_id') || '|' ||
    current_setting('pg_stat_statements.track')" \
  | tr -d '\r[:space:]')"
[[ "$cluster_settings" == "100|500ms|pg_stat_statements|auto|all" ]]

docker exec "$container_name" psql --no-psqlrc -U x2_admin -d postgres \
  --command="CREATE EXTENSION IF NOT EXISTS pg_stat_statements" >/dev/null
extension_probe="$(docker exec "$container_name" \
  psql --no-psqlrc -U x2_admin -d postgres --tuples-only --no-align \
  --command="SELECT (SELECT count(*) FROM pg_stat_statements) >= 0
             AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements')" \
  | tr -d '\r[:space:]')"
[[ "$extension_probe" == "t" ]]

echo "X2_ROLE_TIMEOUTS=PASS"
echo "X2_POSTGRESQL_CONFIG=PASS"
echo "X2_PG_STAT_STATEMENTS=PASS"
echo "X2_PRODUCTION_STATUS=CONFIGURATION_CONTRACT_ONLY"
echo "X2_POSTGRES_HARDENING_VERIFICATION=PASS"
