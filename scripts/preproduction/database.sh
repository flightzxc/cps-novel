#!/usr/bin/env bash
set -euo pipefail
set +x

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/preproduction/lib.sh
source "$root/scripts/preproduction/lib.sh"
preprod_load_env

usage() {
  echo "usage: database.sh fresh-init|persistent-check|migrate-approved" >&2
  exit 64
}

verify_roles_and_schema() {
  preprod_compose exec -T postgres psql --no-psqlrc -v ON_ERROR_STOP=1 \
    -U postgres -d cps_novel <<'SQL' >/dev/null
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['migration_owner','web_app','worker_app','scheduler_app','analyst_ro','backup_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      RAISE EXCEPTION 'required role missing: %', role_name;
    END IF;
  END LOOP;
END $$;
SELECT 1 FROM "_prisma_migrations" LIMIT 1;
SQL
}

case "${1:-}" in
  fresh-init)
    [[ "${PREPROD_CONFIRM_EMPTY_VOLUME:-}" == "EMPTY_cps_novel_postgres_data" ]] || {
      echo "DATABASE_FRESH_INIT=REFUSED reason=explicit_empty_confirmation_required"; exit 65;
    }
    preprod_compose config | grep -q '^    name: cps_novel_postgres_data$' || {
      echo "DATABASE_FRESH_INIT=REFUSED reason=volume_identity"; exit 65;
    }
    if docker volume inspect cps_novel_postgres_data >/dev/null 2>&1; then
      count="$(docker run --rm -v cps_novel_postgres_data:/data:ro alpine:3.20 sh -c 'find /data -mindepth 1 -maxdepth 1 -print | head -1' | wc -l | tr -d ' ')"
      [[ "$count" == "0" ]] || { echo "DATABASE_FRESH_INIT=REFUSED reason=volume_not_empty"; exit 73; }
    fi
    preprod_compose up -d postgres
    PREPROD_APPROVED_MIGRATION=YES "$0" migrate-approved
    verify_roles_and_schema
    echo "DATABASE_FRESH_INIT=PASS foundation_rows=NOT_APPLIED account_bootstrap=REQUIRED"
    ;;
  persistent-check)
    docker volume inspect cps_novel_postgres_data >/dev/null 2>&1 || {
      echo "DATABASE_PERSISTENT_CHECK=FAIL reason=volume_missing"; exit 65;
    }
    preprod_compose ps --status running postgres | grep -q postgres || {
      echo "DATABASE_PERSISTENT_CHECK=FAIL reason=postgres_not_running"; exit 69;
    }
    verify_roles_and_schema
    for pair in \
      migration_owner:/run/secrets/migration_owner_password \
      web_app:/run/secrets/web_app_password \
      worker_app:/run/secrets/worker_app_password \
      scheduler_app:/run/secrets/scheduler_app_password \
      analyst_ro:/run/secrets/analyst_ro_password \
      backup_role:/run/secrets/backup_role_password; do
      role="${pair%%:*}"; password_file="${pair#*:}"
      preprod_compose exec -T -e CHECK_ROLE="$role" -e CHECK_PASSWORD_FILE="$password_file" postgres \
        bash -ceu 'export PGPASSWORD="$(<"$CHECK_PASSWORD_FILE")"; psql --no-psqlrc -h 127.0.0.1 -U "$CHECK_ROLE" -d cps_novel -Atqc "SELECT current_user"' \
        | grep -qx "$role" || { echo "DATABASE_PERSISTENT_CHECK=FAIL reason=role_auth"; exit 65; }
    done
    echo "DATABASE_PERSISTENT_CHECK=PASS"
    ;;
  migrate-approved)
    [[ "${PREPROD_APPROVED_MIGRATION:-}" == "YES" ]] || {
      echo "DATABASE_MIGRATION=REFUSED reason=approval_required"; exit 65;
    }
    # 🔴 应用镜像入口：禁 pull、禁就地 build。
    preprod_compose_app_run \
      -e DATABASE_URL="$P1_12_MIGRATION_DATABASE_URL" web \
      npx --no-install prisma migrate deploy
    echo "DATABASE_MIGRATION=PASS"
    ;;
  *) usage ;;
esac
