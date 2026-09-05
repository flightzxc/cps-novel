#!/usr/bin/env bash
# X8 release-identity gate work order (2026-09-05) test fixture. A stub
# `docker` CLI for tests/backend/runtime/x8-gate-catalog.test.ts -- it never
# talks to a real docker daemon; every response is a canned fixture driven by
# STUB_* environment variables the test sets before spawning
# scripts/x8-production-like.sh. Kept as a plain shell fixture file (rather
# than an inline JS template literal) so its own `${VAR:-default}` bash
# syntax never collides with TypeScript template-literal interpolation.
set -euo pipefail

marker="${STUB_MARKER_FILE:-}"

read_marker_flag() {
  local key="$1"
  [[ -n "$marker" && -f "$marker" ]] || return 1
  grep -m1 "^${key}=" "$marker" | cut -d= -f2-
}

if [[ "${1:-}" == "image" && "${2:-}" == "inspect" ]]; then
  shift 2
  ref="$1"
  fmt=""
  if [[ "${2:-}" == "--format" ]]; then fmt="${3:-}"; fi
  if [[ "$ref" != "${STUB_IMAGE_REF:-}" ]]; then
    echo "Error: No such image: $ref" >&2
    exit 1
  fi
  if [[ -n "$fmt" ]]; then
    echo "${STUB_IMAGE_ID:-}"
  fi
  exit 0
fi

if [[ "${1:-}" == "inspect" ]]; then
  shift
  # `docker inspect` accepts --format either before or after the container
  # argument, and this repo's own callers use both orders (x8_container_env_value
  # puts --format first; x8_check_container_labels puts the container first) --
  # scan positionally instead of assuming one fixed order.
  fmt=""
  container=""
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "--format" ]]; then
      fmt="${2:-}"
      shift 2
    else
      container="$1"
      shift
    fi
  done
  case "$container" in
    "${STUB_WEB_CONTAINER_ID:-__none__}")
      label_project="${STUB_WEB_LABEL_PROJECT:-}"; label_service="${STUB_WEB_LABEL_SERVICE:-}"
      label_config_files="${STUB_WEB_LABEL_CONFIG_FILES:-}"; env_json="${STUB_WEB_ENV_JSON:-[]}"
      pre_image="${STUB_WEB_LABEL_IMAGE:-}"; marker_key=WEB
      ;;
    "${STUB_WORKER_CONTAINER_ID:-__none__}")
      label_project="${STUB_WORKER_LABEL_PROJECT:-}"; label_service="${STUB_WORKER_LABEL_SERVICE:-}"
      label_config_files="${STUB_WORKER_LABEL_CONFIG_FILES:-}"; env_json="${STUB_WORKER_ENV_JSON:-[]}"
      pre_image="${STUB_WORKER_LABEL_IMAGE:-}"; marker_key=WORKER
      ;;
    *)
      echo "Error: No such object: $container" >&2
      exit 1
      ;;
  esac
  case "$fmt" in
    '{{index .Config.Labels "com.docker.compose.project"}}') echo "$label_project" ;;
    '{{index .Config.Labels "com.docker.compose.service"}}') echo "$label_service" ;;
    '{{index .Config.Labels "com.docker.compose.project.config_files"}}') echo "$label_config_files" ;;
    '{{.Image}}')
      post_flag="$(read_marker_flag "${marker_key}_RECREATED" || true)"
      if [[ "$post_flag" == "1" ]]; then
        echo "${STUB_POST_IMAGE:-${STUB_IMAGE_ID:-}}"
      else
        echo "$pre_image"
      fi
      ;;
    '{{json .Config.Env}}')
      post_flag="$(read_marker_flag "${marker_key}_RECREATED" || true)"
      if [[ "$post_flag" == "1" ]]; then
        enabled="$(read_marker_flag "${marker_key}_ENABLED" || true)"
        write="$(read_marker_flag "${marker_key}_WRITE" || true)"
        other="$(read_marker_flag "${marker_key}_OTHER" || true)"
        node -e '
          const [, enabled, write, other] = process.argv;
          const entries = [
            "FEATURE_NOVEL_CATALOG_SYNC=" + enabled,
            "NOVEL_CATALOG_SYNC_ALLOW_WRITE=" + write,
          ];
          for (const pair of (other || "").split(";")) if (pair) entries.push(pair);
          console.log(JSON.stringify(entries));
        ' "$enabled" "$write" "$other"
      else
        echo "$env_json"
      fi
      ;;
    *)
      echo "Error: unsupported inspect format: $fmt" >&2
      exit 1
      ;;
  esac
  exit 0
fi

if [[ "${1:-}" == "compose" ]]; then
  shift
  while [[ "${1:-}" == "-p" || "${1:-}" == "-f" ]]; do shift 2; done
  sub="${1:-}"; shift || true
  case "$sub" in
    ps)
      service="${2:-}"
      case "$service" in
        web) echo "${STUB_WEB_CONTAINER_ID:-}" ;;
        worker) echo "${STUB_WORKER_CONTAINER_ID:-}" ;;
      esac
      exit 0
      ;;
    config)
      node -e '
        const enabled = process.env.FEATURE_NOVEL_CATALOG_SYNC ?? "false";
        const write = process.env.NOVEL_CATALOG_SYNC_ALLOW_WRITE ?? "false";
        const allowlist = process.env.WORKER_TASK_ALLOWLIST ?? "";
        const promoRoles = process.env.PROMO_CLAIM_ROLES ?? "";
        const twoFactor = process.env.ADMIN_TWO_FACTOR_ENFORCEMENT ?? "true";
        console.log(JSON.stringify({
          services: {
            web: {
              image: process.env.CPS_NOVEL_APP_IMAGE ?? "",
              environment: {
                FEATURE_NOVEL_CATALOG_SYNC: enabled,
                NOVEL_CATALOG_SYNC_ALLOW_WRITE: write,
                PROMO_CLAIM_ROLES: promoRoles,
                ADMIN_TWO_FACTOR_ENFORCEMENT: twoFactor,
              },
            },
            worker: {
              image: process.env.CPS_NOVEL_APP_IMAGE ?? "",
              environment: {
                FEATURE_NOVEL_CATALOG_SYNC: enabled,
                NOVEL_CATALOG_SYNC_ALLOW_WRITE: write,
                WORKER_TASK_ALLOWLIST: allowlist,
              },
            },
          },
        }));
      '
      exit 0
      ;;
    up)
      exit_code="${STUB_RECREATE_EXIT:-0}"
      if [[ -n "$marker" ]]; then
        {
          echo "WEB_RECREATED=1"
          echo "WEB_ENABLED=${FEATURE_NOVEL_CATALOG_SYNC:-false}"
          echo "WEB_WRITE=${NOVEL_CATALOG_SYNC_ALLOW_WRITE:-false}"
          echo "WEB_OTHER=PROMO_CLAIM_ROLES=${PROMO_CLAIM_ROLES:-};ADMIN_TWO_FACTOR_ENFORCEMENT=${ADMIN_TWO_FACTOR_ENFORCEMENT:-true}"
          echo "WORKER_RECREATED=1"
          echo "WORKER_ENABLED=${FEATURE_NOVEL_CATALOG_SYNC:-false}"
          echo "WORKER_WRITE=${NOVEL_CATALOG_SYNC_ALLOW_WRITE:-false}"
          echo "WORKER_OTHER=WORKER_TASK_ALLOWLIST=${STUB_POST_WORKER_ALLOWLIST_OVERRIDE:-${WORKER_TASK_ALLOWLIST:-}}"
        } >"$marker"
      fi
      exit "$exit_code"
      ;;
    *)
      echo "Error: unsupported compose subcommand: $sub" >&2
      exit 1
      ;;
  esac
fi

echo "Error: unsupported docker invocation: $*" >&2
exit 1
