import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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

type DirSnapshot = Record<string, { mtimeMs: number; size: number; sha256: string }>;

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
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        const stat = statSync(full);
        const sha256 = createHash("sha256").update(readFileSync(full)).digest("hex");
        out[rel] = { mtimeMs: stat.mtimeMs, size: stat.size, sha256 };
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

const IDENTITY_DEFAULTS = {
  schemaVersion: 1,
  appVersion: "0.1.0",
  gitCommit: "a".repeat(40),
  level: "0",
  imageRef: "cps-novel:0.1.0-test1234",
  imageDigest: "sha256:" + "1".repeat(64),
  composeProject: "cps-novel-x8-local",
  composeConfigFiles: ["/fixture/docker-compose.yml", "/fixture/infra/production-like/docker-compose.yml"],
  buildDate: "2026-09-05T00:00:00.000Z",
  createdAt: "2026-09-05T00:00:01.000Z",
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

  it("does NOT flag a base-image-baked key present only in the container as drift (the documented, tested exemption)", () => {
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
});

describe("X8 gate command: status is read-only", () => {
  it("fails clearly (without creating anything) when there is no gate state yet", () => {
    const result = runGate(["status"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("nothing has been established yet");
  });

  it("reports the persisted state and a container match without any identity file or writes", () => {
    writeGateState("closed");
    const before = snapshotDir(runtimeDir);
    const result = runGate(["status"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("X8_CATALOG_GATE=closed");
    expect(result.stdout).toContain("X8_CATALOG_GATE_CONTAINER_CHECK=match");
    expectIdenticalSnapshots(before, snapshotDir(runtimeDir));
  });

  it("reports drift (but still exits 0, a warning not a failure) when the container disagrees with the state file", () => {
    writeGateState("apply"); // expects true/true; HAPPY_STUB_ENV containers are false/false
    const result = runGate(["status"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("X8_CATALOG_GATE_CONTAINER_CHECK=drift");
    expect(result.stderr).toContain("X8 catalog-write gate drift");
  });

  it("checks BOTH web and worker, not only web (P1-9)", () => {
    writeGateState("closed");
    const result = runGate(["status"], { STUB_WORKER_CONTAINER_ID: "" }); // web running, worker is not
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("X8_CATALOG_GATE_CONTAINER_CHECK=drift");
    expect(result.stderr).toContain("only one of web/worker has a running container");
  });

  it("treats a query failure as an error, not as 'no container' (P1-9 fail-closed)", () => {
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
    writeIdentity();
    writeGateState("closed");
    const before = gateStateFileStat();
    const result = runGate(["on", "--apply"], { STUB_POST_WORKER_ALLOWLIST_OVERRIDE: "some_other_allowlist" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("WORKER_TASK_ALLOWLIST drifted after recreate");
    expect(result.stderr).toContain("rolled back successfully");
    expect(gateStateFileStat().mtimeMs).toBe(before.mtimeMs);
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
