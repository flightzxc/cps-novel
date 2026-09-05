#!/usr/bin/env bash
set -euo pipefail
set +x

# 2026-09-06 patch (second round): ${BASH_SOURCE[0]}, not $0 -- $0 is whatever
# the OUTER caller's $0 happens to be when this file is `source`d (this
# repo's own test suite does exactly that, to exercise the release-identity
# write/fail/promote chain via its real functions rather than reimplementing
# it), while BASH_SOURCE[0] always resolves to this file's own path in both
# the sourced and directly-executed cases. Every real invocation still
# executes this file directly, where $0 and BASH_SOURCE[0] are identical, so
# this changes nothing about production behavior.
X8_SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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
    '     fail fast in prepare_x8_environment(). Every subcommand that calls' \
    '     prepare_x8_environment() reads this shell'"'"'s X8_LEVEL -- that is' \
    '     `up`, `down`, `verify`, `accept`, `backup-now`, `restore-smoke`,' \
    '     `catalog-one`, `preview-one`, `promo-fixture`, `health-sql`,' \
    '     `admin-secret`, `admin-seed`, and `admin-reset` (2026-09-06 patch:' \
    '     this line used to say "only `up`", which was already inaccurate).' \
    '     `gate catalog-write` and plain `status` do NOT read it at all --' \
    '     both derive their run level from the committed release identity' \
    '     file `up` last wrote (.tmp/x8-production-like/release-identity.json)' \
    '     and fail if that file is missing, is only a candidate (a previous' \
    '     `up` did not finish), or does not resolve to a level.' \
    '     `gate catalog-write on|off|dry-run` defaults to plan mode (prints' \
    '     the diff, touches nothing); pass --apply to actually recreate. A' \
    '     recreate that does not fully verify is rolled back to the values' \
    '     it started from and the state file is never left half-written.' >&2
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

# X8 release-identity gate work order (2026-09-05), 施工项一 4.3(四), amended
# by the 2026-09-06 patch (P1-8): container labels are used ONLY for this
# front-and-back comparison against the release identity file -- never as a
# source of identity themselves. Any mismatch stops the gate command and
# names exactly which field drifted. The working_dir label check is the
# patch addition: Compose stamps com.docker.compose.project.working_dir with
# the directory of the FIRST `-f` file in the invocation that created the
# container, so comparing it against the directory implied by the identity's
# own first recorded compose file (X8_IDENTITY_WORKING_DIR) is what catches
# "a different worktree, pointed at the same runtime dir, recreating with
# its own directory's config files" even in the (unlikely) case its config
# file *paths* happen to collide with the identity's.
x8_check_container_labels() {
  local container="$1" service="$2"
  local label_project label_service label_config_files label_image_id label_working_dir
  label_project="$(docker inspect "$container" --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)"
  label_service="$(docker inspect "$container" --format '{{index .Config.Labels "com.docker.compose.service"}}' 2>/dev/null || true)"
  label_config_files="$(docker inspect "$container" --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' 2>/dev/null || true)"
  label_working_dir="$(docker inspect "$container" --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null || true)"
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
  [[ "$label_working_dir" == "$X8_IDENTITY_WORKING_DIR" ]] || {
    echo "ERROR: X8 gate pre-check failed: $service container compose working-directory label drift (running='$label_working_dir' identity='$X8_IDENTITY_WORKING_DIR')" >&2
    return 65
  }
  [[ "$label_image_id" == "$X8_IDENTITY_IMAGE_DIGEST" ]] || {
    echo "ERROR: X8 gate pre-check failed: $service container image digest drift (running='$label_image_id' identity='$X8_IDENTITY_IMAGE_DIGEST')" >&2
    return 65
  }
  return 0
}

# 2026-09-06 patch work order, P1-8: the compose context the gate command
# actually executes against, bound to the release identity's own recorded
# project name and config-file list -- never the current script's directory
# or ${X8_PROJECT_ROOT}. Before this, x8_check_container_labels() compared
# the identity's config-files list against the running containers' labels,
# but every actual `docker compose` invocation in the gate path still used
# $X8_PROJECT_ROOT/docker-compose.yml -- so a second worktree pointed at the
# same runtime directory could pass the label check yet recreate with its
# own directory's compose files. Must only be called after
# prepare_x8_gate_environment() (which calls resolve_x8_identity() and
# exports X8_IDENTITY_COMPOSE_PROJECT / X8_IDENTITY_COMPOSE_CONFIG_FILES).
x8_gate_compose() {
  local -a config_files=()
  local IFS=','
  read -r -a config_files <<<"$X8_IDENTITY_COMPOSE_CONFIG_FILES"
  local -a file_args=()
  local f
  for f in "${config_files[@]}"; do
    file_args+=(-f "$f")
  done
  docker compose -p "$X8_IDENTITY_COMPOSE_PROJECT" "${file_args[@]}" "$@"
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

# X8 release-identity gate work order (2026-09-05), 施工项一 4.3(五), leg 2,
# rewritten by the 2026-09-06 patch (决策一 / P0-3 / P0-4): compares the
# baseline render (persisted intent) against the web/worker containers'
# actual live environment for EVERY environment key the baseline render
# declares for that service -- not a hand-picked list of 7. This is what
# catches the exact drift this repo's local environment was confirmed to be
# in (state file says the gate is open; both containers actually have it
# closed), but also the promo double-gate, the preview source allowlist, the
# build-version variable, or any other key a curated whitelist would have
# missed by construction. The only keys exempt from the "container has,
# baseline doesn't" direction are BASE_IMAGE_BAKED_KEYS in
# scripts/lib/x8-gate-diff.mjs (PATH/NODE_VERSION/YARN_VERSION/
# NEXT_TELEMETRY_DISABLED/PORT/HOSTNAME) -- baked into the image, not
# declared by docker-compose.yml for at least one of web/worker, already
# pinned by the image-digest check that runs before this.
x8_gate_actual_matches_baseline() {
  local baseline_file="$1" web_container="$2" worker_container="$3"
  local web_env_file worker_env_file actual_file keys_file image_env_file
  web_env_file="$(mktemp "$X8_GATE_TMPDIR/x8-gate-web-env.XXXXXX")"
  worker_env_file="$(mktemp "$X8_GATE_TMPDIR/x8-gate-worker-env.XXXXXX")"
  actual_file="$(mktemp "$X8_GATE_TMPDIR/x8-gate-actual.XXXXXX")"
  keys_file="$(mktemp "$X8_GATE_TMPDIR/x8-gate-keys.XXXXXX")"
  image_env_file="$(mktemp "$X8_GATE_TMPDIR/x8-gate-image-env.XXXXXX")"
  # Terminal review, release-identity gate second round: a single self-
  # clearing RETURN trap replaces the scattered `rm -f ...; return N` pairs
  # this function used to repeat at every exit point -- one place to get
  # right instead of N, and it also fires for any FUTURE return path a later
  # edit adds without remembering to clean up by hand. `trap - RETURN`
  # inside the handler itself is what makes it fire exactly once for THIS
  # invocation: without it, a RETURN trap set here would still be armed (and
  # referencing these now-out-of-scope locals) the next time ANY function
  # returns, including a caller several frames up.
  trap 'rm -f "$web_env_file" "$worker_env_file" "$actual_file" "$keys_file" "$image_env_file"; trap - RETURN' RETURN

  docker inspect --format '{{json .Config.Env}}' "$web_container" >"$web_env_file" 2>/dev/null || echo '[]' >"$web_env_file"
  docker inspect --format '{{json .Config.Env}}' "$worker_container" >"$worker_env_file" 2>/dev/null || echo '[]' >"$worker_env_file"
  # Terminal review, release-identity gate second round, finding 一: the
  # image's OWN baked-in default environment, read directly off the exact
  # image the release identity is bound to -- never off a running
  # container, since a container can be CREATED with an env override for a
  # key that also happens to be baked into the image (e.g. `docker run -e
  # PATH=...` or a compose `environment:` entry), and that override changes
  # nothing about `.Image`'s digest (already pinned by the caller's own
  # check before this function runs). Without this, BASE_IMAGE_BAKED_KEYS
  # below would keep accepting ANY value for an exempted key -- exactly the
  # gap this patch closes. $X8_IDENTITY_IMAGE_REF is safe to inspect here
  # (rather than the raw digest) because every real call path already
  # verified it resolves to the identity's own pinned image ID before ever
  # reaching this function (gate_catalog_recreate's 4.3(二) check).
  docker image inspect "$X8_IDENTITY_IMAGE_REF" --format '{{json .Config.Env}}' >"$image_env_file" 2>/dev/null || echo '[]' >"$image_env_file"

  # 2026-09-06 patch (second round), group 4: requiredKeys (CATALOG_GATE_ENV_KEYS)
  # closes the "declared on neither side" blind spot in findActualDrift() --
  # without it, if a future docker-compose.yml edit ever dropped
  # FEATURE_NOVEL_CATALOG_SYNC / NOVEL_CATALOG_SYNC_ALLOW_WRITE from a
  # service's `environment:` block entirely, that key would be absent from
  # BOTH the baseline render and the actual container and never enter the
  # per-key loop at all -- a silent pass for exactly the two variables this
  # command exists to police. This exact same keys_file (and therefore this
  # same requiredKeys list) is reused for the post-recreate/rollback
  # reconciliation calls in x8_gate_verify_recreate() below.
  if ! node -e '
    const fs = require("fs");
    const { pathToFileURL } = require("url");
    const [, outPath, diffModulePath, imageEnvPath] = process.argv;
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
    import(pathToFileURL(diffModulePath).href).then(({ BASE_IMAGE_BAKED_KEYS, CATALOG_GATE_ENV_KEYS }) => {
      const imageBakedEnv = toMap(fs.readFileSync(imageEnvPath, "utf8"));
      fs.writeFileSync(outPath, JSON.stringify({ services: ["web", "worker"], allowedExtraKeys: BASE_IMAGE_BAKED_KEYS, requiredKeys: CATALOG_GATE_ENV_KEYS, imageBakedEnv }));
    }).catch((error) => {
      process.stderr.write(`ERROR: unable to resolve the base-image-baked key exemption list: ${error.message}\n`);
      process.exit(70);
    });
  ' "$keys_file" "$X8_PROJECT_ROOT/scripts/lib/x8-gate-diff.mjs" "$image_env_file"; then
    return 65
  fi

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

# X8 release-identity gate work order (2026-09-05), 施工项一 4.3(一), rewritten
# by the 2026-09-06 patch work order (决策二: candidate vs. committed
# identity). `up` is the only entry point that builds images, so it is the
# only entry point allowed to register a deploy identity -- but writing
# straight onto the committed identity file here (before postgres, before
# any container, before the health probes) is exactly what let a failed `up`
# leave behind a committed identity that pointed at an image that was never
# actually deployed. This writes a CANDIDATE instead, right after
# build_app_image() succeeds and before any container starts (preserving the
# original "on disk before anything starts" intent). Fields are all derived
# from the environment already established in this same `up` -- the image
# digest is freshly re-read from docker right here, which is what lets this
# file "self-verify against the just-built image" rather than trust a value
# computed earlier. Never hand-edited: written 0400 via temp-then-rename.
# See promote_x8_identity_candidate() for the second half.
write_x8_identity_candidate() {
  require_command docker
  require_command node
  local image_digest
  image_digest="$(docker image inspect "$CPS_NOVEL_APP_IMAGE" --format '{{.Id}}' 2>/dev/null || true)"
  [[ -n "$image_digest" ]] || {
    echo "ERROR: unable to resolve the local image digest for $CPS_NOVEL_APP_IMAGE while writing the X8 deploy identity candidate" >&2
    return 65
  }
  # Owner fix (release-identity gate third round): the previous fix here
  # (finding 三) froze the level table's fully-RESOLVED values (levelEnv)
  # into the identity so prepare_x8_gate_environment() would never have to
  # re-read scripts/lib/x8-levels.json (a file that lives in -- and can
  # change independently in -- the current git worktree). That solved the
  # "worktree edit silently changes gate behavior" problem, but at the cost
  # of letting business flags (AUTO_WRITE_AUTHORIZED among them) bypass the
  # one file the compliance validator's ADR guard actually protects. The
  # correct fix -- matching how composeConfigFiles/imageDigest already bind
  # the identity to a SOURCE plus a verifiable fingerprint, never to derived
  # values -- is to freeze the level table's PATH and a CONTENT DIGEST here,
  # and let the gate re-read and re-verify that exact file (see
  # prepare_x8_gate_environment() and x8_file_sha256()) instead of trusting a
  # frozen snapshot of what it once said.
  # CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION/X8_ADMIN_DOMAIN are unrelated to
  # this fix (deploy identity, not a business flag) and are still frozen
  # directly, unchanged from finding 三: $X8_LEVEL/$X8_ADMIN_DOMAIN/
  # $CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION are already exported by
  # prepare_x8_environment() (via x8_level_config/x8_export_static_topology/
  # prepare_p1_12_local_environment) by the time `up` reaches this function --
  # this is not re-deriving them, only capturing the values this deploy
  # actually used.
  local levels_file_digest
  levels_file_digest="$(x8_file_sha256 "$X8_LEVELS_FILE")" || {
    echo "ERROR: failed to digest the X8 level table at $X8_LEVELS_FILE while writing the X8 deploy identity candidate" >&2
    return 65
  }
  [[ -n "${X8_ADMIN_DOMAIN:-}" ]] || {
    echo "ERROR: X8_ADMIN_DOMAIN is not set while writing the X8 deploy identity candidate" >&2
    return 65
  }
  [[ -n "${CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION:-}" ]] || {
    echo "ERROR: CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION is not set while writing the X8 deploy identity candidate" >&2
    return 65
  }
  local temporary="${X8_IDENTITY_CANDIDATE_FILE}.tmp.$$"
  if ! node -e '
    const fs = require("fs");
    // `node -e` has no script-filename slot, so argv[1] is the first extra
    // CLI argument -- one leading skip, not two.
    const [
      , outPath, appVersion, gitCommit, level, imageRef, imageDigest,
      composeProject, buildDate, configFileA, configFileB,
      levelsFile, levelsFileDigest, adminDomain, credentialActiveKeyVersion,
    ] = process.argv;
    const payload = {
      schemaVersion: 3,
      appVersion,
      gitCommit,
      level,
      imageRef,
      imageDigest,
      composeProject,
      buildDate,
      composeConfigFiles: [configFileA, configFileB],
      // Owner fix (release-identity gate third round): the level table
      // SOURCE, not its resolved values -- prepare_x8_gate_environment()
      // re-reads this exact path, refuses if its content digest no longer
      // matches, and only then resolves it through x8_level_config(), which
      // also runs the independent P2-06.5 safety-invariant check
      // (scripts/lib/x8-level-safety-invariants.mjs) before exporting
      // anything.
      levelsFile,
      levelsFileDigest,
      // Finding 三: the two remaining values prepare_x8_gate_environment()
      // used to default from the CALLER ambient environment instead of
      // the frozen identity -- frozen the same way every other
      // identity-derived field already is.
      adminDomain,
      credentialActiveKeyVersion,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  ' "$temporary" "$APP_VERSION" "$GIT_COMMIT" "$X8_LEVEL" "$CPS_NOVEL_APP_IMAGE" "$image_digest" \
    "$P1_12_COMPOSE_PROJECT" "$BUILD_DATE" \
    "$X8_PROJECT_ROOT/docker-compose.yml" "$X8_PROJECT_ROOT/infra/production-like/docker-compose.yml" \
    "$X8_LEVELS_FILE" "$levels_file_digest" "$X8_ADMIN_DOMAIN" "$CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION"; then
    rm -f "$temporary"
    echo "ERROR: failed to render the X8 deploy identity candidate file" >&2
    return 65
  fi
  chmod 400 "$temporary"
  mv -f "$temporary" "$X8_IDENTITY_CANDIDATE_FILE"
  echo "X8_RELEASE_IDENTITY_CANDIDATE_WRITTEN=$X8_IDENTITY_CANDIDATE_FILE"
}

# 2026-09-06 patch work order, 决策二: called only after database prep,
# container start, and every health probe in `up` have all passed. Promotes
# the candidate onto the committed identity file (an atomic rename), which
# is the only file resolve_x8_identity() (and therefore the gate command)
# ever reads. Also clears any stale failure marker from a previous failed
# attempt -- this deploy is what supersedes it.
#
# 2026-09-06 patch (second round), group 1 P0: the ORIGINAL order here did
# the `mv` (committing the new identity) and then a separate `rm -f` of the
# failure marker, with `up_x8()` clearing X8_IDENTITY_DEPLOY_IN_PROGRESS as a
# THIRD, later statement back in its own body. Under `set -e`, if the `mv`
# succeeded but the `rm -f` on the very next line failed for any reason
# (e.g. the runtime directory briefly not writable), this function would
# abort right there -- `up_x8()` would never reach its own
# `X8_IDENTITY_DEPLOY_IN_PROGRESS=""` line, the EXIT trap would still see the
# flag set, and x8_mark_identity_deploy_failed() would write a marker
# falsely claiming "the previously committed release identity was left
# untouched" when the `mv` had, in fact, already landed. Clearing the flag
# is now the very next statement after the `mv` succeeds -- before the
# failure-marker cleanup that follows it -- so a failure in that cleanup can
# no longer make the trap misreport a promotion that already happened.
# up_x8() no longer repeats this clear itself; see its own call site.
promote_x8_identity_candidate() {
  [[ -f "$X8_IDENTITY_CANDIDATE_FILE" ]] || {
    echo "ERROR: no X8 deploy identity candidate to promote at $X8_IDENTITY_CANDIDATE_FILE (write_x8_identity_candidate must run first)" >&2
    return 65
  }
  chmod 400 "$X8_IDENTITY_CANDIDATE_FILE" 2>/dev/null || true
  mv -f "$X8_IDENTITY_CANDIDATE_FILE" "$X8_IDENTITY_FILE"
  X8_IDENTITY_DEPLOY_IN_PROGRESS=""
  rm -f "$X8_IDENTITY_FAILURE_MARKER"
  echo "X8_RELEASE_IDENTITY_COMMITTED=$X8_IDENTITY_FILE"
}

# 2026-09-06 patch work order, 决策二 / P0-1: called (via the EXIT trap
# up_x8() installs around the candidate-to-committed span) whenever `up`
# terminates -- by `set -e`, by an explicit `exit`, or by a signal -- after
# the candidate identity was written but before it was promoted. Never
# touches the committed identity file; only leaves a readable record of what
# happened. Best-effort throughout (the process may already be unwinding
# from an unrelated failure) -- a failure to write the marker itself must
# never mask the original error or change the exit status.
#
# 2026-09-06 patch (second round), group 1 P0: the write below used to be a
# bare `{ ... } >"$temporary" 2>/dev/null` with no error guard of its own.
# This whole script runs under `set -e`; if that redirect failed for any
# reason (the runtime directory briefly unwritable, disk full, ...), `set -e`
# would abort THIS function immediately -- and since this function is called
# as a plain statement inside x8_up_exit_trap() (see below), the trap itself
# would then also abort right there, meaning its final `exit "$status"` line
# never runs. The shell would still exit (still under `set -e`), but with the
# EXIT STATUS OF THE FAILED WRITE, not the original failure status the trap
# exists to preserve -- silently corrupting the very exit code a caller/CI
# depends on. The `if ! { ... }; then ... fi` guard below, plus the explicit
# `return 0` at every path out of this function, makes the marker write
# best-effort in fact, not just in the comment above: whatever happens while
# writing it, this function itself always returns 0, so `set -e` never sees
# ITS invocation as a failing simple command and the caller's trap always
# reaches its own `exit "$status"`.
x8_mark_identity_deploy_failed() {
  local reason="$1"
  local temporary="${X8_IDENTITY_FAILURE_MARKER}.tmp.$$"
  if ! {
    printf 'timestamp=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf 'reason=%s\n' "$reason"
    printf 'candidate_file=%s\n' "$X8_IDENTITY_CANDIDATE_FILE"
    if [[ -f "$X8_IDENTITY_FILE" ]]; then
      printf 'previously_committed_identity_left_untouched_at=%s\n' "$X8_IDENTITY_FILE"
    else
      printf 'previously_committed_identity=<none -- there was no prior successful up>\n'
    fi
    if [[ -f "$X8_IDENTITY_CANDIDATE_FILE" ]]; then
      printf 'candidate_contents:\n'
      cat "$X8_IDENTITY_CANDIDATE_FILE"
    fi
  } >"$temporary" 2>/dev/null; then
    rm -f "$temporary" 2>/dev/null || true
    echo "ERROR: $reason -- the previously committed release identity (if any) was left untouched, but the failure marker itself could not be written to $X8_IDENTITY_FAILURE_MARKER (best-effort only; this is not the original error)" >&2
    return 0
  fi
  chmod 600 "$temporary" 2>/dev/null || true
  mv -f "$temporary" "$X8_IDENTITY_FAILURE_MARKER" 2>/dev/null || true
  echo "X8_RELEASE_IDENTITY_DEPLOY_FAILED=$X8_IDENTITY_FAILURE_MARKER" >&2
  echo "ERROR: $reason -- the previously committed release identity (if any) was left untouched; see $X8_IDENTITY_FAILURE_MARKER" >&2
  return 0
}

# 2026-09-06 patch work order, 决策二 / P0-1: the EXIT trap up_x8() installs
# right after write_x8_identity_candidate(). $? must be captured as the
# FIRST statement (before any other command changes it) and the trap must
# end by re-exiting with that same status, so installing this trap never
# changes `up`'s actual exit behavior for a caller/CI -- it only adds the
# failure-marker side effect when the deploy did not reach promotion.
x8_up_exit_trap() {
  local status=$?
  if [[ -n "${X8_IDENTITY_DEPLOY_IN_PROGRESS:-}" ]]; then
    x8_mark_identity_deploy_failed "'up' exited with status $status after the candidate identity was written but before it was promoted"
  fi
  exit "$status"
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
  # X8 release-identity gate work order (2026-09-05), 施工项一 4.3(一), amended
  # by the 2026-09-06 patch work order (决策二): the CANDIDATE deploy identity
  # is registered right after a successful build, before any container
  # starts (including postgres, which prepare_database() below would
  # otherwise bring up first) -- preserving the original intent. It is not
  # yet the committed identity the gate command reads.
  write_x8_identity_candidate

  # 决策二 / P0-1: from here until the candidate is promoted, ANY exit --
  # whether via `set -e`, an explicit `exit` inside a helper (several in
  # this file call `exit` directly rather than `return`), or a signal --
  # must leave the previously committed identity (if any) untouched and
  # leave a readable record that this deploy did not finish. Registered as
  # an EXIT trap (not ERR) specifically because it must also fire for a
  # direct `exit N` call, which does not trigger an ERR trap.
  X8_IDENTITY_DEPLOY_IN_PROGRESS=1
  trap 'x8_up_exit_trap' EXIT
  prepare_database
  x8_compose up -d web worker scheduler

  # 2026-09-06 patch (second round), group 1 P0: `up -d` only confirms these
  # three containers were CREATED and started -- nothing about whether the
  # application inside actually came up. Before this line existed, the only
  # health confirmation anywhere in `up` was the HTTP probes against nginx
  # further down, and those only ever exercise web (via
  # https://novel.test/api/health and the admin-domain equivalent) --
  # neither worker nor scheduler was ever confirmed healthy before the
  # candidate identity got promoted a few lines down. A worker that starts
  # and immediately exits (or never passes its own healthcheck) would still
  # let `up` proceed straight to a successful, committed deploy. All three
  # services declare a healthcheck in docker-compose.yml; this polls the
  # exact same mechanism the gate command's own post-recreate check already
  # relies on (x8_gate_wait_ready()) and fails `up` -- before promotion,
  # while the EXIT trap above is still armed -- the moment any of them is
  # not running/healthy.
  x8_wait_services_healthy web worker scheduler

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

  # 决策二: every probe above passed -- promote the candidate onto the
  # committed identity file. 2026-09-06 patch (second round), group 1 P0:
  # promote_x8_identity_candidate() itself clears
  # X8_IDENTITY_DEPLOY_IN_PROGRESS the instant its `mv` lands (see that
  # function's own comment) rather than as a separate statement here -- so a
  # failure in ITS OWN post-mv cleanup can never make the EXIT trap
  # misreport "the previously committed identity was left untouched" for an
  # identity that was, in fact, just committed. Anything that fails from
  # here on (backup-timer, admin-seed) is a real deploy that already
  # succeeded running into a separate, later problem -- not a reason to
  # claim the identity itself never landed.
  promote_x8_identity_candidate

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
# 2026-09-06 patch work order, P1-9: `x8_compose ps -q <service> 2>/dev/null
# || true` cannot tell "the query itself failed" (docker daemon down, a
# compose/env rendering error, ...) apart from "there genuinely is no such
# container" -- both come back as an empty string, and the caller silently
# treated that as success. Runs the query with stderr captured separately;
# a non-zero exit is reported as a hard failure, never folded into "no
# container". 2026-09-06 patch (second round), group 4: switched from
# x8_compose() to x8_gate_compose() -- see gate_catalog_status()'s own
# comment for why the non-identity-bound wrapper was the actual bug here.
x8_gate_query_container() {
  local service="$1"
  local err_file container status=0
  err_file="$(mktemp "$X8_GATE_TMPDIR/x8-gate-query-err.XXXXXX")"
  # Terminal review, release-identity gate second round: one self-clearing
  # RETURN trap instead of the two hand-duplicated `rm -f "$err_file"` calls
  # this function used to have (one per return path) -- see the identical
  # pattern (and its rationale) in x8_gate_actual_matches_baseline() above.
  trap 'rm -f "$err_file"; trap - RETURN' RETURN
  container="$(x8_gate_compose ps -q "$service" 2>"$err_file")" || status=$?
  if [[ $status -ne 0 ]]; then
    echo "ERROR: X8 gate status query failed while checking the $service service (exit $status): $(tr -d '\r\n' <"$err_file")" >&2
    return 65
  fi
  printf '%s' "$container"
}

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

  # 2026-09-06 patch (second round), group 4: this used to just set
  # P1_12_COMPOSE_PROJECT to a hardcoded literal and query containers through
  # x8_compose(), the NON-identity-bound wrapper that reads
  # $X8_PROJECT_ROOT/docker-compose.yml directly. In a genuinely clean shell
  # (no leftover env from a prior `up` in the SAME shell), that compose
  # file's own required (`:?`) variables -- APP_VERSION, CPS_NOVEL_APP_IMAGE,
  # every DATABASE_URL, ... -- are unset, and `docker compose ... ps` fails
  # at compose-file interpolation time with a raw "required variable is
  # missing a value" error before this function's own diagnostics ever run
  # (confirmed against the real docker compose binary, not a stub, while
  # fixing this). prepare_x8_gate_environment() is the SAME read-only,
  # already-established-runtime-only, identity-derived environment builder
  # gate_catalog_recreate() and status_x8() already use -- it populates
  # every required compose variable from the committed release identity and
  # the secrets `up` already wrote, and x8_gate_compose() (used by
  # x8_gate_query_container() below) is bound to that same identity's own
  # project name and config-file list (P1-8), never $X8_PROJECT_ROOT. This
  # is what makes `gate catalog-write status` actually runnable in a clean
  # shell; it now requires the exact same already-established runtime every
  # other gate subcommand requires, rather than being the one command that
  # could somehow run without a committed identity while still silently
  # failing on the compose call it needed that identity for anyway.
  prepare_x8_gate_environment || return 65
  require_command docker

  # P1-9: both services are checked, and a query failure (as opposed to a
  # confirmed absence) is a hard error -- fail-closed instead of the
  # previous web-only, "any failure reads as no container" behavior.
  local web_container worker_container
  web_container="$(x8_gate_query_container web)" || return 65
  worker_container="$(x8_gate_query_container worker)" || return 65

  if [[ -z "$web_container" && -z "$worker_container" ]]; then
    echo "X8_CATALOG_GATE_CONTAINER_CHECK=skipped (no running web/worker containers)"
    return 0
  fi
  if [[ -z "$web_container" || -z "$worker_container" ]]; then
    echo "X8_CATALOG_GATE_CONTAINER_CHECK=drift"
    printf '%s\n' \
      "WARNING: X8 catalog-write gate status: only one of web/worker has a running container (web='${web_container:-<none>}' worker='${worker_container:-<none>}') -- the gate command requires both to be running" >&2
    return 0
  fi

  local expected_enabled expected_write
  case "$persisted" in
    apply) expected_enabled=true; expected_write=true ;;
    dry-run) expected_enabled=true; expected_write=false ;;
    closed) expected_enabled=false; expected_write=false ;;
  esac
  local web_enabled web_write worker_enabled worker_write
  web_enabled="$(x8_container_env_value "$web_container" FEATURE_NOVEL_CATALOG_SYNC)"
  web_write="$(x8_container_env_value "$web_container" NOVEL_CATALOG_SYNC_ALLOW_WRITE)"
  worker_enabled="$(x8_container_env_value "$worker_container" FEATURE_NOVEL_CATALOG_SYNC)"
  worker_write="$(x8_container_env_value "$worker_container" NOVEL_CATALOG_SYNC_ALLOW_WRITE)"
  if [[ "$web_enabled" == "$expected_enabled" && "$web_write" == "$expected_write" \
    && "$worker_enabled" == "$expected_enabled" && "$worker_write" == "$expected_write" ]]; then
    echo "X8_CATALOG_GATE_CONTAINER_CHECK=match"
  else
    echo "X8_CATALOG_GATE_CONTAINER_CHECK=drift"
    printf '%s\n' \
      "WARNING: X8 catalog-write gate drift: state=$persisted (expects FEATURE_NOVEL_CATALOG_SYNC=$expected_enabled NOVEL_CATALOG_SYNC_ALLOW_WRITE=$expected_write) actual web=FEATURE_NOVEL_CATALOG_SYNC=$web_enabled/NOVEL_CATALOG_SYNC_ALLOW_WRITE=$web_write worker=FEATURE_NOVEL_CATALOG_SYNC=$worker_enabled/NOVEL_CATALOG_SYNC_ALLOW_WRITE=$worker_write" >&2
  fi
}

# 2026-09-06 patch work order, P2-12, generalized by the 2026-09-06 patch
# (second round), group 1: reads verification (image digest, gate values,
# ...) directly off `docker inspect`, which is available the moment a
# container is *created* -- it proves nothing about whether the application
# inside actually came up. Polls the compose healthcheck status before
# verification runs. Originally written for the gate command's post-recreate
# check (web/worker only); `up_x8()` now reuses it verbatim for its own
# post-`up` health wait (web/worker/scheduler, see x8_wait_services_healthy()
# below), so the message below no longer assumes "recreate" is what just
# happened. Every service either caller touches already declares a
# healthcheck in docker-compose.yml, so a container stuck in "starting" (or
# without a Health block at all, which would be a compose-file regression)
# is treated as not-yet-ready rather than silently skipped.
x8_gate_wait_ready() {
  local container="$1" service="$2"
  # Overridable only so this repo's own test suite can exercise the timeout
  # path in milliseconds instead of real seconds; production callers never
  # set these and get the real 30x1s poll.
  local retries="${X8_GATE_READY_RETRIES:-30}"
  local sleep_seconds="${X8_GATE_READY_SLEEP_SECONDS:-1}"
  local status="" i
  for i in $(seq 1 "$retries"); do
    status="$(docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || true)"
    [[ "$status" == "healthy" ]] && return 0
    sleep "$sleep_seconds"
  done
  echo "ERROR: $service container did not report healthy (last status: '${status:-unknown}')" >&2
  return 1
}

# 2026-09-06 patch (second round), group 1 P0: shared by `up_x8()` (confirm
# web/worker/scheduler are actually healthy before the release identity is
# promoted -- see that call site) and available for any future caller that
# needs the same "resolve by service name, then poll until healthy"
# guarantee. Resolves each service's container fresh by name (via
# x8_compose, the topology this function is always used against before any
# release identity exists) rather than trusting a caller-supplied id, so a
# service that never started at all (e.g. it crash-looped and compose gave
# up) is reported the same way as one that started but never became
# healthy -- both are failures, neither is silently skipped.
x8_wait_services_healthy() {
  local service container
  for service in "$@"; do
    container="$(x8_compose ps -q "$service" 2>/dev/null || true)"
    [[ -n "$container" ]] || {
      echo "ERROR: $service container does not exist after 'docker compose up' (it may have failed to start or exited immediately)" >&2
      return 1
    }
    x8_gate_wait_ready "$container" "$service" || return 1
  done
}

# 2026-09-06 patch work order, P0-2 support, REWRITTEN by the 2026-09-06
# patch (second round), group 3: re-resolves web/worker fresh by service
# name (never a stale container id -- --force-recreate replaces the
# container object) and verifies every identity-relevant field. The
# structural checks (readiness, frozen image digest, container labels
# front-and-back including the P1-8 working-dir check) stay as explicit,
# individually-diagnosed per-service checks. What changed is the
# ENVIRONMENT check: the pre-patch version hand-verified exactly five keys
# beyond the catalog-write pair (PROMO_CLAIM_ROLES/ADMIN_TWO_FACTOR_ENFORCEMENT
# for web, WORKER_TASK_ALLOWLIST for worker) against whatever this shell
# happened to have exported -- the EXACT SAME curated-whitelist mistake
# 决策一 already eliminated from the PRE-operation check, just relocated to
# the POST-operation one. This now takes the full expected render (the same
# `docker compose config` JSON gate_catalog_recreate() already produces for
# the target it is verifying -- candidate_file for the primary recreate,
# baseline_file for a rollback) and reconciles it against the containers'
# actual live environment via the identical full-declared-environment
# machinery the pre-check already uses (x8_gate_actual_matches_baseline /
# findActualDrift, same BASE_IMAGE_BAKED_KEYS exemption, same
# CATALOG_GATE_ENV_KEYS required-key check) -- so ANY declared variable that
# doesn't land where the render says it should (the promo double-gate, the
# preview source allowlist, a stray future flag, ...) fails verification,
# not just those five. On success prints nothing and returns 0. On the
# first mismatch it finds, prints one or more diagnostic lines to stdout
# (captured by the caller) and returns 1 -- used both for the primary
# post-recreate check and, with the pre-operation render, to confirm a
# rollback actually restored consistency.
x8_gate_verify_recreate() {
  local expected_render_file="$1"
  local new_web new_worker
  new_web="$(x8_gate_compose ps -q web 2>/dev/null || true)"
  new_worker="$(x8_gate_compose ps -q worker 2>/dev/null || true)"
  local service container pair
  for pair in "web:$new_web" "worker:$new_worker"; do
    service="${pair%%:*}"
    container="${pair#*:}"
    if [[ -z "$container" ]]; then
      echo "$service container is missing"
      return 1
    fi
    x8_gate_wait_ready "$container" "$service" >/dev/null 2>&1 || {
      echo "$service container did not become healthy"
      return 1
    }
    local post_image_id
    post_image_id="$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null || true)"
    if [[ "$post_image_id" != "$X8_IDENTITY_IMAGE_DIGEST" ]]; then
      echo "$service image drifted after recreate (expected $X8_IDENTITY_IMAGE_DIGEST got $post_image_id)"
      return 1
    fi
    local label_error
    if ! label_error="$(x8_check_container_labels "$container" "$service" 2>&1 >/dev/null)"; then
      echo "$label_error"
      return 1
    fi
  done

  local mismatch verify_status=0
  mismatch="$(x8_gate_actual_matches_baseline "$expected_render_file" "$new_web" "$new_worker" 2>&1)" || verify_status=$?
  if [[ "$verify_status" -ne 0 ]]; then
    echo "environment drifted after recreate: $mismatch"
    return 1
  fi
  return 0
}

# 2026-09-06 patch work order, P0-2 support: prints the actual, live
# identity-relevant environment of both web and worker (resolved fresh by
# service name), for the FATAL "rollback also failed" report -- the operator
# reading this output needs to know exactly what each service currently has,
# not just that something is wrong.
x8_gate_actual_snapshot() {
  local service container
  for service in web worker; do
    container="$(x8_gate_compose ps -q "$service" 2>/dev/null || true)"
    if [[ -z "$container" ]]; then
      echo "  $service: NO CONTAINER"
      continue
    fi
    echo "  $service: FEATURE_NOVEL_CATALOG_SYNC=$(x8_container_env_value "$container" FEATURE_NOVEL_CATALOG_SYNC) NOVEL_CATALOG_SYNC_ALLOW_WRITE=$(x8_container_env_value "$container" NOVEL_CATALOG_SYNC_ALLOW_WRITE) image=$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null || echo '?')"
  done
}

# X8 release-identity gate work order (2026-09-05), 施工项一: the single-
# variable recreate for the catalog-write gate. Implements 4.3(二)(三)(四)
# (五)(六)(七); the 2026-09-06 patch work order additionally closes:
#   - P1-6: the entire environment now comes from prepare_x8_gate_environment()
#     (scripts/lib/x8-production-like-env.sh), which builds it directly from
#     the release identity -- it never runs prepare_x8_environment()'s
#     HEAD/package.json-dependent provisioning flow and then overwrites four
#     fields after the fact.
#   - P1-8: every compose invocation in this function uses x8_gate_compose()
#     (bound to the identity's own project name and config-file list, never
#     $X8_PROJECT_ROOT), the working-dir label is checked front-and-back
#     (x8_check_container_labels), and labels are re-checked after recreate
#     (inside x8_gate_verify_recreate()), not only before.
#   - P0-2: a recreate that does not fully verify -- whether the `up` command
#     itself failed, or it exited 0 but post-recreate verification finds
#     drift -- is no longer just reported and abandoned. If the environment
#     already still matches the pre-operation values exactly, there is
#     genuinely nothing to roll back (the original, correct comment for that
#     one specific case). Otherwise this is a PARTIAL success -- one or both
#     services moved and the other didn't, exactly the "web closed, worker
#     still open" hazard the patch work order names -- and a compensating
#     recreate back to the pre-operation values is attempted and
#     re-verified. If that also fails to fully verify, this fails loudly
#     with the actual live state of both services; the gate state file is
#     never written in any of these paths.
#   - P2-12: post-recreate verification waits for both containers to report
#     healthy before reading anything off them.
gate_catalog_recreate() {
  local action="$1" apply="$2"
  prepare_x8_gate_environment || return 65
  local persisted="$X8_GATE_PERSISTED_STATE"

  local target
  case "$action" in
    on) target=apply ;;
    off) target=closed ;;
    dry-run) target=dry-run ;;
  esac

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
  web_container="$(x8_gate_compose ps -q web 2>/dev/null || true)"
  worker_container="$(x8_gate_compose ps -q worker 2>/dev/null || true)"
  [[ -n "$web_container" && -n "$worker_container" ]] || {
    echo "ERROR: X8 gate command requires web and worker to already be running (run 'up' first)" >&2
    return 65
  }

  # 4.3(四) / P1-8: container labels, front-and-back (including working
  # directory), never as identity source.
  x8_check_container_labels "$web_container" web || return 65
  x8_check_container_labels "$worker_container" worker || return 65

  local baseline_file candidate_file
  baseline_file="$(mktemp "$X8_GATE_TMPDIR/x8-gate-baseline.XXXXXX")"
  candidate_file="$(mktemp "$X8_GATE_TMPDIR/x8-gate-candidate.XXXXXX")"
  # Terminal review, release-identity gate second round, finding 二: these
  # two files used to be cleaned up by a hand-duplicated `rm -f
  # "$baseline_file" "$candidate_file"` immediately before every one of this
  # function's ~9 return points -- easy to add a tenth return path later and
  # forget the pair, and it does nothing at all for the one exit path that
  # was never covered: this function is called at the top level (never
  # inside a tested `if`/`||`), so a raw SIGINT/SIGTERM delivered while it is
  # blocked in the (potentially slow) `docker compose up` call below
  # terminates the process immediately, running neither the next line nor
  # any of the manual `rm -f`s. An EXIT trap is bash's actual mechanism for
  # "runs no matter how this process stops" -- confirmed empirically before
  # relying on it here: `trap CMD EXIT` (deliberately WITHOUT also trapping
  # INT/TERM, which would override their default terminate-the-process
  # behavior and require this function to re-implement it) still fires CMD
  # and the process still dies on SIGTERM exactly as it would with no trap
  # at all. Safe to install process-wide here because nothing else in this
  # function's call graph (x8_gate_rendered_diff, x8_gate_actual_matches_baseline,
  # x8_gate_verify_recreate, write_x8_gate_state, x8_gate_actual_snapshot)
  # ever touches the EXIT trap itself -- they use their own, independent,
  # self-clearing RETURN traps instead, which cannot clobber this one.
  #
  # Deliberately DOUBLE-quoted, not single-quoted: this function returns
  # normally on every non-signal path (success or any of its `return N`
  # statements), and only much later -- once the whole script has unwound
  # all the way back to its own end -- does the process actually exit and
  # this trap fire. By then $baseline_file/$candidate_file (both `local` to
  # THIS function invocation) are long out of scope, so a single-quoted trap
  # body (which defers `$baseline_file`/`$candidate_file` expansion to
  # fire-time) would hit "unbound variable" under this script's `set -u`.
  # Double-quoting expands them immediately, right here, embedding the two
  # literal resolved paths into the trap's command text -- correct whether
  # the trap ends up firing seconds from now (SIGINT/SIGTERM while blocked in
  # the `docker compose up` call below) or only after this function has long
  # since returned.
  trap "rm -f '$baseline_file' '$candidate_file'" EXIT
  if ! x8_gate_compose config --format json >"$baseline_file"; then
    return 65
  fi

  local target_enabled target_write
  case "$target" in
    apply) target_enabled=true; target_write=true ;;
    dry-run) target_enabled=true; target_write=false ;;
    closed) target_enabled=false; target_write=false ;;
  esac
  if ! FEATURE_NOVEL_CATALOG_SYNC="$target_enabled" NOVEL_CATALOG_SYNC_ALLOW_WRITE="$target_write" \
    x8_gate_compose config --format json >"$candidate_file"; then
    return 65
  fi

  local diff_output
  if ! diff_output="$(x8_gate_rendered_diff "$baseline_file" "$candidate_file")"; then
    echo "ERROR: X8 gate rendered-config gate failed: a field outside the requested catalog-write flags would change (see above)" >&2
    return 65
  fi

  # 4.3(五) / P0-3 / P0-4: the third leg -- baseline (persisted intent) vs.
  # what the containers actually have right now, reconciled key-for-key
  # (fail-closed on anything missing or extra), not a curated 7-key list.
  if ! x8_gate_actual_matches_baseline "$baseline_file" "$web_container" "$worker_container"; then
    echo "ERROR: X8 gate pre-check failed: the running containers do not match the persisted catalog-gate state (see drift above); the environment is not self-consistent enough for a single-variable recreate -- reconcile out of band (e.g. re-run 'up') first" >&2
    return 65
  fi

  echo "=== X8 gate command: frozen pre-state ==="
  echo "project=$X8_IDENTITY_COMPOSE_PROJECT level=$X8_IDENTITY_LEVEL image=$X8_IDENTITY_IMAGE_REF image_digest=$X8_IDENTITY_IMAGE_DIGEST"
  echo "persisted_gate=$persisted requested_action=$action target_gate=$target"
  echo "=== rendered config gate: PASS (only the catalog-write gate variables differ) ==="
  echo "$diff_output"
  echo "=== three-way check: PASS (state file, rendered candidate, and container runtime agree outside the requested change) ==="

  # 4.3(七): plan mode is the default. Nothing above this point wrote
  # anything to disk or touched a container.
  if [[ "$apply" != "true" ]]; then
    echo "X8_GATE_PLAN=PASS"
    echo "No production-like action was executed (pass --apply to recreate)."
    return 0
  fi

  # 2026-09-06 patch (second round), group 3: baseline_file (the persisted /
  # pre-operation render) and candidate_file (the target render) stay alive
  # for the rest of this apply flow (the EXIT trap installed above is what
  # now removes them, on every path, including this function's own normal
  # return -- see that trap's comment). candidate_file is exactly the full
  # expected post-recreate environment x8_gate_verify_recreate() now
  # reconciles against instead of a curated key list; baseline_file is
  # exactly what a rollback must be re-verified
  # against. Every exit point below removes them explicitly.

  # Pre-operation (persisted) gate values -- the exact pair the environment
  # must be restored to if apply does not fully verify (P0-2).
  local pre_enabled pre_write
  case "$persisted" in
    apply) pre_enabled=true; pre_write=true ;;
    dry-run) pre_enabled=true; pre_write=false ;;
    closed) pre_enabled=false; pre_write=false ;;
  esac

  echo "=== recreating web worker (--no-build --pull never) ==="
  local recreate_status=0
  FEATURE_NOVEL_CATALOG_SYNC="$target_enabled" NOVEL_CATALOG_SYNC_ALLOW_WRITE="$target_write" \
    x8_gate_compose up -d --no-deps --no-build --pull never --force-recreate web worker || recreate_status=$?

  # `var="$(cmd)"` propagates a failing `cmd`'s exit status to the
  # assignment itself, which `set -e` treats as a failing simple command --
  # these verification calls are EXPECTED to return non-zero on the failure
  # paths this function exists to handle, so each is paired with
  # `|| status=$?` to capture that status without aborting the script.
  local mismatch verify_status=0
  mismatch="$(x8_gate_verify_recreate "$candidate_file")" || verify_status=$?

  # 2026-09-06 patch (second round), group 2: the FINAL write of the gate
  # state file used to happen unconditionally after this point with no
  # failure path of its own. If recreate and verification both succeeded but
  # write_x8_gate_state() then failed (e.g. the runtime directory briefly
  # unwritable, disk full), `set -e` would abort this function right there:
  # the containers would already be at the NEW target values, the state
  # file would still hold the OLD persisted value, and neither the
  # compensating rollback below nor any diagnostic would ever run -- the
  # exact class of drift this gate command exists to prevent, now produced
  # by its own last step. write_x8_gate_state() is only attempted once
  # recreate+verify have already succeeded, and its failure is folded into
  # the SAME state_write_status check below, so it goes through the
  # identical compensating-rollback path as a recreate or verify failure.
  local state_write_status=0
  if [[ "$recreate_status" -eq 0 && "$verify_status" -eq 0 ]]; then
    case "$target" in
      apply) write_x8_gate_state apply ;;
      dry-run) write_x8_gate_state dry-run ;;
      closed) write_x8_gate_state closed ;;
    esac || state_write_status=$?
  fi

  if [[ "$recreate_status" -ne 0 || "$verify_status" -ne 0 || "$state_write_status" -ne 0 ]]; then
    # Did the attempt actually change anything? If both services are still
    # (or already back) at the pre-operation values, there is genuinely
    # nothing to roll back -- this is the one case where "state left
    # unchanged, nothing to roll back" is simply true rather than assumed.
    # Re-verifies against baseline_file with the SAME full reconciliation
    # used everywhere else in this function, not a narrower check.
    local already_at_pre
    already_at_pre="$(x8_gate_verify_recreate "$baseline_file")" || true
    if [[ -z "$already_at_pre" ]]; then
      if [[ "$state_write_status" -ne 0 ]]; then
        echo "ERROR: X8 gate recreate and verification succeeded and both services already matched the pre-operation values (a no-op flip), but writing the new gate state failed (exit $state_write_status); nothing to roll back, gate state left unchanged at '$persisted'" >&2
      else
        echo "ERROR: recreate failed (exit $recreate_status); X8 catalog gate state left unchanged at '$persisted' (nothing was written, and both services are still at the pre-operation values -- nothing to roll back)" >&2
      fi
      return 65
    fi

    # P0-2 (and, since this round, a state-write failure too): a genuine
    # partial success -- one or both services moved off the pre-operation
    # values without the outcome being safely recorded either. This is
    # exactly the "web closed, worker still open" hazard (or its state-file
    # equivalent: containers moved, state file didn't): attempt a
    # compensating recreate back to the pre-operation values for BOTH
    # services and re-verify, rather than leaving the running containers at
    # (or split between) a value the persisted state disagrees with.
    if [[ "$state_write_status" -ne 0 ]]; then
      echo "ERROR: X8 gate recreate and verification succeeded, but writing the new gate state failed (exit $state_write_status); attempting a consistency rollback to the pre-operation values ('$persisted')..." >&2
    else
      echo "ERROR: X8 gate recreate did not verify cleanly (reason: $mismatch); attempting a consistency rollback to the pre-operation values ('$persisted')..." >&2
    fi
    local rollback_status=0
    X8_GATE_ROLLBACK=1 FEATURE_NOVEL_CATALOG_SYNC="$pre_enabled" NOVEL_CATALOG_SYNC_ALLOW_WRITE="$pre_write" \
      x8_gate_compose up -d --no-deps --no-build --pull never --force-recreate web worker || rollback_status=$?
    local rollback_mismatch rollback_verify_status=0
    rollback_mismatch="$(x8_gate_verify_recreate "$baseline_file")" || rollback_verify_status=$?

    if [[ "$rollback_status" -ne 0 || "$rollback_verify_status" -ne 0 ]]; then
      echo "FATAL: X8 catalog gate rollback ALSO failed (reason: ${rollback_mismatch:-recreate exited $rollback_status}) -- the environment is now INCONSISTENT between web and worker and requires manual reconciliation." >&2
      echo "Gate state file was left at '$persisted' (never written during this attempt), but the running containers may not reliably match it or each other. Actual current state:" >&2
      x8_gate_actual_snapshot >&2
      echo "Inspect both containers by hand; a clean recovery path is normally re-running 'up' to re-establish a consistent baseline." >&2
      return 70
    fi
    echo "ERROR: recreate did not verify cleanly; rolled back successfully -- both services restored to the pre-operation values (gate state unchanged at '$persisted')" >&2
    return 65
  fi

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

# 2026-09-06 patch work order, P2-10: the top-level `status` query, split
# out of the side-effecting prepare_x8_environment() the same way 施工项一
# 4.3(九) already split `gate catalog-write status` -- a caller who only
# wants to look must never provision a directory, a secret file, or a
# default gate-state file as a side effect of looking. Reuses
# prepare_x8_gate_environment() (identity-only, already-established runtime
# required, zero provisioning) rather than a second bespoke read path.
status_x8() {
  prepare_x8_gate_environment || return 65
  x8_gate_compose ps
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

# 2026-09-06 patch (second round), group 1 test support: only dispatch a
# subcommand when this file is being executed directly. Every real caller
# (a human at a terminal, a doc's copy-pasted command, this repo's own CI)
# always runs `bash scripts/x8-production-like.sh ...` or
# `./scripts/x8-production-like.sh ...` -- in both cases BASH_SOURCE[0] and
# $0 are identical, so this branch is unconditionally taken and nothing
# about real-world behavior changes. What this DOES enable: this repo's own
# test suite can `source` this file to call its functions directly (e.g.
# write_x8_identity_candidate / promote_x8_identity_candidate /
# x8_mark_identity_deploy_failed / x8_wait_services_healthy) and exercise
# the actual candidate-write -> health-check -> promote-or-fail chain
# end-to-end against a stub docker, instead of only ever hand-writing the
# identity files a real `up` would have produced and checking how later
# commands read them.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  command="${1:-}"
  case "$command" in
    setup) [[ $# -eq 1 ]] || usage; setup_x8 ;;
    up) [[ $# -eq 1 ]] || usage; up_x8 ;;
    down) shift; [[ $# -le 1 ]] || usage; down_x8 "${1:-}" ;;
    status) [[ $# -eq 1 ]] || usage; status_x8 ;;
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
fi
