#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/cps-compose-identity.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT INT TERM

render_release() {
  local name="$1" dir="$tmp/$1" output="$tmp/$1.yaml"
  mkdir -p "$dir/infra/preproduction"
  cp "$root/docker-compose.yml" "$dir/docker-compose.yml"
  cp "$root/infra/preproduction/docker-compose.yml" "$dir/infra/preproduction/docker-compose.yml"
  (
    cd "$dir"
    env \
      CPS_NOVEL_APP_IMAGE='registry.invalid/cps-novel@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
      APP_VERSION=0.1.0 GIT_COMMIT=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
      BUILD_DATE=2026-09-20T00:00:00Z NEXT_PUBLIC_BUILD_VERSION=v0.1.0 \
      P1_12_COMPOSE_PROJECT=cps-novel SITE_URL=https://www.bangbangji.cloud \
      ADMIN_CANONICAL_ORIGIN=https://zbcwf.bangbangji.cloud TZ=Asia/Tokyo \
      P1_12_WEB_DATABASE_URL=postgresql://web_app:placeholder@postgres/cps_novel \
      P1_12_WORKER_DATABASE_URL=postgresql://worker_app:placeholder@postgres/cps_novel \
      P1_12_SCHEDULER_DATABASE_URL=postgresql://scheduler_app:placeholder@postgres/cps_novel \
      P1_12_POSTGRES_ADMIN_PASSWORD_FILE=/opt/cps-novel/shared/secrets/postgres_admin_password \
      P1_12_MIGRATION_OWNER_PASSWORD_FILE=/opt/cps-novel/shared/secrets/migration_owner_password \
      P1_12_WEB_APP_PASSWORD_FILE=/opt/cps-novel/shared/secrets/web_app_password \
      P1_12_WORKER_APP_PASSWORD_FILE=/opt/cps-novel/shared/secrets/worker_app_password \
      P1_12_SCHEDULER_APP_PASSWORD_FILE=/opt/cps-novel/shared/secrets/scheduler_app_password \
      P1_12_ANALYST_RO_PASSWORD_FILE=/opt/cps-novel/shared/secrets/analyst_ro_password \
      P1_12_BACKUP_ROLE_PASSWORD_FILE=/opt/cps-novel/shared/secrets/backup_role_password \
      CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION=1 \
      CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE=/opt/cps-novel/shared/secrets/channel_credential_encryption_key_v1 \
      CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE=/opt/cps-novel/shared/secrets/channel_credential_fingerprint_key \
      WORKER_TASK_ALLOWLIST=credential.validate.v1 \
      docker compose -p cps-novel -f docker-compose.yml -f infra/preproduction/docker-compose.yml config >"$output"
  )
  grep -E 'name: cps_novel_(runtime|postgres_data|sitemap_static)|source: /opt/cps-novel/shared|target: /var/lib/(postgresql|cps-novel)|host_ip: 127.0.0.1|published: "3000"' \
    "$output" | sort >"$tmp/$name.identity"
  grep -q 'name: cps_novel_runtime' "$output"
  grep -q 'name: cps_novel_postgres_data' "$output"
  grep -q 'name: cps_novel_sitemap_static' "$output"
  grep -q 'host_ip: 127.0.0.1' "$output"
  ! grep -A8 '^    ports:' "$output" | grep -q 'published: "5432"'
}

render_release release-a
render_release release-b
cmp -s "$tmp/release-a.identity" "$tmp/release-b.identity"
echo "COMPOSE_IDENTITY=PASS releases=2"
