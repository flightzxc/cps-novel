#!/usr/bin/env bash
set -euo pipefail
set +x

read_secret() {
  local variable_name="$1"
  local path="${!variable_name:-}"
  [[ -n "$path" && -r "$path" ]] || {
    echo "ERROR: required PostgreSQL role secret file is unavailable: $variable_name" >&2
    exit 1
  }
  tr -d '\r\n' <"$path"
}

psql --no-psqlrc --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --file /opt/cps-novel-postgres/roles.sql

for role in migration_owner web_app worker_app scheduler_app analyst_ro backup_role; do
  variable="P1_12_${role^^}_PASSWORD_FILE"
  password="$(read_secret "$variable")"
  [[ "$password" =~ ^[0-9a-f]{48}$ ]] || {
    echo "ERROR: invalid local password material for role $role" >&2
    exit 1
  }
  psql --no-psqlrc --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --set=role_name="$role" --set=role_password="$password" <<'SQL'
ALTER ROLE :"role_name" PASSWORD :'role_password';
SQL
done

psql --no-psqlrc --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=database_name="$POSTGRES_DB" <<'SQL'
ALTER DATABASE :"database_name" OWNER TO migration_owner;
SQL

echo "P1_12_POSTGRES_ROLES_INITIALIZED=PASS"
