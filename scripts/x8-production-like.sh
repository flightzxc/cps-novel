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
    '       scripts/x8-production-like.sh gate catalog-write <on|off|dry-run> [--apply]' \
    '       scripts/x8-production-like.sh gate catalog-write status' \
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
    '     fail fast in prepare_x8_environment(). Only `up` reads X8_LEVEL --' \
    '     `gate catalog-write` reads its run level from the release identity' \
    '     file `up` last wrote (.tmp/x8-production-like/release-identity.json)' \
    '     and fails if that file is missing or does not resolve to a level.' \
    '     `gate catalog-write on|off|dry-run` defaults to plan mode (prints' \
    '     the diff, touches nothing); pass --apply to actually recreate.' >&2
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

# X8 release-identity gate work order (2026-09-05), 施工项一: reads one
# environment variable out of a running (or stopped) container's *actual*
# baked-in Config.Env -- never out of a re-render of persisted config, and
# never out of `docker exec ... env` (which needs the container running).
# Used both by warn_x8_gate_drift() (soft warning, in x8-production-like-env.sh)
# and by the gate command's three-way pre-check below (hard failure). Never
# fails: an unreadable container or an absent key both resolve to "", which
# reliably compares unequal to any real expected value (fail-closed).
x8_container_env_value() {
  local container="$1" key="$2"
  docker inspect --format '{{json .Config.Env}}' "$container" 2>/dev/null | node -e '
    let data = "";
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => {
      const key = process.argv[1];
      let entries = [];
      try { entries = JSON.parse(data); } catch { entries = []; }
      const prefix = `${key}=`;
      const match = Array.isArray(entries) ? entries.find((entry) => typeof entry === "string" && entry.startsWith(prefix)) : undefined;
      process.stdout.write(match ? match.slice(prefix.length) : "");
    });
  ' "$key"
}

# X8 release-identity gate work order (2026-09-05), 施工项一 4.3(四): container
# labels are used ONLY for this front-and-back comparison against the release
# identity file -- never as a source of identity themselves. Any mismatch
# stops the gate command and names exactly which field drifted.
x8_check_container_labels() {
  local container="$1" service="$2"
  local label_project label_service label_config_files label_image_id
  label_project="$(docker inspect "$container" --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)"
  label_service="$(docker inspect "$container" --format '{{index .Config.Labels "com.docker.compose.service"}}' 2>/dev/null || true)"
  label_config_files="$(docker inspect "$container" --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' 2>/dev/null || true)"
  label_image_id="$(docker inspect "$container" --format '{{.Image}}' 2>/dev/null || true)"

  [[ "$label_project" == "$X8_IDENTITY_COMPOSE_PROJECT" ]] || {
    echo "ERROR: X8 gate pre-check failed: $service container compose-project label drift (running='$label_project' identity='$X8_IDENTITY_COMPOSE_PROJECT')" >&2
    return 65
  }
  [[ "$label_service" == "$service" ]] || {
    echo "ERROR: X8 gate pre-check failed: $service container compose-service label drift (running='$label_service' expected='$service')" >&2
    return 65
  }
  [[ "$label_config_files" == "$X8_IDENTITY_COMPOSE_CONFIG_FILES" ]] || {
    echo "ERROR: X8 gate pre-check failed: $service container compose config-files label drift (running='$label_config_files' identity='$X8_IDENTITY_COMPOSE_CONFIG_FILES')" >&2
    return 65
  }
  [[ "$label_image_id" == "$X8_IDENTITY_IMAGE_DIGEST" ]] || {
    echo "ERROR: X8 gate pre-check failed: $service container image digest drift (running='$label_image_id' identity='$X8_IDENTITY_IMAGE_DIGEST')" >&2
    return 65
  }
  return 0
}

# X8 release-identity gate work order (2026-09-05), 施工项一 4.3(五), leg 1: the
# rendered-config gate borrowed from the reference CPS short-drama
# implementation. Renders differ; anything outside the two catalog-write
# gate variables is unauthorized and fails closed.
x8_gate_rendered_diff() {
  local baseline_file="$1" candidate_file="$2"
  node "$X8_PROJECT_ROOT/scripts/lib/x8-gate-diff.mjs" rendered "$baseline_file" "$candidate_file" \
    "FEATURE_NOVEL_CATALOG_SYNC,NOVEL_CATALOG_SYNC_ALLOW_WRITE"
}

# X8 release-identity gate work order (2026-09-05), 施工项一 4.3(五), leg 2: the
# leg the reference implementation is missing. Compares the baseline render
# (persisted intent) against the web/worker containers' actual live
# environment for the curated identity-relevant keys -- this is what catches
# the exact drift this repo's local environment is confirmed to be in today
# (state file says the gate is open; both containers actually have it
# closed).
x8_gate_actual_matches_baseline() {
  local baseline_file="$1" web_container="$2" worker_container="$3"
  local web_env_file worker_env_file actual_file keys_file
  web_env_file="$(mktemp "${TMPDIR:-/tmp}/x8-gate-web-env.XXXXXX")"
  worker_env_file="$(mktemp "${TMPDIR:-/tmp}/x8-gate-worker-env.XXXXXX")"
  actual_file="$(mktemp "${TMPDIR:-/tmp}/x8-gate-actual.XXXXXX")"
  keys_file="$(mktemp "${TMPDIR:-/tmp}/x8-gate-keys.XXXXXX")"

  docker inspect --format '{{json .Config.Env}}' "$web_container" >"$web_env_file" 2>/dev/null || echo '[]' >"$web_env_file"
  docker inspect --format '{{json .Config.Env}}' "$worker_container" >"$worker_env_file" 2>/dev/null || echo '[]' >"$worker_env_file"

  node -e '
    const fs = require("fs");
    fs.writeFileSync(process.argv[1], JSON.stringify({
      web: ["FEATURE_NOVEL_CATALOG_SYNC", "NOVEL_CATALOG_SYNC_ALLOW_WRITE", "PROMO_CLAIM_ROLES", "ADMIN_TWO_FACTOR_ENFORCEMENT"],
      worker: ["FEATURE_NOVEL_CATALOG_SYNC", "NOVEL_CATALOG_SYNC_ALLOW_WRITE", "WORKER_TASK_ALLOWLIST"],
    }));
  ' "$keys_file"

  node -e '
    const fs = require("fs");
    // `node -e` has no script-filename slot, so argv[1] is the first extra
    // CLI argument (unlike running an actual .js/.mjs file, where argv[1] is
    // the file path and extras start at argv[2]).
    const [, outPath, webEnvPath, workerEnvPath] = process.argv;
    const toMap = (raw) => {
      let entries = [];
      try { entries = JSON.parse(raw); } catch { entries = []; }
      const map = {};
      for (const entry of Array.isArray(entries) ? entries : []) {
        const index = typeof entry === "string" ? entry.indexOf("=") : -1;
        if (index > 0) map[entry.slice(0, index)] = entry.slice(index + 1);
      }
      return map;
    };
    fs.writeFileSync(outPath, JSON.stringify({
      web: toMap(fs.readFileSync(webEnvPath, "utf8")),
      worker: toMap(fs.readFileSync(workerEnvPath, "utf8")),
    }));
  ' "$actual_file" "$web_env_file" "$worker_env_file"

  local status=0
  node "$X8_PROJECT_ROOT/scripts/lib/x8-gate-diff.mjs" actual "$baseline_file" "$actual_file" "$keys_file" || status=$?
  rm -f "$web_env_file" "$worker_env_file" "$actual_file" "$keys_file"
  return "$status"
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

# X8 release-identity gate work order (2026-09-05), 施工项一 4.3(一): `up` is
# the only entry point that builds images, so it is the only entry point
# allowed to register a deploy identity. Called right after build_app_image()
# succeeds and before any container starts. Fields are all derived from the
# environment prepare_x8_environment()/build_app_image() already established
# in this same `up` -- the image digest is freshly re-read from docker right
# here, which is what lets this file "self-verify against the just-built
# image" rather than trust a value computed earlier. Never hand-edited: the
# file is written 0400 via temp-then-rename, and every gate operation only
# ever reads it (resolve_x8_identity() in scripts/lib/x8-production-like-env.sh).
write_x8_identity() {
  require_command docker
  require_command node
  local image_digest
  image_digest="$(docker image inspect "$CPS_NOVEL_APP_IMAGE" --format '{{.Id}}' 2>/dev/null || true)"
  [[ -n "$image_digest" ]] || {
    echo "ERROR: unable to resolve the local image digest for $CPS_NOVEL_APP_IMAGE while writing the X8 deploy identity" >&2
    return 65
  }
  local temporary="${X8_IDENTITY_FILE}.tmp.$$"
  if ! node -e '
    const fs = require("fs");
    // `node -e` has no script-filename slot, so argv[1] is the first extra
    // CLI argument -- one leading skip, not two.
    const [
      , outPath, appVersion, gitCommit, level, imageRef, imageDigest,
      composeProject, buildDate, configFileA, configFileB,
    ] = process.argv;
    const payload = {
      schemaVersion: 1,
      appVersion,
      gitCommit,
      level,
      imageRef,
      imageDigest,
      composeProject,
      buildDate,
      composeConfigFiles: [configFileA, configFileB],
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  ' "$temporary" "$APP_VERSION" "$GIT_COMMIT" "$X8_LEVEL" "$CPS_NOVEL_APP_IMAGE" "$image_digest" \
    "$P1_12_COMPOSE_PROJECT" "$BUILD_DATE" \
    "$X8_PROJECT_ROOT/docker-compose.yml" "$X8_PROJECT_ROOT/infra/production-like/docker-compose.yml"; then
    rm -f "$temporary"
    echo "ERROR: failed to render the X8 deploy identity file" >&2
    return 65
  fi
  chmod 400 "$temporary"
  mv -f "$temporary" "$X8_IDENTITY_FILE"
  echo "X8_RELEASE_IDENTITY_WRITTEN=$X8_IDENTITY_FILE"
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
  # X8 release-identity gate work order (2026-09-05), 施工项一 4.3(一): the
  # deploy identity is registered right after a successful build, before any
  # container starts (including postgres, which prepare_database() below
  # would otherwise bring up first).
  write_x8_identity
  prepare_database
  x8_compose up -d web worker scheduler

  # M2/RC-… : persisted operator choice remains authoritative, but drift
  # between it and what the containers actually have must never be silent.
  # Checked here (after web/worker exist) rather than before, per 施工项一
  # 4.3(八): the comparison basis is now "state file vs. container reality",
  # which only means something once there is a container to inspect. The
  # helper only warns and prints the explicit repair; it never blocks `up`.
  warn_x8_gate_drift

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

# X8 release-identity gate work order (2026-09-05), 施工项一 4.3(九): a pure
# read path with zero environment prep -- no mkdir, no chmod, no secret-file
# creation, no gate-state default write. This is the direct fix for the
# incident that motivated this work order: an audit that believed itself
# read-only ended up rewriting the gate state file's mtime by going through
# the side-effecting prepare_x8_environment().
gate_catalog_status() {
  if [[ ! -f "$X8_GATE_STATE_FILE" ]]; then
    echo "ERROR: no X8 catalog gate state file at $X8_GATE_STATE_FILE; nothing has been established yet (run 'up')" >&2
    return 65
  fi
  local persisted
  persisted="$(tr -d '\r\n' <"$X8_GATE_STATE_FILE")"
  case "$persisted" in
    dry-run | apply | closed) : ;;
    *)
      echo "ERROR: corrupt X8 catalog gate state" >&2
      return 65
      ;;
  esac
  printf 'X8_CATALOG_GATE=%s\n' "$persisted"

  # P1_12_COMPOSE_PROJECT is a hardcoded literal, not an env-prep side
  # effect -- setting it here (instead of calling prepare_x8_environment)
  # is what lets `x8_compose ps`/`docker inspect` below run without ever
  # touching a directory, a secret file, or the gate-state file itself.
  export P1_12_COMPOSE_PROJECT="$X8_COMPOSE_PROJECT_NAME"
  require_command docker
  local web_container
  web_container="$(x8_compose ps -q web 2>/dev/null || true)"
  if [[ -z "$web_container" ]]; then
    echo "X8_CATALOG_GATE_CONTAINER_CHECK=skipped (no running web container)"
    return 0
  fi

  local expected_enabled expected_write
  case "$persisted" in
    apply) expected_enabled=true; expected_write=true ;;
    dry-run) expected_enabled=true; expected_write=false ;;
    closed) expected_enabled=false; expected_write=false ;;
  esac
  local actual_enabled actual_write
  actual_enabled="$(x8_container_env_value "$web_container" FEATURE_NOVEL_CATALOG_SYNC)"
  actual_write="$(x8_container_env_value "$web_container" NOVEL_CATALOG_SYNC_ALLOW_WRITE)"
  if [[ "$actual_enabled" == "$expected_enabled" && "$actual_write" == "$expected_write" ]]; then
    echo "X8_CATALOG_GATE_CONTAINER_CHECK=match"
  else
    echo "X8_CATALOG_GATE_CONTAINER_CHECK=drift"
    printf '%s\n' \
      "WARNING: X8 catalog-write gate drift: state=$persisted (expects FEATURE_NOVEL_CATALOG_SYNC=$expected_enabled NOVEL_CATALOG_SYNC_ALLOW_WRITE=$expected_write) actual web container has FEATURE_NOVEL_CATALOG_SYNC=$actual_enabled NOVEL_CATALOG_SYNC_ALLOW_WRITE=$actual_write" >&2
  fi
}

# X8 release-identity gate work order (2026-09-05), 施工项一: the single-
# variable recreate for the catalog-write gate. Implements 4.3(二)(三)(四)
# (五)(六)(七): level and image come only from the release identity file
# (never recomputed from the branch's latest commit, never defaulted);
# container labels are used only for a front-and-back comparison against
# that identity, never as an identity source; the pre-check is a three-way
# comparison (persisted state, rendered candidate, container reality), not
# just the reference implementation's two-way rendered diff; recreate always
# runs before anything is written to disk, so a failure at any point up to
# and including the recreate itself leaves the gate state file completely
# untouched -- there is nothing to roll back; and plan mode (no --apply) is
# the default, touching nothing.
gate_catalog_recreate() {
  local action="$1" apply="$2"
  resolve_x8_identity || return 65

  local persisted
  persisted="$(x8_read_gate_state)" || return 65

  local target
  case "$action" in
    on) target=apply ;;
    off) target=closed ;;
    dry-run) target=dry-run ;;
  esac

  # 4.3(三): the run level comes from the release identity, full stop --
  # never from whatever X8_LEVEL the caller's shell happened to have (or not
  # have) exported. Forcing it here before prepare_x8_environment() means a
  # missing/wrong caller-side X8_LEVEL prefix can no longer silently change
  # what this command does (一.1's core complaint).
  export X8_LEVEL="$X8_IDENTITY_LEVEL"
  prepare_x8_environment
  # 4.3(二): image and version identity come only from the release identity
  # file, overriding whatever prepare_p1_12_local_environment() just computed
  # from the live git worktree HEAD.
  export APP_VERSION="$X8_IDENTITY_APP_VERSION"
  export GIT_COMMIT="$X8_IDENTITY_GIT_COMMIT"
  export CPS_NOVEL_APP_IMAGE="$X8_IDENTITY_IMAGE_REF"
  export BUILD_DATE="$X8_IDENTITY_BUILD_DATE"
  echo "X8_GATE_LEVEL_SOURCE=release-identity level=$X8_IDENTITY_LEVEL image=$X8_IDENTITY_IMAGE_REF" >&2

  require_command docker
  require_command node

  # 4.3(二): never build, never pull -- the frozen image must already exist
  # locally and match the identity's digest exactly.
  docker image inspect "$X8_IDENTITY_IMAGE_REF" >/dev/null 2>&1 || {
    echo "ERROR: X8 gate command requires the frozen release image to already exist locally: $X8_IDENTITY_IMAGE_REF (the gate command never builds or pulls; run 'up' to (re)establish it)" >&2
    return 65
  }
  local local_image_id
  local_image_id="$(docker image inspect "$X8_IDENTITY_IMAGE_REF" --format '{{.Id}}')"
  [[ "$local_image_id" == "$X8_IDENTITY_IMAGE_DIGEST" ]] || {
    echo "ERROR: local image $X8_IDENTITY_IMAGE_REF has drifted from the release identity (identity=$X8_IDENTITY_IMAGE_DIGEST local=$local_image_id); run 'up' to re-establish identity" >&2
    return 65
  }

  local web_container worker_container
  web_container="$(x8_compose ps -q web 2>/dev/null || true)"
  worker_container="$(x8_compose ps -q worker 2>/dev/null || true)"
  [[ -n "$web_container" && -n "$worker_container" ]] || {
    echo "ERROR: X8 gate command requires web and worker to already be running (run 'up' first)" >&2
    return 65
  }

  # 4.3(四): container labels, front-and-back, never as identity source.
  x8_check_container_labels "$web_container" web || return 65
  x8_check_container_labels "$worker_container" worker || return 65

  local baseline_file candidate_file
  baseline_file="$(mktemp "${TMPDIR:-/tmp}/x8-gate-baseline.XXXXXX")"
  candidate_file="$(mktemp "${TMPDIR:-/tmp}/x8-gate-candidate.XXXXXX")"
  if ! x8_compose config --format json >"$baseline_file"; then
    rm -f "$baseline_file" "$candidate_file"
    return 65
  fi

  local target_enabled target_write
  case "$target" in
    apply) target_enabled=true; target_write=true ;;
    dry-run) target_enabled=true; target_write=false ;;
    closed) target_enabled=false; target_write=false ;;
  esac
  if ! FEATURE_NOVEL_CATALOG_SYNC="$target_enabled" NOVEL_CATALOG_SYNC_ALLOW_WRITE="$target_write" \
    x8_compose config --format json >"$candidate_file"; then
    rm -f "$baseline_file" "$candidate_file"
    return 65
  fi

  local diff_output
  if ! diff_output="$(x8_gate_rendered_diff "$baseline_file" "$candidate_file")"; then
    rm -f "$baseline_file" "$candidate_file"
    echo "ERROR: X8 gate rendered-config gate failed: a field outside the requested catalog-write flags would change (see above)" >&2
    return 65
  fi

  # 4.3(五): the third leg -- baseline (persisted intent) vs. what the
  # containers actually have right now. This is a hard failure, not a
  # warning: the environment is confirmed to already be in exactly this
  # drifted state today (state file says apply/write=true, both containers
  # actually have it closed), and building a single-variable recreate on top
  # of an inconsistent baseline is precisely what this work order forbids.
  if ! x8_gate_actual_matches_baseline "$baseline_file" "$web_container" "$worker_container"; then
    rm -f "$baseline_file" "$candidate_file"
    echo "ERROR: X8 gate pre-check failed: the running containers do not match the persisted catalog-gate state (see drift above); the environment is not self-consistent enough for a single-variable recreate -- reconcile out of band (e.g. re-run 'up') first" >&2
    return 65
  fi

  echo "=== X8 gate command: frozen pre-state ==="
  echo "project=$P1_12_COMPOSE_PROJECT level=$X8_IDENTITY_LEVEL image=$X8_IDENTITY_IMAGE_REF image_digest=$X8_IDENTITY_IMAGE_DIGEST"
  echo "persisted_gate=$persisted requested_action=$action target_gate=$target"
  echo "=== rendered config gate: PASS (only the catalog-write gate variables differ) ==="
  echo "$diff_output"
  echo "=== three-way check: PASS (state file, rendered candidate, and container runtime agree outside the requested change) ==="

  # 4.3(七): plan mode is the default. Nothing above this point wrote
  # anything to disk or touched a container.
  if [[ "$apply" != "true" ]]; then
    rm -f "$baseline_file" "$candidate_file"
    echo "X8_GATE_PLAN=PASS"
    echo "No production-like action was executed (pass --apply to recreate)."
    return 0
  fi
  rm -f "$baseline_file" "$candidate_file"

  # 4.3(六): recreate first; only write the state file after a fully
  # verified success. A failure here leaves the gate state file exactly as
  # it was -- there is nothing to roll back.
  echo "=== recreating web worker (--no-build --pull never) ==="
  if ! FEATURE_NOVEL_CATALOG_SYNC="$target_enabled" NOVEL_CATALOG_SYNC_ALLOW_WRITE="$target_write" \
    x8_compose up -d --no-deps --no-build --pull never --force-recreate web worker; then
    echo "ERROR: recreate failed; X8 catalog gate state left unchanged at '$persisted' (nothing was written)" >&2
    return 65
  fi

  local new_web new_worker
  new_web="$(x8_compose ps -q web 2>/dev/null || true)"
  new_worker="$(x8_compose ps -q worker 2>/dev/null || true)"
  local service container pair mismatch=""
  for pair in "web:$new_web" "worker:$new_worker"; do
    service="${pair%%:*}"
    container="${pair#*:}"
    if [[ -z "$container" ]]; then
      mismatch="$service container missing after recreate"
      break
    fi
    local post_image_id
    post_image_id="$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null || true)"
    if [[ "$post_image_id" != "$X8_IDENTITY_IMAGE_DIGEST" ]]; then
      mismatch="$service image drifted after recreate (expected $X8_IDENTITY_IMAGE_DIGEST got $post_image_id)"
      break
    fi
    local post_enabled post_write
    post_enabled="$(x8_container_env_value "$container" FEATURE_NOVEL_CATALOG_SYNC)"
    post_write="$(x8_container_env_value "$container" NOVEL_CATALOG_SYNC_ALLOW_WRITE)"
    if [[ "$post_enabled" != "$target_enabled" || "$post_write" != "$target_write" ]]; then
      mismatch="$service did not pick up the requested gate values after recreate"
      break
    fi
    # 4.4 acceptance: "正常路径执行一次开闸: ... 任务白名单、领取授权角色、双因素
    # 强制、镜像摘要,前后逐项相同". The pre-check's rendered-diff-gate already
    # guarantees this mathematically (baseline vs. candidate render differ
    # only in the two gate keys, and the recreate below used the exact same
    # candidate environment) -- these direct post-hoc reads are the
    # belt-and-suspenders confirmation, not a repeat of that inference.
    if [[ "$service" == "web" ]]; then
      local post_promo_roles post_two_factor
      post_promo_roles="$(x8_container_env_value "$container" PROMO_CLAIM_ROLES)"
      post_two_factor="$(x8_container_env_value "$container" ADMIN_TWO_FACTOR_ENFORCEMENT)"
      if [[ "$post_promo_roles" != "${PROMO_CLAIM_ROLES:-}" || "$post_two_factor" != "${ADMIN_TWO_FACTOR_ENFORCEMENT:-}" ]]; then
        mismatch="$service PROMO_CLAIM_ROLES/ADMIN_TWO_FACTOR_ENFORCEMENT drifted after recreate"
        break
      fi
    else
      local post_allowlist
      post_allowlist="$(x8_container_env_value "$container" WORKER_TASK_ALLOWLIST)"
      if [[ "$post_allowlist" != "${WORKER_TASK_ALLOWLIST:-}" ]]; then
        mismatch="$service WORKER_TASK_ALLOWLIST drifted after recreate"
        break
      fi
    fi
  done

  if [[ -n "$mismatch" ]]; then
    echo "ERROR: post-recreate verification failed: $mismatch -- X8 catalog gate state left unchanged at '$persisted' (nothing was written); investigate the containers manually" >&2
    return 65
  fi

  # Written as an explicit case (rather than a generic write_x8_gate_state
  # "$target") so a future refactor can never widen what this line is
  # allowed to persist without the change being visible in a diff here.
  case "$target" in
    apply) write_x8_gate_state apply ;;
    dry-run) write_x8_gate_state dry-run ;;
    closed) write_x8_gate_state closed ;;
  esac
  echo "X8_CATALOG_GATE=$target"
  echo "X8_GATE_APPLY=PASS"
}

gate_catalog() {
  [[ "${1:-}" == "catalog-write" ]] || usage
  local action="${2:-}"
  case "$action" in
    status)
      [[ $# -eq 2 ]] || usage
      gate_catalog_status
      ;;
    on | off | dry-run)
      local apply=false
      case "${3:-}" in
        "") : ;;
        --apply) apply=true ;;
        *) usage ;;
      esac
      [[ $# -le 3 ]] || usage
      gate_catalog_recreate "$action" "$apply"
      ;;
    *) usage ;;
  esac
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
  gate) shift; [[ $# -ge 2 && $# -le 3 ]] || usage; gate_catalog "$@" ;;
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
