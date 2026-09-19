#!/usr/bin/env bash

PREPROD_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${PREPROD_ENV_FILE:=/opt/cps-novel/shared/env/preprod.env}"

preprod_load_env() {
  [[ "$PREPROD_ENV_FILE" = /* && -r "$PREPROD_ENV_FILE" ]] || {
    echo "ERROR: PREPROD_ENV_FILE must be an absolute readable file" >&2
    return 66
  }
  set -a
  # shellcheck disable=SC1090
  source "$PREPROD_ENV_FILE"
  set +a
  [[ "${P1_12_COMPOSE_PROJECT:-}" == "cps-novel" ]] || {
    echo "ERROR: P1_12_COMPOSE_PROJECT must equal cps-novel" >&2
    return 65
  }
}

preprod_compose() {
  docker compose --env-file "$PREPROD_ENV_FILE" -p cps-novel \
    -f "$PREPROD_REPO_ROOT/docker-compose.yml" \
    -f "$PREPROD_REPO_ROOT/infra/preproduction/docker-compose.yml" "$@"
}
