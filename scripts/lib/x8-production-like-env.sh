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
# X8 release-identity gate work order (2026-09-05), amended by the
# 2026-09-06 patch work order (决策二: candidate vs. committed identity).
# X8_IDENTITY_FILE is the COMMITTED identity -- the only one any gate
# operation ever reads (resolve_x8_identity() in x8-production-like.sh).
# X8_IDENTITY_CANDIDATE_FILE is written by `up` right after a successful
# build, before any container starts (preserving the original, correct
# "on disk before anything starts" intent) -- but it is NOT the committed
# identity yet. Only once database prep, container start, and the health
# probes all pass does `up` promote the candidate onto X8_IDENTITY_FILE
# (write_x8_identity_candidate() / promote_x8_identity_candidate() in
# x8-production-like.sh). If `up` fails anywhere in between, the previously
# committed identity (if any) is left completely untouched, and
# X8_IDENTITY_FAILURE_MARKER records that the deploy did not complete.
X8_IDENTITY_FILE="$X8_RUNTIME_DIR/release-identity.json"
X8_IDENTITY_CANDIDATE_FILE="$X8_RUNTIME_DIR/release-identity.candidate.json"
X8_IDENTITY_FAILURE_MARKER="$X8_RUNTIME_DIR/release-identity.failed.txt"
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
#
# Owner fix (release-identity gate third round): accepts an OPTIONAL second
# argument -- the levels-file path to read -- defaulting to $X8_LEVELS_FILE
# (the current worktree's own copy) so every pre-existing caller
# (prepare_x8_environment(), x8_expected_worker_allowlist()) is unchanged.
# prepare_x8_gate_environment() is the one caller that passes an explicit
# path: the release identity's own recorded levelsFile, only after
# independently verifying its content digest still matches what 'up' froze
# (see that function and x8_file_sha256()) -- never a fresh, possibly-since-
# edited read of this worktree's file.
x8_level_config() {
  local level="$1"
  local levels_file="${2:-$X8_LEVELS_FILE}"
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
  ' "$levels_file" "$level"
}

# Owner fix (release-identity gate third round): the one place a file's
# content digest is computed, used both to freeze the level table's digest
# into the release identity at `up` time (write_x8_identity_candidate() in
# scripts/x8-production-like.sh) and to re-verify it before the gate command
# ever resolves that table (prepare_x8_gate_environment() below). node's
# crypto module, not `shasum`/`sha256sum`, so the same code path runs
# identically on every platform this repo's scripts already require node for.
x8_file_sha256() {
  local file="$1"
  command -v node >/dev/null 2>&1 || {
    echo "ERROR: node is required to compute a file digest" >&2
    return 69
  }
  node -e '
    const fs = require("fs");
    const crypto = require("crypto");
    const path = process.argv[1];
    let data;
    try {
      data = fs.readFileSync(path);
    } catch (error) {
      process.stderr.write(`ERROR: unable to read file for digest: ${path} (${error.message})\n`);
      process.exit(65);
    }
    process.stdout.write(crypto.createHash("sha256").update(data).digest("hex"));
  ' "$file"
}

# Owner fix (release-identity gate third round): the safety-invariant check
# the gate command runs immediately after resolving the level table's flags
# and strictly before touching any container. The content-digest check in
# prepare_x8_gate_environment() only proves the level table has not changed
# since 'up' produced this release identity -- it says nothing about whether
# the table's CONTENT was ever safe. This asserts the SAME P2-06.5
# auto-classification ADR guard scripts/acceptance/x8-validate-compose.mjs
# enforces on the rendered compose config, reading it from the one shared
# definition (scripts/lib/x8-level-safety-invariants.mjs) so the two call
# sites can never silently diverge.
x8_assert_level_safety_invariants() {
  local level_config_lines="$1"
  node -e '
    const { pathToFileURL } = require("url");
    const [, invariantsModulePath, levelConfigLines] = process.argv;
    const flags = {};
    for (const line of levelConfigLines.split("\n")) {
      if (!line) continue;
      const index = line.indexOf("=");
      if (index <= 0) continue;
      flags[line.slice(0, index)] = line.slice(index + 1);
    }
    import(pathToFileURL(invariantsModulePath).href).then(({ findLevelSafetyInvariantViolations }) => {
      const violations = findLevelSafetyInvariantViolations(flags);
      if (violations.length === 0) return;
      for (const violation of violations) {
        process.stderr.write(
          `ERROR: X8 gate safety invariant violated (ADR guard): ${violation.key} must be "${violation.expected}" at every X8_LEVEL, got "${violation.actual}" -- refusing to touch any container.\n`,
        );
      }
      process.exit(65);
    }).catch((error) => {
      process.stderr.write(`ERROR: unable to load the X8 level safety invariant definitions: ${error.message}\n`);
      process.exit(70);
    });
  ' "$X8_PROJECT_ROOT/scripts/lib/x8-level-safety-invariants.mjs" "$level_config_lines"
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
    # 2026-09-06 patch, 决策二: a candidate (or a failure marker from a prior
    # attempt) with no committed identity means a previous `up` started but
    # never finished -- say so explicitly rather than the generic "run up"
    # message, which reads as "nothing has ever been attempted" when
    # something in fact was, and failed partway.
    if [[ -f "$X8_IDENTITY_CANDIDATE_FILE" || -f "$X8_IDENTITY_FAILURE_MARKER" ]]; then
      echo "ERROR: no committed X8 deploy identity file at $X8_IDENTITY_FILE -- the previous 'up' did not complete successfully (a candidate identity and/or failure marker exists but was never promoted)." >&2
      [[ -f "$X8_IDENTITY_FAILURE_MARKER" ]] && echo "See $X8_IDENTITY_FAILURE_MARKER for what failed." >&2
      echo "Run 'scripts/x8-production-like.sh up' again (with an explicit X8_LEVEL=0|uat|r) to complete a deploy before using the gate command." >&2
      return 65
    fi
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
    // Owner fix (release-identity gate third round): no real deploy has ever
    // written a release identity file, so there is no back-compat
    // obligation for schemaVersion 1 or 2 -- 3 (levelEnv REMOVED, replaced
    // by levelsFile/levelsFileDigest -- see below) is simply the only
    // accepted value now, and the version number is what actually changed,
    // not left stale.
    if (data.schemaVersion !== 3) {
      process.stderr.write(`ERROR: X8 deploy identity file has an unsupported schemaVersion (${JSON.stringify(data.schemaVersion)}); expected 3\n`);
      process.exit(65);
    }
    const requiredStrings = [
      "appVersion", "gitCommit", "level", "imageRef", "imageDigest", "composeProject", "buildDate",
      // Finding 三: the two values prepare_x8_gate_environment() used to
      // default from the callers ambient environment instead of reading
      // back from the frozen identity.
      "adminDomain", "credentialActiveKeyVersion",
      // Owner fix (release-identity gate third round): the level table
      // SOURCE -- its path and a content digest taken at deploy time --
      // never its resolved values. prepare_x8_gate_environment() re-reads this
      // exact path, re-verifies the digest, and only then resolves it via
      // the ordinary x8_level_config() (this is the fix for the previous
      // schemaVersion 2, which embedded `levelEnv` and froze RESOLVED values
      // instead of binding to a verifiable source, exactly like
      // composeConfigFiles/imageDigest already do for the compose files and
      // image).
      "levelsFile", "levelsFileDigest",
    ];
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
    // Owner fix (release-identity gate third round): levelsFile must be an
    // absolute path (the same convention composeConfigFiles already uses,
    // enforced in bash below) and levelsFileDigest must look like a real
    // sha256 hex digest -- catches an obviously-corrupt identity here,
    // before prepare_x8_gate_environment() ever tries to open the path or
    // compare digests.
    if (!data.levelsFile.startsWith("/")) {
      process.stderr.write(`ERROR: X8 deploy identity file has an invalid "levelsFile" (must be an absolute path, got ${JSON.stringify(data.levelsFile)})\n`);
      process.exit(65);
    }
    if (!/^[0-9a-f]{64}$/i.test(data.levelsFileDigest)) {
      process.stderr.write("ERROR: X8 deploy identity file has an invalid \"levelsFileDigest\" (must be a sha256 hex digest)\n");
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
      `ADMIN_DOMAIN=${data.adminDomain}`,
      `CREDENTIAL_ACTIVE_KEY_VERSION=${data.credentialActiveKeyVersion}`,
      `LEVELS_FILE=${data.levelsFile}`,
      `LEVELS_FILE_DIGEST=${data.levelsFileDigest}`,
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
  X8_IDENTITY_ADMIN_DOMAIN=""
  X8_IDENTITY_CREDENTIAL_ACTIVE_KEY_VERSION=""
  X8_IDENTITY_LEVELS_FILE=""
  X8_IDENTITY_LEVELS_FILE_DIGEST=""
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
      ADMIN_DOMAIN) X8_IDENTITY_ADMIN_DOMAIN="$value" ;;
      CREDENTIAL_ACTIVE_KEY_VERSION) X8_IDENTITY_CREDENTIAL_ACTIVE_KEY_VERSION="$value" ;;
      LEVELS_FILE) X8_IDENTITY_LEVELS_FILE="$value" ;;
      LEVELS_FILE_DIGEST) X8_IDENTITY_LEVELS_FILE_DIGEST="$value" ;;
    esac
  done <<<"$parsed"
  # Belt-and-suspenders: the node script above already exits 65 on a missing
  # level, but never let a run level fall back silently for any other reason
  # either (e.g. a future field-parsing change) -- undecidable always fails.
  if [[ -z "$X8_IDENTITY_LEVEL" ]]; then
    echo "ERROR: X8 deploy identity file does not resolve to a run level" >&2
    return 65
  fi
  # 2026-09-06 patch work order, P1-8: the working directory Compose stamped
  # onto every container it created (com.docker.compose.project.working_dir)
  # is always the directory of the first `-f` file in that invocation -- so
  # deriving the *expected* value from the identity's own first recorded
  # config file (rather than the current script's $X8_PROJECT_ROOT) is what
  # lets x8_check_container_labels() catch "a different worktree, pointed at
  # the same runtime dir, silently recreating with its own directory's
  # files" instead of only comparing the config-files list itself.
  local first_config_file="${X8_IDENTITY_COMPOSE_CONFIG_FILES%%,*}"
  # Pure string dirname -- deliberately never `cd`/`pwd` this, so a still-
  # valid identity file whose recorded path happens not to exist right now
  # (a stale identity for a runtime dir that was relocated, or -- as in this
  # repo's own tests -- an intentionally fixture-only path) still resolves
  # instead of failing for an unrelated filesystem reason.
  case "$first_config_file" in
    /*) X8_IDENTITY_WORKING_DIR="$(dirname "$first_config_file")" ;;
    *)
      echo "ERROR: X8 deploy identity file's composeConfigFiles must be absolute paths (got \"$first_config_file\")" >&2
      return 65
      ;;
  esac
  export X8_IDENTITY_APP_VERSION X8_IDENTITY_GIT_COMMIT X8_IDENTITY_LEVEL X8_IDENTITY_IMAGE_REF \
    X8_IDENTITY_IMAGE_DIGEST X8_IDENTITY_COMPOSE_PROJECT X8_IDENTITY_BUILD_DATE X8_IDENTITY_COMPOSE_CONFIG_FILES \
    X8_IDENTITY_WORKING_DIR X8_IDENTITY_ADMIN_DOMAIN X8_IDENTITY_CREDENTIAL_ACTIVE_KEY_VERSION \
    X8_IDENTITY_LEVELS_FILE X8_IDENTITY_LEVELS_FILE_DIGEST
}

write_x8_gate_state() {
  local state="$1"
  [[ "$state" == "dry-run" || "$state" == "apply" || "$state" == "closed" ]] || {
    echo "ERROR: invalid X8 catalog gate state: $state" >&2
    return 65
  }
  local temporary="${X8_GATE_STATE_FILE}.tmp.$$"
  # 2026-09-06 patch (third round), High finding: every call site invokes
  # this as the left operand of `||` (e.g. `case ... esac || state_write_status=$?`
  # in gate_catalog_write()) so it can capture a non-zero return without
  # aborting the caller. Bash's documented `-e` inertness for "part of any
  # command executed in a && or || list except the command following the
  # final && or ||" propagates into a called function's ENTIRE body for the
  # duration of that call -- confirmed empirically before relying on it here.
  # That means none of the three steps below can rely on `set -e` to stop
  # execution on failure; each one is checked explicitly instead. Without
  # this, a failure in the first two steps (disk full, quota, transient I/O
  # error) used to fall through to `chmod`/`mv` anyway -- `mv` renaming
  # whatever the temp file ended up containing (empty, truncated, or stale
  # leftover content) onto the real state file and returning 0, silently
  # corrupting the persisted gate state while every caller believed the
  # write had succeeded.
  if ! printf '%s\n' "$state" >"$temporary"; then
    echo "ERROR: failed to write X8 catalog gate state to temporary file '$temporary'" >&2
    rm -f "$temporary"
    return 65
  fi
  if ! chmod 600 "$temporary"; then
    echo "ERROR: failed to set permissions on X8 catalog gate state temporary file '$temporary'" >&2
    rm -f "$temporary"
    return 65
  fi
  if ! mv "$temporary" "$X8_GATE_STATE_FILE"; then
    echo "ERROR: failed to move X8 catalog gate state temporary file '$temporary' into place at '$X8_GATE_STATE_FILE'" >&2
    rm -f "$temporary"
    return 65
  fi
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
  # 2026-09-06 patch (second round), group 4: the P2-13 wording this replaced
  # said the repair command below is "only guaranteed to work if this exact
  # drift ... is the ONLY thing out of sync" -- implying such a case exists.
  # It does not: `gate catalog-write`'s own three-way pre-check
  # (x8_gate_actual_matches_baseline) reconciles the render of this SAME
  # persisted state against these SAME containers' full environment. Since
  # this warning already found that the persisted state and the actual web
  # container disagree on FEATURE_NOVEL_CATALOG_SYNC/NOVEL_CATALOG_SYNC_ALLOW_WRITE,
  # that pre-check is GUARANTEED to find the identical disagreement and
  # refuse -- there is no narrower case where the suggested command
  # succeeds. The only real recovery is re-running `up`, and specifically
  # with the SAME X8_LEVEL this environment was last brought up at: `up`
  # defaults to Level 0 when X8_LEVEL is unset, which would silently
  # downgrade (not repair) a Level UAT/R environment.
  printf '%s\n' \
    "WARNING: X8 catalog-write gate drift: state=$persisted (expects FEATURE_NOVEL_CATALOG_SYNC=$expected_enabled NOVEL_CATALOG_SYNC_ALLOW_WRITE=$expected_write) actual web container has FEATURE_NOVEL_CATALOG_SYNC=$actual_enabled NOVEL_CATALOG_SYNC_ALLOW_WRITE=$actual_write" \
    "This is NOT fixable by running 'gate catalog-write on --apply' (or off/dry-run): that command's own three-way pre-check reconciles the same persisted state against the same containers and is guaranteed to refuse for the identical reason this warning just fired." \
    "Re-run 'scripts/x8-production-like.sh up' to re-establish a consistent baseline -- with the SAME X8_LEVEL this environment was brought up at ('up' defaults to Level 0 when X8_LEVEL is unset, which would silently downgrade rather than repair a Level UAT/R environment)." >&2
}

# Static topology exports shared by prepare_x8_environment() (the full,
# provisioning-capable path) and prepare_x8_gate_environment() (the
# 2026-09-06 patch's read-only, identity-only path, P1-6). Kept in one place
# so the two paths cannot drift on a constant like a domain name or a port
# default -- none of these ever depend on X8_LEVEL, the release identity, or
# the live git worktree.
x8_export_static_topology() {
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
  export MOBOREADER_PREVIEW_SOURCE_APP_CODES=moboreader
  export X8_HTTP_PORT="${X8_HTTP_PORT:-80}"
  export X8_HTTPS_PORT="${X8_HTTPS_PORT:-443}"
  export X8_NGINX_IMAGE="${X8_NGINX_IMAGE:-nginx:1.28.0-alpine}"
  export X8_BACKUP_INTERVAL_SECONDS="${X8_BACKUP_INTERVAL_SECONDS:-86400}"
  export X8_BACKUP_RUN_ON_START="${X8_BACKUP_RUN_ON_START:-true}"
  export X8_RUNTIME_DIR X8_SECRET_DIR X8_TLS_DIR X8_NGINX_RUNTIME_DIR X8_BACKUP_DIR X8_EVIDENCE_DIR
  export X8_GATE_STATE_FILE X8_BACKUP_PGPASS_FILE X8_IDENTITY_FILE X8_IDENTITY_CANDIDATE_FILE X8_IDENTITY_FAILURE_MARKER
}

# Maps a persisted/target catalog-gate tri-state onto the two double-gate
# environment variables. Shared so the mapping can never disagree between
# prepare_x8_environment() and prepare_x8_gate_environment().
x8_export_catalog_gate_env() {
  local gate_state="$1"
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
    *)
      echo "ERROR: invalid X8 catalog gate state: $gate_state" >&2
      return 65
      ;;
  esac
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
  x8_export_static_topology
  x8_export_catalog_gate_env "$gate_state" || return 65
  # RC-2b: WORKER_TASK_ALLOWLIST and the four other double-gate pairs
  # (promo claim / sitemap / indexnow outbox / indexnow delivery) all come
  # from the single X8_LEVEL table (scripts/lib/x8-levels.json) instead of
  # being hard-coded here — this is the only place their values are set, so
  # X8_LEVEL=0 stays byte-for-byte what this file exported before RC-2b.
  # PR6 lane F added the P2-06.5 tagging double-gate (FEATURE_P2_06_5_TAGGING /
  # FEATURE_P2_06_5_TAG_ADMIN_WRITE) and the auto-classify pair
  # (FEATURE_NOVEL_TAG_AUTO / AUTO_WRITE_AUTHORIZED) to that same table's
  # `flags` object; the loop below exports whatever keys that object has, so
  # lane F needed no code change here. AUTO_WRITE_AUTHORIZED is a fail-closed
  # exact-match string ("YES" required) and this table must never carry
  # anything but "NO" until Owner authorizes auto-write (P2-06.5 ADR).
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

# 2026-09-06 patch work order, P1-6 ("闸门需要的环境应当直接由身份文件构造", not
# "run the HEAD-dependent prep flow, then overwrite four fields"). Builds the
# ENTIRE environment the catalog-write gate command (and, per P2-10, the
# read-only top-level `status` query) needs directly from the release
# identity file:
#   - never calls prepare_p1_12_local_environment() or anything that reads
#     the live git worktree's HEAD or package.json -- APP_VERSION,
#     GIT_COMMIT, CPS_NOVEL_APP_IMAGE, BUILD_DATE and NEXT_PUBLIC_BUILD_VERSION
#     all come only from the frozen identity (this is also the P2-11 fix: the
#     build-version variable is now covered by the same identity freeze as
#     the other four fields, instead of being silently recomputed);
#   - never mkdir's a directory or creates a secret/gate-state file -- every
#     directory and secret this function needs must already exist (created
#     by a prior `up`), or it fails outright rather than silently
#     provisioning a fresh one out from under a caller who only wanted to
#     read the gate's current plan;
#   - is therefore also what makes a directory-existence assertion of "up
#     never fully ran" instead of the previous silent bootstrap.
# Terminal review, release-identity gate second round, finding 二: every
# x8_gate_* temp file (scripts/x8-production-like.sh) used to build its
# mktemp template directly on "${TMPDIR:-/tmp}", trusting the caller's
# environment without question. A caller whose shell happens to have TMPDIR
# pointed AT (or inside) this environment's own runtime directory would then
# have the gate command's "plan mode / status make zero writes to the
# runtime directory" guarantee broken by construction -- a temp file would
# be created, however briefly, inside the very directory that guarantee is
# about. Resolved exactly once here, the single choke point every gate
# subcommand already goes through, and exported as X8_GATE_TMPDIR so
# scripts/x8-production-like.sh's own mktemp call sites never re-derive or
# re-validate it themselves. Fails closed (refuses) rather than silently
# substituting a different directory: an operator whose TMPDIR resolves
# inside the runtime directory almost certainly set it that way by mistake,
# and silently working around it would hide that mistake instead of
# surfacing it.
x8_resolve_gate_tmpdir() {
  local candidate="${TMPDIR:-/tmp}"
  local resolved_candidate resolved_runtime
  resolved_candidate="$(cd "$candidate" 2>/dev/null && pwd -P || true)"
  resolved_runtime="$(cd "$X8_RUNTIME_DIR" 2>/dev/null && pwd -P || true)"
  if [[ -n "$resolved_candidate" && -n "$resolved_runtime" ]]; then
    case "$resolved_candidate" in
      "$resolved_runtime" | "$resolved_runtime"/*)
        echo "ERROR: TMPDIR ('$candidate') resolves at or inside the X8 runtime directory ('$X8_RUNTIME_DIR') -- refusing to place temporary gate files there, which would defeat the gate command's zero-write guarantee for that directory. Unset TMPDIR or point it somewhere outside the runtime directory." >&2
        return 65
        ;;
    esac
  fi
  X8_GATE_TMPDIR="$candidate"
  export X8_GATE_TMPDIR
}

# resolve_x8_identity() (called first) is itself pure/read-only, so on
# failure this function has touched nothing at all.
prepare_x8_gate_environment() {
  resolve_x8_identity || return 65

  export X8_LEVEL="$X8_IDENTITY_LEVEL"
  export P1_12_COMPOSE_PROJECT="$X8_IDENTITY_COMPOSE_PROJECT"
  x8_export_static_topology
  x8_resolve_gate_tmpdir || return 65

  local dir
  for dir in "$X8_RUNTIME_DIR" "$X8_SECRET_DIR" "$X8_NGINX_RUNTIME_DIR" "$X8_TLS_DIR" "$X8_BACKUP_DIR"; do
    [[ -d "$dir" ]] || {
      echo "ERROR: X8 gate command requires an already-established runtime directory: $dir (run 'up' first -- the gate path never provisions one)" >&2
      return 65
    }
  done

  local secret_file
  for secret_file in postgres_admin.password migration_owner.password web_app.password worker_app.password \
    scheduler_app.password analyst_ro.password backup_role.password \
    totp.key credential-v1.key credential-fingerprint.key tracking-hash-salt.key; do
    [[ -f "$X8_SECRET_DIR/$secret_file" ]] || {
      echo "ERROR: X8 gate command requires an already-established secret file: $X8_SECRET_DIR/$secret_file (run 'up' first -- the gate path never creates one)" >&2
      return 65
    }
  done
  [[ -f "$X8_BACKUP_PGPASS_FILE" ]] || {
    echo "ERROR: X8 gate command requires an already-established file: $X8_BACKUP_PGPASS_FILE (run 'up' first)" >&2
    return 65
  }

  export P1_12_POSTGRES_ADMIN_PASSWORD_FILE="$X8_SECRET_DIR/postgres_admin.password"
  export P1_12_MIGRATION_OWNER_PASSWORD_FILE="$X8_SECRET_DIR/migration_owner.password"
  export P1_12_WEB_APP_PASSWORD_FILE="$X8_SECRET_DIR/web_app.password"
  export P1_12_WORKER_APP_PASSWORD_FILE="$X8_SECRET_DIR/worker_app.password"
  export P1_12_SCHEDULER_APP_PASSWORD_FILE="$X8_SECRET_DIR/scheduler_app.password"
  export P1_12_ANALYST_RO_PASSWORD_FILE="$X8_SECRET_DIR/analyst_ro.password"
  export P1_12_BACKUP_ROLE_PASSWORD_FILE="$X8_SECRET_DIR/backup_role.password"

  local migration_password web_password worker_password scheduler_password
  migration_password="$(read_secret_value "$P1_12_MIGRATION_OWNER_PASSWORD_FILE")"
  web_password="$(read_secret_value "$P1_12_WEB_APP_PASSWORD_FILE")"
  worker_password="$(read_secret_value "$P1_12_WORKER_APP_PASSWORD_FILE")"
  scheduler_password="$(read_secret_value "$P1_12_SCHEDULER_APP_PASSWORD_FILE")"
  export P1_12_MIGRATION_DATABASE_URL="postgresql://migration_owner:${migration_password}@postgres:5432/cps_novel?schema=public"
  export P1_12_WEB_DATABASE_URL="postgresql://web_app:${web_password}@postgres:5432/cps_novel?schema=public"
  export P1_12_WORKER_DATABASE_URL="postgresql://worker_app:${worker_password}@postgres:5432/cps_novel?schema=public"
  export P1_12_SCHEDULER_DATABASE_URL="postgresql://scheduler_app:${scheduler_password}@postgres:5432/cps_novel?schema=public"
  export TOTP_ENCRYPTION_KEY="$(read_secret_value "$X8_SECRET_DIR/totp.key")"
  export CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE="$X8_SECRET_DIR/credential-v1.key"
  export CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE="$X8_SECRET_DIR/credential-fingerprint.key"
  export TRACKING_HASH_SALT="$(read_secret_value "$X8_SECRET_DIR/tracking-hash-salt.key")"

  # Release identity, never the live git worktree (P1-6 / P2-11). Unlike
  # prepare_p1_12_local_environment()'s own "${NEXT_PUBLIC_BUILD_VERSION:-v${APP_VERSION}}"
  # convention -- which exists so a real deployment's environment can
  # deliberately override a derived default -- this path is READING BACK a
  # frozen, already-committed identity, not computing one: a caller's shell
  # having NEXT_PUBLIC_BUILD_VERSION set (however that happened) must never
  # be able to override what the identity says. 2026-09-06 patch (second
  # round), group 4: the previous `${NEXT_PUBLIC_BUILD_VERSION:-...}` form
  # was exactly the same class of bug P2-11 already fixed for this same
  # variable in a different shape -- a caller's ambient shell could still
  # inject a value here and have it silently win over the identity's own
  # appVersion. Every other field derived from the identity in this function
  # (APP_VERSION, GIT_COMMIT, CPS_NOVEL_APP_IMAGE, BUILD_DATE, immediately
  # above) is already unconditional; this is now consistent with them.
  export APP_VERSION="$X8_IDENTITY_APP_VERSION"
  export GIT_COMMIT="$X8_IDENTITY_GIT_COMMIT"
  export CPS_NOVEL_APP_IMAGE="$X8_IDENTITY_IMAGE_REF"
  export BUILD_DATE="$X8_IDENTITY_BUILD_DATE"
  export NEXT_PUBLIC_BUILD_VERSION="v${X8_IDENTITY_APP_VERSION}"
  # Terminal review, release-identity gate second round, finding 三: these
  # two used to be defaulted from the CALLER's ambient environment --
  # X8_ADMIN_DOMAIN inside x8_export_static_topology() (called above, via
  # "${X8_ADMIN_DOMAIN:-zbcwf.novel.test}") and CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION
  # directly in this function (via "${CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION:-1}").
  # Both are now unconditional overrides from the frozen identity, exactly
  # like APP_VERSION/GIT_COMMIT/etc. immediately above -- a caller's shell
  # having either ambient variable set (however that happened) must never
  # win over what this deploy's identity actually recorded.
  # ADMIN_CANONICAL_ORIGIN is re-derived here too: x8_export_static_topology()
  # already computed it from whatever X8_ADMIN_DOMAIN it saw, which is now
  # stale the moment X8_ADMIN_DOMAIN is overridden below.
  export X8_ADMIN_DOMAIN="$X8_IDENTITY_ADMIN_DOMAIN"
  export ADMIN_CANONICAL_ORIGIN="https://${X8_ADMIN_DOMAIN}"
  export CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION="$X8_IDENTITY_CREDENTIAL_ACTIVE_KEY_VERSION"

  # Owner fix (release-identity gate third round): the previous design froze
  # the level table's RESOLVED values (levelEnv) straight into the identity,
  # which meant business flags (AUTO_WRITE_AUTHORIZED among them) left the
  # one file the compliance script (scripts/acceptance/x8-validate-compose.mjs)
  # and its independent fail-closed ADR guard actually protect -- the gate
  # read a snapshot nothing ever re-validated. The fix binds the identity to
  # the level table's SOURCE instead (levelsFile + levelsFileDigest, the same
  # path+digest pattern imageRef/imageDigest already use for the release
  # image): re-read the exact path 'up' recorded, refuse if it is gone or if
  # its content digest no longer matches what was frozen (both fail closed --
  # this environment's worktree was modified after deploy), and only then
  # resolve it through the ordinary x8_level_config(). A safety-invariant
  # check independent of the table's own content runs immediately after,
  # before any of these values are exported and strictly before this
  # environment lets a caller touch any container -- the digest check above
  # only proves the table has not changed since deploy; it says nothing about
  # whether what it says was ever safe.
  [[ -f "$X8_IDENTITY_LEVELS_FILE" ]] || {
    echo "ERROR: the X8 level table recorded in the release identity no longer exists at $X8_IDENTITY_LEVELS_FILE (has the deployed worktree been moved, or the file removed, since 'up' ran?)" >&2
    return 65
  }
  local current_levels_digest
  current_levels_digest="$(x8_file_sha256 "$X8_IDENTITY_LEVELS_FILE")" || {
    echo "ERROR: failed to digest the X8 level table at $X8_IDENTITY_LEVELS_FILE" >&2
    return 65
  }
  [[ "$current_levels_digest" == "$X8_IDENTITY_LEVELS_FILE_DIGEST" ]] || {
    echo "ERROR: the X8 level table at $X8_IDENTITY_LEVELS_FILE has changed since 'up' produced this release identity (recorded digest $X8_IDENTITY_LEVELS_FILE_DIGEST, current digest $current_levels_digest) -- the working tree was modified after this deploy; re-run 'up' to establish a fresh identity before using the gate command." >&2
    return 65
  }

  local level_config level_key level_value
  level_config="$(x8_level_config "$X8_IDENTITY_LEVEL" "$X8_IDENTITY_LEVELS_FILE")" || {
    echo "ERROR: failed to resolve X8_LEVEL configuration for '$X8_IDENTITY_LEVEL' from $X8_IDENTITY_LEVELS_FILE" >&2
    return 65
  }
  x8_assert_level_safety_invariants "$level_config" || return 65
  while IFS='=' read -r level_key level_value; do
    [[ -n "$level_key" ]] || continue
    export "$level_key=$level_value"
  done <<<"$level_config"

  local gate_state
  gate_state="$(x8_read_gate_state)" || return 65
  x8_export_catalog_gate_env "$gate_state" || return 65
  X8_GATE_PERSISTED_STATE="$gate_state"
  export X8_GATE_PERSISTED_STATE
}

# 施工工单_PhaseD_安全与运行态收口_2026-09-06.md D-4: the compose project name
# (X8_COMPOSE_PROJECT_NAME, a fixed literal) is shared by every worktree that
# ever runs this script -- nothing before this stamped which worktree
# actually started the containers currently running under that name. A
# second worktree's `up` or `gate` would happily reuse (recreate/inspect)
# containers another worktree started, against the SAME named Postgres
# volume, using ITS OWN secrets -- the exact db-role-password-mismatch shape
# D-2 also closes. This is the minimal, additive pre-flight both D-2 and D-4
# ask for: read the label Docker Compose itself already stamps on every
# container it creates (`com.docker.compose.project.working_dir` /
# `...project.config_files`) and compare against what starting fresh FROM
# THIS worktree would use. No new indirection (lock file, pointer file) --
# the labels already ARE the record.
#
# Deliberately plain `docker ps`/`docker inspect`, never the `docker compose`
# CLI wrapper: a `docker compose ... ps` invocation needs its own `-f` files
# to parse (and their env-var interpolation to succeed) before it can even
# get to listing containers, which would make this check depend on exactly
# the kind of environment setup it must run ahead of. Label lookups need
# none of that -- they work against whatever is actually running, regardless
# of which worktree's compose files happen to be on hand right now.
#
# Zero running containers under this project name is not a conflict (a
# caller starting the very first `up`, or one running after a clean `down`)
# -- passes silently. A mismatch fails closed with the other worktree's
# recorded path in the message, per the doc's exact wording ("该栈由 <path>
# 起，请从那里操作或先 down").
x8_assert_worktree_stack_binding() {
  local project="$1"
  local expected_working_dir="$2"
  local expected_config_files="$3"
  local ps_output container
  # Fail-closed on a `docker ps` failure itself (a broken/unreachable daemon,
  # say) rather than silently treating "the query errored" the same as "zero
  # containers are running" -- `ps_output` captures stderr too so the
  # message names the real cause.
  if ! ps_output="$(docker ps --filter "label=com.docker.compose.project=${project}" --format '{{.ID}}' 2>&1)"; then
    echo "ERROR: unable to query running containers for compose project '$project': $ps_output" >&2
    return 65
  fi
  container="$(printf '%s\n' "$ps_output" | head -n 1)"
  [[ -n "$container" ]] || return 0

  local running_working_dir running_config_files
  running_working_dir="$(docker inspect "$container" --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null || true)"
  running_config_files="$(docker inspect "$container" --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' 2>/dev/null || true)"

  if [[ "$running_working_dir" != "$expected_working_dir" || "$running_config_files" != "$expected_config_files" ]]; then
    echo "ERROR: compose project '$project' is already running from a different worktree ($running_working_dir) -- please run this command from that worktree, or 'down' the stack there first." >&2
    return 65
  fi
  return 0
}

# The two-file list x8_compose() itself always passes, in the same order --
# the single place both x8_assert_worktree_stack_binding() call sites below
# and any future caller compute the "starting fresh from this worktree"
# expectation, so they can never drift apart from what x8_compose() actually
# invokes.
x8_expected_compose_config_files() {
  printf '%s,%s' "$X8_PROJECT_ROOT/docker-compose.yml" "$X8_PROJECT_ROOT/infra/production-like/docker-compose.yml"
}

# 施工工单_PhaseD_安全与运行态收口_2026-09-06.md D-2, 做法1: `init-roles.sh`
# (infra/postgres/init-roles.sh) only ever runs once, on a brand-new Postgres
# data directory (it is a docker-entrypoint-initdb.d script) -- so on a
# volume some OTHER worktree's `up` originally initialized, the six roles'
# actual passwords in the database are still THAT worktree's, while this
# worktree's own freshly-generated (or merely different) local secret files
# never touch them. The app containers this worktree starts next read THIS
# worktree's secret files for their DATABASE_URLs -- an immediate auth
# failure, and previously only discoverable by watching web/worker fail to
# come up. Idempotent (ALTER ROLE unconditionally sets the desired value
# regardless of the role's current password) and safe to run on every `up`,
# including the very first one (setting the same value `init-roles.sh` just
# set is a no-op). Superuser-executed (same `postgres` bootstrap role
# prepare_database() already uses for roles.sql/grants.sql), so it needs no
# role's own current password.
x8_align_db_role_passwords() {
  local role variable password
  for role in migration_owner web_app worker_app scheduler_app analyst_ro backup_role; do
    # `${role^^}` (bash 4+ case conversion) is deliberately not used here --
    # the host's `/usr/bin/env bash` this script actually runs under is
    # macOS's stock bash (3.2, frozen there for licensing reasons), which
    # does not support it and fails the whole function with "bad
    # substitution". `tr` is the portable equivalent every other case-
    # sensitive lookup in this file already avoids needing.
    variable="P1_12_$(printf '%s' "$role" | tr '[:lower:]' '[:upper:]')_PASSWORD_FILE"
    password="$(read_secret_value "${!variable}")" || {
      echo "ERROR: unable to read the local secret file for role $role (\$$variable)" >&2
      return 65
    }
    [[ "$password" =~ ^[0-9a-f]{48}$ ]] || {
      echo "ERROR: invalid local password material for role $role" >&2
      return 65
    }
    x8_compose exec -T postgres psql --no-psqlrc -v ON_ERROR_STOP=1 -U postgres -d cps_novel \
      --set=role_name="$role" --set=role_password="$password" <<'SQL' >/dev/null
ALTER ROLE :"role_name" PASSWORD :'role_password';
SQL
  done
}

# 施工工单_PhaseD_安全与运行态收口_2026-09-06.md D-2, 做法2: proves the six
# roles' passwords ACTUALLY match this worktree's secret files, over the
# network, with the same auth path the web/worker/scheduler containers
# themselves use -- never `docker exec ... psql` into the postgres
# container, which reaches Postgres over the local Unix socket and, per this
# repo's default pg_hba.conf (the stock postgres:16.14 entrypoint's, unless
# POSTGRES_HOST_AUTH_METHOD is overridden -- it is not here), authenticates
# `local` connections by `trust`: a wrong password would still connect, so
# that path can never actually verify anything. `postgres:16.14 psql` run as
# a disposable, `--rm` container on the SAME `cps_novel_x8_runtime` network,
# resolving the `postgres` service by its compose network-alias exactly like
# the real app containers do, is what forces the connection over TCP and
# through the server's normal `host` pg_hba.conf entries -- `scram-sha-256`
# by that same default. The image is expected to already be present locally
# (prepare_database() itself never pulls); this reuses whatever `docker run
# --pull never` already relies on elsewhere in this file.
#
# fail-closed: the first role whose network connection does not succeed
# aborts with its name so an operator is never left guessing which of the
# six is wrong.
x8_verify_db_role_passwords_via_network() {
  local role variable role_upper password env_file status
  # X8_ROLE_VERIFY_NETWORK exists solely so
  # scripts/run-phase-d-role-password-postgres-verification.sh can point
  # this at its own disposable network instead of the real
  # cps_novel_x8_runtime -- that verification script must never join the
  # network the real cps-novel-x8-local stack uses. No real caller (`up`)
  # ever sets this, so production behavior is unchanged.
  local network="${X8_ROLE_VERIFY_NETWORK:-cps_novel_x8_runtime}"
  for role in migration_owner web_app worker_app scheduler_app analyst_ro backup_role; do
    # Portable uppercase -- see the matching comment on x8_align_db_role_passwords().
    role_upper="$(printf '%s' "$role" | tr '[:lower:]' '[:upper:]')"
    variable="P1_12_${role_upper}_PASSWORD_FILE"
    password="$(read_secret_value "${!variable}")" || {
      echo "ERROR: unable to read the local secret file for role $role (\$$variable)" >&2
      return 65
    }
    env_file="$(mktemp "$X8_RUNTIME_DIR/role-verify.XXXXXX")"
    chmod 600 "$env_file"
    printf 'PGPASSWORD=%s\n' "$password" >"$env_file"
    status=0
    docker run --rm --pull never \
      --network "$network" \
      --env-file "$env_file" \
      --entrypoint psql \
      postgres:16.14 \
      --no-psqlrc -h postgres -p 5432 -U "$role" -d cps_novel -v ON_ERROR_STOP=1 -tAc 'SELECT 1' >/dev/null || status=$?
    rm -f "$env_file"
    [[ "$status" -eq 0 ]] || {
      echo "ERROR: network-side scram-sha-256 verification failed for PostgreSQL role '$role' -- its password file no longer matches the database (run 'up' again to re-align, or check \$P1_12_${role_upper}_PASSWORD_FILE)" >&2
      return 65
    }
  done
}
