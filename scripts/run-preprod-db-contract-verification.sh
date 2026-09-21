#!/usr/bin/env bash
set -euo pipefail
set +x

# Real-PostgreSQL proof for the preprod grants-replay defect fix
# (scripts/preproduction/database.sh's migrate-approved grants replay and
# persistent-check's DATABASE_PRIVILEGE_CHECK). A disposable PostgreSQL
# 16.14 + a disposable named volume, unique per run (includes $$), torn down
# by name in an EXIT trap -- mirrors scripts/run-x9-postgres-verification.sh
# and scripts/p1-13-postgres-verification.sh.
#
# Why this exists: a green vitest suite over string-matching database.sh is
# not evidence the fix actually works against a real server -- it only
# proves the right characters are present in the file. This script proves
# the five things that actually matter against a real, unmodified PostgreSQL
# 16.14: (1) the grants replay makes the roles' privileges actually usable,
# (2) the pre-fix state (no replay) is actually broken the way the incident
# report says, (3) --single-transaction actually provides the atomicity
# claimed in the comments, (4) DATABASE_PRIVILEGE_CHECK actually detects a
# regression rather than rubber-stamping, and (5) the privilege-check SQL is
# the exact text database.sh runs, with the grants-replay invocation's own
# flags independently trip-wired against drift -- not a hand-copied
# approximation that could quietly drift from database.sh unnoticed.
#
# What is, and is NOT, actually shared with database.sh (this corrects an
# earlier version of this comment, which overclaimed "IDENTICAL SQL, flags,
# and expectations database.sh itself uses" across the board -- an
# independent review found and reproduced two ways that claim was false):
#   - SHARED, byte-for-byte: the DATABASE_PRIVILEGE_CHECK SQL body. This
#     file does NOT keep its own copy of it -- extract_privilege_check_sql()
#     below pulls the DO $$ ... $$; block VERBATIM out of
#     scripts/preproduction/database.sh's verify_database_privileges()
#     function, and privilege_check() below runs that exact extracted text.
#   - TRIP-WIRED, not executed: the grants-replay invocation's FLAGS
#     (--single-transaction, -v ON_ERROR_STOP=1, -U postgres -d cps_novel).
#     psql_grants_replay() below hard-codes these flags itself rather than
#     invoking database.sh; the drift trip-wire near the top of this script
#     independently extracts database.sh's ACTUAL grants-replay invocation
#     line (the `if ! preprod_compose exec ... < .../grants.sql` line
#     specifically -- not merely any non-comment line anywhere in the file,
#     which previously let the flags survive inside the FAILURE branch's
#     echoed recovery-command text even after being removed from the real
#     invocation) and refuses to run at all if that line's flags no longer
#     match what this script is about to run.
#   - NEITHER shared NOR trip-wired: the DATABASE_PRIVILEGE_CHECK
#     invocation's own FLAGS. privilege_check() below hard-codes `--no-psqlrc
#     -v ON_ERROR_STOP=1 -U postgres -d "$db"`, matching database.sh's
#     verify_database_privileges() invocation line as of this writing, but
#     nothing in this script re-derives or checks that match against
#     database.sh's text -- a future flag change to that one database.sh
#     invocation line would NOT be caught here.
#   - This script never executes scripts/preproduction/database.sh itself
#     (no subcommand of it is invoked, nothing sources it) -- it
#     re-implements the two invocations above directly against a disposable
#     Postgres, extracting or trip-wiring what it practically can from
#     database.sh's own text rather than running database.sh's real code
#     paths.

project_root="$(cd "$(dirname "$0")/.." && pwd)"
database_sh="$project_root/scripts/preproduction/database.sh"
grants_sql="$project_root/infra/postgres/grants.sql"
roles_sql="$project_root/infra/postgres/roles.sql"

run_id="$(date +%Y%m%d%H%M%S)-$$-$RANDOM"
container_name="cps-novel-preprod-db-contract-pg16-${run_id}"
volume_name="cps-novel-preprod-db-contract-pgdata-${run_id}"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/cps-novel-preprod-db-contract-secrets.XXXXXX")"
cleanup_ran=no

cleanup() {
  set +e
  [[ "$cleanup_ran" == no ]] || return 0
  cleanup_ran=yes
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  docker volume rm "$volume_name" >/dev/null 2>&1 || true
  rm -rf "$secret_dir"
  if ! docker ps -a --format '{{.Names}}' | grep -Fx "$container_name" >/dev/null 2>&1 \
    && ! docker volume ls --format '{{.Name}}' | grep -Fx "$volume_name" >/dev/null 2>&1; then
    printf 'PREPROD_DB_CONTRACT_CLEANUP=PASS\n'
  else
    printf 'PREPROD_DB_CONTRACT_CLEANUP=FAIL\n' >&2
  fi
}
trap cleanup EXIT INT TERM

case_results=()
fail() {
  # $1 = case name (may be "" for a pre-case setup failure), $2 = reason
  local case_name="$1" reason="$2"
  if [[ -n "$case_name" ]]; then
    echo "PREPROD_DB_CONTRACT_CASE_${case_name}=FAIL reason=${reason}" >&2
  fi
  echo "PREPROD_DB_CONTRACT=FAIL reason=${reason}" >&2
  exit 1
}

# --- Drift trip-wire: the grants-replay flags this script is about to run
# must already be exactly what database.sh's REAL invocation runs.
# Independent of the SQL extraction below (which covers the privilege-check
# SQL specifically) -- this covers the invocation shape instead.
#
# Anchored on the ACTUAL invocation line specifically -- the
# `if ! preprod_compose exec -T postgres psql ... < .../grants.sql` line
# inside the migrate-approved case -- not a bare grep over every non-comment
# line in the file. database.sh:270 also echoes a copy-pasteable recovery
# command (`echo "DATABASE_GRANTS_RECOVERY_COMMAND=preprod_compose exec ...
# --single-transaction ..."`) for an operator to run by hand after a
# failure; that echoed text is itself a non-comment line containing every
# one of these flags. A trip-wire grepping the whole file would therefore
# stay green even after a flag is removed from the REAL invocation, as long
# as the echoed recovery text still names it -- exactly the false-green an
# independent review reproduced: it removed --single-transaction from the
# real invocation only, left the recovery echo untouched, and this script
# still ran to a full PASS. Extracting the real invocation line specifically
# closes that gap.
extract_grants_invocation() {
  awk '
    /^[[:space:]]*if ! preprod_compose exec -T postgres psql/ { capture=1 }
    capture { print }
    capture && /grants\.sql/ { exit }
  ' "$database_sh"
}
grants_invocation="$(extract_grants_invocation)"
[[ -n "$grants_invocation" ]] || fail "" "grants_invocation_extraction_empty"
grep -qF 'infra/postgres/grants.sql' <<<"$grants_invocation" \
  || fail "" "grants_invocation_extraction_malformed"
for needle in \
  '--single-transaction' \
  '-v ON_ERROR_STOP=1' \
  '-U postgres -d cps_novel'; do
  grep -qF -- "$needle" <<<"$grants_invocation" || fail "" "grants_invocation_drifted_missing_${needle// /_}"
done
if grep -qF -- '-U migration_owner' <<<"$grants_invocation"; then
  fail "" "grants_invocation_drifted_found_migration_owner"
fi

# --- Extract the DATABASE_PRIVILEGE_CHECK SQL verbatim out of database.sh.
# Anchored on the real heredoc-open line (contains "-d cps_novel <<" followed
# by the delimiter) rather than a bare delimiter match, because the comment
# block directly above that function in database.sh also mentions the
# delimiter name in prose -- a bare match would latch onto the comment
# instead of the real heredoc.
extract_privilege_check_sql() {
  awk '
    /-d cps_novel <<.DATABASE_PRIVILEGE_CHECK_SQL./ { started=1; next }
    started && /^DATABASE_PRIVILEGE_CHECK_SQL$/ { exit }
    started
  ' "$database_sh"
}
privilege_check_sql="$(extract_privilege_check_sql)"
[[ -n "$privilege_check_sql" ]] || fail "" "privilege_check_sql_extraction_empty"
grep -qF 'PRIVILEGE_CHECK_FAILED' <<<"$privilege_check_sql" || fail "" "privilege_check_sql_extraction_malformed"

umask 077
bootstrap_password="$(openssl rand -hex 24)"
migration_password="$(openssl rand -hex 24)"
web_password="$(openssl rand -hex 24)"
worker_password="$(openssl rand -hex 24)"
scheduler_password="$(openssl rand -hex 24)"
analyst_password="$(openssl rand -hex 24)"
backup_password="$(openssl rand -hex 24)"

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

cd "$project_root"
if ! docker image inspect postgres:16.14 >/dev/null 2>&1; then
  docker pull postgres:16.14 >/dev/null
fi
docker volume create "$volume_name" >/dev/null

# POSTGRES_USER=postgres and POSTGRES_DB=cps_novel deliberately match
# production exactly (docker-compose.yml:31-32) -- database.sh's grants
# replay and privilege check both hard-code `-U postgres -d cps_novel`, so
# this disposable cluster's bootstrap superuser and database name must be
# the real ones, not a throwaway admin/db name like the sibling harnesses
# use, or the invocation shape under test would not actually be identical.
docker run -d \
  --name "$container_name" \
  --mount "type=volume,src=${volume_name},dst=/var/lib/postgresql/data" \
  --mount "type=bind,src=${secret_dir},dst=/run/preprod-db-contract-secrets,readonly" \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD_FILE=/run/preprod-db-contract-secrets/bootstrap-password \
  -e POSTGRES_DB=cps_novel \
  -p 127.0.0.1::5432 \
  postgres:16.14 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U postgres -d cps_novel >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$container_name" pg_isready -U postgres -d cps_novel >/dev/null
host_port="$(docker port "$container_name" 5432/tcp | tail -n 1 | sed 's/.*://')"

docker exec -i "$container_name" psql --no-psqlrc -v ON_ERROR_STOP=1 -U postgres -d cps_novel \
  <"$roles_sql" >/dev/null
docker exec -i "$container_name" psql --no-psqlrc -v ON_ERROR_STOP=1 -U postgres -d cps_novel \
  <"$secret_dir/role-passwords.sql" >/dev/null
# Mirrors infra/postgres/init-roles.sh's own `ALTER DATABASE ... OWNER TO
# migration_owner;` (run there via docker-entrypoint-initdb.d on a brand-new
# PGDATA in production) -- migration_owner needs to own cps_novel for
# `prisma migrate deploy` to have CREATE rights on schema public before
# grants.sql ever runs. This harness performs that one statement directly
# rather than mounting the real initdb.d scripts, because the rest of
# init-roles.sh (the replication pg_hba append) is irrelevant to what is
# being proven here; that is a deliberate, documented simplification.
docker exec -i "$container_name" psql --no-psqlrc -v ON_ERROR_STOP=1 -U postgres -d cps_novel \
  -c 'ALTER DATABASE cps_novel OWNER TO migration_owner;' >/dev/null

owner_url() { printf 'postgresql://migration_owner:%s@127.0.0.1:%s/%s?schema=public' "$migration_password" "$host_port" "$1"; }

DATABASE_URL="$(owner_url cps_novel)" npx prisma migrate deploy >/dev/null
echo "PREPROD_DB_CONTRACT_SETUP=PASS database=cps_novel migrations=applied"

# --- helpers --------------------------------------------------------------

# Runs $2.. as postgres superuser against database $1, stdin from heredoc
# text passed as $3. Prints combined stdout to stdout, returns psql's exit
# status.
psql_as_postgres() {
  local db="$1" sql="$2"
  printf '%s' "$sql" | docker exec -i "$container_name" \
    psql --no-psqlrc -v ON_ERROR_STOP=1 -U postgres -d "$db" 2>&1
}

# Same shape but with --single-transaction, for the actual grants replay --
# identical flags to database.sh's own invocation.
psql_grants_replay() {
  local db="$1" file="$2"
  docker exec -i "$container_name" \
    psql --no-psqlrc -v ON_ERROR_STOP=1 --single-transaction -U postgres -d "$db" \
    <"$file" 2>&1
}

# Deliberately the PRE-FIX shape: identical to psql_grants_replay() minus
# --single-transaction. Used ONLY by the atomicity case's mutation-proof
# sub-case (CASE 3b below), to prove the flag is actually load-bearing
# rather than assuming it -- never used against a database anything else in
# this script depends on afterward.
psql_grants_replay_no_single_transaction() {
  local db="$1" file="$2"
  docker exec -i "$container_name" \
    psql --no-psqlrc -v ON_ERROR_STOP=1 -U postgres -d "$db" \
    <"$file" 2>&1
}

privilege_check() {
  local db="$1"
  printf '%s' "$privilege_check_sql" | docker exec -i "$container_name" \
    psql --no-psqlrc -v ON_ERROR_STOP=1 -U postgres -d "$db" 2>&1
}

scalar_bool() {
  # $1 = db, $2 = SQL expression returning boolean
  docker exec "$container_name" psql --no-psqlrc -U postgres -d "$1" -Atqc "$2" | tr -d '\r'
}

# ===========================================================================
# CASE 1 (positive): grants replay makes privileges actually usable.
# ===========================================================================
grants_output="$(psql_grants_replay cps_novel "$grants_sql")" \
  || fail "POSITIVE" "grants_replay_failed_on_clean_database: $grants_output"
echo "PREPROD_DB_CONTRACT_CASE_POSITIVE_GRANTS_REPLAY=PASS"

privilege_output="$(privilege_check cps_novel)" \
  || fail "POSITIVE" "privilege_check_failed_immediately_after_replay: $privilege_output"
echo "PREPROD_DB_CONTRACT_CASE_POSITIVE_PRIVILEGE_CHECK=PASS"

web_probe_sql="INSERT INTO operation_audit (actor_type, actor_id, action, entity_type, entity_id)
VALUES ('system', 'preprod-db-contract', 'contract_check.probe', 'ContractCheck', 'operation_audit-probe-${run_id}');
INSERT INTO admin_identity (id, username, password_hash, role, status, session_version, created_at, updated_at)
VALUES (gen_random_uuid(), 'preprod-db-contract-probe-${run_id//[^a-z0-9]/}', 'scrypt\$v1\$dummyhash', 'super_admin', 'active', 0, now(), now());"
web_probe_output="$(printf '%s' "$web_probe_sql" | docker exec -i -e PGPASSWORD="$web_password" "$container_name" \
  psql --no-psqlrc -v ON_ERROR_STOP=1 -h 127.0.0.1 -U web_app -d cps_novel 2>&1)" \
  || fail "POSITIVE" "web_app_insert_failed_after_grants_replay: $web_probe_output"
echo "PREPROD_DB_CONTRACT_CASE_POSITIVE_WEB_APP_INSERT=PASS"

printf '127.0.0.1:5432:cps_novel:backup_role:%s\n' "$backup_password" >"$secret_dir/backup_role.pgpass"
chmod 600 "$secret_dir/backup_role.pgpass"
dump_output="$(docker exec \
  -e PGPASSFILE=/run/preprod-db-contract-secrets/backup_role.pgpass \
  -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE=cps_novel -e PGUSER=backup_role \
  "$container_name" pg_dump --format=custom --compress=gzip:6 --no-owner --no-acl --file=/tmp/positive-case.dump 2>&1)" \
  || fail "POSITIVE" "backup_role_pg_dump_failed_after_grants_replay: $dump_output"
docker exec "$container_name" test -s /tmp/positive-case.dump \
  || fail "POSITIVE" "backup_role_pg_dump_produced_empty_file"
echo "PREPROD_DB_CONTRACT_CASE_POSITIVE_BACKUP_ROLE_PG_DUMP=PASS"
echo "PREPROD_DB_CONTRACT_CASE_POSITIVE=PASS"

# ===========================================================================
# CASE 2 (negative, pre-fix state): grants NEVER replayed -- the bug this
# whole change fixes. Proves the harness can actually detect it.
# ===========================================================================
docker exec "$container_name" createdb -U postgres -O migration_owner cps_novel_nogrants >/dev/null
DATABASE_URL="$(owner_url cps_novel_nogrants)" npx prisma migrate deploy >/dev/null
echo "PREPROD_DB_CONTRACT_CASE_NEGATIVE_PRE_FIX_SETUP=PASS database=cps_novel_nogrants migrations=applied grants=NOT_REPLAYED"

sqlstate_probe_sql="DO \$\$
BEGIN
  INSERT INTO operation_audit (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('system', 'preprod-db-contract', 'contract_check.probe', 'ContractCheck', 'should-fail-${run_id}');
  RAISE EXCEPTION 'PREPROD_DB_CONTRACT_UNEXPECTED_SUCCESS';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'CAUGHT_SQLSTATE=%', SQLSTATE;
END
\$\$;"
sqlstate_status=0
sqlstate_output="$(printf '%s' "$sqlstate_probe_sql" | docker exec -i -e PGPASSWORD="$web_password" "$container_name" \
  psql --no-psqlrc -v ON_ERROR_STOP=1 -h 127.0.0.1 -U web_app -d cps_novel_nogrants 2>&1)" || sqlstate_status=$?
if [[ "$sqlstate_status" -ne 0 ]] || ! grep -q 'CAUGHT_SQLSTATE=42501' <<<"$sqlstate_output"; then
  fail "NEGATIVE_PRE_FIX" "web_app_insert_did_not_fail_with_42501_without_grants: $sqlstate_output"
fi
echo "PREPROD_DB_CONTRACT_CASE_NEGATIVE_PRE_FIX_WEB_APP_INSERT=FAIL_AS_EXPECTED sqlstate=42501"

printf '127.0.0.1:5432:cps_novel_nogrants:backup_role:%s\n' "$backup_password" >"$secret_dir/backup_role_nogrants.pgpass"
chmod 600 "$secret_dir/backup_role_nogrants.pgpass"
if docker exec \
  -e PGPASSFILE=/run/preprod-db-contract-secrets/backup_role_nogrants.pgpass \
  -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE=cps_novel_nogrants -e PGUSER=backup_role \
  "$container_name" pg_dump --format=custom --compress=gzip:6 --no-owner --no-acl --file=/tmp/nogrants-case.dump \
  >"$secret_dir"/nogrants-dump-stdout 2>"$secret_dir"/nogrants-dump-stderr; then
  fail "NEGATIVE_PRE_FIX" "backup_role_pg_dump_unexpectedly_succeeded_without_grants"
fi
nogrants_dump_stderr="$(cat "$secret_dir"/nogrants-dump-stderr 2>/dev/null || true)"
rm -f "$secret_dir"/nogrants-dump-stdout "$secret_dir"/nogrants-dump-stderr
grep -qi 'permission denied' <<<"$nogrants_dump_stderr" \
  || fail "NEGATIVE_PRE_FIX" "backup_role_pg_dump_failed_for_an_unexpected_reason: $nogrants_dump_stderr"
echo "PREPROD_DB_CONTRACT_CASE_NEGATIVE_PRE_FIX_BACKUP_ROLE_PG_DUMP=FAIL_AS_EXPECTED reason=permission_denied"
echo "PREPROD_DB_CONTRACT_CASE_NEGATIVE_PRE_FIX=PASS"

# ===========================================================================
# CASE 3 (negative, atomicity): a grants.sql replay that fails PARTWAY
# THROUGH must leave privileges EXACTLY as it found them -- never
# "REVOKE committed, GRANT missing".
#
# Review fix (round 1): the original version of this case started from an
# UNGRANTED database (grants never replayed, before-state f,f) and asserted
# the after-state was still f,f. That does not discriminate: starting from
# f, the after-state is f whether or not --single-transaction is present --
# with the flag, the whole failed transaction rolls back to f; without it,
# the REVOKEs on an already-privilege-less role are simply no-ops, the
# injected failure aborts before any GRANT lands, and the result is still f
# either way. A test that passes regardless of the fix under test has no
# teeth. The hazard --single-transaction actually protects against is a
# database whose grants are ALREADY GOOD (t) -- so this case now seeds a
# genuinely granted database first, and a SEPARATE mutation sub-case (3b,
# below) proves the flag's ABSENCE actually causes damage on an identically
# seeded database, so both directions are visible side by side.
# ===========================================================================
docker exec "$container_name" createdb -U postgres -O migration_owner cps_novel_atomicity >/dev/null
DATABASE_URL="$(owner_url cps_novel_atomicity)" npx prisma migrate deploy >/dev/null
echo "PREPROD_DB_CONTRACT_CASE_ATOMICITY_SETUP=PASS database=cps_novel_atomicity migrations=applied grants=NOT_REPLAYED"

# Seed: a NORMAL, successful, unmodified grants.sql replay -- the state that
# actually matters for this hazard is "already granted", not "never granted".
seed_output="$(psql_grants_replay cps_novel_atomicity "$grants_sql")" \
  || fail "ATOMICITY" "seed_grants_replay_failed_on_atomicity_database: $seed_output"

before_backup_select="$(scalar_bool cps_novel_atomicity "SELECT has_table_privilege('backup_role','public.operation_audit','SELECT')")"
before_web_select="$(scalar_bool cps_novel_atomicity "SELECT has_table_privilege('web_app','public.admin_identity','SELECT')")"
[[ "$before_backup_select" == "t" && "$before_web_select" == "t" ]] \
  || fail "ATOMICITY" "seed_replay_did_not_actually_grant_privileges backup=$before_backup_select web=$before_web_select"
echo "PREPROD_DB_CONTRACT_CASE_ATOMICITY_SEED=PASS before=backup:${before_backup_select},web:${before_web_select}"

# Same injection as before -- right after backup_role's ALL-TABLES/
# ALL-SEQUENCES grants (grants.sql line 52-53) and well before web_app's
# admin-table grants (line ~102). Position does not matter for THIS
# sub-case's correctness (--single-transaction rolls back the WHOLE file
# regardless of where the failure lands, including statements that already
# ran to completion earlier in the same file) -- it matters for sub-case 3b
# below, and this file is reused there unmodified, per the review's explicit
# instruction to run "the same broken grants file" in both directions.
anchor='GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO backup_role;'
broken_grants="$secret_dir/grants-broken.sql"
awk -v anchor="$anchor" -v injected=0 '
  { print }
  $0 == anchor && injected == 0 {
    print "GRANT SELECT ON TABLE preprod_db_contract_nonexistent_table_xyz TO web_app;"
    injected = 1
  }
' "$grants_sql" >"$broken_grants"
grep -qF 'preprod_db_contract_nonexistent_table_xyz' "$broken_grants" \
  || fail "ATOMICITY" "broken_grants_injection_anchor_not_found_in_grants_sql"

if psql_grants_replay cps_novel_atomicity "$broken_grants" >"$secret_dir"/atomicity-replay.log 2>&1; then
  atomicity_replay_output="$(cat "$secret_dir"/atomicity-replay.log)"
  rm -f "$secret_dir"/atomicity-replay.log
  fail "ATOMICITY" "broken_grants_replay_unexpectedly_succeeded: $atomicity_replay_output"
fi
rm -f "$secret_dir"/atomicity-replay.log

after_backup_select="$(scalar_bool cps_novel_atomicity "SELECT has_table_privilege('backup_role','public.operation_audit','SELECT')")"
after_web_select="$(scalar_bool cps_novel_atomicity "SELECT has_table_privilege('web_app','public.admin_identity','SELECT')")"
if [[ "$after_backup_select" != "t" || "$after_web_select" != "t" ]]; then
  fail "ATOMICITY" "privileges_changed_after_failed_replay_BEFORE=backup:$before_backup_select,web:${before_web_select}_AFTER=backup:$after_backup_select,web:$after_web_select"
fi
echo "PREPROD_DB_CONTRACT_CASE_ATOMICITY_STATE_UNCHANGED=PASS before=backup:${before_backup_select},web:${before_web_select} after=backup:${after_backup_select},web:${after_web_select}"
echo "PREPROD_DB_CONTRACT_CASE_ATOMICITY=PASS"

# ===========================================================================
# CASE 3b (negative, mutation proof): the two-directional proof the flag is
# load-bearing. A SEPARATE throwaway database, seeded IDENTICALLY (a normal
# successful grants.sql replay first, so the before-state is genuinely
# granted, t/t) -- then the SAME broken_grants file from case 3 above is
# replayed again, this time WITHOUT --single-transaction. Without the flag,
# psql autocommits each statement as it runs: grants.sql's REVOKE block (the
# file's first ~15 statements) commits immediately, stripping every role,
# and the injected failure then aborts the file before any of the
# re-GRANTs can land -- so the roles end up STRIPPED, not restored.
#
# web_app is the discriminating signal: its admin_identity/operation_audit
# grants (grants.sql lines ~72, ~102) sit AFTER the injection anchor
# (line 53), so neither has re-run by the time the script dies -- they must
# come back f. backup_role's OWN ALL-TABLES/ALL-SEQUENCES re-grant
# (lines 52-53) sits BEFORE the injection anchor, so it re-commits and
# succeeds before the script ever reaches the injected failure -- backup_role
# is therefore expected to come back t, not f. This is reported for
# transparency (it is itself a real, illustrative instance of "some roles'
# grants land, others don't" -- the exact partial-application shape
# --single-transaction exists to prevent) but only the web_app signals gate
# pass/fail, since they are the ones this specific injection position can
# actually discriminate.
# ===========================================================================
docker exec "$container_name" createdb -U postgres -O migration_owner cps_novel_atomicity_mutation >/dev/null
DATABASE_URL="$(owner_url cps_novel_atomicity_mutation)" npx prisma migrate deploy >/dev/null
echo "PREPROD_DB_CONTRACT_CASE_ATOMICITY_MUTATION_SETUP=PASS database=cps_novel_atomicity_mutation migrations=applied grants=NOT_REPLAYED"

mutation_seed_output="$(psql_grants_replay cps_novel_atomicity_mutation "$grants_sql")" \
  || fail "ATOMICITY_MUTATION" "seed_grants_replay_failed_on_mutation_database: $mutation_seed_output"

before_mut_backup="$(scalar_bool cps_novel_atomicity_mutation "SELECT has_table_privilege('backup_role','public.operation_audit','SELECT')")"
before_mut_web_admin="$(scalar_bool cps_novel_atomicity_mutation "SELECT has_table_privilege('web_app','public.admin_identity','SELECT')")"
before_mut_web_audit="$(scalar_bool cps_novel_atomicity_mutation "SELECT has_table_privilege('web_app','public.operation_audit','SELECT')")"
[[ "$before_mut_backup" == "t" && "$before_mut_web_admin" == "t" && "$before_mut_web_audit" == "t" ]] \
  || fail "ATOMICITY_MUTATION" "seed_replay_did_not_actually_grant_privileges backup=$before_mut_backup web_admin=$before_mut_web_admin web_audit=$before_mut_web_audit"

if psql_grants_replay_no_single_transaction cps_novel_atomicity_mutation "$broken_grants" \
  >"$secret_dir"/atomicity-mutation-replay.log 2>&1; then
  mutation_replay_output="$(cat "$secret_dir"/atomicity-mutation-replay.log)"
  rm -f "$secret_dir"/atomicity-mutation-replay.log
  fail "ATOMICITY_MUTATION" "broken_grants_without_single_transaction_unexpectedly_succeeded: $mutation_replay_output"
fi
rm -f "$secret_dir"/atomicity-mutation-replay.log

after_mut_backup="$(scalar_bool cps_novel_atomicity_mutation "SELECT has_table_privilege('backup_role','public.operation_audit','SELECT')")"
after_mut_web_admin="$(scalar_bool cps_novel_atomicity_mutation "SELECT has_table_privilege('web_app','public.admin_identity','SELECT')")"
after_mut_web_audit="$(scalar_bool cps_novel_atomicity_mutation "SELECT has_table_privilege('web_app','public.operation_audit','SELECT')")"
if [[ "$after_mut_web_admin" != "f" || "$after_mut_web_audit" != "f" ]]; then
  fail "ATOMICITY_MUTATION" "without_single_transaction_did_not_strip_web_app_privileges_the_way_the_pre_fix_bug_did before=backup:${before_mut_backup},web_admin:${before_mut_web_admin},web_audit:${before_mut_web_audit} after=backup:${after_mut_backup},web_admin:${after_mut_web_admin},web_audit:${after_mut_web_audit}"
fi
echo "PREPROD_DB_CONTRACT_CASE_ATOMICITY_MUTATION=PASS without_single_transaction_strips=web_admin_identity:${after_mut_web_admin},web_operation_audit:${after_mut_web_audit} backup_role_operation_audit:${after_mut_backup}_(re-granted_before_injection_point_in_file_order,_expected)"

# ===========================================================================
# CASE 4 (negative, check has teeth): revoke/grant one specific privilege
# DATABASE_PRIVILEGE_CHECK asserts on the ALREADY-GRANTED cps_novel database
# from case 1, then prove the extracted privilege-check SQL fails and names
# the right reason. Three independent sub-probes, each REVOKE/GRANT-then-
# restore in sequence (rather than all three mutations left standing at
# once), because verify_database_privileges()'s DO block RAISE EXCEPTIONs on
# the FIRST violation it finds -- leaving an earlier sub-probe's mutation in
# place would mask a later one instead of proving it independently. Before
# this fix, only sub-case 4a was ever exercised: the backup_role
# must-SELECT-every-table/sequence loop (the exact assertion covering the
# backup-chain incident that motivated this whole PR) and the one NEGATIVE
# assertion in the whole check (4c) were never proven to fire at all.
# ===========================================================================

# 4a: web_app operation_audit INSERT missing (pre-existing sub-case).
psql_as_postgres cps_novel 'REVOKE INSERT ON TABLE operation_audit FROM web_app;' >/dev/null \
  || fail "CHECK_HAS_TEETH" "setup_revoke_web_app_operation_audit_insert_failed"
teeth_status=0
teeth_output="$(privilege_check cps_novel)" || teeth_status=$?
if [[ "$teeth_status" -eq 0 ]]; then
  fail "CHECK_HAS_TEETH" "privilege_check_passed_despite_revoked_web_app_operation_audit_insert"
fi
grep -q 'PRIVILEGE_CHECK_FAILED reason=web_app_missing_operation_audit_privilege' <<<"$teeth_output" \
  || fail "CHECK_HAS_TEETH" "privilege_check_failed_but_not_with_the_expected_reason: $teeth_output"
echo "PREPROD_DB_CONTRACT_CASE_CHECK_HAS_TEETH_WEB_APP_OPERATION_AUDIT=PASS reason=web_app_missing_operation_audit_privilege"
psql_as_postgres cps_novel 'GRANT INSERT ON TABLE operation_audit TO web_app;' >/dev/null \
  || fail "CHECK_HAS_TEETH" "restore_web_app_operation_audit_insert_failed"

# 4b (review MAJOR-4b, sub-case 1 of 2): revoke SELECT on exactly ONE table
# from backup_role and prove the must-SELECT-every-table enumeration loop
# fails, naming both backup_role_missing_table_select AND the table -- this
# is the assertion covering the actual backup-chain incident; it had never
# been exercised by this harness before this fix.
backup_probe_table="operation_audit"
psql_as_postgres cps_novel "REVOKE SELECT ON TABLE ${backup_probe_table} FROM backup_role;" >/dev/null \
  || fail "CHECK_HAS_TEETH" "setup_revoke_backup_role_table_select_failed"
teeth_status=0
teeth_output="$(privilege_check cps_novel)" || teeth_status=$?
if [[ "$teeth_status" -eq 0 ]]; then
  fail "CHECK_HAS_TEETH" "privilege_check_passed_despite_revoked_backup_role_table_select"
fi
grep -q "PRIVILEGE_CHECK_FAILED reason=backup_role_missing_table_select table=public.${backup_probe_table}" <<<"$teeth_output" \
  || fail "CHECK_HAS_TEETH" "privilege_check_failed_but_not_with_the_expected_reason_or_table: $teeth_output"
echo "PREPROD_DB_CONTRACT_CASE_CHECK_HAS_TEETH_BACKUP_ROLE_TABLE_SELECT=PASS reason=backup_role_missing_table_select table=public.${backup_probe_table}"
psql_as_postgres cps_novel "GRANT SELECT ON TABLE ${backup_probe_table} TO backup_role;" >/dev/null \
  || fail "CHECK_HAS_TEETH" "restore_backup_role_table_select_failed"

# 4c (review MAJOR-4b, sub-case 2 of 2): every other assertion in
# verify_database_privileges() is POSITIVE (something required is missing).
# unexpected_admin_auth_select is the ONLY negative assertion (something
# forbidden is present) and was likewise never proven to fire -- grant
# worker_app SELECT on the most sensitive Admin-auth table (a privilege
# grants.sql never grants it) and prove the check catches the over-grant.
psql_as_postgres cps_novel 'GRANT SELECT ON TABLE admin_two_factor TO worker_app;' >/dev/null \
  || fail "CHECK_HAS_TEETH" "setup_grant_worker_app_admin_two_factor_select_failed"
teeth_status=0
teeth_output="$(privilege_check cps_novel)" || teeth_status=$?
if [[ "$teeth_status" -eq 0 ]]; then
  fail "CHECK_HAS_TEETH" "privilege_check_passed_despite_unexpected_worker_app_admin_two_factor_select"
fi
grep -q 'PRIVILEGE_CHECK_FAILED reason=unexpected_admin_auth_select role=worker_app' <<<"$teeth_output" \
  || fail "CHECK_HAS_TEETH" "privilege_check_failed_but_not_with_the_expected_reason: $teeth_output"
echo "PREPROD_DB_CONTRACT_CASE_CHECK_HAS_TEETH_UNEXPECTED_ADMIN_AUTH_SELECT=PASS reason=unexpected_admin_auth_select role=worker_app"
psql_as_postgres cps_novel 'REVOKE SELECT ON TABLE admin_two_factor FROM worker_app;' >/dev/null \
  || fail "CHECK_HAS_TEETH" "restore_worker_app_admin_two_factor_select_failed"

echo "PREPROD_DB_CONTRACT_CASE_CHECK_HAS_TEETH=PASS"

# ===========================================================================
# CASE 5 (negative, reason fallback -- review MINOR-5): database.sh's
# privilege_check_failure_reason() must emit SOME reason even when
# verify_database_privileges() fails WITHOUT a structured
# "PRIVILEGE_CHECK_FAILED reason=..." line (connection refused, "role does
# not exist", psql not found, ...) -- rather than silently aborting the
# `set -euo pipefail` shell it runs under before either persistent-check
# `>&2` line ever executes, which is exactly what the pre-fix inline
# `grep -o ... | tail -1 | sed ...` pipeline did (pipefail makes the whole
# pipeline exit non-zero when grep finds no match, even though tail and sed
# both exit 0, and that unguarded non-zero assignment aborts the case under
# `set -e`).
#
# Same no-drift mechanism as the privilege-check SQL above: this extracts
# privilege_check_failure_reason() VERBATIM out of database.sh and runs it,
# under the identical `set -euo pipefail` database.sh itself runs under, in
# a throwaway `bash -c` subshell -- it does not keep a second hand-copied
# implementation of the function that could quietly drift from the real one.
# ===========================================================================
extract_privilege_check_failure_reason_fn() {
  awk '
    /^privilege_check_failure_reason\(\) \{/ { capture=1 }
    capture { print }
    capture && /^\}/ { exit }
  ' "$database_sh"
}
privilege_check_failure_reason_fn_src="$(extract_privilege_check_failure_reason_fn)"
[[ -n "$privilege_check_failure_reason_fn_src" ]] || fail "" "privilege_check_failure_reason_fn_extraction_empty"
grep -qF 'grep -o' <<<"$privilege_check_failure_reason_fn_src" \
  || fail "" "privilege_check_failure_reason_fn_extraction_malformed"

# 5a: no structured reason available (the bug's actual trigger condition) --
# must still exit 0 and fall back to "unknown detail=<raw psql stderr>",
# never abort silently.
reason_fallback_script="set -euo pipefail
${privilege_check_failure_reason_fn_src}
privilege_check_failure_reason 'psql: error: connection to server at \"127.0.0.1\", port 5999 failed: Connection refused'"
reason_fallback_status=0
reason_fallback_output="$(bash -c "$reason_fallback_script" 2>&1)" || reason_fallback_status=$?
if [[ "$reason_fallback_status" -ne 0 ]]; then
  fail "REASON_FALLBACK" "privilege_check_failure_reason_aborted_under_set_euo_pipefail status=$reason_fallback_status output=$reason_fallback_output"
fi
[[ -n "$reason_fallback_output" ]] \
  || fail "REASON_FALLBACK" "privilege_check_failure_reason_produced_empty_output"
grep -qF 'unknown' <<<"$reason_fallback_output" \
  || fail "REASON_FALLBACK" "privilege_check_failure_reason_did_not_fall_back_to_unknown: $reason_fallback_output"
grep -qF 'Connection refused' <<<"$reason_fallback_output" \
  || fail "REASON_FALLBACK" "privilege_check_failure_reason_dropped_the_raw_psql_detail: $reason_fallback_output"
echo "PREPROD_DB_CONTRACT_CASE_REASON_FALLBACK=PASS reason=unknown detail_present=yes"

# 5b: corroborate the structured path is unharmed by the refactor -- a
# captured output that DOES contain a PRIVILEGE_CHECK_FAILED line must still
# yield exactly that reason, not the "unknown" fallback.
reason_structured_script="set -euo pipefail
${privilege_check_failure_reason_fn_src}
privilege_check_failure_reason 'psql:<stdin>:12: ERROR:  PRIVILEGE_CHECK_FAILED reason=web_app_missing_operation_audit_privilege
CONTEXT:  PL/pgSQL function inline_code_block line 62 at RAISE'"
reason_structured_status=0
reason_structured_output="$(bash -c "$reason_structured_script" 2>&1)" || reason_structured_status=$?
if [[ "$reason_structured_status" -ne 0 ]]; then
  fail "REASON_FALLBACK" "privilege_check_failure_reason_structured_path_aborted status=$reason_structured_status output=$reason_structured_output"
fi
if [[ "$reason_structured_output" != "web_app_missing_operation_audit_privilege" ]]; then
  fail "REASON_FALLBACK" "privilege_check_failure_reason_broke_the_structured_path: got '$reason_structured_output'"
fi
echo "PREPROD_DB_CONTRACT_CASE_REASON_FALLBACK_STRUCTURED=PASS reason=web_app_missing_operation_audit_privilege"

echo "PREPROD_DB_CONTRACT=PASS"
