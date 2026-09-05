#!/usr/bin/env bash

set -euo pipefail
set +x

X8_PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
X8_RUNTIME_DIR="${X8_RUNTIME_DIR:-$X8_PROJECT_ROOT/.tmp/x8-production-like}"
X8_SECRET_DIR="$X8_RUNTIME_DIR/secrets"
X8_TLS_DIR="$X8_RUNTIME_DIR/tls"
X8_NGINX_RUNTIME_DIR="$X8_RUNTIME_DIR/nginx"
X8_BACKUP_DIR="$X8_RUNTIME_DIR/backups"
X8_EVIDENCE_DIR="$X8_RUNTIME_DIR/evidence"
X8_GATE_STATE_FILE="$X8_RUNTIME_DIR/catalog-gate.state"
X8_BACKUP_PGPASS_FILE="$X8_SECRET_DIR/backup.pgpass"
# X8 release-identity gate work order (2026-09-05): the one file `up` writes
# after a successful build and before any container starts, and the one file
# every gate operation reads its deployment identity from. Never hand-edited
# (see resolve_x8_identity() / write_x8_identity() in x8-production-like.sh).
X8_IDENTITY_FILE="$X8_RUNTIME_DIR/release-identity.json"
# Single source of truth for the compose project name so gate_catalog_status()
# (which must do zero environment prep, see 4.3(9)) doesn't need to call
# prepare_x8_environment() just to know it.
X8_COMPOSE_PROJECT_NAME="cps-novel-x8-local"

export P1_12_RUNTIME_DIR="$X8_RUNTIME_DIR"
export P1_12_SECRET_DIR="$X8_SECRET_DIR"
# shellcheck source=scripts/lib/p1-12-local-env.sh
source "$X8_PROJECT_ROOT/scripts/lib/p1-12-local-env.sh"

X8_LEVELS_FILE="$X8_PROJECT_ROOT/scripts/lib/x8-levels.json"
X8_ALLOWED_LEVELS=(0 uat r)

# RC-2b: single source of truth for the per-level WORKER_TASK_ALLOWLIST /
# double-gate values is scripts/lib/x8-levels.json — scripts/acceptance/
# x8-validate-compose.mjs reads the same file so the two never drift apart.
# This helper is the only place that parses it on the bash side.
x8_level_config() {
  local level="$1"
  command -v node >/dev/null 2>&1 || {
    echo "ERROR: node is required to resolve X8_LEVEL configuration" >&2
    return 69
  }
  node -e '
    const fs = require("fs");
    const [, configPath, level] = process.argv;
    let table;
    try {
      table = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (error) {
      process.stderr.write(`ERROR: unable to read X8 level table at ${configPath}: ${error.message}\n`);
      process.exit(70);
    }
    const entry = table[level];
    if (!entry) {
      const allowed = Object.keys(table).filter((key) => key !== "_comment");
      process.stderr.write(`ERROR: unknown X8 level "${level}" (allowed: ${allowed.join(", ")})\n`);
      process.exit(65);
    }
    const lines = [
      `WORKER_TASK_ALLOWLIST=${entry.workerTaskAllowlist}`,
      // Not a double-gate flag: the promo:claim admin capability grant. The
      // claim dialog on /catalog-sync refuses apply mode without it, so a
      // Level UAT topology that only flipped FEATURE_PROMO_LINK_CLAIM would
      // still be unable to run steps 6/7 of the Owner runbook.
      `PROMO_CLAIM_ROLES=${entry.promoClaimRoles}`,
      // RC-10: the global 2FA enforcement switch (src/lib/auth/
      // two-factor-enforcement.ts). Canonical values are "true"/"false";
      // "false" only for Level UAT, Level 0 and Level R stay "true"
      // (fail-closed default).
      `ADMIN_TWO_FACTOR_ENFORCEMENT=${entry.adminTwoFactorEnforcement}`,
      // RC-11: gate for scripts/ensure-local-admin-identities.ts. Fail-closed
      // exact match on "allow" -- only Level UAT sets it; Level 0 and Level R
      // render it empty, which that exact-match check treats the same as
      // unset.
      `ADMIN_LOCAL_IDENTITY_SEED=${entry.adminLocalIdentitySeed}`,
    ];
    for (const [key, value] of Object.entries(entry.flags)) lines.push(`${key}=${value}`);
    process.stdout.write(lines.join("\n") + "\n");
  ' "$X8_LEVELS_FILE" "$level"
}

# Extracts just the expected WORKER_TASK_ALLOWLIST string for a level, from
# the same table x8_level_config() reads — used by validate_rendered_topology
# in scripts/x8-production-like.sh so the assertion can never quote a value
# that disagrees with what prepare_x8_environment() actually exported.
x8_expected_worker_allowlist() {
  local level="$1"
  x8_level_config "$level" | awk -F= '$1 == "WORKER_TASK_ALLOWLIST" { print substr($0, index($0, "=") + 1) }'
}

# The catalog-write tri-state gate (dry-run/apply/closed) predates X8_LEVEL
# and keeps its own persisted state file + `gate catalog-write` command,
# unchanged. This only picks the *seed* value written the first time that
# state file is created for a given level; `gate catalog-write on|off|dry-run`
# still overrides it afterward exactly as before.
x8_level_catalog_default() {
  local level="$1"
  node -e '
    const fs = require("fs");
    const [, configPath, level] = process.argv;
    const table = JSON.parse(fs.readFileSync(configPath, "utf8"));
    process.stdout.write(`${table[level].catalogSyncDefaultGateState}\n`);
  ' "$X8_LEVELS_FILE" "$level"
}

x8_read_gate_state() {
  [[ -f "$X8_GATE_STATE_FILE" ]] || {
    echo "ERROR: no X8 catalog gate state file at $X8_GATE_STATE_FILE; run 'up' first" >&2
    return 65
  }
  local state
  state="$(tr -d '\r\n' <"$X8_GATE_STATE_FILE")"
  case "$state" in
    dry-run | apply | closed) printf '%s' "$state" ;;
    *)
      echo "ERROR: corrupt X8 catalog gate state" >&2
      return 65
      ;;
  esac
}

# X8 release-identity gate work order (2026-09-05), 施工项一 4.3(一)/(三): reads
# the deploy identity `up` last wrote and exports X8_IDENTITY_*. This is the
# ONLY sanctioned way for the gate command to learn its run level, image ref,
# and image digest -- never from the branch's latest commit, never from a
# caller-supplied X8_LEVEL, and never with a fallback if the file is missing
# or unreadable. A missing/corrupt/leveless identity file is a hard failure,
# by design ("级别不可判定即拒绝执行" -- Owner). This function never touches
# docker, never creates a directory, and never writes anything -- it is safe
# to call from a purely read-only path.
resolve_x8_identity() {
  if [[ ! -f "$X8_IDENTITY_FILE" ]]; then
    echo "ERROR: no X8 deploy identity file at $X8_IDENTITY_FILE" >&2
    echo "Run 'scripts/x8-production-like.sh up' (with an explicit X8_LEVEL=0|uat|r) to establish one before using the gate command." >&2
    return 65
  fi
  local parsed
  if ! parsed="$(node -e '
    const fs = require("fs");
    let data;
    try {
      data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    } catch (error) {
      process.stderr.write(`ERROR: corrupt X8 deploy identity file (${error.message})\n`);
      process.exit(65);
    }
    const requiredStrings = ["appVersion", "gitCommit", "level", "imageRef", "imageDigest", "composeProject", "buildDate"];
    for (const key of requiredStrings) {
      const value = data[key];
      if (typeof value !== "string" || value.trim().length === 0) {
        process.stderr.write(`ERROR: X8 deploy identity file is missing a valid "${key}"\n`);
        process.exit(65);
      }
    }
    if (!["0", "uat", "r"].includes(data.level)) {
      process.stderr.write(`ERROR: X8 deploy identity file has an unrecognized level "${data.level}" (allowed: 0, uat, r)\n`);
      process.exit(65);
    }
    if (
      !Array.isArray(data.composeConfigFiles) ||
      data.composeConfigFiles.length === 0 ||
      !data.composeConfigFiles.every((entry) => typeof entry === "string" && entry.trim().length > 0)
    ) {
      process.stderr.write("ERROR: X8 deploy identity file is missing a valid \"composeConfigFiles\" list\n");
      process.exit(65);
    }
    const lines = [
      `APP_VERSION=${data.appVersion}`,
      `GIT_COMMIT=${data.gitCommit}`,
      `LEVEL=${data.level}`,
      `IMAGE_REF=${data.imageRef}`,
      `IMAGE_DIGEST=${data.imageDigest}`,
      `COMPOSE_PROJECT=${data.composeProject}`,
      `BUILD_DATE=${data.buildDate}`,
      `COMPOSE_CONFIG_FILES=${data.composeConfigFiles.join(",")}`,
    ];
    process.stdout.write(lines.join("\n") + "\n");
  ' "$X8_IDENTITY_FILE")"; then
    return 65
  fi
  X8_IDENTITY_APP_VERSION=""
  X8_IDENTITY_GIT_COMMIT=""
  X8_IDENTITY_LEVEL=""
  X8_IDENTITY_IMAGE_REF=""
  X8_IDENTITY_IMAGE_DIGEST=""
  X8_IDENTITY_COMPOSE_PROJECT=""
  X8_IDENTITY_BUILD_DATE=""
  X8_IDENTITY_COMPOSE_CONFIG_FILES=""
  local key value
  while IFS='=' read -r key value; do
    case "$key" in
      APP_VERSION) X8_IDENTITY_APP_VERSION="$value" ;;
      GIT_COMMIT) X8_IDENTITY_GIT_COMMIT="$value" ;;
      LEVEL) X8_IDENTITY_LEVEL="$value" ;;
      IMAGE_REF) X8_IDENTITY_IMAGE_REF="$value" ;;
      IMAGE_DIGEST) X8_IDENTITY_IMAGE_DIGEST="$value" ;;
      COMPOSE_PROJECT) X8_IDENTITY_COMPOSE_PROJECT="$value" ;;
      BUILD_DATE) X8_IDENTITY_BUILD_DATE="$value" ;;
      COMPOSE_CONFIG_FILES) X8_IDENTITY_COMPOSE_CONFIG_FILES="$value" ;;
    esac
  done <<<"$parsed"
  # Belt-and-suspenders: the node script above already exits 65 on a missing
  # level, but never let a run level fall back silently for any other reason
  # either (e.g. a future field-parsing change) -- undecidable always fails.
  if [[ -z "$X8_IDENTITY_LEVEL" ]]; then
    echo "ERROR: X8 deploy identity file does not resolve to a run level" >&2
    return 65
  fi
  export X8_IDENTITY_APP_VERSION X8_IDENTITY_GIT_COMMIT X8_IDENTITY_LEVEL X8_IDENTITY_IMAGE_REF \
    X8_IDENTITY_IMAGE_DIGEST X8_IDENTITY_COMPOSE_PROJECT X8_IDENTITY_BUILD_DATE X8_IDENTITY_COMPOSE_CONFIG_FILES
}

write_x8_gate_state() {
  local state="$1"
  [[ "$state" == "dry-run" || "$state" == "apply" || "$state" == "closed" ]] || {
    echo "ERROR: invalid X8 catalog gate state: $state" >&2
    return 65
  }
  local temporary="${X8_GATE_STATE_FILE}.tmp.$$"
  printf '%s\n' "$state" >"$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$X8_GATE_STATE_FILE"
}

# X8 release-identity gate work order (2026-09-05), 施工项一 4.3(八): this used
# to compare "the level's documented default" against "the persisted state
# file" -- both static, neither ever looked at what the containers actually
# have. That is exactly the blind spot the work order's 一.1 describes: the
# alert stayed silent while the persisted state said "apply" and both running
# containers actually had the gate closed. The comparison is now "persisted
# state file" vs. "what is actually baked into the running web container's
# environment" -- and the repair suggestion carries the full command,
# including the level prefix and the (now-required, see 4.3(七)) --apply flag.
warn_x8_gate_drift() {
  [[ "$X8_LEVEL" == "uat" || "$X8_LEVEL" == "r" ]] || return 0
  [[ -f "$X8_GATE_STATE_FILE" ]] || return 0
  local persisted expected_enabled expected_write
  persisted="$(tr -d '\r\n' <"$X8_GATE_STATE_FILE")"
  case "$persisted" in
    apply) expected_enabled=true; expected_write=true ;;
    dry-run) expected_enabled=true; expected_write=false ;;
    closed) expected_enabled=false; expected_write=false ;;
    *) return 0 ;; # corrupt state is caught elsewhere (prepare_x8_environment)
  esac
  local web_container
  web_container="$(x8_compose ps -q web 2>/dev/null || true)"
  [[ -n "$web_container" ]] || return 0 # nothing running yet to compare against
  local actual_enabled actual_write
  actual_enabled="$(x8_container_env_value "$web_container" FEATURE_NOVEL_CATALOG_SYNC)"
  actual_write="$(x8_container_env_value "$web_container" NOVEL_CATALOG_SYNC_ALLOW_WRITE)"
  [[ "$actual_enabled" == "$expected_enabled" && "$actual_write" == "$expected_write" ]] && return 0
  printf '%s\n' \
    "WARNING: X8 catalog-write gate drift: state=$persisted (expects FEATURE_NOVEL_CATALOG_SYNC=$expected_enabled NOVEL_CATALOG_SYNC_ALLOW_WRITE=$expected_write) actual web container has FEATURE_NOVEL_CATALOG_SYNC=$actual_enabled NOVEL_CATALOG_SYNC_ALLOW_WRITE=$actual_write" \
    "Repair explicitly (state is not overwritten): X8_LEVEL=$X8_LEVEL scripts/x8-production-like.sh gate catalog-write on --apply" >&2
}

prepare_x8_environment() {
  # RC-2b: X8_LEVEL selects which docs/p2/V020_RELEASE_CHECKLIST.md flag
  # ladder rung this local topology boots at. Fail fast, before any
  # directory/state-file side effect, on anything outside the frozen set.
  X8_LEVEL="${X8_LEVEL:-0}"
  local level_is_allowed=no allowed_level
  for allowed_level in "${X8_ALLOWED_LEVELS[@]}"; do
    [[ "$X8_LEVEL" == "$allowed_level" ]] && { level_is_allowed=yes; break; }
  done
  [[ "$level_is_allowed" == yes ]] || {
    echo "ERROR: invalid X8_LEVEL '$X8_LEVEL' (allowed values: ${X8_ALLOWED_LEVELS[*]})" >&2
    return 65
  }
  export X8_LEVEL

  mkdir -p "$X8_SECRET_DIR" "$X8_TLS_DIR" "$X8_NGINX_RUNTIME_DIR" "$X8_BACKUP_DIR" "$X8_EVIDENCE_DIR"
  chmod 700 "$X8_RUNTIME_DIR" "$X8_SECRET_DIR" "$X8_TLS_DIR" "$X8_NGINX_RUNTIME_DIR" \
    "$X8_BACKUP_DIR" "$X8_EVIDENCE_DIR"

  if [[ ! -f "$X8_GATE_STATE_FILE" ]]; then
    local catalog_default
    catalog_default="$(x8_level_catalog_default "$X8_LEVEL")" || {
      echo "ERROR: failed to resolve catalog gate default for X8_LEVEL=$X8_LEVEL" >&2
      return 65
    }
    write_x8_gate_state "$catalog_default"
  fi
  local gate_state
  gate_state="$(tr -d '\r\n' <"$X8_GATE_STATE_FILE")"
  [[ "$gate_state" == "dry-run" || "$gate_state" == "apply" || "$gate_state" == "closed" ]] || {
    echo "ERROR: corrupt X8 catalog gate state" >&2
    return 65
  }

  export P1_12_COMPOSE_PROJECT="$X8_COMPOSE_PROJECT_NAME"
  export X8_LOCAL_DOMAIN=novel.test
  # RC-9 admin-host isolation (2026-09-03, Owner): the admin backend is a
  # distinct domain from the public site at every X8_LEVEL -- this is a
  # security invariant, not a per-level knob (see
  # docs/operations/PRODUCTION_DOMAIN_2026-09-03.md and src/proxy.ts). Prefix
  # matches CPS's own `zbcwf` admin-subdomain convention. Overridable only
  # for local experimentation; validate_rendered_topology() in
  # scripts/x8-production-like.sh refuses to proceed if it ever equals
  # X8_LOCAL_DOMAIN.
  export X8_ADMIN_DOMAIN="${X8_ADMIN_DOMAIN:-zbcwf.novel.test}"
  export ADMIN_CANONICAL_ORIGIN="https://${X8_ADMIN_DOMAIN}"
  export SITE_URL=https://novel.test
  export TZ=Asia/Tokyo
  export MOBOREADER_PREVIEW_SOURCE_APP_CODES=changdu
  export X8_HTTP_PORT="${X8_HTTP_PORT:-80}"
  export X8_HTTPS_PORT="${X8_HTTPS_PORT:-443}"
  export X8_NGINX_IMAGE="${X8_NGINX_IMAGE:-nginx:1.28.0-alpine}"
  export X8_BACKUP_INTERVAL_SECONDS="${X8_BACKUP_INTERVAL_SECONDS:-86400}"
  export X8_BACKUP_RUN_ON_START="${X8_BACKUP_RUN_ON_START:-true}"
  export X8_RUNTIME_DIR X8_SECRET_DIR X8_TLS_DIR X8_NGINX_RUNTIME_DIR X8_BACKUP_DIR X8_EVIDENCE_DIR
  export X8_GATE_STATE_FILE X8_BACKUP_PGPASS_FILE X8_IDENTITY_FILE

  case "$gate_state" in
    dry-run)
      export FEATURE_NOVEL_CATALOG_SYNC=true
      export NOVEL_CATALOG_SYNC_ALLOW_WRITE=false
      ;;
    apply)
      export FEATURE_NOVEL_CATALOG_SYNC=true
      export NOVEL_CATALOG_SYNC_ALLOW_WRITE=true
      ;;
    closed)
      export FEATURE_NOVEL_CATALOG_SYNC=false
      export NOVEL_CATALOG_SYNC_ALLOW_WRITE=false
      ;;
  esac
  # RC-2b: WORKER_TASK_ALLOWLIST and the four other double-gate pairs
  # (promo claim / sitemap / indexnow outbox / indexnow delivery) all come
  # from the single X8_LEVEL table (scripts/lib/x8-levels.json) instead of
  # being hard-coded here — this is the only place their values are set, so
  # X8_LEVEL=0 stays byte-for-byte what this file exported before RC-2b.
  local level_config level_key level_value
  level_config="$(x8_level_config "$X8_LEVEL")" || {
    echo "ERROR: failed to resolve X8_LEVEL configuration for '$X8_LEVEL'" >&2
    return 65
  }
  while IFS='=' read -r level_key level_value; do
    [[ -n "$level_key" ]] || continue
    export "$level_key=$level_value"
  done <<<"$level_config"

  prepare_p1_12_local_environment

  if [[ ! -f "$X8_BACKUP_PGPASS_FILE" ]]; then
    local backup_password temporary
    backup_password="$(read_secret_value "$P1_12_BACKUP_ROLE_PASSWORD_FILE")"
    temporary="${X8_BACKUP_PGPASS_FILE}.tmp.$$"
    printf 'postgres:5432:cps_novel:backup_role:%s\n' "$backup_password" >"$temporary"
    chmod 600 "$temporary"
    mv "$temporary" "$X8_BACKUP_PGPASS_FILE"
  fi
}
