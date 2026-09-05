import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const STUB_DOCKER_SCRIPT = readFileSync(resolve(import.meta.dirname, "fixtures/x8-gate-stub-docker.sh"), "utf8");

/**
 * X8 release-identity gate work order (2026-09-05), extended by the
 * 2026-09-06 patch work order. These exercise
 * `scripts/x8-production-like.sh gate catalog-write ...` and `status` as a
 * real subprocess against a stub `docker` on PATH, so the bash orchestration
 * itself (not just the pure diff logic in x8-gate-diff.test.ts) is under
 * test: identity resolution, the three-way pre-check, plan-mode-is-default,
 * the partial-success recovery path (P0-2), identity-bound compose context
 * (P1-8), and true byte-level zero-writes for every read-only path (P1-7 /
 * P1-9 / P2-10).
 *
 * The stub never talks to a real docker daemon or the real running
 * cps-novel-x8-local containers -- every docker/compose response is a canned
 * fixture driven by STUB_* environment variables (see
 * tests/backend/runtime/fixtures/x8-gate-stub-docker.sh), and X8_RUNTIME_DIR
 * always points at a throwaway temp directory.
 */

const root = resolve(import.meta.dirname, "../../..");
const launcher = resolve(root, "scripts/x8-production-like.sh");
const envLib = resolve(root, "scripts/lib/x8-production-like-env.sh");
const realLevelsFilePath = resolve(root, "scripts/lib/x8-levels.json");
const realLevelsFileDigest = createHash("sha256").update(readFileSync(realLevelsFilePath)).digest("hex");

let workDir: string;
let runtimeDir: string;
let stubBinDir: string;

// The full set of files prepare_x8_gate_environment() requires to already
// exist (created by a prior `up`) -- since that function must NEVER
// provision anything itself (P1-6), tests have to set the fixture up as
// "already established" instead of relying on the code under test to do it.
function establishRuntime() {
  const secretDir = join(runtimeDir, "secrets");
  mkdirSync(secretDir, { recursive: true });
  mkdirSync(join(runtimeDir, "nginx"), { recursive: true });
  mkdirSync(join(runtimeDir, "tls"), { recursive: true });
  mkdirSync(join(runtimeDir, "backups"), { recursive: true });
  mkdirSync(join(runtimeDir, "evidence"), { recursive: true });
  for (const name of [
    "postgres_admin.password",
    "migration_owner.password",
    "web_app.password",
    "worker_app.password",
    "scheduler_app.password",
    "analyst_ro.password",
    "backup_role.password",
  ]) {
    writeFileSync(join(secretDir, name), "deadbeef00112233\n");
  }
  for (const name of ["totp.key", "credential-v1.key", "credential-fingerprint.key", "tracking-hash-salt.key"]) {
    writeFileSync(join(secretDir, name), "ZmFrZS1rZXktdmFsdWU=\n");
  }
  writeFileSync(join(secretDir, "backup.pgpass"), "postgres:5432:cps_novel:backup_role:deadbeef\n");
}

// Terminal review, release-identity gate second round, finding 四: the
// original shape here only ever recorded FILE entries (mtimeMs/size/sha256),
// keyed by relative path. That silently missed four whole categories of
// change to the runtime directory the "zero writes" tests in this file
// exist to police:
//   - an empty directory added or removed (the old `walk()` recursed into a
//     directory but never gave the directory ITSELF an entry in `out`, so
//     an empty dir appearing/disappearing left `Object.keys(out)` unchanged);
//   - a directory's own mtime changing (same root cause -- directories
//     never got a record at all);
//   - a file's permission bits changing without its content, size, or mtime
//     also changing (chmod does not touch mtime -- only the file's own
//     record needs a `mode` field to see this, the file's OTHER three
//     fields are silent on a chmod-only change);
//   - a symlink appearing, disappearing, or being repointed (a `Dirent` for
//     a symlink is neither `isDirectory()` nor `isFile()`, so the old code's
//     `if`/`else if` matched neither branch and skipped it entirely --
//     completely invisible, not even walked).
// This is a test-only change: DirSnapshot now tags each entry with its
// `type` (file/dir/symlink) and records the fields that matter for that
// type, keyed by the same relative path as before.
type DirSnapshot = Record<
  string,
  | { type: "file"; mtimeMs: number; size: number; sha256: string; mode: number }
  | { type: "dir"; mtimeMs: number; mode: number }
  | { type: "symlink"; target: string; mode: number }
>;

// Byte-level "did anything at all change" proof for the plan-mode /
// status / query zero-write guarantees (patch work order section 3): a
// full file listing plus per-file mtime and content digest, not just one
// file's mtime. A previous version of this suite only checked the gate
// state file's mtime and content plus a recreate marker -- which never
// proved zero writes, only "these two specific things didn't change".
function snapshotDir(dir: string): DirSnapshot {
  const out: DirSnapshot = {};
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        const stat = lstatSync(full);
        out[rel] = { type: "symlink", target: readlinkSync(full), mode: stat.mode & 0o777 };
        continue;
      }
      if (entry.isDirectory()) {
        const stat = statSync(full);
        out[rel] = { type: "dir", mtimeMs: stat.mtimeMs, mode: stat.mode & 0o777 };
        walk(full, rel);
      } else if (entry.isFile()) {
        const stat = statSync(full);
        const sha256 = createHash("sha256").update(readFileSync(full)).digest("hex");
        out[rel] = { type: "file", mtimeMs: stat.mtimeMs, size: stat.size, sha256, mode: stat.mode & 0o777 };
      }
    }
  };
  walk(dir, "");
  return out;
}

function expectIdenticalSnapshots(before: DirSnapshot, after: DirSnapshot) {
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  for (const key of Object.keys(before)) {
    expect(after[key], `runtime directory file changed: ${key}`).toEqual(before[key]);
  }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "x8-gate-catalog-"));
  runtimeDir = join(workDir, "runtime");
  stubBinDir = join(workDir, "bin");
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(stubBinDir, { recursive: true });
  const dockerPath = join(stubBinDir, "docker");
  writeFileSync(dockerPath, STUB_DOCKER_SCRIPT);
  chmodSync(dockerPath, 0o755);
  establishRuntime();
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// Finding 三 (release-identity gate second round), amended by the Owner fix
// (release-identity gate third round): LEVEL_0_ENV mirrors Level "0"'s real
// entry in scripts/lib/x8-levels.json (WORKER_TASK_ALLOWLIST/
// PROMO_CLAIM_ROLES/ADMIN_TWO_FACTOR_ENFORCEMENT/ADMIN_LOCAL_IDENTITY_SEED
// plus the eight double-gate flags) -- kept byte-for-byte in sync with that
// file's Level 0 section deliberately, so every EXISTING test in this suite
// (whose STUB_WEB_ENV_JSON/STUB_WORKER_ENV_JSON/`compose config` fixtures
// already assume these exact values) keeps passing unchanged even though the
// gate no longer embeds this in the identity: IDENTITY_DEFAULTS now binds to
// the REAL scripts/lib/x8-levels.json by path + content digest
// (realLevelsFilePath/realLevelsFileDigest above), and
// prepare_x8_gate_environment() re-reads and re-resolves that exact file --
// which is why this happens to match. See the dedicated "reads the level
// table from the identity's recorded path" describe block below for the
// case where a test deliberately points the identity at a DIFFERENT,
// custom-built table instead.
const LEVEL_0_ENV = {
  WORKER_TASK_ALLOWLIST: "credential.validate.v1,credential.supersede.v1,catalog_scan,home_carousel.compute.v1",
  PROMO_CLAIM_ROLES: "",
  ADMIN_TWO_FACTOR_ENFORCEMENT: "true",
  ADMIN_LOCAL_IDENTITY_SEED: "",
  FEATURE_PROMO_LINK_CLAIM: "false",
  PROMO_LINK_CLAIM_ALLOW_WRITE: "false",
  FEATURE_SITEMAP_AUTO_REFRESH: "false",
  SITEMAP_AUTO_REFRESH_ALLOW_WRITE: "false",
  FEATURE_INDEXNOW_OUTBOX: "false",
  INDEXNOW_OUTBOX_ALLOW_WRITE: "false",
  FEATURE_INDEXNOW_DELIVERY: "false",
  INDEXNOW_DELIVERY_ALLOW_WRITE: "false",
};

// A full, standalone Level "0" table entry (the shape x8_level_config()
// requires: workerTaskAllowlist/promoClaimRoles/adminTwoFactorEnforcement/
// adminLocalIdentitySeed/flags) -- used by the tests below that write a
// CUSTOM levels-file fixture (never this repo's real scripts/lib/x8-levels.json)
// so they can freely mutate one flag (e.g. AUTO_WRITE_AUTHORIZED) without
// ever touching the real, committed table.
const VALID_LEVEL_0_TABLE_ENTRY = {
  workerTaskAllowlist: LEVEL_0_ENV.WORKER_TASK_ALLOWLIST,
  promoClaimRoles: LEVEL_0_ENV.PROMO_CLAIM_ROLES,
  adminTwoFactorEnforcement: LEVEL_0_ENV.ADMIN_TWO_FACTOR_ENFORCEMENT,
  adminLocalIdentitySeed: LEVEL_0_ENV.ADMIN_LOCAL_IDENTITY_SEED,
  flags: {
    FEATURE_PROMO_LINK_CLAIM: "false",
    PROMO_LINK_CLAIM_ALLOW_WRITE: "false",
    FEATURE_SITEMAP_AUTO_REFRESH: "false",
    SITEMAP_AUTO_REFRESH_ALLOW_WRITE: "false",
    FEATURE_INDEXNOW_OUTBOX: "false",
    INDEXNOW_OUTBOX_ALLOW_WRITE: "false",
    FEATURE_INDEXNOW_DELIVERY: "false",
    INDEXNOW_DELIVERY_ALLOW_WRITE: "false",
    FEATURE_P2_06_5_TAGGING: "false",
    FEATURE_P2_06_5_TAG_ADMIN_WRITE: "false",
    FEATURE_NOVEL_TAG_AUTO: "false",
    AUTO_WRITE_AUTHORIZED: "NO",
  },
};

function writeCustomLevelsFile(path: string, level0Entry: typeof VALID_LEVEL_0_TABLE_ENTRY) {
  writeFileSync(path, JSON.stringify({ "0": level0Entry }, null, 2));
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const IDENTITY_DEFAULTS = {
  schemaVersion: 3,
  appVersion: "0.1.0",
  gitCommit: "a".repeat(40),
  level: "0",
  imageRef: "cps-novel:0.1.0-test1234",
  imageDigest: "sha256:" + "1".repeat(64),
  composeProject: "cps-novel-x8-local",
  composeConfigFiles: ["/fixture/docker-compose.yml", "/fixture/infra/production-like/docker-compose.yml"],
  buildDate: "2026-09-05T00:00:00.000Z",
  createdAt: "2026-09-05T00:00:01.000Z",
  // Owner fix (release-identity gate third round): binds to the level
  // table's SOURCE, not its resolved values -- the REAL repo file and its
  // REAL current content digest, verified afresh by
  // prepare_x8_gate_environment() on every call.
  levelsFile: realLevelsFilePath,
  levelsFileDigest: realLevelsFileDigest,
  adminDomain: "zbcwf.novel.test",
  credentialActiveKeyVersion: "1",
};

function writeIdentity(overrides: Partial<typeof IDENTITY_DEFAULTS> = {}) {
  writeFileSync(join(runtimeDir, "release-identity.json"), JSON.stringify({ ...IDENTITY_DEFAULTS, ...overrides }, null, 2));
}

function writeGateState(value: "dry-run" | "apply" | "closed") {
  writeFileSync(join(runtimeDir, "catalog-gate.state"), `${value}\n`);
}

const HAPPY_STUB_ENV = {
  STUB_IMAGE_REF: IDENTITY_DEFAULTS.imageRef,
  STUB_IMAGE_ID: IDENTITY_DEFAULTS.imageDigest,
  STUB_WEB_CONTAINER_ID: "stub-web-1",
  STUB_WORKER_CONTAINER_ID: "stub-worker-1",
  STUB_WEB_LABEL_PROJECT: IDENTITY_DEFAULTS.composeProject,
  STUB_WORKER_LABEL_PROJECT: IDENTITY_DEFAULTS.composeProject,
  STUB_WEB_LABEL_SERVICE: "web",
  STUB_WORKER_LABEL_SERVICE: "worker",
  STUB_WEB_LABEL_CONFIG_FILES: IDENTITY_DEFAULTS.composeConfigFiles.join(","),
  STUB_WORKER_LABEL_CONFIG_FILES: IDENTITY_DEFAULTS.composeConfigFiles.join(","),
  STUB_WEB_LABEL_IMAGE: IDENTITY_DEFAULTS.imageDigest,
  STUB_WORKER_LABEL_IMAGE: IDENTITY_DEFAULTS.imageDigest,
  // Actual containers agree with the persisted "closed" baseline used by
  // most tests below (FEATURE_NOVEL_CATALOG_SYNC=false, ...=false).
  STUB_WEB_ENV_JSON: JSON.stringify([
    "FEATURE_NOVEL_CATALOG_SYNC=false",
    "NOVEL_CATALOG_SYNC_ALLOW_WRITE=false",
    "PROMO_CLAIM_ROLES=",
    "ADMIN_TWO_FACTOR_ENFORCEMENT=true",
    // Matches the stub `config` render's defaults (Level 0: preview source
    // apps default "changdu", FEATURE_PROMO_LINK_CLAIM default "false") --
    // P0-3/P0-4 coverage lives in the "no curated whitelist" describe block
    // below, which deliberately mismatches one of these.
    "MOBOREADER_PREVIEW_SOURCE_APP_CODES=changdu",
    "FEATURE_PROMO_LINK_CLAIM=false",
  ]),
  STUB_WORKER_ENV_JSON: JSON.stringify([
    "FEATURE_NOVEL_CATALOG_SYNC=false",
    "NOVEL_CATALOG_SYNC_ALLOW_WRITE=false",
    "WORKER_TASK_ALLOWLIST=credential.validate.v1,credential.supersede.v1,catalog_scan,home_carousel.compute.v1",
    "FEATURE_PROMO_LINK_CLAIM=false",
  ]),
  // Keep the health-check poll instant in tests; only a dedicated
  // not-ready test overrides these to something that will actually time out.
  X8_GATE_READY_RETRIES: "1",
  X8_GATE_READY_SLEEP_SECONDS: "0",
};

function runGate(args: string[], envOverrides: Record<string, string | undefined> = {}) {
  const marker = join(runtimeDir, "recreate-marker.env");
  return spawnSync("bash", [launcher, "gate", "catalog-write", ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${stubBinDir}:${process.env.PATH}`,
      X8_RUNTIME_DIR: runtimeDir,
      STUB_MARKER_FILE: marker,
      ...HAPPY_STUB_ENV,
      ...envOverrides,
    },
  });
}

function runStatus(envOverrides: Record<string, string | undefined> = {}) {
  return spawnSync("bash", [launcher, "status"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${stubBinDir}:${process.env.PATH}`,
      X8_RUNTIME_DIR: runtimeDir,
      ...HAPPY_STUB_ENV,
      ...envOverrides,
    },
  });
}

function gateStateFileStat() {
  return statSync(join(runtimeDir, "catalog-gate.state"));
}

describe("X8 gate command: identity is mandatory and undecidable levels always fail", () => {
  it("fails with instructions when no identity file exists yet, before touching docker or the gate state", () => {
    writeGateState("closed");
    const before = gateStateFileStat();
    const result = runGate(["on"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no X8 deploy identity file");
    expect(result.stderr).toContain("scripts/x8-production-like.sh up");
    expect(gateStateFileStat().mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(join(runtimeDir, "catalog-gate.state"), "utf8")).toBe("closed\n");
  });

  it("fails when the identity file exists but its level is missing/unrecognized -- no silent fallback", () => {
    writeGateState("closed");
    writeIdentity({ level: "" } as never);
    const before = gateStateFileStat();
    const result = runGate(["on"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/missing a valid "level"|unrecognized level/);
    expect(gateStateFileStat().mtimeMs).toBe(before.mtimeMs);
  });

  it("fails when the identity file is not valid JSON", () => {
    writeGateState("closed");
    writeFileSync(join(runtimeDir, "release-identity.json"), "{not json");
    const result = runGate(["on"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("corrupt X8 deploy identity file");
  });

  it("fails when there is no persisted gate state file at all, even with a valid identity", () => {
    writeIdentity();
    const result = runGate(["on"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no X8 catalog gate state file");
  });
});

describe("X8 gate command: candidate vs. committed identity (P0-1 / 决策二)", () => {
  it("refuses to use a candidate-only identity, and says the previous deploy did not complete", () => {
    // No committed release-identity.json -- only a candidate, as `up` would
    // leave behind if it died between writing the candidate and promoting
    // it (e.g. postgres never came up, or a health probe timed out).
    writeFileSync(join(runtimeDir, "release-identity.candidate.json"), JSON.stringify(IDENTITY_DEFAULTS, null, 2));
    writeGateState("closed");
    const result = runGate(["on"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("did not complete successfully");
    expect(result.stderr).not.toContain("no X8 deploy identity file at"); // the sharper message, not the generic one
  });

  it("points at the failure marker when one exists alongside a candidate", () => {
    writeFileSync(join(runtimeDir, "release-identity.candidate.json"), JSON.stringify(IDENTITY_DEFAULTS, null, 2));
    const markerPath = join(runtimeDir, "release-identity.failed.txt");
    writeFileSync(markerPath, "timestamp=2026-09-06T00:00:00Z\nreason=simulated\n");
    writeGateState("closed");
    const result = runGate(["on"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(markerPath);
  });

  it("succeeds once a committed identity exists, even if a stale candidate is still sitting next to it", () => {
    // A committed identity always wins -- a leftover candidate from some
    // earlier, already-superseded attempt must not block the gate command.
    writeFileSync(join(runtimeDir, "release-identity.candidate.json"), JSON.stringify({ ...IDENTITY_DEFAULTS, appVersion: "0.0.1-stale" }, null, 2));
    writeIdentity();
    writeGateState("closed");
    const result = runGate(["on"]); // plan mode
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("X8_GATE_PLAN=PASS");
  });
});

describe("X8 gate environment: identity-derived fields, never the live git worktree (P1-6 / P2-11)", () => {
  it("derives APP_VERSION / GIT_COMMIT / CPS_NOVEL_APP_IMAGE / BUILD_DATE / NEXT_PUBLIC_BUILD_VERSION from the release identity, and provisions nothing", () => {
    // gitCommit is deliberately 40 "a"s -- guaranteed not to equal this
    // repo's real `git rev-parse HEAD`, so a pass here can only mean the
    // value came from the identity file, not a live git read. Likewise
    // appVersion is deliberately NOT this repo's real package.json version.
    writeIdentity({ appVersion: "9.9.9-test-patch" });
    writeGateState("closed");

    const before = snapshotDir(runtimeDir);
    const script = `
      set -euo pipefail
      source "${envLib}"
      prepare_x8_gate_environment
      echo "APP_VERSION=$APP_VERSION"
      echo "GIT_COMMIT=$GIT_COMMIT"
      echo "CPS_NOVEL_APP_IMAGE=$CPS_NOVEL_APP_IMAGE"
      echo "BUILD_DATE=$BUILD_DATE"
      echo "NEXT_PUBLIC_BUILD_VERSION=$NEXT_PUBLIC_BUILD_VERSION"
    `;
    const result = spawnSync("bash", ["-c", script], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, X8_RUNTIME_DIR: runtimeDir },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("APP_VERSION=9.9.9-test-patch");
    expect(result.stdout).toContain(`GIT_COMMIT=${IDENTITY_DEFAULTS.gitCommit}`);
    expect(result.stdout).toContain(`CPS_NOVEL_APP_IMAGE=${IDENTITY_DEFAULTS.imageRef}`);
    expect(result.stdout).toContain(`BUILD_DATE=${IDENTITY_DEFAULTS.buildDate}`);
    expect(result.stdout).toContain("NEXT_PUBLIC_BUILD_VERSION=v9.9.9-test-patch");

    // The real regression this guards: prepare_p1_12_local_environment()
    // creates .tmp/p1-12-runtime/build-date-<live HEAD>.txt as a side
    // effect of computing BUILD_DATE from the current worktree. Proving the
    // gate's OWN runtime directory saw zero writes is the direct evidence
    // that path was never invoked.
    expectIdenticalSnapshots(before, snapshotDir(runtimeDir));
  });

  // 2026-09-06 patch (second round), group 4: the direct regression test for
  // the fix -- before it, this exact call site read
  // `${NEXT_PUBLIC_BUILD_VERSION:-v${X8_IDENTITY_APP_VERSION}}`, so a caller
  // whose shell already had NEXT_PUBLIC_BUILD_VERSION set (for any reason --
  // a stale export, a CI default, ...) would silently win over the frozen
  // identity's own appVersion, exactly the class of bug P2-11 already fixed
  // for this same variable in a different shape. Every OTHER identity-
  // derived field on the same call site (APP_VERSION, GIT_COMMIT,
  // CPS_NOVEL_APP_IMAGE, BUILD_DATE) was already unconditional; this proves
  // NEXT_PUBLIC_BUILD_VERSION now is too.
  it("group 4: NEXT_PUBLIC_BUILD_VERSION cannot be overridden by the caller's ambient shell -- it always comes from the frozen identity", () => {
    writeIdentity({ appVersion: "9.9.9-test-patch" });
    writeGateState("closed");
    const script = `
      set -euo pipefail
      source "${envLib}"
      prepare_x8_gate_environment
      echo "NEXT_PUBLIC_BUILD_VERSION=$NEXT_PUBLIC_BUILD_VERSION"
    `;
    const result = spawnSync("bash", ["-c", script], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, X8_RUNTIME_DIR: runtimeDir, NEXT_PUBLIC_BUILD_VERSION: "v-caller-injected-bogus" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("NEXT_PUBLIC_BUILD_VERSION=v9.9.9-test-patch");
    expect(result.stdout).not.toContain("v-caller-injected-bogus");
  });

  it("fails closed (and provisions nothing) when a required secret file is missing, instead of creating one", () => {
    writeIdentity();
    writeGateState("closed");
    rmSync(join(runtimeDir, "secrets", "totp.key"));
    const before = snapshotDir(runtimeDir);
    const script = `
      set -euo pipefail
      source "${envLib}"
      prepare_x8_gate_environment
    `;
    const result = spawnSync("bash", ["-c", script], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, X8_RUNTIME_DIR: runtimeDir },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("already-established secret file");
    expect(result.stderr).toContain("totp.key");
    expectIdenticalSnapshots(before, snapshotDir(runtimeDir));
  });

  // Owner fix (release-identity gate third round): this is the direct
  // regression test for "the gate reads the level table from the identity's
  // RECORDED PATH, never unconditionally this worktree's own
  // scripts/lib/x8-levels.json". The identity below points levelsFile at a
  // CUSTOM, throwaway table (never the real repo file) whose Level 0 entry
  // deliberately uses a WORKER_TASK_ALLOWLIST that does not appear anywhere
  // in the real table -- a pass here can only mean the exported value came
  // from the recorded path, with its digest independently verified, not a
  // hard-coded read of this repo's own file.
  it("reads the level table from the identity's recorded levelsFile path once its digest is verified, never a fixed worktree path", () => {
    const customLevelsPath = join(workDir, "custom-levels.json");
    const customDigest = writeCustomLevelsFile(customLevelsPath, {
      ...VALID_LEVEL_0_TABLE_ENTRY,
      workerTaskAllowlist: "totally-different-allowlist-value-not-in-the-real-table",
    });
    writeIdentity({ levelsFile: customLevelsPath, levelsFileDigest: customDigest });
    writeGateState("closed");
    const script = `
      set -euo pipefail
      source "${envLib}"
      prepare_x8_gate_environment
      echo "WORKER_TASK_ALLOWLIST=$WORKER_TASK_ALLOWLIST"
    `;
    const result = spawnSync("bash", ["-c", script], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, X8_RUNTIME_DIR: runtimeDir },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("WORKER_TASK_ALLOWLIST=totally-different-allowlist-value-not-in-the-real-table");
  });

  // Finding 三, second half: X8_ADMIN_DOMAIN and CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION
  // used to be defaulted from the CALLER's ambient shell (`${X8_ADMIN_DOMAIN:-zbcwf.novel.test}`
  // in x8_export_static_topology(), `${CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION:-1}`
  // directly in prepare_x8_gate_environment()) -- the exact same class of bug
  // the NEXT_PUBLIC_BUILD_VERSION test above already covers for that
  // variable. Both ambient variables are set here to values that differ from
  // IDENTITY_DEFAULTS -- a pass can only mean the identity's frozen values
  // won, not the caller's.
  it("finding 三: X8_ADMIN_DOMAIN and CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION cannot be overridden by the caller's ambient shell -- both always come from the frozen identity", () => {
    writeIdentity();
    writeGateState("closed");
    const script = `
      set -euo pipefail
      source "${envLib}"
      prepare_x8_gate_environment
      echo "X8_ADMIN_DOMAIN=$X8_ADMIN_DOMAIN"
      echo "ADMIN_CANONICAL_ORIGIN=$ADMIN_CANONICAL_ORIGIN"
      echo "CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION=$CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION"
    `;
    const result = spawnSync("bash", ["-c", script], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        X8_RUNTIME_DIR: runtimeDir,
        X8_ADMIN_DOMAIN: "caller-injected-bogus.example.test",
        CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION: "999-caller-injected-bogus",
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`X8_ADMIN_DOMAIN=${IDENTITY_DEFAULTS.adminDomain}`);
    expect(result.stdout).toContain(`ADMIN_CANONICAL_ORIGIN=https://${IDENTITY_DEFAULTS.adminDomain}`);
    expect(result.stdout).toContain(`CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION=${IDENTITY_DEFAULTS.credentialActiveKeyVersion}`);
    expect(result.stdout).not.toContain("caller-injected-bogus");
  });

  // A missing/invalid levelsFile, levelsFileDigest, adminDomain, or
  // credentialActiveKeyVersion must fail closed the same way a missing
  // appVersion/level/etc. already does -- undecidable always fails, never
  // falls back to a default.
  it("Owner fix: fails closed when the identity's levelsFile is missing", () => {
    const withoutLevelsFile: Partial<typeof IDENTITY_DEFAULTS> = { ...IDENTITY_DEFAULTS };
    delete withoutLevelsFile.levelsFile;
    writeFileSync(join(runtimeDir, "release-identity.json"), JSON.stringify(withoutLevelsFile, null, 2));
    writeGateState("closed");
    const result = runGate(["status"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing a valid "levelsFile"');
  });

  it("Owner fix: fails closed when the identity's levelsFileDigest is missing", () => {
    const withoutDigest: Partial<typeof IDENTITY_DEFAULTS> = { ...IDENTITY_DEFAULTS };
    delete withoutDigest.levelsFileDigest;
    writeFileSync(join(runtimeDir, "release-identity.json"), JSON.stringify(withoutDigest, null, 2));
    writeGateState("closed");
    const result = runGate(["status"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing a valid "levelsFileDigest"');
  });

  it("Owner fix: fails closed when the identity's levelsFileDigest is not a valid sha256 hex digest", () => {
    writeIdentity({ levelsFileDigest: "not-a-real-digest" });
    writeGateState("closed");
    const result = runGate(["status"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('invalid "levelsFileDigest"');
  });

  it("Owner fix: fails closed when the identity's levelsFile is not an absolute path", () => {
    writeIdentity({ levelsFile: "scripts/lib/x8-levels.json" });
    writeGateState("closed");
    const result = runGate(["status"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('invalid "levelsFile"');
  });

  it("finding 三: fails closed when the identity's adminDomain is empty", () => {
    writeIdentity({ adminDomain: "" });
    writeGateState("closed");
    const result = runGate(["status"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing a valid "adminDomain"');
  });

  it("finding 三: fails closed on an unsupported schemaVersion instead of silently accepting it", () => {
    writeIdentity({ schemaVersion: 1 } as never);
    writeGateState("closed");
    const result = runGate(["status"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unsupported schemaVersion");
  });
});

/**
 * Owner fix (release-identity gate third round): the core of this fix. The
 * previous design (schemaVersion 2's `levelEnv`) froze the level table's
 * RESOLVED values into the identity, which meant a business flag
 * (AUTO_WRITE_AUTHORIZED) could leave the one file the compliance validator
 * protects and reach the gate unexamined. The fix binds the identity to the
 * level table's SOURCE instead -- levelsFile + levelsFileDigest -- and adds
 * two independent checks in prepare_x8_gate_environment(), run in this
 * order, strictly before any container is touched:
 *   1. the recorded path must exist and its current content digest must
 *      match what was frozen at `up` time (proves "the table has not
 *      changed since deploy");
 *   2. the resolved level config must satisfy the P2-06.5 auto-write ADR
 *      guard (proves "the table's content was never unsafe to begin with"),
 *      read from the SAME shared definition
 *      (scripts/lib/x8-level-safety-invariants.mjs) scripts/acceptance/
 *      x8-validate-compose.mjs uses.
 * These are deliberately two SEPARATE properties: (1) alone cannot catch a
 * level table that was already unsafe before this deploy's `up` ever ran;
 * (2) alone cannot catch the table changing after deploy. Both must hold.
 */
describe("X8 gate command: level table content-digest binding and safety invariant (Owner fix, release-identity gate third round)", () => {
  it("fails closed, and never touches the persisted gate state, when the level table's content digest no longer matches the release identity", () => {
    const customLevelsPath = join(workDir, "tampered-levels.json");
    writeCustomLevelsFile(customLevelsPath, VALID_LEVEL_0_TABLE_ENTRY);
    // A digest that is guaranteed not to match whatever writeCustomLevelsFile
    // just wrote (64 hex chars, but not the real sha256 of that content).
    const wrongDigest = "0".repeat(64);
    writeIdentity({ levelsFile: customLevelsPath, levelsFileDigest: wrongDigest });
    writeGateState("closed");
    const before = gateStateFileStat();
    const result = runGate(["on"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("has changed since");
    expect(result.stderr).toContain(customLevelsPath);
    expect(gateStateFileStat().mtimeMs).toBe(before.mtimeMs);
  });

  it("fails closed when the level table path recorded in the release identity no longer exists", () => {
    const missingPath = join(workDir, "does-not-exist-levels.json");
    writeIdentity({ levelsFile: missingPath, levelsFileDigest: "a".repeat(64) });
    writeGateState("closed");
    const result = runGate(["on"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no longer exists");
    expect(result.stderr).toContain(missingPath);
  });

  it("exports the exact level config resolved from the recorded levels file, once its digest matches -- equivalent to a direct parse of that same file", () => {
    const customLevelsPath = join(workDir, "matching-levels.json");
    const entry = { ...VALID_LEVEL_0_TABLE_ENTRY, workerTaskAllowlist: "custom-matching-allowlist-value" };
    const digest = writeCustomLevelsFile(customLevelsPath, entry);
    writeIdentity({ levelsFile: customLevelsPath, levelsFileDigest: digest });
    writeGateState("closed");
    const script = `
      set -euo pipefail
      source "${envLib}"
      prepare_x8_gate_environment
      echo "WORKER_TASK_ALLOWLIST=$WORKER_TASK_ALLOWLIST"
      echo "PROMO_CLAIM_ROLES=$PROMO_CLAIM_ROLES"
      echo "ADMIN_TWO_FACTOR_ENFORCEMENT=$ADMIN_TWO_FACTOR_ENFORCEMENT"
    `;
    const result = spawnSync("bash", ["-c", script], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, X8_RUNTIME_DIR: runtimeDir },
    });
    expect(result.status, result.stderr).toBe(0);
    // Exactly what a direct x8_level_config("0", customLevelsPath) call
    // would produce -- proving the gate's export is equivalent to parsing
    // the recorded file directly, not some other derivation.
    expect(result.stdout).toContain(`WORKER_TASK_ALLOWLIST=${entry.workerTaskAllowlist}`);
    expect(result.stdout).toContain(`PROMO_CLAIM_ROLES=${entry.promoClaimRoles}`);
    expect(result.stdout).toContain(`ADMIN_TWO_FACTOR_ENFORCEMENT=${entry.adminTwoFactorEnforcement}`);
  });

  // The core new requirement: a level table that is self-consistent (digest
  // matches) but whose CONTENT violates the P2-06.5 auto-write ADR guard
  // must still be refused -- and refused before ever reaching a docker call.
  // "X8_GATE_LEVEL_SOURCE=" is the first line gate_catalog_recreate() prints
  // AFTER prepare_x8_gate_environment() returns successfully (see
  // scripts/x8-production-like.sh) -- its absence is direct evidence this
  // never got past environment preparation, let alone touched any container.
  it("Owner fix (core): refuses when AUTO_WRITE_AUTHORIZED is not \"NO\" in an otherwise self-consistent (digest-matching) level table, and never touches any container", () => {
    const badLevelsPath = join(workDir, "bad-auto-write-authorized.json");
    const badEntry = {
      ...VALID_LEVEL_0_TABLE_ENTRY,
      flags: { ...VALID_LEVEL_0_TABLE_ENTRY.flags, AUTO_WRITE_AUTHORIZED: "YES" },
    };
    const digest = writeCustomLevelsFile(badLevelsPath, badEntry);
    writeIdentity({ levelsFile: badLevelsPath, levelsFileDigest: digest });
    writeGateState("closed");
    const before = gateStateFileStat();
    const result = runGate(["on", "--apply"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ADR guard");
    expect(result.stderr).toContain("AUTO_WRITE_AUTHORIZED");
    expect(result.stderr).toContain('got "YES"');
    expect(result.stderr).not.toContain("X8_GATE_LEVEL_SOURCE=");
    expect(gateStateFileStat().mtimeMs).toBe(before.mtimeMs);
  });

  it("Owner fix: refuses when FEATURE_NOVEL_TAG_AUTO is not \"false\" in an otherwise self-consistent level table, and never touches any container", () => {
    const badLevelsPath = join(workDir, "bad-tag-auto.json");
    const badEntry = {
      ...VALID_LEVEL_0_TABLE_ENTRY,
      flags: { ...VALID_LEVEL_0_TABLE_ENTRY.flags, FEATURE_NOVEL_TAG_AUTO: "true" },
    };
    const digest = writeCustomLevelsFile(badLevelsPath, badEntry);
    writeIdentity({ levelsFile: badLevelsPath, levelsFileDigest: digest });
    writeGateState("closed");
    const before = gateStateFileStat();
    const result = runGate(["on", "--apply"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ADR guard");
    expect(result.stderr).toContain("FEATURE_NOVEL_TAG_AUTO");
    expect(gateStateFileStat().mtimeMs).toBe(before.mtimeMs);
  });
});

describe("X8 gate command: never builds or pulls, and refuses a missing/drifted frozen image", () => {
  it("fails when the identity's image does not exist locally, and never touches the state file", () => {
    writeIdentity();
    writeGateState("closed");
    const before = gateStateFileStat();
    const result = runGate(["on"], { STUB_IMAGE_REF: "cps-novel:0.1.0-doesnotexist" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("requires the frozen release image to already exist locally");
    expect(result.stderr).toContain("never builds or pulls");
    expect(gateStateFileStat().mtimeMs).toBe(before.mtimeMs);
  });

  it("fails when the local image exists but its digest does not match the identity", () => {
    writeIdentity();
    writeGateState("closed");
    const result = runGate(["on"], { STUB_IMAGE_ID: "sha256:" + "9".repeat(64) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("has drifted from the release identity");
  });
});

describe("X8 gate command: container labels are used only for front-and-back comparison", () => {
  it("fails when the running web container's compose-project label does not match the identity", () => {
    writeIdentity();
    writeGateState("closed");
    const result = runGate(["on"], { STUB_WEB_LABEL_PROJECT: "some-other-project" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("compose-project label drift");
  });

  it("fails when the running worker container's image digest does not match the identity", () => {
    writeIdentity();
    writeGateState("closed");
    const result = runGate(["on"], { STUB_WORKER_LABEL_IMAGE: "sha256:" + "2".repeat(64) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("worker container image digest drift");
  });

  it("fails when web or worker is not running yet at all", () => {
    writeIdentity();
    writeGateState("closed");
    const result = runGate(["on"], { STUB_WEB_CONTAINER_ID: "" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("requires web and worker to already be running");
  });

  it("fails when the running web container's working-directory label does not match the identity (P1-8)", () => {
    writeIdentity(); // composeConfigFiles[0] = /fixture/docker-compose.yml -> expected working dir /fixture
    writeGateState("closed");
    const result = runGate(["on"], { STUB_WEB_LABEL_WORKING_DIR: "/some/other/worktree" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("working-directory label drift");
  });
});

describe("X8 gate command: compose context is bound to the release identity, not the script directory (P1-8)", () => {
  it("invokes docker compose with the identity's own project name and config files on every call", () => {
    writeIdentity();
    writeGateState("closed");
    const argsLog = join(runtimeDir, "compose-args.log");
    const result = runGate(["on"], { STUB_COMPOSE_ARGS_LOG: argsLog }); // plan mode: still issues ps + config calls
    expect(result.status, result.stderr).toBe(0);
    const lines = readFileSync(argsLog, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toContain(`-p ${IDENTITY_DEFAULTS.composeProject}`);
      for (const file of IDENTITY_DEFAULTS.composeConfigFiles) {
        expect(line).toContain(`-f ${file}`);
      }
      // The real repo's own docker-compose.yml lives under `root` -- if that
      // ever shows up here, the gate silently fell back to
      // $X8_PROJECT_ROOT instead of the identity's recorded files.
      expect(line).not.toContain(root);
    }
  });
});

describe("X8 gate command: the three-way pre-check catches drift the reference implementation cannot", () => {
  it("fails closed when the persisted state says the gate is open but the containers actually have it closed", () => {
    // Reproduces this repo's confirmed real drift as of the original work
    // order: catalog-gate.state = apply, but both running containers
    // actually have FEATURE_NOVEL_CATALOG_SYNC=false /
    // NOVEL_CATALOG_SYNC_ALLOW_WRITE=false.
    writeIdentity();
    writeGateState("apply");
    const before = gateStateFileStat();
    // HAPPY_STUB_ENV's container env fixtures are false/false -- left as-is.
    const result = runGate(["off"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not self-consistent enough for a single-variable recreate");
    expect(result.stderr).toContain("ACTUAL_CONTAINER_DRIFT");
    expect(gateStateFileStat().mtimeMs).toBe(before.mtimeMs);
  });

  it("passes the three-way check when persisted state and container reality agree", () => {
    writeIdentity();
    writeGateState("closed"); // matches HAPPY_STUB_ENV's false/false containers
    const result = runGate(["on"]); // plan mode: just prints the plan
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("three-way check: PASS");
    expect(result.stdout).toContain("X8_GATE_PLAN=PASS");
  });

  it("fails closed on drift in the preview source allowlist -- a key the old curated 7-key list never covered (P0-3 / P0-4)", () => {
    // 决策一 / P0-3: reconciliation now covers every key the baseline
    // render declares for the service, not the pre-patch hard-coded list of
    // 7 (FEATURE_NOVEL_CATALOG_SYNC, NOVEL_CATALOG_SYNC_ALLOW_WRITE,
    // PROMO_CLAIM_ROLES, ADMIN_TWO_FACTOR_ENFORCEMENT, WORKER_TASK_ALLOWLIST).
    // MOBOREADER_PREVIEW_SOURCE_APP_CODES is exactly the kind of key that
    // list silently ignored -- and it is the very variable 施工项二 of the
    // original work order had to wire into Web in the first place. The
    // baseline renders "changdu" (prepare_x8_gate_environment()'s constant
    // default); the container fixture below reports an empty allowlist,
    // reproducing that exact prior incident as a three-way-check failure.
    writeIdentity();
    writeGateState("closed");
    const result = runGate(["on"], {
      STUB_WEB_ENV_JSON: JSON.stringify([
        "FEATURE_NOVEL_CATALOG_SYNC=false",
        "NOVEL_CATALOG_SYNC_ALLOW_WRITE=false",
        "PROMO_CLAIM_ROLES=",
        "ADMIN_TWO_FACTOR_ENFORCEMENT=true",
        "MOBOREADER_PREVIEW_SOURCE_APP_CODES=", // drifted: baseline says "changdu"
        "FEATURE_PROMO_LINK_CLAIM=false",
      ]),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ACTUAL_CONTAINER_DRIFT");
    expect(result.stderr).toContain("MOBOREADER_PREVIEW_SOURCE_APP_CODES");
  });

  it("fails closed on drift in the promo-link double-gate -- also never covered by the old curated list (P0-3 / P0-4)", () => {
    writeIdentity();
    writeGateState("closed");
    const result = runGate(["on"], {
      STUB_WORKER_ENV_JSON: JSON.stringify([
        "FEATURE_NOVEL_CATALOG_SYNC=false",
        "NOVEL_CATALOG_SYNC_ALLOW_WRITE=false",
        "WORKER_TASK_ALLOWLIST=credential.validate.v1,credential.supersede.v1,catalog_scan,home_carousel.compute.v1",
        "FEATURE_PROMO_LINK_CLAIM=true", // drifted: baseline (Level 0) says "false"
      ]),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ACTUAL_CONTAINER_DRIFT");
    expect(result.stderr).toContain("FEATURE_PROMO_LINK_CLAIM");
  });

  it("fails closed when the container is missing a key the baseline declares (baseline has, container doesn't)", () => {
    writeIdentity();
    writeGateState("closed");
    const result = runGate(["on"], {
      STUB_WEB_ENV_JSON: JSON.stringify([
        "FEATURE_NOVEL_CATALOG_SYNC=false",
        "NOVEL_CATALOG_SYNC_ALLOW_WRITE=false",
        "PROMO_CLAIM_ROLES=",
        "ADMIN_TWO_FACTOR_ENFORCEMENT=true",
        // MOBOREADER_PREVIEW_SOURCE_APP_CODES omitted entirely.
        "FEATURE_PROMO_LINK_CLAIM=false",
      ]),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ACTUAL_CONTAINER_DRIFT");
    expect(result.stderr).toContain("MOBOREADER_PREVIEW_SOURCE_APP_CODES");
  });

  it("fails closed when the container has a key the baseline never declared (container has, baseline doesn't, and it is not on the exemption list)", () => {
    writeIdentity();
    writeGateState("closed");
    const result = runGate(["on"], {
      STUB_WEB_ENV_JSON: JSON.stringify([
        "FEATURE_NOVEL_CATALOG_SYNC=false",
        "NOVEL_CATALOG_SYNC_ALLOW_WRITE=false",
        "PROMO_CLAIM_ROLES=",
        "ADMIN_TWO_FACTOR_ENFORCEMENT=true",
        "MOBOREADER_PREVIEW_SOURCE_APP_CODES=changdu",
        "FEATURE_PROMO_LINK_CLAIM=false",
        "SOME_UNEXPECTED_RUNTIME_VAR=surprise", // never declared by compose at all
      ]),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ACTUAL_CONTAINER_DRIFT");
    expect(result.stderr).toContain("SOME_UNEXPECTED_RUNTIME_VAR");
  });

  // Finding 一 (release-identity gate second round): the exemption is only
  // legitimate when the container's value for an exempted key EQUALS what
  // the identity-bound image itself bakes in by default -- x8_gate_actual_matches_baseline()
  // now reads that default via `docker image inspect --format '{{json .Config.Env}}'`
  // on $X8_IDENTITY_IMAGE_REF and compares against it, so this happy-path
  // test must supply a matching STUB_IMAGE_ENV_JSON, or every exempted key
  // would now (correctly) be flagged as drift.
  const BASE_IMAGE_ENV_JSON = JSON.stringify([
    "NODE_VERSION=20.20.2",
    "YARN_VERSION=1.22.22",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "NEXT_TELEMETRY_DISABLED=1",
  ]);

  it("does NOT flag a base-image-baked key present only in the container as drift, when its value matches the image's own baked default (the documented, tested exemption)", () => {
    writeIdentity();
    writeGateState("closed");
    const result = runGate(["on"], {
      STUB_IMAGE_ENV_JSON: BASE_IMAGE_ENV_JSON,
      STUB_WEB_ENV_JSON: JSON.stringify([
        "FEATURE_NOVEL_CATALOG_SYNC=false",
        "NOVEL_CATALOG_SYNC_ALLOW_WRITE=false",
        "PROMO_CLAIM_ROLES=",
        "ADMIN_TWO_FACTOR_ENFORCEMENT=true",
        "MOBOREADER_PREVIEW_SOURCE_APP_CODES=changdu",
        "FEATURE_PROMO_LINK_CLAIM=false",
        // Baked into the base image, never declared by docker-compose.yml's
        // `environment:` block for at least one of web/worker -- see
        // BASE_IMAGE_BAKED_KEYS in scripts/lib/x8-gate-diff.mjs.
        "NODE_VERSION=20.20.2",
        "YARN_VERSION=1.22.22",
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "NEXT_TELEMETRY_DISABLED=1",
      ]),
    });
    expect(result.status, result.stderr).toBe(0);
  });

  // Finding 一: the direct regression test. Before the fix, a container
  // whose env for an exempted key (here PATH) was CREATED with an override
  // that differs from the image's own baked default was silently accepted
  // -- because the exemption used to be "container has it -> always OK",
  // never checked against anything. This container's actual PATH here
  // diverges from the image's baked PATH (BASE_IMAGE_ENV_JSON above), which
  // must now fail the three-way pre-check.
  it("finding 一: FLAGS a base-image-baked key whose actual container value diverges from the identity-bound image's own baked default", () => {
    writeIdentity();
    writeGateState("closed");
    const result = runGate(["on"], {
      STUB_IMAGE_ENV_JSON: BASE_IMAGE_ENV_JSON,
      STUB_WEB_ENV_JSON: JSON.stringify([
        "FEATURE_NOVEL_CATALOG_SYNC=false",
        "NOVEL_CATALOG_SYNC_ALLOW_WRITE=false",
        "PROMO_CLAIM_ROLES=",
        "ADMIN_TWO_FACTOR_ENFORCEMENT=true",
        "MOBOREADER_PREVIEW_SOURCE_APP_CODES=changdu",
        "FEATURE_PROMO_LINK_CLAIM=false",
        "NODE_VERSION=20.20.2",
        "YARN_VERSION=1.22.22",
        // Overridden at container-creation time to something OTHER than what
        // the image itself bakes in -- this changes nothing about `.Image`'s
        // digest, so only the new imageBakedEnv comparison can catch it.
        "PATH=/some/attacker-controlled/path:/usr/bin",
        "NEXT_TELEMETRY_DISABLED=1",
      ]),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ACTUAL_CONTAINER_DRIFT");
    expect(result.stderr).toContain("web.PATH");
    expect(result.stderr).toContain("/some/attacker-controlled/path:/usr/bin");
  });
});

describe("X8 gate command: plan mode is the default and produces zero writes", () => {
  it("makes zero changes anywhere in the runtime directory without --apply (byte-level snapshot, not just one file's mtime)", () => {
    writeIdentity();
    writeGateState("closed");
    const before = snapshotDir(runtimeDir);
    const result = runGate(["on"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("X8_GATE_PLAN=PASS");
    expect(result.stdout).toContain("No production-like action was executed");
    expectIdenticalSnapshots(before, snapshotDir(runtimeDir));
  });

  it("does not create a recreate marker (i.e. never calls compose up) in plan mode", () => {
    writeIdentity();
    writeGateState("closed");
    const marker = join(runtimeDir, "recreate-marker.env");
    runGate(["on"]);
    expect(() => statSync(marker)).toThrow();
  });

  // Self-check for the snapshot method itself: if this regresses to "plan
  // mode writes something", the byte-level comparison above must actually
  // catch it, not just the two narrower checks that used to be here.
  it("self-check: the snapshot comparison actually detects a stray write (regression canary)", () => {
    writeIdentity();
    writeGateState("closed");
    const before = snapshotDir(runtimeDir);
    writeFileSync(join(runtimeDir, "stray-file.txt"), "should never happen in plan mode");
    expect(() => expectIdenticalSnapshots(before, snapshotDir(runtimeDir))).toThrow();
  });

  // Terminal review, release-identity gate second round, finding 四: four
  // more self-checks for the snapshot method itself, each pinning one of the
  // categories the pre-fix snapshotDir()/DirSnapshot silently missed. These
  // exercise the helper directly (no gate command involved) since the point
  // is the snapshot mechanism's own coverage, not gate behavior.
  it("self-check finding 四: detects an empty directory added", () => {
    const before = snapshotDir(runtimeDir);
    mkdirSync(join(runtimeDir, "a-new-empty-directory"));
    expect(() => expectIdenticalSnapshots(before, snapshotDir(runtimeDir))).toThrow();
  });

  it("self-check finding 四: detects an empty directory removed", () => {
    mkdirSync(join(runtimeDir, "will-be-removed"));
    const before = snapshotDir(runtimeDir);
    rmSync(join(runtimeDir, "will-be-removed"), { recursive: true });
    expect(() => expectIdenticalSnapshots(before, snapshotDir(runtimeDir))).toThrow();
  });

  it("self-check finding 四: detects a directory's own mtime changing", () => {
    const dir = join(runtimeDir, "secrets");
    const before = snapshotDir(runtimeDir);
    const distinctPast = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(dir, distinctPast, distinctPast);
    expect(() => expectIdenticalSnapshots(before, snapshotDir(runtimeDir))).toThrow();
  });

  it("self-check finding 四: detects a file's permission bits changing with content/size/mtime all unchanged (chmod does not touch mtime)", () => {
    const file = join(runtimeDir, "secrets", "totp.key");
    const beforeStat = statSync(file);
    const originalMode = beforeStat.mode & 0o777;
    // 0o444 is guaranteed to differ from writeFileSync's default mode
    // (0o644 under a typical 022 umask, confirmed empirically) -- picking a
    // fixed "different" mode instead of e.g. re-applying the same default
    // is what makes this a real permission CHANGE rather than an accidental
    // no-op chmod.
    const before = snapshotDir(runtimeDir);
    chmodSync(file, 0o444);
    const afterStat = statSync(file);
    expect(afterStat.mode & 0o777).not.toBe(originalMode);
    // chmod must not have moved mtime -- otherwise this would not isolate
    // "permission changed" from "the OLD fields already caught it".
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    try {
      expect(() => expectIdenticalSnapshots(before, snapshotDir(runtimeDir))).toThrow();
    } finally {
      chmodSync(file, originalMode);
    }
  });

  it("self-check finding 四: detects a symlink added (the old code silently skipped symlinks -- neither isFile() nor isDirectory())", () => {
    const before = snapshotDir(runtimeDir);
    symlinkSync(join(runtimeDir, "secrets", "totp.key"), join(runtimeDir, "a-new-symlink"));
    try {
      expect(() => expectIdenticalSnapshots(before, snapshotDir(runtimeDir))).toThrow();
    } finally {
      rmSync(join(runtimeDir, "a-new-symlink"));
    }
  });

  it("self-check finding 四: detects a symlink's target changing", () => {
    symlinkSync(join(runtimeDir, "secrets", "totp.key"), join(runtimeDir, "a-retargeted-symlink"));
    try {
      const before = snapshotDir(runtimeDir);
      rmSync(join(runtimeDir, "a-retargeted-symlink"));
      symlinkSync(join(runtimeDir, "secrets", "credential-v1.key"), join(runtimeDir, "a-retargeted-symlink"));
      expect(() => expectIdenticalSnapshots(before, snapshotDir(runtimeDir))).toThrow();
    } finally {
      rmSync(join(runtimeDir, "a-retargeted-symlink"), { force: true });
    }
  });
});

describe("X8 gate command: temp files never leak, and never trust TMPDIR blindly (finding 二)", () => {
  // Terminal review, release-identity gate second round, finding 二, second
  // half ("并确保临时文件不落在运行时目录内"): x8_resolve_gate_tmpdir() (scripts/lib/
  // x8-production-like-env.sh) refuses outright when TMPDIR resolves at or
  // inside the runtime directory, instead of silently letting every
  // x8_gate_* mktemp call site place a file (however briefly) inside the
  // very directory the "plan mode / status make zero writes" guarantee is
  // about.
  it("refuses to run at all when TMPDIR resolves inside the runtime directory, instead of silently writing temp files there", () => {
    writeIdentity();
    writeGateState("closed");
    const bogusTmpdir = join(runtimeDir, "tmp-inside-runtime-dir");
    mkdirSync(bogusTmpdir, { recursive: true });
    const result = runGate(["on"], { TMPDIR: bogusTmpdir });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("resolves at or inside the X8 runtime directory");
    // The refusal itself must not have created anything under the bogus
    // TMPDIR either -- it exits before ever calling mktemp.
    expect(readdirSync(bogusTmpdir)).toEqual([]);
  });

  it("still runs normally when TMPDIR points somewhere unrelated to the runtime directory", () => {
    writeIdentity();
    writeGateState("closed");
    const unrelatedTmpdir = mkdtempSync(join(tmpdir(), "x8-gate-unrelated-tmpdir-"));
    try {
      const result = runGate(["on"], { TMPDIR: unrelatedTmpdir });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("X8_GATE_PLAN=PASS");
    } finally {
      rmSync(unrelatedTmpdir, { recursive: true, force: true });
    }
  });

  // Terminal review, release-identity gate second round, finding 二, first
  // half ("没有覆盖全部退出路径的统一清理"): gate_catalog_recreate()'s
  // baseline_file/candidate_file used to be removed by a hand-duplicated
  // `rm -f` immediately before each of its ~9 return points -- which did
  // nothing at all for a raw SIGTERM/SIGINT delivered while the function is
  // genuinely blocked in `docker compose up` (this function is called at
  // the top level, never inside a tested `if`/`||`, so `set -e` gives it no
  // protection either). An EXIT trap is what actually covers that path.
  // This spawns the gate command ASYNCHRONOUSLY (not spawnSync) specifically
  // so the test can deliver SIGTERM while the stub `docker compose up` is
  // still sleeping, then assert no x8-gate-baseline.*/x8-gate-candidate.*
  // file was left behind in a dedicated, otherwise-empty TMPDIR.
  it("finding 二: an EXIT trap removes baseline_file/candidate_file even when SIGTERM arrives while blocked in `docker compose up`", async () => {
    writeIdentity();
    writeGateState("closed");
    const isolatedTmpdir = mkdtempSync(join(tmpdir(), "x8-gate-sigterm-tmpdir-"));
    try {
      const marker = join(runtimeDir, "recreate-marker.env");
      const child = spawn("bash", [launcher, "gate", "catalog-write", "on", "--apply"], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${stubBinDir}:${process.env.PATH}`,
          X8_RUNTIME_DIR: runtimeDir,
          TMPDIR: isolatedTmpdir,
          STUB_MARKER_FILE: marker,
          ...HAPPY_STUB_ENV,
          // Blocks the stub's `docker compose up` long enough that a SIGTERM
          // sent shortly after spawn is guaranteed to land while this
          // function is still inside that call, with baseline_file/
          // candidate_file (created earlier, before the pre-check) still
          // sitting in isolatedTmpdir.
          STUB_RECREATE_SLEEP_SECONDS: "5",
        },
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
        child.on("exit", (code, signal) => resolveExit({ code, signal }));
      });
      // Give the child enough time to get through identity resolution and
      // the three-way pre-check and reach the stub's (now-sleeping) `docker
      // compose up` call before signaling it.
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 700));
      child.kill("SIGTERM");
      const { signal } = await exited;
      expect(signal).toBe("SIGTERM");
      const leftover = readdirSync(isolatedTmpdir).filter(
        (name) => name.startsWith("x8-gate-baseline.") || name.startsWith("x8-gate-candidate."),
      );
      expect(leftover).toEqual([]);
    } finally {
      rmSync(isolatedTmpdir, { recursive: true, force: true });
    }
  }, 10000);
});

describe("X8 gate command: status is read-only", () => {
  it("fails clearly (without creating anything) when there is no gate state yet", () => {
    const result = runGate(["status"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("nothing has been established yet");
  });

  // 2026-09-06 patch (second round), group 4: `gate catalog-write status`
  // now requires the same already-established identity every other gate
  // subcommand requires (see gate_catalog_status()'s own comment for why --
  // in short, querying containers through the non-identity-bound x8_compose()
  // wrapper is what made this command unable to run in a genuinely clean
  // shell in the first place). This test used to prove status worked
  // WITHOUT an identity file at all; that specific claim is no longer true
  // by design, so it now establishes one like every other test in this file.
  it("reports the persisted state and a container match, with zero writes", () => {
    writeIdentity();
    writeGateState("closed");
    const before = snapshotDir(runtimeDir);
    const result = runGate(["status"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("X8_CATALOG_GATE=closed");
    expect(result.stdout).toContain("X8_CATALOG_GATE_CONTAINER_CHECK=match");
    expectIdenticalSnapshots(before, snapshotDir(runtimeDir));
  });

  it("reports drift (but still exits 0, a warning not a failure) when the container disagrees with the state file", () => {
    writeIdentity();
    writeGateState("apply"); // expects true/true; HAPPY_STUB_ENV containers are false/false
    const result = runGate(["status"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("X8_CATALOG_GATE_CONTAINER_CHECK=drift");
    expect(result.stderr).toContain("X8 catalog-write gate drift");
  });

  it("checks BOTH web and worker, not only web (P1-9)", () => {
    writeIdentity();
    writeGateState("closed");
    const result = runGate(["status"], { STUB_WORKER_CONTAINER_ID: "" }); // web running, worker is not
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("X8_CATALOG_GATE_CONTAINER_CHECK=drift");
    expect(result.stderr).toContain("only one of web/worker has a running container");
  });

  it("treats a query failure as an error, not as 'no container' (P1-9 fail-closed)", () => {
    writeIdentity();
    writeGateState("closed");
    const result = runGate(["status"], { STUB_PS_FAIL_WEB: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("X8_CATALOG_GATE_CONTAINER_CHECK=skipped");
    expect(result.stderr).toContain("status query failed");
  });

  it("never creates the identity file, the secrets directory, or any other side effect", () => {
    writeGateState("closed");
    runGate(["status"]);
    // release-identity.json must still not exist (never created), and the
    // secrets directory that establishRuntime() pre-created must be
    // completely unchanged.
    expect(() => statSync(join(runtimeDir, "release-identity.json"))).toThrow();
  });
});

// 2026-09-06 patch (second round), group 4: the stub `docker` used by every
// other test in this file never parses a real docker-compose.yml at all --
// its `compose` handler ignores `-p`/`-f` entirely and returns canned
// values regardless of the ambient environment, so it cannot see (and
// cannot catch a regression to) the actual bug: `gate catalog-write status`
// used to set only P1_12_COMPOSE_PROJECT and then invoke the real compose
// binary with none of docker-compose.yml's other required variables set,
// which fails at compose-file interpolation time before this command's own
// diagnostics ever run (confirmed by hand against the real docker CLI while
// diagnosing this). This describe block talks to the REAL docker/docker
// compose binaries -- no stub on PATH -- so it is the one place in this
// suite that actually exercises the real entry point Codex's audit meant.
// It uses a compose PROJECT NAME unique to this test (never
// "cps-novel-x8-local") specifically so it cannot collide with, list, or
// otherwise touch a real X8 local stack that may happen to be running on
// the machine executing this suite -- `ps -q` for a project with no
// containers simply returns nothing, which is all this test needs.
describe("X8 gate command: `gate catalog-write status` against the REAL docker compose binary (group 4)", () => {
  const dockerComposeAvailable = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;

  it.skipIf(!dockerComposeAvailable)("runs to completion in a clean shell -- no ambient compose env beyond PATH/HOME, and no stub", () => {
    writeIdentity({
      composeProject: "cps-novel-x8-gate-status-realdocker-test",
      composeConfigFiles: [resolve(root, "docker-compose.yml"), resolve(root, "infra/production-like/docker-compose.yml")],
    });
    writeGateState("closed");
    const result = spawnSync("bash", [launcher, "gate", "catalog-write", "status"], {
      cwd: root,
      encoding: "utf8",
      env: {
        // Deliberately NOT `...process.env` and NOT the stub bin dir: this
        // is meant to be as close to "a fresh terminal" as this test runner
        // can produce. PATH/HOME are the only carry-overs, since they are
        // what let bash/docker/node resolve at all.
        // NODE_ENV is required by NodeJS.ProcessEnv's type (augmented by
        // Next.js) but has no bearing on docker/docker-compose behavior --
        // carrying it over does not compromise the "clean shell" intent.
        NODE_ENV: process.env.NODE_ENV,
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        X8_RUNTIME_DIR: runtimeDir,
      },
    });
    expect(result.status, `stdout:\n${result.stdout}\n---\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("X8_CATALOG_GATE=closed");
    // No real container exists under this throwaway, never-before-seen
    // project name, so the container cross-check degrades to "skipped" --
    // the regression this test guards against is docker compose itself
    // erroring out on an unset required variable before ever reaching this
    // far, not any particular value of this line.
    expect(result.stdout).toContain("X8_CATALOG_GATE_CONTAINER_CHECK=skipped");
  });
});

describe("X8 top-level `status` command: also read-only (P2-10)", () => {
  it("requires an established identity/runtime and provisions nothing on failure", () => {
    // Nothing established at all beyond establishRuntime()'s scaffolding --
    // no identity, no gate state.
    const before = snapshotDir(runtimeDir);
    const result = runStatus();
    expect(result.status).not.toBe(0);
    expectIdenticalSnapshots(before, snapshotDir(runtimeDir));
  });

  it("lists containers via the identity-bound compose context with zero writes to the runtime directory", () => {
    writeIdentity();
    writeGateState("closed");
    const before = snapshotDir(runtimeDir);
    const result = runStatus();
    expect(result.status, result.stderr).toBe(0);
    expectIdenticalSnapshots(before, snapshotDir(runtimeDir));
  });
});

describe("X8 gate command: readiness wait before post-recreate verification (P2-12)", () => {
  it("fails post-recreate verification when the recreated container never reports healthy", () => {
    writeIdentity();
    writeGateState("closed");
    const before = gateStateFileStat();
    const result = runGate(["on", "--apply"], { STUB_WEB_HEALTH: "starting" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/did not verify cleanly|did not become healthy/);
    expect(gateStateFileStat().mtimeMs).toBe(before.mtimeMs);
  });
});

describe("X8 gate command: apply mode recreates, verifies, and only then writes state", () => {
  it("recreates with --no-build --pull never, changes only the two gate variables, and writes the new state", () => {
    writeIdentity();
    writeGateState("closed");
    const result = runGate(["on", "--apply"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("--no-build --pull never");
    expect(result.stdout).toContain("X8_GATE_APPLY=PASS");
    expect(result.stdout).toContain("X8_CATALOG_GATE=apply");
    expect(readFileSync(join(runtimeDir, "catalog-gate.state"), "utf8").trim()).toBe("apply");
  });

  it("leaves the state file completely untouched when the recreate command itself fails outright (nothing ever changed)", () => {
    writeIdentity();
    writeGateState("closed");
    const before = gateStateFileStat();
    const result = runGate(["on", "--apply"], { STUB_RECREATE_EXIT: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("recreate failed");
    expect(result.stderr).toContain("left unchanged at 'closed'");
    expect(result.stderr).toContain("nothing to roll back");
    expect(gateStateFileStat().mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(join(runtimeDir, "catalog-gate.state"), "utf8").trim()).toBe("closed");
  });

  it("P0-2: a partial success (web reached target, worker never touched) is detected and rolled back to the pre-operation values", () => {
    // Models exactly the hazard the patch work order names: "web closed,
    // worker still open" -- here inverted (opening), but the same shape:
    // the compose command overall reports failure, yet web already moved.
    writeIdentity();
    writeGateState("closed");
    const before = gateStateFileStat();
    const result = runGate(["on", "--apply"], { STUB_RECREATE_EXIT: "1", STUB_RECREATE_PARTIAL: "web" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("did not verify cleanly");
    expect(result.stderr).toContain("attempting a consistency rollback");
    expect(result.stderr).toContain("rolled back successfully");
    expect(result.stderr).toContain("gate state unchanged at 'closed'");
    expect(gateStateFileStat().mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(join(runtimeDir, "catalog-gate.state"), "utf8").trim()).toBe("closed");
  });

  it("P0-2: post-recreate verification catching a wrong image digest triggers a rollback that succeeds", () => {
    writeIdentity();
    writeGateState("closed");
    const before = gateStateFileStat();
    const result = runGate(["on", "--apply"], { STUB_POST_IMAGE: "sha256:" + "7".repeat(64) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("did not verify cleanly");
    expect(result.stderr).toContain("image drifted after recreate");
    expect(result.stderr).toContain("rolled back successfully");
    expect(gateStateFileStat().mtimeMs).toBe(before.mtimeMs);
  });

  it("P0-2: post-recreate verification catching a drifted non-gate key (WORKER_TASK_ALLOWLIST) triggers a rollback that succeeds", () => {
    // 4.4 acceptance: "正常路径执行一次开闸: ... 任务白名单、领取授权角色、双因素
    // 强制、镜像摘要,前后逐项相同" -- this is the direct behavioral test for
    // that clause, not just an inference from the rendered-diff-gate.
    // 2026-09-06 patch (second round), group 3: the message wording changed
    // from a hand-written "WORKER_TASK_ALLOWLIST drifted after recreate" to
    // the shared full-reconciliation diagnostic (ACTUAL_CONTAINER_DRIFT +
    // the formatted per-key line) -- assert on the pieces that prove the
    // right key was actually caught, not the old literal sentence.
    writeIdentity();
    writeGateState("closed");
    const before = gateStateFileStat();
    const result = runGate(["on", "--apply"], { STUB_POST_WORKER_ALLOWLIST_OVERRIDE: "some_other_allowlist" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("did not verify cleanly");
    expect(result.stderr).toContain("environment drifted after recreate");
    expect(result.stderr).toContain("WORKER_TASK_ALLOWLIST");
    expect(result.stderr).toContain("rolled back successfully");
    expect(gateStateFileStat().mtimeMs).toBe(before.mtimeMs);
  });

  // 2026-09-06 patch (second round), group 3: MOBOREADER_PREVIEW_SOURCE_APP_CODES
  // is exactly the kind of key the OLD post-recreate verification (five
  // hand-picked keys: the catalog-write pair, PROMO_CLAIM_ROLES,
  // ADMIN_TWO_FACTOR_ENFORCEMENT, WORKER_TASK_ALLOWLIST) could never catch --
  // it is not on that list, even though the PRE-operation three-way check a
  // few lines up in this same file already reconciles it (see the "three-way
  // pre-check catches drift the reference implementation cannot" describe
  // block above). This is the direct regression test for closing that gap:
  // revert x8_gate_verify_recreate() back to the five-key check and this
  // goes green with no rollback attempted at all (post-recreate verification
  // would report clean when it is not).
  it("group 3: post-recreate verification now also catches drift in a key the OLD hand-checked list never covered (MOBOREADER_PREVIEW_SOURCE_APP_CODES)", () => {
    writeIdentity();
    writeGateState("closed");
    const before = gateStateFileStat();
    const result = runGate(["on", "--apply"], { STUB_POST_WEB_PREVIEW_APPS_OVERRIDE: "some_other_source_app" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("did not verify cleanly");
    expect(result.stderr).toContain("environment drifted after recreate");
    expect(result.stderr).toContain("MOBOREADER_PREVIEW_SOURCE_APP_CODES");
    expect(result.stderr).toContain("rolled back successfully");
    expect(gateStateFileStat().mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(join(runtimeDir, "catalog-gate.state"), "utf8").trim()).toBe("closed");
  });

  // 2026-09-06 patch (second round), group 2: the final write_x8_gate_state()
  // call used to have no failure path of its own -- if it failed AFTER
  // recreate and post-recreate verification had already succeeded, the
  // containers would be left at the NEW target values while the state file
  // silently kept the OLD one, with no rollback attempt and no diagnostic.
  // X8_RUNTIME_DIR is chmod'd read-only (no write/create/delete of new
  // directory entries) right before the run so write_x8_gate_state()'s own
  // `printf ... >"$temporary"` (a NEW file, .tmp.$$-suffixed) fails --
  // portable, no root/special flags needed. The recreate-marker file is
  // pre-created (empty) first so the stub docker's `>>` appends during the
  // recreate/rollback `compose up` calls still succeed: appending to an
  // EXISTING file only needs write permission on the FILE, not the
  // directory (verified by hand before writing this test).
  it("group 2: a failure writing the FINAL gate state file (after a fully successful recreate+verify) is routed through the same compensating rollback", () => {
    writeIdentity();
    writeGateState("closed");
    const before = gateStateFileStat();
    const marker = join(runtimeDir, "recreate-marker.env");
    writeFileSync(marker, "");
    chmodSync(runtimeDir, 0o500);
    try {
      const result = runGate(["on", "--apply"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("writing the new gate state failed");
      expect(result.stderr).toContain("attempting a consistency rollback");
      expect(result.stderr).toContain("rolled back successfully");
    } finally {
      chmodSync(runtimeDir, 0o700);
    }
    expect(gateStateFileStat().mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(join(runtimeDir, "catalog-gate.state"), "utf8").trim()).toBe("closed");
  });

  it("P0-2: when the compensating rollback ALSO fails to verify, this fails loudly with both services' actual live state, and never writes state", () => {
    // A working-directory label mismatch models a genuinely broken compose
    // invocation context (e.g. a second worktree racing on the same runtime
    // dir) that a same-process retry cannot fix -- the rollback recreate
    // hits the identical problem.
    writeIdentity();
    writeGateState("closed");
    const before = gateStateFileStat();
    const result = runGate(["on", "--apply"], { STUB_POST_WEB_LABEL_WORKING_DIR: "/some/other/worktree" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("FATAL");
    expect(result.stderr).toContain("INCONSISTENT");
    expect(result.stderr).toContain("web:");
    expect(result.stderr).toContain("worker:");
    expect(gateStateFileStat().mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(join(runtimeDir, "catalog-gate.state"), "utf8").trim()).toBe("closed");
  });
});
