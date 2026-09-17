#!/usr/bin/env bash
set -euo pipefail
set +x

# Phase D (施工工单_PhaseD_安全与运行态收口_2026-09-06.md) D-2 verification --
# disposable Postgres, same discipline as
# scripts/run-phase-b-entity-fix-postgres-verification.sh: a brand-new,
# uniquely-named container/volume/network, infra/postgres/roles.sql to
# provision the same six least-privilege roles the real schema expects, a
# random host port, and a full teardown on exit. NEVER touches
# cps-novel-x8-local or its network cps_novel_x8_runtime -- this uses its
# OWN disposable network, joined via X8_ROLE_VERIFY_NETWORK (an override
# x8_verify_db_role_passwords_via_network() in
# scripts/lib/x8-production-like-env.sh only reads for exactly this reason;
# with it unset, that function always joins the real
# cps_novel_x8_runtime network, unchanged from before this doc).
#
# Exercises x8_align_db_role_passwords() and
# x8_verify_db_role_passwords_via_network() -- the two real functions
# scripts/x8-production-like.sh's prepare_database() now calls -- against a
# REAL Postgres server, proving the actual self-heal round trip the doc
# names: roles.sql leaves all six roles password-less (or, for two of them,
# deliberately wrong below) -> verify fails closed -> align -> verify
# passes. x8_align_db_role_passwords() itself calls x8_compose(), which this
# script overrides (after sourcing the real x8-production-like.sh) to
# redirect its one `exec -T postgres ...` shape at this disposable
# container via a plain `docker exec`, instead of standing up the entire
# six-service compose stack (nginx/TLS/mkcert/hosts-file plumbing) just to
# reach the one Postgres call this test cares about.

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="$(date +%Y%m%d%H%M%S)-$$-$RANDOM"
container_name="cps-novel-phase-d-role-pg16-${run_id}"
volume_name="cps-novel-phase-d-role-pgdata-${run_id}"
network_name="cps-novel-phase-d-role-net-${run_id}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-phase-d-role-secrets.XXXXXX")"
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
    printf 'PHASE_D_ROLE_POSTGRES_CLEANUP=PASS\n'
  else
    printf 'PHASE_D_ROLE_POSTGRES_CLEANUP=FAIL\n' >&2
  fi
}
trap cleanup EXIT INT TERM
trap 'status=$?; printf "PHASE_D_ROLE_POSTGRES_ERROR line=%s status=%s\n" "$LINENO" "$status" >&2; exit "$status"' ERR

umask 077
bootstrap_password="$(openssl rand -hex 24)"
printf '%s' "$bootstrap_password" >"$secret_dir/bootstrap-password"
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
  --mount "type=bind,src=${secret_dir},dst=/run/phase-d-role-secrets,readonly" \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD_FILE=/run/phase-d-role-secrets/bootstrap-password \
  -e POSTGRES_DB=cps_novel \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U postgres -d cps_novel >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$container_name" pg_isready -U postgres -d cps_novel >/dev/null

# roles.sql leaves every role password-less (see that file's own header
# comment) -- already "misaligned" for two of the six with no work needed.
# For the other two, go further and set a deliberately WRONG password, to
# additionally prove align overwrites a mismatched (not merely absent)
# password, not just one that was never set.
docker exec -i "$container_name" psql --no-psqlrc -v ON_ERROR_STOP=1 -U postgres -d cps_novel \
  <infra/postgres/roles.sql >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -v ON_ERROR_STOP=1 -U postgres -d cps_novel <<'SQL' >/dev/null
ALTER ROLE migration_owner PASSWORD 'deliberately-wrong-owner-password';
ALTER ROLE worker_app PASSWORD 'deliberately-wrong-worker-password';
SQL

# This worktree's own (throwaway) secret files -- what align/verify will
# use as "the desired password" for each role.
for role in migration_owner web_app worker_app scheduler_app analyst_ro backup_role; do
  openssl rand -hex 24 >"$secret_dir/${role}.password"
done
chmod 600 "$secret_dir"/*.password

host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

script="
  set -euo pipefail
  source \"$project_root/scripts/x8-production-like.sh\"

  # Redirect x8_compose() -- the one thing x8_align_db_role_passwords()
  # calls that this script does not otherwise stand up -- at this
  # disposable container via a plain 'docker exec', instead of a real
  # compose project. Only the one invocation shape
  # x8_align_db_role_passwords() actually issues
  # ('exec -T postgres psql ...') is handled; anything else is a test bug.
  x8_compose() {
    if [[ \"\$1\" == exec && \"\$2\" == -T && \"\$3\" == postgres ]]; then
      shift 3
      docker exec -i \"$container_name\" \"\$@\"
    else
      echo \"ERROR: unexpected x8_compose call in role-password verification harness: \$*\" >&2
      return 70
    fi
  }

  export X8_RUNTIME_DIR=\"$secret_dir/runtime\"
  mkdir -p \"\$X8_RUNTIME_DIR\"
  export P1_12_MIGRATION_OWNER_PASSWORD_FILE=\"$secret_dir/migration_owner.password\"
  export P1_12_WEB_APP_PASSWORD_FILE=\"$secret_dir/web_app.password\"
  export P1_12_WORKER_APP_PASSWORD_FILE=\"$secret_dir/worker_app.password\"
  export P1_12_SCHEDULER_APP_PASSWORD_FILE=\"$secret_dir/scheduler_app.password\"
  export P1_12_ANALYST_RO_PASSWORD_FILE=\"$secret_dir/analyst_ro.password\"
  export P1_12_BACKUP_ROLE_PASSWORD_FILE=\"$secret_dir/backup_role.password\"
  export X8_ROLE_VERIFY_NETWORK=\"$network_name\"

  echo 'PHASE_D_ROLE_STEP=verify_before_align'
  if x8_verify_db_role_passwords_via_network 2>/tmp/phase-d-role-verify-before.stderr; then
    echo 'PHASE_D_ROLE_VERIFY_BEFORE_ALIGN=UNEXPECTEDLY_PASSED'
    exit 1
  else
    echo 'PHASE_D_ROLE_VERIFY_BEFORE_ALIGN=FAILED_AS_EXPECTED'
    cat /tmp/phase-d-role-verify-before.stderr
  fi

  echo 'PHASE_D_ROLE_STEP=align'
  x8_align_db_role_passwords
  echo 'PHASE_D_ROLE_ALIGN=DONE'

  echo 'PHASE_D_ROLE_STEP=align_is_idempotent'
  x8_align_db_role_passwords
  echo 'PHASE_D_ROLE_ALIGN_REPEAT=DONE'

  echo 'PHASE_D_ROLE_STEP=verify_after_align'
  x8_verify_db_role_passwords_via_network
  echo 'PHASE_D_ROLE_VERIFY_AFTER_ALIGN=PASSED'
"

DATABASE_URL="postgresql://postgres:${bootstrap_password}@127.0.0.1:${host_port}/cps_novel?schema=public" \
  bash -c "$script"
printf 'PHASE_D_ROLE_PASSWORD_SELF_HEAL=PASS\n'
