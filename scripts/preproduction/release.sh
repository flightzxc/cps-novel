#!/usr/bin/env bash
set -euo pipefail
set +x

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/preproduction/lib.sh
source "$root/scripts/preproduction/lib.sh"
preprod_load_env
shared="${PREPROD_SHARED_ROOT:-/opt/cps-novel/shared}"
state_file="$shared/release-state.json"
maintenance_dir="$shared/maintenance"

usage() {
  echo "usage: release.sh deploy --manifest FILE | rollback --manifest FILE | maintenance on|off" >&2
  exit 64
}

write_state() {
  local state="$1" commit="${2:-}" image="${3:-}"
  mkdir -p "$shared"
  local temporary="${state_file}.tmp.$$"
  node -e 'const fs=require("fs"); const [p,state,commit,image]=process.argv.slice(1); fs.writeFileSync(p,JSON.stringify({schemaVersion:1,state,commit,image,updatedAt:new Date().toISOString()},null,2)+"\n",{mode:0o600});' \
    "$temporary" "$state" "$commit" "$image"
  mv "$temporary" "$state_file"
}

maintenance_on() {
  mkdir -p "$maintenance_dir"
  install -m 0644 "$root/infra/preproduction/maintenance/__preprod_maintenance.html" \
    "$maintenance_dir/__preprod_maintenance.html"
  : >"$maintenance_dir/enabled"
  echo "MAINTENANCE=ON"
}

maintenance_off() {
  [[ "${PREPROD_RELEASE_VERIFIED:-}" == "YES" ]] || {
    echo "MAINTENANCE_OFF=REFUSED reason=release_not_verified"; return 65;
  }
  rm -f "$maintenance_dir/enabled"
  echo "MAINTENANCE=OFF"
}

read_manifest() {
  local manifest="$1"
  [[ "$manifest" = /* && -r "$manifest" ]] || { echo "RELEASE=REFUSED reason=manifest"; exit 66; }
  manifest_commit="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.commit||"")' "$manifest")"
  manifest_image="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.image||"")' "$manifest")"
  [[ "$manifest_commit" =~ ^[0-9a-f]{40}$ && "$manifest_image" =~ @sha256:[0-9a-f]{64}$ ]] || {
    echo "RELEASE=REFUSED reason=manifest_identity"; exit 65;
  }
  [[ "${APPROVED_GIT_COMMIT:-}" == "$manifest_commit" ]] || {
    echo "RELEASE=REFUSED reason=owner_approved_commit"; exit 65;
  }
  export GIT_COMMIT="$manifest_commit" CPS_NOVEL_APP_IMAGE="$manifest_image"
}

deploy() {
  local manifest="$1" failed=1
  read_manifest "$manifest"
  [[ "$(git -C "$root" rev-parse HEAD)" == "$manifest_commit" ]] || {
    echo "RELEASE=REFUSED reason=checkout_commit"; exit 65;
  }
  EXPECTED_RELEASE_COMMIT="$manifest_commit" EXPECTED_RELEASE_IMAGE="$manifest_image" \
    "$root/scripts/preproduction/preflight.sh"
  write_state preflight_passed "$manifest_commit" "$manifest_image"
  maintenance_on
  write_state maintenance "$manifest_commit" "$manifest_image"
  trap 'if [[ "$failed" == "1" ]]; then write_state failed "$manifest_commit" "$manifest_image"; echo "RELEASE=FAILED maintenance=ON"; fi' EXIT

  preprod_compose stop scheduler
  write_state scheduler_stopped "$manifest_commit" "$manifest_image"
  preprod_compose stop worker
  write_state worker_stopped "$manifest_commit" "$manifest_image"
  preprod_compose stop web
  write_state web_stopped "$manifest_commit" "$manifest_image"

  [[ "${PREPROD_APPROVED_MIGRATION:-}" == "YES" ]] || {
    echo "RELEASE=REFUSED reason=migration_approval"; exit 65;
  }
  PREPROD_APPROVED_MIGRATION=YES "$root/scripts/preproduction/database.sh" migrate-approved
  write_state migrated "$manifest_commit" "$manifest_image"

  preprod_compose up -d --no-deps web
  write_state web_started "$manifest_commit" "$manifest_image"
  "$root/scripts/preproduction/verify-release.sh"
  write_state verified "$manifest_commit" "$manifest_image"

  preprod_compose up -d --no-deps worker
  preprod_compose up -d --no-deps scheduler
  PREPROD_RELEASE_VERIFIED=YES maintenance_off
  ln -sfn "/opt/cps-novel/releases/$manifest_commit" /opt/cps-novel/current
  write_state ready "$manifest_commit" "$manifest_image"
  failed=0
  trap - EXIT
  echo "RELEASE=PASS"
}

rollback() {
  local manifest="$1" failed=1
  [[ "${SCHEMA_COMPATIBLE_WITH_PREVIOUS:-}" == "YES" ]] || {
    echo "ROLLBACK=REFUSED reason=schema_compatibility_not_approved"; exit 65;
  }
  read_manifest "$manifest"
  [[ "$(git -C "$root" rev-parse HEAD)" == "$manifest_commit" ]] || {
    echo "ROLLBACK=REFUSED reason=invoke_from_previous_release"; exit 65;
  }
  maintenance_on
  trap 'if [[ "$failed" == "1" ]]; then write_state rollback_failed "$manifest_commit" "$manifest_image"; echo "ROLLBACK=FAILED maintenance=ON"; fi' EXIT
  preprod_compose stop scheduler
  preprod_compose stop worker
  preprod_compose stop web
  # Application rollback only: deliberately no down migration and no restore.
  preprod_compose up -d --no-deps web
  "$root/scripts/preproduction/verify-release.sh"
  preprod_compose up -d --no-deps worker
  preprod_compose up -d --no-deps scheduler
  PREPROD_RELEASE_VERIFIED=YES maintenance_off
  write_state rolled_back "$manifest_commit" "$manifest_image"
  failed=0
  trap - EXIT
  echo "ROLLBACK=PASS"
}

case "${1:-}" in
  deploy) [[ "${2:-}" == "--manifest" && -n "${3:-}" ]] || usage; deploy "$3" ;;
  rollback) [[ "${2:-}" == "--manifest" && -n "${3:-}" ]] || usage; rollback "$3" ;;
  maintenance)
    case "${2:-}" in
      on) maintenance_on ;;
      off) maintenance_off ;;
      *) usage ;;
    esac ;;
  *) usage ;;
esac
