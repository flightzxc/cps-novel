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

warn_x8_gate_drift() {
  local expected actual
  [[ "$X8_LEVEL" == "uat" || "$X8_LEVEL" == "r" ]] || return 0
  expected="$(x8_level_catalog_default "$X8_LEVEL")"
  actual="$(tr -d '\r\n' <"$X8_GATE_STATE_FILE")"
  [[ "$actual" == "$expected" ]] && return 0
  printf '%s\n' \
    "WARNING: X8 catalog-write gate drift: level=$X8_LEVEL expected=$expected actual=$actual" \
    "Repair explicitly (state is not overwritten): scripts/x8-production-like.sh gate catalog-write on" >&2
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

  export P1_12_COMPOSE_PROJECT=cps-novel-x8-local
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
  export X8_GATE_STATE_FILE X8_BACKUP_PGPASS_FILE

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
  # RC-2b: WORKER_TASK_ALLOWLIST and the double-gate pairs (promo claim /
  # sitemap / indexnow outbox / indexnow delivery) all come from the single
  # X8_LEVEL table (scripts/lib/x8-levels.json) instead of being hard-coded
  # here — this is the only place their values are set, so X8_LEVEL=0 stays
  # byte-for-byte what this file exported before RC-2b. PR6 lane F added the
  # P2-06.5 tagging double-gate (FEATURE_P2_06_5_TAGGING /
  # FEATURE_P2_06_5_TAG_ADMIN_WRITE) and the auto-classify pair
  # (FEATURE_NOVEL_TAG_AUTO / AUTO_WRITE_AUTHORIZED) to the same table's
  # `flags` object — this loop exports whatever keys that object has, so no
  # change was needed here beyond this comment.
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
