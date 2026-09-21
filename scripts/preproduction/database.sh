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

# docs/governance/database-governance.md:433 requires infra/postgres/grants.sql
# to be replayed after every migration. The mature X8 path
# (scripts/x8-production-like.sh prepare_database(), X8_DB_PREP_STEP=grants)
# already does this; persistent-check asserts the ACTUAL, observable result of
# that replay (rather than re-deriving expectations by hand) so drift between
# grants.sql and this check shows up immediately.
#
# scripts/run-preprod-db-contract-verification.sh extracts the SQL below
# VERBATIM out of this file -- between the `<<'DATABASE_PRIVILEGE_CHECK_SQL'`
# heredoc open and its closing `DATABASE_PRIVILEGE_CHECK_SQL` delimiter line
# below -- rather than keeping a second copy of its own. That is the single
# source of truth this check and the disposable-Postgres proof harness share;
# do not fork a second copy of this SQL anywhere else.
#
# Every assertion below is derived from reading infra/postgres/grants.sql
# itself, not guessed (line numbers as of this change):
#   - "at least one table privilege in public" for web_app/worker_app/
#     scheduler_app/analyst_ro/backup_role: grants.sql:52-53 (backup_role),
#     :99 (web_app/analyst_ro), :316-329 (worker_app), :454 (scheduler_app).
#   - backup_role SELECT on every table/sequence in public: grants.sql:52-53.
#   - web_app SELECT+INSERT+UPDATE on the six Admin-auth tables:
#     grants.sql:102-105.
#   - web_app DELETE on admin_recovery_code/admin_login_attempt only:
#     grants.sql:106.
#   - web_app SELECT+INSERT (never UPDATE/DELETE) on operation_audit:
#     grants.sql:72 (SELECT, part of the shared web_app/analyst_ro list),
#     :215 (INSERT). No GRANT UPDATE/DELETE ... operation_audit ... TO
#     web_app exists anywhere in the file.
#   - web_app USAGE on every sequence in public: grants.sql:472.
#   - migration_owner CREATE on schema public: grants.sql:38.
#   - worker_app/scheduler_app/analyst_ro have NO SELECT on admin_two_factor/
#     admin_recovery_code/admin_two_factor_challenge: the only GRANTs
#     touching those three tables anywhere in the file are grants.sql:102-106,
#     all TO web_app.
verify_database_privileges() {
  preprod_compose exec -T postgres psql --no-psqlrc -v ON_ERROR_STOP=1 \
    -U postgres -d cps_novel <<'DATABASE_PRIVILEGE_CHECK_SQL' 2>&1 >/dev/null
DO $$
DECLARE
  role_name text;
  table_name text;
BEGIN
  -- Positive: each runtime role holds at least one TABLE privilege in
  -- schema public. Catches "grants.sql was never applied" / "grants were
  -- wiped" wholesale, before any of the narrower checks below even matter.
  FOREACH role_name IN ARRAY ARRAY['web_app','worker_app','scheduler_app','analyst_ro','backup_role'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_tables t
      WHERE t.schemaname = 'public'
        AND has_table_privilege(
          role_name, format('%I.%I', t.schemaname, t.tablename),
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        )
    ) THEN
      RAISE EXCEPTION 'PRIVILEGE_CHECK_FAILED reason=role_has_zero_table_privileges role=% schema=public', role_name;
    END IF;
  END LOOP;

  -- backup_role must SELECT every table and every sequence in public --
  -- pg_dump COPYs each one; a single missing grant fails the whole backup.
  FOR table_name IN SELECT format('%I.%I', schemaname, tablename) FROM pg_tables WHERE schemaname = 'public' LOOP
    IF NOT has_table_privilege('backup_role', table_name, 'SELECT') THEN
      RAISE EXCEPTION 'PRIVILEGE_CHECK_FAILED reason=backup_role_missing_table_select table=%', table_name;
    END IF;
  END LOOP;
  FOR table_name IN SELECT format('%I.%I', schemaname, sequencename) FROM pg_sequences WHERE schemaname = 'public' LOOP
    IF NOT has_sequence_privilege('backup_role', table_name, 'SELECT') THEN
      RAISE EXCEPTION 'PRIVILEGE_CHECK_FAILED reason=backup_role_missing_sequence_select sequence=%', table_name;
    END IF;
  END LOOP;

  -- web_app Admin-auth table set: SELECT+INSERT+UPDATE on all six.
  FOREACH table_name IN ARRAY ARRAY[
    'admin_identity','admin_session','admin_two_factor',
    'admin_two_factor_challenge','admin_recovery_code','admin_login_attempt'
  ] LOOP
    IF NOT (
      has_table_privilege('web_app', format('public.%I', table_name), 'SELECT') AND
      has_table_privilege('web_app', format('public.%I', table_name), 'INSERT') AND
      has_table_privilege('web_app', format('public.%I', table_name), 'UPDATE')
    ) THEN
      RAISE EXCEPTION 'PRIVILEGE_CHECK_FAILED reason=web_app_missing_admin_auth_privilege table=%', table_name;
    END IF;
  END LOOP;

  -- web_app DELETE on exactly admin_recovery_code and admin_login_attempt.
  FOREACH table_name IN ARRAY ARRAY['admin_recovery_code','admin_login_attempt'] LOOP
    IF NOT has_table_privilege('web_app', format('public.%I', table_name), 'DELETE') THEN
      RAISE EXCEPTION 'PRIVILEGE_CHECK_FAILED reason=web_app_missing_delete table=%', table_name;
    END IF;
  END LOOP;

  -- web_app SELECT+INSERT on operation_audit; explicitly NOT UPDATE/DELETE
  -- (append-only -- no such grant exists anywhere in grants.sql).
  IF NOT (
    has_table_privilege('web_app', 'public.operation_audit', 'SELECT') AND
    has_table_privilege('web_app', 'public.operation_audit', 'INSERT')
  ) THEN
    RAISE EXCEPTION 'PRIVILEGE_CHECK_FAILED reason=web_app_missing_operation_audit_privilege';
  END IF;
  IF has_table_privilege('web_app', 'public.operation_audit', 'UPDATE') THEN
    RAISE EXCEPTION 'PRIVILEGE_CHECK_FAILED reason=web_app_unexpected_operation_audit_update';
  END IF;
  IF has_table_privilege('web_app', 'public.operation_audit', 'DELETE') THEN
    RAISE EXCEPTION 'PRIVILEGE_CHECK_FAILED reason=web_app_unexpected_operation_audit_delete';
  END IF;

  -- web_app USAGE on every sequence in public.
  FOR table_name IN SELECT format('%I.%I', schemaname, sequencename) FROM pg_sequences WHERE schemaname = 'public' LOOP
    IF NOT has_sequence_privilege('web_app', table_name, 'USAGE') THEN
      RAISE EXCEPTION 'PRIVILEGE_CHECK_FAILED reason=web_app_missing_sequence_usage sequence=%', table_name;
    END IF;
  END LOOP;

  -- migration_owner CREATE on schema public.
  IF NOT has_schema_privilege('migration_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'PRIVILEGE_CHECK_FAILED reason=migration_owner_missing_schema_create';
  END IF;

  -- Negative: worker_app/scheduler_app/analyst_ro must have NO SELECT on the
  -- three most sensitive Admin-auth tables. grants.sql only ever grants
  -- these to web_app; this proves the check has teeth against a too-broad
  -- future grant, not just against a missing one.
  FOREACH role_name IN ARRAY ARRAY['worker_app','scheduler_app','analyst_ro'] LOOP
    IF has_table_privilege(role_name, 'public.admin_two_factor', 'SELECT')
      OR has_table_privilege(role_name, 'public.admin_recovery_code', 'SELECT')
      OR has_table_privilege(role_name, 'public.admin_two_factor_challenge', 'SELECT')
    THEN
      RAISE EXCEPTION 'PRIVILEGE_CHECK_FAILED reason=unexpected_admin_auth_select role=%', role_name;
    END IF;
  END LOOP;
END
$$;
DATABASE_PRIVILEGE_CHECK_SQL
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
    # 🔴 verify-release.sh calls this subcommand as
    # `database.sh persistent-check >/dev/null` (see lib.sh's own comment on
    # preprod_assert_app_runtime_immutable for the same rule stated for the
    # app-runtime gate: "拒绝走 stderr、PASS 走 stdout"). Every FAIL/REFUSED
    # line in this case -- pre-existing ones included -- must go to stderr,
    # or a real failure during `release.sh deploy` surfaces to the operator
    # as a bare non-zero exit code with no reason at all. Only PASS lines
    # (which callers grep stdout for) stay on stdout.
    docker volume inspect cps_novel_postgres_data >/dev/null 2>&1 || {
      echo "DATABASE_PERSISTENT_CHECK=FAIL reason=volume_missing" >&2; exit 65;
    }
    preprod_compose ps --status running postgres | grep -q postgres || {
      echo "DATABASE_PERSISTENT_CHECK=FAIL reason=postgres_not_running" >&2; exit 69;
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
        | grep -qx "$role" || { echo "DATABASE_PERSISTENT_CHECK=FAIL reason=role_auth" >&2; exit 65; }
    done
    privilege_check_output="$(verify_database_privileges)" || {
      privilege_reason="$(printf '%s\n' "$privilege_check_output" | grep -o 'PRIVILEGE_CHECK_FAILED reason=.*' | tail -1 | sed 's/^PRIVILEGE_CHECK_FAILED //')"
      echo "DATABASE_PRIVILEGE_CHECK=FAIL reason=${privilege_reason:-unknown}" >&2
      echo "DATABASE_PERSISTENT_CHECK=FAIL reason=privilege_check" >&2
      exit 65
    }
    echo "DATABASE_PRIVILEGE_CHECK=PASS"
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

    # docs/governance/database-governance.md:433 requires infra/postgres/
    # grants.sql to be replayed after every migration. The mature X8 path
    # (scripts/x8-production-like.sh prepare_database(), X8_DB_PREP_STEP=grants)
    # already does this; this preproduction path never did, which left every
    # runtime role at zero table privileges the moment a migration created or
    # altered any object -- measured on the real host: web_app and
    # backup_role each had SELECT on 0 of 54 tables, which also breaks
    # pg_dump for backup_role. Replay uses the EXACT X8-proven shape:
    #
    # -U postgres, NOT -U migration_owner: grants.sql's blanket
    # `REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC`
    # also touches postgres-owned extension functions (e.g.
    # pg_stat_statements). migration_owner does not own those functions, so a
    # REVOKE issued as migration_owner is not guaranteed to be idempotent on
    # a repeat run -- only the bootstrap superuser (postgres) stays
    # idempotent every time. See scripts/x8-production-like.sh's own comment
    # on this exact point (its prepare_database(), X8_DB_PREP_STEP=grants).
    #
    # --single-transaction: grants.sql REVOKEs every privilege up front and
    # then re-GRANTs them line by line (see that file's own header comment).
    # Without --single-transaction, psql commits each statement as it runs --
    # a mid-file failure (disk full, connection drop, a lock timeout against
    # `SET lock_timeout` below) could leave the REVOKE half committed and the
    # GRANT half never applied, stripping every runtime role down to zero
    # privileges. With --single-transaction the REVOKE block and the GRANT
    # block either both land or both roll back -- there is no window where
    # only the REVOKE half is durable.
    if ! preprod_compose exec -T postgres psql --no-psqlrc -v ON_ERROR_STOP=1 --single-transaction \
      -U postgres -d cps_novel <"$root/infra/postgres/grants.sql" >/dev/null; then
      # --single-transaction means PostgreSQL has ALREADY rolled this failed
      # attempt back, atomically, to whatever state grants.sql found in place
      # when it started. Do NOT replay grants.sql a second time here -- there
      # is nothing to repair, and a second replay would just be a redundant
      # transaction on top of a state that was never actually altered
      # (mirrors scripts/x8-production-like.sh's own comment on this exact
      # point: "不要再重放一次"). Print a copy-pasteable recovery command for
      # an operator to run by hand after investigating -- never auto-execute
      # it here.
      echo "DATABASE_GRANTS=REFUSED reason=grants_replay_failed" >&2
      echo "DATABASE_GRANTS_RECOVERY_COMMAND=preprod_compose exec -T postgres psql --no-psqlrc -v ON_ERROR_STOP=1 --single-transaction -U postgres -d cps_novel < infra/postgres/grants.sql  # run from the release checkout root after: source scripts/preproduction/lib.sh && preprod_load_env" >&2
      exit 65
    fi
    echo "DATABASE_GRANTS=PASS"

    # Deliberately NOT porting x8_restore_grants_for_running_release(): that
    # function exists because a FAILED X8 `up` can leave the PREVIOUS
    # release's containers still running against a database whose grants
    # this same attempt may have just disturbed -- restoring the running
    # release's own committed grants.sql (via `git show <running commit>`)
    # is what protects it from losing access mid-flight. That hazard does
    # not exist on this path: scripts/preproduction/release.sh's deploy()
    # stops scheduler, worker, and web (release.sh lines ~78-83) BEFORE
    # calling `database.sh migrate-approved` (release.sh line ~88) -- there
    # is no running release's containers left connected to this database
    # while migrate-approved runs, so nothing here can strip access out from
    # under a live container. A failed migrate-approved simply leaves
    # release.sh's own maintenance-page/failed-state handling to take over.
    ;;
  *) usage ;;
esac
