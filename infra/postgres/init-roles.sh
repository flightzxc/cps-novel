#!/usr/bin/env bash
set -euo pipefail
set +x

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/postgres/hba-replication-rule.sh
source "${SCRIPT_DIR}/hba-replication-rule.sh"

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

# Gate 5-Dev (WAL retention rollout §5.2): grants backup_role a replication
# connection from anywhere on the runtime docker network, so a future
# backup-timer step that has that container itself dial `pg_basebackup
# --wal-method=stream` over the network (rather than the docker-exec/local-
# socket path base-backup-now/wal-gc already use, which never touches
# pg_hba at all) has a rule to match. Deliberately scoped to `replication`
# database + `backup_role` only -- never `all all` -- and to the runtime
# subnet, not 0.0.0.0/0.
#
# This only takes effect here on a brand-new PGDATA (initdb.d scripts run
# exactly once, the first time a cluster is bootstrapped from empty). An
# already-initialized, already-running cluster's pg_hba.conf is NOT touched
# by this file ever running again -- that is Gate 5-Ops's job: append the
# same line to the live pg_hba.conf by hand (or via a bind-mounted
# postgres-entrypoint.sh addition, per the rollout plan's §5.2) and call
# `SELECT pg_reload_conf();`, which is the PostgreSQL-native, no-restart way
# to pick up a pg_hba.conf edit.
#
# Gate 5 review fix (P1-3): the actual append logic now lives in
# hba-replication-rule.sh (sourced above) so it can be unit-tested in
# isolation (tests/backend/database/init-roles-hba.test.ts) without a live
# psql/PGDATA -- it also now guarantees the file ends with a newline before
# appending, so a pg_hba.conf whose last line lacked a trailing newline can
# no longer get the new rule glued onto the end of that line.
hba_file="${PGDATA:-/var/lib/postgresql/data}/pg_hba.conf"
x8_append_hba_replication_rule "$hba_file"

echo "P1_12_POSTGRES_ROLES_INITIALIZED=PASS"
