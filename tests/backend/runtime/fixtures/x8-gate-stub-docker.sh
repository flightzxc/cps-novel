#!/usr/bin/env bash
# X8 release-identity gate work order (2026-09-05) test fixture, extended by
# the 2026-09-06 patch work order. A stub `docker` CLI for
# tests/backend/runtime/x8-gate-catalog.test.ts -- it never talks to a real
# docker daemon; every response is a canned fixture driven by STUB_*
# environment variables the test sets before spawning
# scripts/x8-production-like.sh. Kept as a plain shell fixture file (rather
# than an inline JS template literal) so its own `${VAR:-default}` bash
# syntax never collides with TypeScript template-literal interpolation.
set -euo pipefail

marker="${STUB_MARKER_FILE:-}"

# Reads the LAST written value for a marker key, not the first -- the
# 2026-09-06 patch's rollback path can invoke `docker compose up` a second
# time (X8_GATE_ROLLBACK=1) within the same test, and the marker file is
# appended to (not overwritten) across calls so a service untouched by the
# second call keeps whatever the first call left it at. Reading the LAST
# match is what makes "the most recent recreate call wins" correct.
read_marker_flag() {
  local key="$1"
  [[ -n "$marker" && -f "$marker" ]] || return 1
  grep "^${key}=" "$marker" | tail -1 | cut -d= -f2-
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
  case "$fmt" in
    # Terminal review, release-identity gate second round, finding 一:
    # x8_gate_actual_matches_baseline() now reads the image's OWN baked-in
    # default environment (to check BASE_IMAGE_BAKED_KEYS-exempted values
    # against it, not accept them unconditionally) -- distinct from every
    # other format this stub is asked for, which all just want the image ID.
    '{{json .Config.Env}}') echo "${STUB_IMAGE_ENV_JSON:-[]}" ;;
    "") : ;; # existence-only check (`docker image inspect "$ref" >/dev/null`): no output needed
    *) echo "${STUB_IMAGE_ID:-}" ;;
  esac
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
      label_working_dir="${STUB_WEB_LABEL_WORKING_DIR:-/fixture}"
      pre_image="${STUB_WEB_LABEL_IMAGE:-}"; marker_key=WEB
      health="${STUB_WEB_HEALTH:-healthy}"
      ;;
    "${STUB_WORKER_CONTAINER_ID:-__none__}")
      label_project="${STUB_WORKER_LABEL_PROJECT:-}"; label_service="${STUB_WORKER_LABEL_SERVICE:-}"
      label_config_files="${STUB_WORKER_LABEL_CONFIG_FILES:-}"; env_json="${STUB_WORKER_ENV_JSON:-[]}"
      label_working_dir="${STUB_WORKER_LABEL_WORKING_DIR:-/fixture}"
      pre_image="${STUB_WORKER_LABEL_IMAGE:-}"; marker_key=WORKER
      health="${STUB_WORKER_HEALTH:-healthy}"
      ;;
    # 2026-09-06 patch (second round), group 1 test support: `up_x8()` now
    # waits for scheduler to report healthy too (x8_wait_services_healthy),
    # alongside web/worker -- only .State.Health.Status is exercised by that
    # path, but the other fields are filled in for symmetry with web/worker
    # in case a future test needs them.
    "${STUB_SCHEDULER_CONTAINER_ID:-__none__}")
      label_project="${STUB_SCHEDULER_LABEL_PROJECT:-}"; label_service="${STUB_SCHEDULER_LABEL_SERVICE:-}"
      label_config_files="${STUB_SCHEDULER_LABEL_CONFIG_FILES:-}"; env_json="${STUB_SCHEDULER_ENV_JSON:-[]}"
      label_working_dir="${STUB_SCHEDULER_LABEL_WORKING_DIR:-/fixture}"
      pre_image="${STUB_SCHEDULER_LABEL_IMAGE:-}"; marker_key=SCHEDULER
      health="${STUB_SCHEDULER_HEALTH:-healthy}"
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
    '{{index .Config.Labels "com.docker.compose.project.working_dir"}}')
      post_flag="$(read_marker_flag "${marker_key}_RECREATED" || true)"
      post_override_var="STUB_POST_${marker_key}_LABEL_WORKING_DIR"
      post_override="${!post_override_var:-}"
      # Unlike STUB_POST_IMAGE / STUB_POST_WORKER_ALLOWLIST_OVERRIDE, this one
      # deliberately does NOT distinguish primary from rollback -- it models a
      # genuinely broken compose invocation context (e.g. a second worktree
      # racing on the same runtime dir), which a same-process retry would not
      # fix either. Tests that need "rollback also fails" use this.
      if [[ "$post_flag" == "1" && -n "$post_override" ]]; then
        echo "$post_override"
      else
        echo "$label_working_dir"
      fi
      ;;
    '{{.State.Health.Status}}')
      echo "$health"
      ;;
    '{{.Image}}')
      post_flag="$(read_marker_flag "${marker_key}_RECREATED" || true)"
      if [[ "$post_flag" == "1" ]]; then
        source_flag="$(read_marker_flag "${marker_key}_SOURCE" || true)"
        # STUB_POST_IMAGE only distorts the PRIMARY recreate's result -- a
        # rollback recreate (X8_GATE_ROLLBACK=1) is modeled as a clean retry
        # that lands on the real frozen image, so a test can exercise "the
        # compensating recreate actually fixes it" as well as "it doesn't".
        if [[ "$source_flag" == "primary" ]]; then
          echo "${STUB_POST_IMAGE:-${STUB_IMAGE_ID:-}}"
        else
          echo "${STUB_IMAGE_ID:-}"
        fi
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
        source_flag="$(read_marker_flag "${marker_key}_SOURCE" || true)"
        # Same "primary-only distortion" rule as {{.Image}} above, for the
        # worker allowlist post-recreate-drift fixture. Only the single key
        # under test is overridden -- FEATURE_PROMO_LINK_CLAIM (also part of
        # worker's declared environment, see the `config` render below)
        # stays at its ambient value so this remains a single-key drift, not
        # an incidental second one.
        if [[ "$marker_key" == "WORKER" && "$source_flag" == "primary" && -n "${STUB_POST_WORKER_ALLOWLIST_OVERRIDE:-}" ]]; then
          other="WORKER_TASK_ALLOWLIST=${STUB_POST_WORKER_ALLOWLIST_OVERRIDE};FEATURE_PROMO_LINK_CLAIM=${FEATURE_PROMO_LINK_CLAIM:-false}"
        fi
        # 2026-09-06 patch (second round), group 3 test support: the web
        # equivalent, for a key the OLD hand-checked post-recreate
        # verification never looked at at all (MOBOREADER_PREVIEW_SOURCE_APP_CODES)
        # but the full-reconciliation post-recreate check now does.
        if [[ "$marker_key" == "WEB" && "$source_flag" == "primary" && -n "${STUB_POST_WEB_PREVIEW_APPS_OVERRIDE:-}" ]]; then
          other="PROMO_CLAIM_ROLES=${PROMO_CLAIM_ROLES:-};ADMIN_TWO_FACTOR_ENFORCEMENT=${ADMIN_TWO_FACTOR_ENFORCEMENT:-true};MOBOREADER_PREVIEW_SOURCE_APP_CODES=${STUB_POST_WEB_PREVIEW_APPS_OVERRIDE};FEATURE_PROMO_LINK_CLAIM=${FEATURE_PROMO_LINK_CLAIM:-false}"
        fi
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
  # P1-8 test support: record every compose invocation's full argument list
  # (including -p/-f, captured BEFORE they are discarded below) so a test
  # can assert which project name and config files were actually used --
  # e.g. that the gate command bound to the release identity's recorded
  # files, never $X8_PROJECT_ROOT's.
  if [[ -n "${STUB_COMPOSE_ARGS_LOG:-}" ]]; then
    { printf 'ARGS:'; printf ' %s' "$@"; printf '\n'; } >>"$STUB_COMPOSE_ARGS_LOG"
  fi
  while [[ "${1:-}" == "-p" || "${1:-}" == "-f" ]]; do shift 2; done
  sub="${1:-}"; shift || true
  case "$sub" in
    ps)
      service="${2:-}"
      case "$service" in
        web)
          if [[ "${STUB_PS_FAIL_WEB:-}" == "1" ]]; then
            echo "Error: stub compose ps failure (web)" >&2
            exit 1
          fi
          echo "${STUB_WEB_CONTAINER_ID:-}"
          ;;
        worker)
          if [[ "${STUB_PS_FAIL_WORKER:-}" == "1" ]]; then
            echo "Error: stub compose ps failure (worker)" >&2
            exit 1
          fi
          echo "${STUB_WORKER_CONTAINER_ID:-}"
          ;;
        scheduler)
          if [[ "${STUB_PS_FAIL_SCHEDULER:-}" == "1" ]]; then
            echo "Error: stub compose ps failure (scheduler)" >&2
            exit 1
          fi
          echo "${STUB_SCHEDULER_CONTAINER_ID:-}"
          ;;
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
        // P0-3 test support: two representative keys that were NOT in the
        // pre-patch curated 7-key list this repo used to reconcile against
        // (the promo-link double-gate and the preview source allowlist),
        // so an integration-level test can prove the three-way check now
        // catches drift in them too, not just at the pure-function level.
        // Phase B (2026-09-06): the real docker-compose.yml default flipped
        // from "changdu" to "moboreader" (Channel/SourceApp entity swap --
        // 施工工单_PhaseB_实体订正与运营表单Parity_2026-09-06.md §二), so this
        // simulated `docker compose config` baseline has to track it or every
        // no-override happy path reports a false ambient drift.
        const previewSourceApps = process.env.MOBOREADER_PREVIEW_SOURCE_APP_CODES ?? "moboreader";
        const promoLinkClaim = process.env.FEATURE_PROMO_LINK_CLAIM ?? "false";
        console.log(JSON.stringify({
          name: process.env.STUB_CONFIG_TOP_LEVEL_NAME ?? "cps-novel-x8-local",
          services: {
            web: {
              image: process.env.CPS_NOVEL_APP_IMAGE ?? "",
              environment: {
                FEATURE_NOVEL_CATALOG_SYNC: enabled,
                NOVEL_CATALOG_SYNC_ALLOW_WRITE: write,
                PROMO_CLAIM_ROLES: promoRoles,
                ADMIN_TWO_FACTOR_ENFORCEMENT: twoFactor,
                MOBOREADER_PREVIEW_SOURCE_APP_CODES: previewSourceApps,
                FEATURE_PROMO_LINK_CLAIM: promoLinkClaim,
              },
            },
            worker: {
              image: process.env.CPS_NOVEL_APP_IMAGE ?? "",
              environment: {
                FEATURE_NOVEL_CATALOG_SYNC: enabled,
                NOVEL_CATALOG_SYNC_ALLOW_WRITE: write,
                WORKER_TASK_ALLOWLIST: allowlist,
                FEATURE_PROMO_LINK_CLAIM: promoLinkClaim,
              },
            },
          },
        }));
      '
      exit 0
      ;;
    up)
      # Terminal review, release-identity gate second round, finding 二: a
      # deliberate delay so a test can send SIGTERM to the parent
      # scripts/x8-production-like.sh process while it is genuinely blocked
      # in `docker compose up` (the exact real-world window a Ctrl+C during a
      # slow recreate lands in) and then assert the EXIT-trap cleanup of
      # baseline_file/candidate_file actually ran.
      if [[ -n "${STUB_RECREATE_SLEEP_SECONDS:-}" ]]; then
        sleep "$STUB_RECREATE_SLEEP_SECONDS"
      fi
      is_rollback="${X8_GATE_ROLLBACK:-}"
      if [[ "$is_rollback" == "1" ]]; then
        exit_code="${STUB_ROLLBACK_EXIT:-0}"
        default_partial=""
        [[ "$exit_code" == "0" ]] && default_partial="web,worker"
        partial_spec="${STUB_ROLLBACK_PARTIAL:-$default_partial}"
        source_tag=rollback
      else
        exit_code="${STUB_RECREATE_EXIT:-0}"
        default_partial=""
        [[ "$exit_code" == "0" ]] && default_partial="web,worker"
        partial_spec="${STUB_RECREATE_PARTIAL:-$default_partial}"
        source_tag=primary
      fi
      if [[ -n "$marker" && -n "$partial_spec" ]]; then
        old_ifs="$IFS"
        IFS=','
        read -r -a targets <<<"$partial_spec"
        IFS="$old_ifs"
        for target in "${targets[@]}"; do
          case "$target" in
            web)
              {
                echo "WEB_RECREATED=1"
                echo "WEB_SOURCE=$source_tag"
                echo "WEB_ENABLED=${FEATURE_NOVEL_CATALOG_SYNC:-false}"
                echo "WEB_WRITE=${NOVEL_CATALOG_SYNC_ALLOW_WRITE:-false}"
                # 2026-09-06 patch (second round), group 3: MOBOREADER_PREVIEW_SOURCE_APP_CODES
                # and FEATURE_PROMO_LINK_CLAIM are also part of web's declared
                # environment (see the `config` render below) -- the full
                # post-recreate reconciliation now checks them too, so the
                # fixture has to actually report them, not just the two keys
                # the OLD hand-checked verification looked at.
                echo "WEB_OTHER=PROMO_CLAIM_ROLES=${PROMO_CLAIM_ROLES:-};ADMIN_TWO_FACTOR_ENFORCEMENT=${ADMIN_TWO_FACTOR_ENFORCEMENT:-true};MOBOREADER_PREVIEW_SOURCE_APP_CODES=${MOBOREADER_PREVIEW_SOURCE_APP_CODES:-moboreader};FEATURE_PROMO_LINK_CLAIM=${FEATURE_PROMO_LINK_CLAIM:-false}"
              } >>"$marker"
              ;;
            worker)
              {
                echo "WORKER_RECREATED=1"
                echo "WORKER_SOURCE=$source_tag"
                echo "WORKER_ENABLED=${FEATURE_NOVEL_CATALOG_SYNC:-false}"
                echo "WORKER_WRITE=${NOVEL_CATALOG_SYNC_ALLOW_WRITE:-false}"
                # FEATURE_PROMO_LINK_CLAIM is also part of worker's declared
                # environment -- see the note on WEB_OTHER above.
                echo "WORKER_OTHER=WORKER_TASK_ALLOWLIST=${WORKER_TASK_ALLOWLIST:-};FEATURE_PROMO_LINK_CLAIM=${FEATURE_PROMO_LINK_CLAIM:-false}"
              } >>"$marker"
              ;;
          esac
        done
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
