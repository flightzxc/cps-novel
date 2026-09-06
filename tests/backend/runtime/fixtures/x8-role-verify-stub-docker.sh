#!/usr/bin/env bash
# Phase D D-2 test fixture -- a stub `docker` CLI for
# tests/backend/runtime/x8-role-password-alignment.test.ts. Models exactly
# the one `docker run --entrypoint psql postgres:16.14 ...` shape
# x8_verify_db_role_passwords_via_network() (scripts/lib/x8-production-like-env.sh)
# issues per role, over the network -- never a real daemon, never a real
# Postgres server. A role name matching $STUB_ROLE_VERIFY_FAIL_ROLE fails
# (models a real scram-sha-256 rejection); every other role succeeds. This
# is deliberately a SEPARATE, minimal fixture from
# fixtures/x8-gate-stub-docker.sh (which models an entirely different set of
# `docker`/`docker compose` invocations for the release-identity gate) --
# reusing that one here would mean teaching its already-large dispatch about
# a shape it has no other reason to know.
set -euo pipefail

if [[ "${1:-}" == "run" ]]; then
  shift
  role=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -U)
        role="$2"
        shift 2
        ;;
      *) shift ;;
    esac
  done
  if [[ -n "${STUB_ROLE_VERIFY_FAIL_ROLE:-}" && "$role" == "$STUB_ROLE_VERIFY_FAIL_ROLE" ]]; then
    echo "psql: error: connection to server at \"postgres\" (127.0.0.1), port 5432 failed: FATAL:  password authentication failed for user \"$role\"" >&2
    exit 2
  fi
  echo "1"
  exit 0
fi

echo "Error: unsupported docker invocation in x8-role-verify-stub-docker.sh: $*" >&2
exit 1
