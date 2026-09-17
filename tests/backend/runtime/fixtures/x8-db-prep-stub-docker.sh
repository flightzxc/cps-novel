#!/usr/bin/env bash
# D-9a (施工工单_D9_up数据库准备原子化与镜像保留_2026-09-09.md 三.3.3) test
# fixture -- a stub `docker` CLI for
# tests/backend/runtime/x8-database-prep-atomicity.test.ts. Models exactly
# the handful of `docker compose ... exec` / `docker run` shapes
# prepare_database() (scripts/x8-production-like.sh) and its helpers
# (scripts/lib/x8-production-like-env.sh) issue -- never a real daemon,
# never a real Postgres server. Deliberately a separate, minimal fixture
# from fixtures/x8-gate-stub-docker.sh (which models the release-identity
# gate's entirely different docker/compose shapes) -- reusing that big
# dispatch table here would mean teaching it about shapes it has no other
# reason to know.
#
# Any `psql` invocation that receives its SQL over STDIN (no --file, no
# --command) -- grants.sql's own single-transaction reload,
# x8_align_db_role_passwords()'s ALTER ROLE heredoc, and
# x8_restore_grants_for_running_release()'s `git show | psql` replay -- is
# logged verbatim (stdin content AND argv) under $STUB_LOG_DIR, numbered by
# a simple counter file, so a test can assert exactly what was (or was not)
# sent to the database without this fixture needing to know which of those
# three call sites produced it. $STUB_GRANTS_REPLAY_EXIT (if set) only fails
# a stdin-fed call whose CONTENT is grants.sql (matched by its signature
# REVOKE line) -- argv alone cannot tell a grants.sql replay apart from the
# ALTER ROLE heredoc, and a test that wants "grants.sql fails" must not also
# accidentally fail the unrelated password-alignment step that always runs
# first.
set -euo pipefail

next_seq() {
  local counter="$STUB_LOG_DIR/.psql-stdin-seq"
  local n=0
  [[ -f "$counter" ]] && n="$(cat "$counter")"
  n=$((n + 1))
  printf '%s' "$n" >"$counter"
  printf '%s' "$n"
}

handle_stdin_psql() {
  local stdin_content
  stdin_content="$(cat)"
  local exit_code=0
  if [[ "$stdin_content" == *"REVOKE CREATE ON SCHEMA public FROM PUBLIC"* ]]; then
    exit_code="${STUB_GRANTS_REPLAY_EXIT:-0}"
  fi
  if [[ -n "${STUB_LOG_DIR:-}" ]]; then
    mkdir -p "$STUB_LOG_DIR"
    local seq
    seq="$(next_seq)"
    printf '%s' "$stdin_content" >"$STUB_LOG_DIR/psql-stdin-${seq}.sql"
    { printf 'ARGS:'; printf ' %s' "$@"; printf '\n'; } >"$STUB_LOG_DIR/psql-argv-${seq}.txt"
  fi
  exit "$exit_code"
}

df_output() {
  local kib="${STUB_DF_AVAILABLE_KIB:-999999999}"
  printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
  printf 'overlay 131787296 94993656 %s 76%% /\n' "$kib"
}

# Records that SOME psql invocation was reached, regardless of shape
# (--file / --command / stdin) -- a test asserting "gate B refused before a
# single DDL/role statement went out" needs this broader signal, since only
# the stdin-fed shapes get their own numbered psql-stdin-*/psql-argv-* pair.
log_any_psql_call() {
  [[ -n "${STUB_LOG_DIR:-}" ]] || return 0
  mkdir -p "$STUB_LOG_DIR"
  { printf 'CALL:'; printf ' %s' "$@"; printf '\n'; } >>"$STUB_LOG_DIR/psql-calls.log"
}

if [[ "${1:-}" == "compose" ]]; then
  shift
  # Discard `-p <project>` / `-f <file>` pairs x8_compose() always passes
  # ahead of the actual subcommand.
  while [[ "${1:-}" == "-p" || "${1:-}" == "-f" ]]; do shift 2; done
  sub="${1:-}"
  shift || true
  case "$sub" in
    up)
      exit 0
      ;;
    exec)
      [[ "${1:-}" == "-T" ]] && shift
      [[ "${1:-}" == "postgres" ]] && shift
      case "${1:-}" in
        pg_isready)
          exit "${STUB_PG_ISREADY_EXIT:-0}"
          ;;
        df)
          df_output
          exit 0
          ;;
        psql)
          shift
          log_any_psql_call "$@"
          has_file=""
          has_command=""
          for arg in "$@"; do
            case "$arg" in
              --file | --file=*) has_file=1 ;;
              --command | --command=*) has_command=1 ;;
            esac
          done
          if [[ -n "$has_file" ]]; then
            exit "${STUB_ROLES_EXIT:-0}"
          fi
          if [[ -n "$has_command" ]]; then
            # Two shapes both use --command: the per-role existence probe
            # ("SELECT 1 FROM pg_roles WHERE rolname=...", needs to print
            # "1") and CREATE EXTENSION (prints nothing). Only the former's
            # --command value ever contains "pg_roles".
            joined=" $* "
            if [[ "$joined" == *"pg_roles"* ]]; then
              echo "${STUB_ROLE_CHECK_OUTPUT:-1}"
              exit "${STUB_ROLE_CHECK_EXIT:-0}"
            fi
            exit "${STUB_EXTENSION_EXIT:-0}"
          fi
          # Neither --file nor --command: SQL arrives over stdin (grants.sql
          # itself, the ALTER ROLE heredoc, or a restore replay).
          handle_stdin_psql "$@"
          ;;
        *)
          echo "Error: unsupported exec target in x8-db-prep-stub-docker.sh: $*" >&2
          exit 1
          ;;
      esac
      ;;
    *)
      echo "Error: unsupported compose subcommand in x8-db-prep-stub-docker.sh: $sub $*" >&2
      exit 1
      ;;
  esac
fi

if [[ "${1:-}" == "run" ]]; then
  shift
  joined=" $* "
  if [[ "$joined" == *"prisma migrate deploy"* ]]; then
    exit_code="${STUB_MIGRATE_EXIT:-0}"
    if [[ "$exit_code" != "0" ]]; then
      echo "Error: P3009 could not extend file \"base/16394/16602\": No space left on device" >&2
    fi
    exit "$exit_code"
  fi
  if [[ "$joined" == *"--entrypoint psql"* ]]; then
    exit "${STUB_NETWORK_VERIFY_EXIT:-0}"
  fi
  if [[ "$joined" == *"df -P -k /"* ]]; then
    df_output
    exit 0
  fi
  echo "Error: unsupported 'docker run' invocation in x8-db-prep-stub-docker.sh: $*" >&2
  exit 1
fi

echo "Error: unsupported docker invocation in x8-db-prep-stub-docker.sh: $*" >&2
exit 1
