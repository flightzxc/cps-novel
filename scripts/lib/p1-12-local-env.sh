#!/usr/bin/env bash

set -euo pipefail
set +x

P1_12_PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
P1_12_RUNTIME_DIR="$P1_12_PROJECT_ROOT/.tmp/p1-12-runtime"
P1_12_SECRET_DIR="$P1_12_RUNTIME_DIR/secrets"

write_secret_once() {
  local path="$1"
  local kind="$2"
  [[ -f "$path" ]] && return 0
  local temporary="${path}.tmp.$$"
  if [[ "$kind" == "hex" ]]; then
    openssl rand -hex 24 >"$temporary"
  else
    openssl rand -base64 32 | tr -d '\r\n' >"$temporary"
    printf '\n' >>"$temporary"
  fi
  chmod 600 "$temporary"
  mv "$temporary" "$path"
}

read_secret_value() {
  tr -d '\r\n' <"$1"
}

prepare_p1_12_local_environment() {
  command -v git >/dev/null 2>&1 || { echo "ERROR: git is required" >&2; return 1; }
  command -v node >/dev/null 2>&1 || { echo "ERROR: node is required" >&2; return 1; }
  command -v openssl >/dev/null 2>&1 || { echo "ERROR: openssl is required" >&2; return 1; }

  mkdir -p "$P1_12_SECRET_DIR"
  chmod 700 "$P1_12_RUNTIME_DIR" "$P1_12_SECRET_DIR"

  local secret
  for secret in postgres_admin migration_owner web_app worker_app scheduler_app analyst_ro backup_role; do
    write_secret_once "$P1_12_SECRET_DIR/${secret}.password" hex
  done
  write_secret_once "$P1_12_SECRET_DIR/totp.key" base64
  write_secret_once "$P1_12_SECRET_DIR/credential-v1.key" base64
  write_secret_once "$P1_12_SECRET_DIR/credential-fingerprint.key" base64

  export P1_12_POSTGRES_ADMIN_PASSWORD_FILE="$P1_12_SECRET_DIR/postgres_admin.password"
  export P1_12_MIGRATION_OWNER_PASSWORD_FILE="$P1_12_SECRET_DIR/migration_owner.password"
  export P1_12_WEB_APP_PASSWORD_FILE="$P1_12_SECRET_DIR/web_app.password"
  export P1_12_WORKER_APP_PASSWORD_FILE="$P1_12_SECRET_DIR/worker_app.password"
  export P1_12_SCHEDULER_APP_PASSWORD_FILE="$P1_12_SECRET_DIR/scheduler_app.password"
  export P1_12_ANALYST_RO_PASSWORD_FILE="$P1_12_SECRET_DIR/analyst_ro.password"
  export P1_12_BACKUP_ROLE_PASSWORD_FILE="$P1_12_SECRET_DIR/backup_role.password"

  local migration_password web_password worker_password scheduler_password
  migration_password="$(read_secret_value "$P1_12_MIGRATION_OWNER_PASSWORD_FILE")"
  web_password="$(read_secret_value "$P1_12_WEB_APP_PASSWORD_FILE")"
  worker_password="$(read_secret_value "$P1_12_WORKER_APP_PASSWORD_FILE")"
  scheduler_password="$(read_secret_value "$P1_12_SCHEDULER_APP_PASSWORD_FILE")"

  export P1_12_MIGRATION_DATABASE_URL="postgresql://migration_owner:${migration_password}@postgres:5432/cps_novel?schema=public"
  export P1_12_WEB_DATABASE_URL="postgresql://web_app:${web_password}@postgres:5432/cps_novel?schema=public"
  export P1_12_WORKER_DATABASE_URL="postgresql://worker_app:${worker_password}@postgres:5432/cps_novel?schema=public"
  export P1_12_SCHEDULER_DATABASE_URL="postgresql://scheduler_app:${scheduler_password}@postgres:5432/cps_novel?schema=public"
  export TOTP_ENCRYPTION_KEY="$(read_secret_value "$P1_12_SECRET_DIR/totp.key")"
  export CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1="$(read_secret_value "$P1_12_SECRET_DIR/credential-v1.key")"
  export CHANNEL_CREDENTIAL_FINGERPRINT_KEY="$(read_secret_value "$P1_12_SECRET_DIR/credential-fingerprint.key")"

  export P1_12_COMPOSE_PROJECT="${P1_12_COMPOSE_PROJECT:-cps-novel-p1-12}"
  export APP_VERSION="$(node -p 'require(process.argv[1]).version' "$P1_12_PROJECT_ROOT/package.json")"
  export GIT_COMMIT="$(git -C "$P1_12_PROJECT_ROOT" rev-parse HEAD)"
  local build_date_file="$P1_12_RUNTIME_DIR/build-date-${GIT_COMMIT}.txt"
  if [[ ! -f "$build_date_file" ]]; then
    date -u +%Y-%m-%dT%H:%M:%SZ >"$build_date_file"
    chmod 600 "$build_date_file"
  fi
  export BUILD_DATE="$(tr -d '\r\n' <"$build_date_file")"
  export CPS_NOVEL_APP_IMAGE="cps-novel:${APP_VERSION}-${GIT_COMMIT:0:7}"
  export ADMIN_CANONICAL_ORIGIN="${ADMIN_CANONICAL_ORIGIN:-http://127.0.0.1:${P1_12_WEB_PORT:-3000}}"
}
