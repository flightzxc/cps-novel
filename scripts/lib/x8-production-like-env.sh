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

prepare_x8_environment() {
  mkdir -p "$X8_SECRET_DIR" "$X8_TLS_DIR" "$X8_NGINX_RUNTIME_DIR" "$X8_BACKUP_DIR" "$X8_EVIDENCE_DIR"
  chmod 700 "$X8_RUNTIME_DIR" "$X8_SECRET_DIR" "$X8_TLS_DIR" "$X8_NGINX_RUNTIME_DIR" \
    "$X8_BACKUP_DIR" "$X8_EVIDENCE_DIR"

  if [[ ! -f "$X8_GATE_STATE_FILE" ]]; then
    write_x8_gate_state dry-run
  fi
  local gate_state
  gate_state="$(tr -d '\r\n' <"$X8_GATE_STATE_FILE")"
  [[ "$gate_state" == "dry-run" || "$gate_state" == "apply" || "$gate_state" == "closed" ]] || {
    echo "ERROR: corrupt X8 catalog gate state" >&2
    return 65
  }

  export P1_12_COMPOSE_PROJECT=cps-novel-x8-local
  export X8_LOCAL_DOMAIN=novel.test
  export ADMIN_CANONICAL_ORIGIN=https://novel.test
  export SITE_URL=https://novel.test
  export TZ=Asia/Tokyo
  export WORKER_TASK_ALLOWLIST=credential.validate.v1,credential.supersede.v1,catalog_scan
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
  export FEATURE_PROMO_LINK_CLAIM=false
  export PROMO_LINK_CLAIM_ALLOW_WRITE=false
  export FEATURE_SITEMAP_AUTO_REFRESH=false
  export SITEMAP_AUTO_REFRESH_ALLOW_WRITE=false
  export FEATURE_INDEXNOW_OUTBOX=false
  export INDEXNOW_OUTBOX_ALLOW_WRITE=false
  export FEATURE_INDEXNOW_DELIVERY=false
  export INDEXNOW_DELIVERY_ALLOW_WRITE=false

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
