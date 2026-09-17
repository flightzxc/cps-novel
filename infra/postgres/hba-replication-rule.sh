#!/usr/bin/env bash
# Gate 5-Dev / Gate 5 review fix (P1-3, P1-4): the pg_hba.conf replication
# rule this file appends is shared between two callers --
# infra/postgres/init-roles.sh (real initdb.d execution, once per
# brand-new PGDATA) and tests/backend/database/init-roles-hba.test.ts (which
# sources this file directly, with no live psql/PGDATA, to exercise the
# append logic in isolation). Splitting it out of init-roles.sh is what
# makes that isolated test possible at all -- init-roles.sh itself needs a
# live `psql`/$POSTGRES_USER/$POSTGRES_DB to run end to end, this function
# does not.
#
# x8_append_hba_replication_rule <pg_hba.conf path>
#
# Appends "host replication backup_role <subnet> scram-sha-256" to the given
# pg_hba.conf if it is not already present verbatim (idempotent: a second
# call is a no-op). Ensures the file ends with a newline before appending,
# so the new rule is never glued onto the end of the previous line (the bug
# this fix closes: a pg_hba.conf whose last line has no trailing newline
# would otherwise get a syntactically-broken merged line). A no-op, not an
# error, if the file does not exist yet.
x8_append_hba_replication_rule() {
  local hba_file="$1"
  local hba_rule="host replication backup_role ${X8_RUNTIME_SUBNET:-172.18.0.0/16} scram-sha-256"
  [[ -f "$hba_file" ]] || return 0
  [ -z "$(tail -c1 "$hba_file")" ] || echo >>"$hba_file"
  grep -qxF "$hba_rule" "$hba_file" || printf '%s\n' "$hba_rule" >>"$hba_file"
}
