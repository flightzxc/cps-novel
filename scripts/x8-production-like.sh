#!/usr/bin/env bash
set -euo pipefail
set +x

X8_SCRIPT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/x8-production-like-env.sh
source "$X8_SCRIPT_ROOT/scripts/lib/x8-production-like-env.sh"

usage() {
  printf '%s\n' \
    'usage: scripts/x8-production-like.sh setup' \
    '       scripts/x8-production-like.sh up' \
    '       scripts/x8-production-like.sh down [--purge]' \
    '       scripts/x8-production-like.sh status' \
    '       scripts/x8-production-like.sh gate catalog-write <on|off|dry-run|status>' \
    '       scripts/x8-production-like.sh backup-now' \
    '       scripts/x8-production-like.sh restore-smoke' \
    '       scripts/x8-production-like.sh catalog-one --task-id <uuid> --item-id <uuid> --actor <operator-handle>' \
    '       scripts/x8-production-like.sh preview-one --task-id <uuid> --item-id <uuid> --actor <operator-handle>' \
    '       scripts/x8-production-like.sh promo-fixture --source-item <id> --channel-account <id> --target-url <url> [--apply]' \
    '       scripts/x8-production-like.sh health-sql' \
    '       scripts/x8-production-like.sh verify' \
    '       scripts/x8-production-like.sh accept' \
    '       scripts/x8-production-like.sh admin-secret set <admin|admin2>' \
    '       scripts/x8-production-like.sh admin-seed [--reset-password]' \
    '       scripts/x8-production-like.sh admin-reset <username> [--deactivate] [--apply] [--break-glass] [--ip <ip>]' \
    '' \
    'env: X8_LEVEL=0|uat|r (default 0) selects the WORKER_TASK_ALLOWLIST /' \
    '     double-gate rung from scripts/lib/x8-levels.json; invalid values' \
    '     fail fast in prepare_x8_environment().' >&2
  exit 64
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required command is unavailable: $1" >&2
    exit 69
  }
}

x8_compose() {
  docker compose \
    -p "$P1_12_COMPOSE_PROJECT" \
    -f "$X8_PROJECT_ROOT/docker-compose.yml" \
    -f "$X8_PROJECT_ROOT/infra/production-like/docker-compose.yml" \
    "$@"
}

host_entry_exists() {
  awk '$1 == "127.0.0.1" { for (i = 2; i <= NF; i++) if ($i == "novel.test") found = 1 } END { exit !found }' \
    /etc/hosts
}

# RC-9: mirrors host_entry_exists()'s literal-domain style deliberately --
# setup_x8() runs before prepare_x8_environment(), so X8_ADMIN_DOMAIN is not
# yet exported at that call site either.
admin_host_entry_exists() {
  awk '$1 == "127.0.0.1" { for (i = 2; i <= NF; i++) if ($i == "zbcwf.novel.test") found = 1 } END { exit !found }' \
    /etc/hosts
}

setup_x8() {
  require_command brew
  require_command sudo
  if ! command -v mkcert >/dev/null 2>&1; then
    echo "Installing mkcert with Homebrew (one-time host change)."
    brew install mkcert
  fi
  echo "Installing/trusting the mkcert local CA (Keychain authorization may be requested)."
  mkcert -install
  if ! host_entry_exists; then
    echo "Adding the marked novel.test entry to /etc/hosts (sudo authorization may be requested)."
    printf '%s\n' '127.0.0.1 novel.test # cps-novel-x8-local' | sudo tee -a /etc/hosts >/dev/null
  fi
  host_entry_exists || { echo "ERROR: novel.test was not added to /etc/hosts" >&2; exit 1; }
  # RC-9 admin-host isolation: a distinct admin domain so src/proxy.ts and
  # the admin nginx server block have somewhere real to isolate onto.
  if ! admin_host_entry_exists; then
    echo "Adding the marked zbcwf.novel.test entry to /etc/hosts (sudo authorization may be requested)."
    printf '%s\n' '127.0.0.1 zbcwf.novel.test # cps-novel-x8-local' | sudo tee -a /etc/hosts >/dev/null
  fi
  admin_host_entry_exists || { echo "ERROR: zbcwf.novel.test was not added to /etc/hosts" >&2; exit 1; }
  echo "X8_HOST_SETUP=PASS"
}

render_nginx_configs() {
  local source_dir="$X8_PROJECT_ROOT/infra/production-like/nginx"
  sed -e "s/__X8_DOMAIN__/$X8_LOCAL_DOMAIN/g" -e "s/__X8_ADMIN_DOMAIN__/$X8_ADMIN_DOMAIN/g" \
    "$source_dir/bootstrap.conf.template" >"$X8_NGINX_RUNTIME_DIR/bootstrap.conf"
  sed -e "s/__X8_DOMAIN__/$X8_LOCAL_DOMAIN/g" -e "s/__X8_ADMIN_DOMAIN__/$X8_ADMIN_DOMAIN/g" \
    "$source_dir/full.conf.template" >"$X8_NGINX_RUNTIME_DIR/full.conf"
  chmod 600 "$X8_NGINX_RUNTIME_DIR/bootstrap.conf" "$X8_NGINX_RUNTIME_DIR/full.conf"
  grep -F -e '__X8_DOMAIN__' -e '__X8_ADMIN_DOMAIN__' \
    "$X8_NGINX_RUNTIME_DIR/bootstrap.conf" "$X8_NGINX_RUNTIME_DIR/full.conf" >/dev/null 2>&1 && {
    echo "ERROR: unresolved nginx template token" >&2
    exit 65
  }
  return 0
}

validate_rendered_topology() {
  [[ "$P1_12_COMPOSE_PROJECT" == "cps-novel-x8-local" ]] || {
    echo "ERROR: X8 compose project drift" >&2
    exit 65
  }
  [[ "$SITE_URL" == "https://novel.test" ]] || {
    echo "ERROR: X8 public origin drift" >&2
    exit 65
  }
  [[ "$ADMIN_CANONICAL_ORIGIN" == "https://${X8_ADMIN_DOMAIN}" ]] || {
    echo "ERROR: X8 admin origin drift" >&2
    exit 65
  }
  # RC-9 admin-host isolation is a security invariant, not a rendering
  # nicety: refuse to proceed at all if the admin and public hosts were ever
  # made to collide, rather than silently booting a topology src/proxy.ts
  # would then have to fail closed against on every single request.
  [[ "$X8_ADMIN_DOMAIN" != "$X8_LOCAL_DOMAIN" ]] || {
    echo "ERROR: X8 admin/public host collision (X8_ADMIN_DOMAIN must differ from X8_LOCAL_DOMAIN)" >&2
    exit 65
  }
  # RC-2b: the expected allowlist depends on X8_LEVEL (0/uat/r); both this
  # exact-match assertion and the value prepare_x8_environment() exported
  # come from the same table (scripts/lib/x8-levels.json), so they can only
  # disagree if WORKER_TASK_ALLOWLIST was tampered with after export.
  local expected_allowlist
  expected_allowlist="$(x8_expected_worker_allowlist "$X8_LEVEL")" || {
    echo "ERROR: unable to resolve expected worker allowlist for X8_LEVEL=$X8_LEVEL" >&2
    exit 65
  }
  [[ "$WORKER_TASK_ALLOWLIST" == "$expected_allowlist" ]] || {
    echo "ERROR: X8 worker allowlist drift for X8_LEVEL=$X8_LEVEL: expected '$expected_allowlist', got '$WORKER_TASK_ALLOWLIST'" >&2
    exit 65
  }
  grep -RInE 'proxy_ignore_headers|server_name[[:space:]]+[^;]*drama' \
    "$X8_PROJECT_ROOT/infra/production-like/nginx" "$X8_NGINX_RUNTIME_DIR" >/dev/null 2>&1 && {
    echo "ERROR: forbidden nginx production-like pattern detected" >&2
    exit 65
  }
  x8_compose config --format json | node "$X8_PROJECT_ROOT/scripts/acceptance/x8-validate-compose.mjs"
}

nginx_is_running() {
  local container_id
  container_id="$(x8_compose ps -q nginx 2>/dev/null || true)"
  [[ -n "$container_id" ]] && [[ "$(docker inspect -f '{{.State.Running}}' "$container_id" 2>/dev/null || true)" == "true" ]]
}

assert_ports_available() {
  nginx_is_running && return 0
  require_command lsof
  local port
  for port in "$X8_HTTP_PORT" "$X8_HTTPS_PORT"; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | grep -q .; then
      echo "ERROR: TCP port $port is already in use; refusing to stop or replace its owner" >&2
      exit 69
    fi
  done
}

build_app_image() {
  if docker image inspect "$CPS_NOVEL_APP_IMAGE" >/dev/null 2>&1; then
    local identity
    identity="$(docker image inspect "$CPS_NOVEL_APP_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.version"}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "org.opencontainers.image.created"}}')"
    [[ "$identity" == "$APP_VERSION|$GIT_COMMIT|$BUILD_DATE" ]] || {
      echo "ERROR: existing X8 app image tag has mismatched immutable metadata" >&2
      exit 65
    }
  else
    x8_compose build web
  fi
}

wait_for_postgres() {
  local ready=no
  for _ in $(seq 1 60); do
    if x8_compose exec -T postgres pg_isready -U postgres -d cps_novel >/dev/null 2>&1; then
      ready=yes
      break
    fi
    sleep 1
  done
  [[ "$ready" == "yes" ]] || { echo "ERROR: X8 PostgreSQL did not become ready" >&2; exit 1; }
}

prepare_database() {
  x8_compose up -d postgres
  wait_for_postgres
  x8_compose exec -T postgres psql --no-psqlrc -v ON_ERROR_STOP=1 -U postgres -d cps_novel \
    --file /opt/cps-novel-postgres/roles.sql >/dev/null
  local role
  for role in migration_owner web_app worker_app scheduler_app analyst_ro backup_role; do
    x8_compose exec -T postgres psql --no-psqlrc -U postgres -d cps_novel \
      --tuples-only --no-align --command="SELECT 1 FROM pg_roles WHERE rolname='${role}'" \
      | grep -Fx 1 >/dev/null || {
        echo "ERROR: required X8 PostgreSQL role is missing: $role" >&2
        exit 1
      }
  done

  local migration_env
  migration_env="$(mktemp "$X8_RUNTIME_DIR/migrate.XXXXXX")"
  chmod 600 "$migration_env"
  printf 'DATABASE_URL=%s\n' "$P1_12_MIGRATION_DATABASE_URL" >"$migration_env"
  local migration_status=0
  docker run --rm --pull never \
    --network cps_novel_x8_runtime \
    --env-file "$migration_env" \
    --entrypoint npx \
    "$CPS_NOVEL_APP_IMAGE" \
    --no-install prisma migrate deploy || migration_status=$?
  rm -f "$migration_env"
  [[ "$migration_status" -eq 0 ]] || return "$migration_status"

  # grants.sql revokes privileges across the whole public schema. On repeat
  # launches, that includes postgres-owned extension functions, so the
  # operation must run as the bootstrap superuser to remain idempotent.
  x8_compose exec -T postgres psql --no-psqlrc -v ON_ERROR_STOP=1 -U postgres -d cps_novel \
    <"$X8_PROJECT_ROOT/infra/postgres/grants.sql" >/dev/null
  x8_compose exec -T postgres psql --no-psqlrc -v ON_ERROR_STOP=1 -U postgres -d cps_novel \
    --command 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements;' >/dev/null
}

wait_for_url() {
  local url="$1"
  local mode="$2"
  # RC-9: defaults to the public domain so every pre-existing call site is
  # unchanged; up_x8()/verify_x8() pass X8_ADMIN_DOMAIN explicitly for the
  # admin-origin probes.
  local domain="${3:-$X8_LOCAL_DOMAIN}"
  local ready=no
  local ca_root=""
  if [[ "$mode" == "https" ]]; then
    ca_root="$(mkcert -CAROOT)/rootCA.pem"
  fi
  for _ in $(seq 1 60); do
    if [[ "$mode" == "https" ]]; then
      if curl --silent --show-error --fail --cacert "$ca_root" --resolve "$domain:443:127.0.0.1" "$url" >/dev/null 2>&1; then
        ready=yes
        break
      fi
    elif curl --silent --show-error --fail --resolve "$domain:80:127.0.0.1" "$url" >/dev/null 2>&1; then
      ready=yes
      break
    fi
    sleep 1
  done
  [[ "$ready" == "yes" ]] || { echo "ERROR: endpoint did not become ready: $url" >&2; exit 1; }
}

ensure_local_certificate() {
  local certificate="$X8_TLS_DIR/novel.test.pem"
  local private_key="$X8_TLS_DIR/novel.test-key.pem"
  # RC-9: reissue if the cert predates the admin SAN too, not only on
  # expiry -- an upgrade from a pre-RC-9 cert must not silently keep serving
  # a certificate the admin server_name can't complete a TLS handshake for.
  if [[ ! -f "$certificate" || ! -f "$private_key" ]] \
    || ! openssl x509 -checkend 604800 -noout -in "$certificate" >/dev/null 2>&1 \
    || ! openssl x509 -noout -ext subjectAltName -in "$certificate" 2>/dev/null | grep -qF "DNS:$X8_ADMIN_DOMAIN"; then
    mkcert -cert-file "$certificate" -key-file "$private_key" novel.test "$X8_ADMIN_DOMAIN" localhost 127.0.0.1 ::1
  fi
  chmod 600 "$certificate" "$private_key"
}

up_x8() {
  prepare_x8_environment
  require_command docker
  require_command node
  require_command curl
  require_command openssl
  require_command mkcert
  host_entry_exists || {
    echo "ERROR: novel.test is absent from /etc/hosts; run scripts/x8-production-like.sh setup" >&2
    exit 69
  }
  admin_host_entry_exists || {
    echo "ERROR: zbcwf.novel.test is absent from /etc/hosts; run scripts/x8-production-like.sh setup" >&2
    exit 69
  }
  [[ -r "$(mkcert -CAROOT)/rootCA.pem" ]] || {
    echo "ERROR: mkcert local CA is not installed; run scripts/x8-production-like.sh setup" >&2
    exit 69
  }
  assert_ports_available
  render_nginx_configs
  validate_rendered_topology
  build_app_image
  prepare_database
  x8_compose up -d web worker scheduler

  cp "$X8_NGINX_RUNTIME_DIR/bootstrap.conf" "$X8_NGINX_RUNTIME_DIR/active.conf"
  chmod 600 "$X8_NGINX_RUNTIME_DIR/active.conf"
  x8_compose up -d --force-recreate nginx
  wait_for_url http://novel.test/api/health http
  wait_for_url "http://$X8_ADMIN_DOMAIN/api/health" http "$X8_ADMIN_DOMAIN"

  ensure_local_certificate
  cp "$X8_NGINX_RUNTIME_DIR/full.conf" "$X8_NGINX_RUNTIME_DIR/active.conf"
  chmod 600 "$X8_NGINX_RUNTIME_DIR/active.conf"
  x8_compose exec -T nginx nginx -t -c /etc/nginx/x8/active.conf
  x8_compose exec -T nginx nginx -s reload -c /etc/nginx/x8/active.conf
  wait_for_url https://novel.test/api/health https
  wait_for_url "https://$X8_ADMIN_DOMAIN/api/health" https "$X8_ADMIN_DOMAIN"

  x8_compose up -d backup-timer

  # RC-11: Level UAT only, and only once both local admin secrets exist --
  # a fresh `setup`+`up` with neither secret set yet must not fail `up`
  # itself, just say so and point at `admin-secret set`.
  if [[ "$X8_LEVEL" == "uat" ]]; then
    if [[ -f "$X8_SECRET_DIR/admin-password" && -f "$X8_SECRET_DIR/admin2-password" ]]; then
      admin_seed
    else
      echo "X8_ADMIN_SEED_SKIPPED=missing local admin secrets; run 'admin-secret set admin' and 'admin-secret set admin2', then 'admin-seed'" >&2
    fi
  fi

  echo "X8_PRODUCTION_LIKE_STARTED=PASS"
  echo "X8_ORIGIN=https://novel.test"
  echo "X8_ADMIN_ORIGIN=https://$X8_ADMIN_DOMAIN"
  echo "X8_COMPOSE_PROJECT=$P1_12_COMPOSE_PROJECT"
}

verify_postgres() {
  x8_compose exec -T postgres /bin/bash <<'POSTGRES_VERIFY'
set -euo pipefail
extension="$(psql --no-psqlrc -U postgres -d cps_novel -Atc "SELECT extname FROM pg_extension WHERE extname='pg_stat_statements'")"
[[ "$extension" == "pg_stat_statements" ]]

verify_role() {
  local role="$1" password_file="$2" expected="$3"
  local password actual
  password="$(tr -d '\r\n' <"$password_file")"
  actual="$(PGPASSWORD="$password" psql --no-psqlrc -h 127.0.0.1 -U "$role" -d cps_novel -Atc \
    "SELECT extract(epoch from current_setting('statement_timeout')::interval)::int || '|' || extract(epoch from current_setting('lock_timeout')::interval)::int || '|' || extract(epoch from current_setting('idle_in_transaction_session_timeout')::interval)::int")"
  [[ "$actual" == "$expected" ]] || {
    echo "ERROR: timeout drift for $role: $actual" >&2
    exit 1
  }
}

verify_role web_app "$P1_12_WEB_APP_PASSWORD_FILE" '30|5|60'
verify_role worker_app "$P1_12_WORKER_APP_PASSWORD_FILE" '300|15|300'
verify_role scheduler_app "$P1_12_SCHEDULER_APP_PASSWORD_FILE" '60|5|60'

analyst_password="$(tr -d '\r\n' <"$P1_12_ANALYST_RO_PASSWORD_FILE")"
analyst_read_only="$(PGPASSWORD="$analyst_password" psql --no-psqlrc -h 127.0.0.1 -U analyst_ro -d cps_novel -Atc 'SHOW default_transaction_read_only')"
[[ "$analyst_read_only" == "on" ]]
echo "X8_POSTGRES_RUNTIME=PASS"
POSTGRES_VERIFY
}

verify_x8() {
  prepare_x8_environment
  require_command curl
  require_command openssl
  render_nginx_configs
  validate_rendered_topology
  local running
  running="$(x8_compose ps --status running --services | sort | tr '\n' ',' | sed 's/,$//')"
  [[ "$running" == "backup-timer,nginx,postgres,scheduler,web,worker" ]] || {
    echo "ERROR: not all X8 services are running: $running" >&2
    exit 1
  }
  x8_compose exec -T nginx nginx -t -c /etc/nginx/x8/active.conf >/dev/null

  local ca_root headers robots sitemap_status redirect_status
  ca_root="$(mkcert -CAROOT)/rootCA.pem"
  headers="$(curl --silent --show-error --cacert "$ca_root" --resolve novel.test:443:127.0.0.1 \
    --dump-header - --output /dev/null https://novel.test/api/health)"
  grep -qi '^strict-transport-security: max-age=31536000' <<<"$headers"
  grep -qi '^x-content-type-options: nosniff' <<<"$headers"
  grep -qi '^cache-control: no-store' <<<"$headers"

  redirect_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --resolve novel.test:80:127.0.0.1 http://novel.test/api/health)"
  [[ "$redirect_status" == "308" ]]
  robots="$(curl --silent --show-error --fail --cacert "$ca_root" --resolve novel.test:443:127.0.0.1 \
    https://novel.test/robots.txt)"
  grep -F 'https://novel.test/sitemap.xml' <<<"$robots" >/dev/null
  sitemap_status="$(curl --silent --show-error --cacert "$ca_root" --resolve novel.test:443:127.0.0.1 \
    --output /dev/null --write-out '%{http_code}' https://novel.test/sitemap.xml)"
  [[ "$sitemap_status" == "503" ]]

  openssl s_client -connect 127.0.0.1:443 -servername novel.test </dev/null 2>/dev/null \
    | openssl x509 -noout -ext subjectAltName | grep -F 'DNS:novel.test' >/dev/null
  grep -F 'proxy_set_header X-Forwarded-For $remote_addr;' \
    "$X8_PROJECT_ROOT/infra/production-like/nginx/snippets/proxy-headers.conf" >/dev/null

  # RC-9 admin-host isolation (2026-09-03, Owner): the admin origin serves
  # /login and /api/health but 404s the public home page; the public origin
  # 404s /login but serves /. This is the exact inversion of the CPS
  # short-drama site's flagged defect (its public domain opens its admin
  # login page) -- verify it end to end, not just that the two nginx server
  # blocks parsed.
  local admin_login_status public_login_status admin_home_status admin_health_status
  openssl s_client -connect 127.0.0.1:443 -servername "$X8_ADMIN_DOMAIN" </dev/null 2>/dev/null \
    | openssl x509 -noout -ext subjectAltName | grep -F "DNS:$X8_ADMIN_DOMAIN" >/dev/null
  admin_login_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --cacert "$ca_root" \
    --resolve "$X8_ADMIN_DOMAIN:443:127.0.0.1" "https://$X8_ADMIN_DOMAIN/login")"
  [[ "$admin_login_status" == "200" ]] || {
    echo "ERROR: admin host did not serve /login (got $admin_login_status)" >&2
    exit 1
  }
  public_login_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --cacert "$ca_root" \
    --resolve novel.test:443:127.0.0.1 https://novel.test/login)"
  [[ "$public_login_status" == "404" ]] || {
    echo "ERROR: public host did not 404 /login (got $public_login_status) -- this is the CPS defect" >&2
    exit 1
  }
  admin_home_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --cacert "$ca_root" \
    --resolve "$X8_ADMIN_DOMAIN:443:127.0.0.1" "https://$X8_ADMIN_DOMAIN/")"
  [[ "$admin_home_status" == "404" ]] || {
    echo "ERROR: admin host served the public home page (got $admin_home_status)" >&2
    exit 1
  }
  admin_health_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --cacert "$ca_root" \
    --resolve "$X8_ADMIN_DOMAIN:443:127.0.0.1" "https://$X8_ADMIN_DOMAIN/api/health")"
  [[ "$admin_health_status" == "200" ]] || {
    echo "ERROR: admin host did not serve /api/health (got $admin_health_status)" >&2
    exit 1
  }

  verify_postgres
  echo "X8_TOPOLOGY_VERIFY=PASS"
}

backup_now() {
  prepare_x8_environment
  x8_compose run --rm --no-deps backup-timer \
    /bin/bash /opt/cps-novel-x8/backup-timer.sh --once
}

restore_smoke() {
  prepare_x8_environment
  local latest container_id container_path
  latest="$(find "$X8_BACKUP_DIR" -maxdepth 1 -type f -name '*.dump' -print | sort | tail -1)"
  [[ -n "$latest" ]] || { echo "ERROR: no X8 logical backup is available" >&2; exit 1; }
  container_id="$(x8_compose ps -q postgres)"
  [[ -n "$container_id" ]] || { echo "ERROR: X8 postgres is not running" >&2; exit 1; }
  container_path=/tmp/cps-novel-x8-restore-smoke.dump
  docker cp "$latest" "$container_id:$container_path" >/dev/null
  x8_compose exec -T postgres /bin/bash <<'RESTORE_SMOKE'
set -euo pipefail
database=cps_novel_x8_restore_smoke
archive=/tmp/cps-novel-x8-restore-smoke.dump
cleanup() {
  dropdb --if-exists --force -U postgres "$database" >/dev/null 2>&1 || true
  rm -f "$archive"
}

promo_fixture() {
  prepare_x8_environment
  local fixture_env
  fixture_env="$(mktemp "$X8_RUNTIME_DIR/promo-fixture.XXXXXX")"
  chmod 600 "$fixture_env"
  printf 'DATABASE_URL=%s\n' "$P1_12_MIGRATION_DATABASE_URL" >"$fixture_env"
  printf 'SITE_URL=%s\n' "$SITE_URL" >>"$fixture_env"
  printf 'P1_12_COMPOSE_PROJECT=%s\n' "$P1_12_COMPOSE_PROJECT" >>"$fixture_env"
  printf 'FEATURE_PROMO_LINK_CLAIM=false\nPROMO_LINK_CLAIM_ALLOW_WRITE=false\n' >>"$fixture_env"
  printf 'X8_ACCEPTANCE_OPERATOR=%s\n' "${X8_ACCEPTANCE_OPERATOR:-local-x8-operator}" >>"$fixture_env"
  if [[ " $* " == *" --apply "* ]]; then
    printf 'X8_ACCEPTANCE_FIXTURE_ALLOW_WRITE=true\n' >>"$fixture_env"
  fi
  local fixture_status=0
  docker run --rm --pull never --network cps_novel_x8_runtime --env-file "$fixture_env" \
    --entrypoint tsx "$CPS_NOVEL_APP_IMAGE" scripts/x8-promo-fixture.ts "$@" || fixture_status=$?
  rm -f "$fixture_env"
  [[ "$fixture_status" -eq 0 ]] || return "$fixture_status"
}
trap cleanup EXIT INT TERM
dropdb --if-exists --force -U postgres "$database" >/dev/null 2>&1 || true
createdb -U postgres -O migration_owner "$database"
pg_restore --exit-on-error --no-owner --no-acl -U postgres -d "$database" "$archive"
psql --no-psqlrc -U postgres -d "$database" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" \
  | grep -E '^[1-9][0-9]*$' >/dev/null
echo "X8_BACKUP_RESTORE_SMOKE=PASS"
RESTORE_SMOKE
}

run_health_sql() {
  prepare_x8_environment
  x8_compose exec -T postgres /bin/bash <<'HEALTH_SQL'
set -euo pipefail
umask 077
password="$(tr -d '\r\n' <"$P1_12_ANALYST_RO_PASSWORD_FILE")"
pgpass=/tmp/x8-analyst.pgpass
trap 'rm -f "$pgpass"' EXIT INT TERM
printf '127.0.0.1:5432:cps_novel:analyst_ro:%s\n' "$password" >"$pgpass"
chmod 600 "$pgpass"
PGPASSFILE="$pgpass" psql --no-psqlrc -h 127.0.0.1 -U analyst_ro -d cps_novel \
  --file /opt/cps-novel-x8/launch-day-health-checks.sql
echo "X8_LAUNCH_DAY_HEALTH_SQL=PASS"
HEALTH_SQL
}

gate_catalog() {
  [[ "${1:-}" == "catalog-write" ]] || usage
  local action="${2:-}"
  prepare_x8_environment
  case "$action" in
    on) write_x8_gate_state apply ;;
    off) write_x8_gate_state closed ;;
    dry-run) write_x8_gate_state dry-run ;;
    status)
      printf 'X8_CATALOG_GATE=%s\n' "$(tr -d '\r\n' <"$X8_GATE_STATE_FILE")"
      return 0
      ;;
    *) usage ;;
  esac
  prepare_x8_environment
  if [[ -n "$(x8_compose ps -q web 2>/dev/null || true)" ]]; then
    x8_compose up -d --no-deps --force-recreate web worker
  fi
  printf 'X8_CATALOG_GATE=%s\n' "$(tr -d '\r\n' <"$X8_GATE_STATE_FILE")"
}

down_x8() {
  prepare_x8_environment
  [[ "$P1_12_COMPOSE_PROJECT" == "cps-novel-x8-local" ]] || {
    echo "ERROR: refusing down for unexpected compose project" >&2
    exit 65
  }
  case "${1:-}" in
    "") x8_compose down --remove-orphans ;;
    --purge) x8_compose down --remove-orphans --volumes ;;
    *) usage ;;
  esac
}

preview_one() {
  [[ $# -eq 6 ]] || usage
  prepare_x8_environment
  validate_rendered_topology
  [[ "$FEATURE_NOVEL_CATALOG_SYNC" == "true" && "$NOVEL_CATALOG_SYNC_ALLOW_WRITE" == "true" ]] || {
    echo "ERROR: preview-one requires the explicit catalog apply window" >&2
    return 65
  }
  local web_container operator_image
  web_container="$(x8_compose ps -q web 2>/dev/null || true)"
  [[ -n "$web_container" ]] || { echo "ERROR: preview-one requires the verified web service image" >&2; return 65; }
  operator_image="$(docker inspect --format '{{.Config.Image}}' "$web_container")"
  # Only this disposable worker may consume preview. The six-service topology
  # and its permanent Level 0 allowlist remain unchanged.
  CPS_NOVEL_APP_IMAGE="$operator_image" x8_compose run --rm --no-deps -T \
    -e P1_12_COMPOSE_PROJECT \
    -e WORKER_TASK_ALLOWLIST=moboreader.preview_refresh.v1 \
    -v "$X8_PROJECT_ROOT/scripts/x8-preview-one.ts:/app/scripts/x8-preview-one.ts:ro" \
    -v "$X8_PROJECT_ROOT/src/lib/adapters/moboreader.ts:/app/src/lib/adapters/moboreader.ts:ro" \
    worker tsx scripts/x8-preview-one.ts "$@"
}

catalog_one() {
  [[ $# -eq 6 ]] || usage
  prepare_x8_environment
  validate_rendered_topology
  [[ "$FEATURE_NOVEL_CATALOG_SYNC" == "true" && "$NOVEL_CATALOG_SYNC_ALLOW_WRITE" == "true" ]] || {
    echo "ERROR: catalog-one requires the explicit catalog apply window" >&2
    return 65
  }
  [[ -z "$(x8_compose ps -q worker 2>/dev/null || true)" ]] || {
    echo "ERROR: catalog-one requires the permanent worker to be stopped" >&2
    return 65
  }
  local web_container operator_image
  web_container="$(x8_compose ps -q web 2>/dev/null || true)"
  [[ -n "$web_container" ]] || { echo "ERROR: catalog-one requires the verified web service image" >&2; return 65; }
  operator_image="$(docker inspect --format '{{.Config.Image}}' "$web_container")"
  CPS_NOVEL_APP_IMAGE="$operator_image" x8_compose run --rm --no-deps -T \
    -e P1_12_COMPOSE_PROJECT \
    -e WORKER_TASK_ALLOWLIST=catalog_scan \
    -v "$X8_PROJECT_ROOT/scripts/x8-catalog-one.ts:/app/scripts/x8-catalog-one.ts:ro" \
    -v "$X8_PROJECT_ROOT/src/lib/adapters/moboreader.ts:/app/src/lib/adapters/moboreader.ts:ro" \
    worker tsx scripts/x8-catalog-one.ts "$@"
}

# RC-11: writes a local X8 admin login password to a 0600 secret file, read
# silently from stdin (never argv, never echoed, never logged) -- same
# never-in-argv discipline `scripts/ensure-local-admin-identities.ts`'s own
# docstring documents. `admin_seed()` reads the two files this writes;
# neither this function nor its caller ever prints the password back out.
admin_secret_set() {
  [[ $# -eq 1 ]] || usage
  local user="$1"
  case "$user" in
    admin | admin2) : ;;
    *) echo "ERROR: admin-secret set requires user 'admin' or 'admin2'" >&2; exit 64 ;;
  esac
  prepare_x8_environment
  local secret_file="$X8_SECRET_DIR/${user}-password"
  local password="" confirm=""
  read -r -s -p "Enter local X8 UAT password for '$user' (never production): " password
  printf '\n' >&2
  read -r -s -p "Confirm: " confirm
  printf '\n' >&2
  if [[ -z "$password" || "$password" != "$confirm" ]]; then
    unset password confirm
    echo "ERROR: password was empty or the two entries did not match" >&2
    exit 65
  fi
  local temporary="${secret_file}.tmp.$$"
  printf '%s' "$password" >"$temporary"
  unset password confirm
  chmod 600 "$temporary"
  mv "$temporary" "$secret_file"
  echo "X8_ADMIN_SECRET_SET=$user"
}

# RC-11: seeds (or, with --reset-password, updates the password hash for)
# the two X8 Level UAT fixture accounts `admin`/`admin2` by running
# scripts/ensure-local-admin-identities.ts inside the already-built `web`
# image. Level UAT only -- that script's own ADMIN_LOCAL_IDENTITY_SEED gate
# is the authoritative fail-closed check; this function's X8_LEVEL guard is
# a fast, friendlier failure before even reading the secret files.
#
# Runs against $P1_12_MIGRATION_DATABASE_URL (not the narrower
# $P1_12_WEB_DATABASE_URL web_app normally gets), the same migration-role
# connection prepare_database() uses for `prisma migrate deploy` --
# web_app's grants (infra/postgres/grants.sql) do not include DELETE on
# admin_two_factor_challenge, which admin-reset (below) needs.
admin_seed() {
  [[ $# -le 1 ]] || usage
  case "${1:-}" in
    "" | --reset-password) : ;;
    *) usage ;;
  esac
  prepare_x8_environment
  [[ "$X8_LEVEL" == "uat" ]] || {
    echo "ERROR: admin-seed is Level UAT only (current X8_LEVEL=$X8_LEVEL)" >&2
    return 65
  }
  local admin_secret="$X8_SECRET_DIR/admin-password"
  local admin2_secret="$X8_SECRET_DIR/admin2-password"
  if [[ ! -f "$admin_secret" || ! -f "$admin2_secret" ]]; then
    echo "ERROR: missing local admin secret file(s); run:" >&2
    echo "  scripts/x8-production-like.sh admin-secret set admin" >&2
    echo "  scripts/x8-production-like.sh admin-secret set admin2" >&2
    return 65
  fi
  local web_container operator_image
  web_container="$(x8_compose ps -q web 2>/dev/null || true)"
  [[ -n "$web_container" ]] || {
    echo "ERROR: admin-seed requires the verified web service image (run 'up' first)" >&2
    return 65
  }
  operator_image="$(docker inspect --format '{{.Config.Image}}' "$web_container")"

  # Env-file, not `-e`, for the two passwords and the migration DATABASE_URL
  # -- same reasoning as prepare_database()'s migrate-deploy invocation:
  # `docker compose run -e VAR=value` would put the value on the process
  # argv `ps` can see; `--env-from-file` never does.
  local seed_env
  seed_env="$(mktemp "$X8_RUNTIME_DIR/admin-seed.XXXXXX")"
  chmod 600 "$seed_env"
  {
    printf 'DATABASE_URL=%s\n' "$P1_12_MIGRATION_DATABASE_URL"
    printf 'ADMIN_LOCAL_IDENTITY_SEED=%s\n' "$ADMIN_LOCAL_IDENTITY_SEED"
    printf 'X8_ADMIN_PASSWORD=%s\n' "$(read_secret_value "$admin_secret")"
    printf 'X8_ADMIN2_PASSWORD=%s\n' "$(read_secret_value "$admin2_secret")"
  } >"$seed_env"
  chmod 600 "$seed_env"

  local status=0
  CPS_NOVEL_APP_IMAGE="$operator_image" x8_compose run --rm --no-deps -T \
    --env-from-file "$seed_env" \
    web tsx scripts/ensure-local-admin-identities.ts "$@" || status=$?
  rm -f "$seed_env"
  return "$status"
}

# RC-11 — the X8-local convenience wrapper around
# scripts/reset-admin-auth-state.ts's audited reset. Runs inside the `web`
# image against $P1_12_MIGRATION_DATABASE_URL for the same reason admin_seed
# does (web_app lacks DELETE on admin_two_factor_challenge). `--reason` and
# `--request-id` are auto-derived here so the common local recovery case is
# one command; `RESET_ADMIN_OPERATOR` defaults to a fixed local handle but
# honors an already-exported value.
admin_reset() {
  [[ $# -ge 1 ]] || usage
  local user="$1"
  shift
  local script_args=(--username "$user"
    --reason "X8 local admin auth-state reset via scripts/x8-production-like.sh admin-reset"
    --request-id "x8-admin-reset-${user}-$(date -u '+%Y%m%dT%H%M%SZ')")
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --deactivate | --apply | --break-glass) script_args+=("$1"); shift ;;
      --ip) [[ $# -ge 2 ]] || usage; script_args+=(--ip "$2"); shift 2 ;;
      *) usage ;;
    esac
  done

  prepare_x8_environment
  local web_container operator_image
  web_container="$(x8_compose ps -q web 2>/dev/null || true)"
  [[ -n "$web_container" ]] || {
    echo "ERROR: admin-reset requires the verified web service image (run 'up' first)" >&2
    return 65
  }
  operator_image="$(docker inspect --format '{{.Config.Image}}' "$web_container")"

  local reset_env
  reset_env="$(mktemp "$X8_RUNTIME_DIR/admin-reset.XXXXXX")"
  chmod 600 "$reset_env"
  {
    printf 'DATABASE_URL=%s\n' "$P1_12_MIGRATION_DATABASE_URL"
    printf 'RESET_ADMIN_OPERATOR=%s\n' "${RESET_ADMIN_OPERATOR:-x8-local-operator}"
  } >"$reset_env"
  chmod 600 "$reset_env"

  local status=0
  CPS_NOVEL_APP_IMAGE="$operator_image" x8_compose run --rm --no-deps -T \
    --env-from-file "$reset_env" \
    web tsx scripts/reset-admin-auth-state.ts "${script_args[@]}" || status=$?
  rm -f "$reset_env"
  return "$status"
}

accept_x8() {
  prepare_x8_environment
  local evidence="$X8_EVIDENCE_DIR/automated-acceptance-$(date -u '+%Y%m%dT%H%M%SZ').log"
  {
    printf 'X8_ACCEPTANCE_STARTED_AT=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf 'X8_GIT_COMMIT=%s\n' "$GIT_COMMIT"
    verify_x8
    "$X8_PROJECT_ROOT/scripts/x8-limiters-smoke.sh"
    backup_now
    restore_smoke
    run_health_sql
    printf 'X8_AUTOMATED_ACCEPTANCE=PASS\n'
  } | tee "$evidence"
  chmod 600 "$evidence"
  echo "X8_ACCEPTANCE_EVIDENCE=$evidence"
}

command="${1:-}"
case "$command" in
  setup) [[ $# -eq 1 ]] || usage; setup_x8 ;;
  up) [[ $# -eq 1 ]] || usage; up_x8 ;;
  down) shift; [[ $# -le 1 ]] || usage; down_x8 "${1:-}" ;;
  status) [[ $# -eq 1 ]] || usage; prepare_x8_environment; x8_compose ps ;;
  gate) shift; [[ $# -eq 2 ]] || usage; gate_catalog "$@" ;;
  backup-now) [[ $# -eq 1 ]] || usage; backup_now ;;
  restore-smoke) [[ $# -eq 1 ]] || usage; restore_smoke ;;
  catalog-one) shift; catalog_one "$@" ;;
  preview-one) shift; preview_one "$@" ;;
  promo-fixture) shift; [[ $# -ge 6 ]] || usage; promo_fixture "$@" ;;
  health-sql) [[ $# -eq 1 ]] || usage; run_health_sql ;;
  verify) [[ $# -eq 1 ]] || usage; verify_x8 ;;
  accept) [[ $# -eq 1 ]] || usage; accept_x8 ;;
  admin-secret) shift; [[ $# -eq 2 && "${1:-}" == "set" ]] || usage; shift; admin_secret_set "$@" ;;
  admin-seed) shift; admin_seed "$@" ;;
  admin-reset) shift; [[ $# -ge 1 ]] || usage; admin_reset "$@" ;;
  *) usage ;;
esac
