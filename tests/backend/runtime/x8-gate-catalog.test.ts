import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const STUB_DOCKER_SCRIPT = readFileSync(resolve(import.meta.dirname, "fixtures/x8-gate-stub-docker.sh"), "utf8");

/**
 * X8 release-identity gate work order (2026-09-05), 施工项一. These exercise
 * `scripts/x8-production-like.sh gate catalog-write ...` as a real subprocess
 * against a stub `docker` on PATH, so the bash orchestration itself (not
 * just the pure diff logic in x8-gate-diff.test.ts) is under test: identity
 * resolution, the three-way pre-check, plan-mode-is-default, and the
 * zero-writes guarantees for plan mode and the status subcommand.
 *
 * The stub never talks to a real docker daemon or the real running
 * cps-novel-x8-local containers -- every docker/compose response is a canned
 * fixture driven by STUB_* environment variables (see
 * tests/backend/runtime/fixtures/x8-gate-stub-docker.sh), and X8_RUNTIME_DIR
 * always points at a throwaway temp directory.
 */

const root = resolve(import.meta.dirname, "../../..");
const launcher = resolve(root, "scripts/x8-production-like.sh");

let workDir: string;
let runtimeDir: string;
let stubBinDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "x8-gate-catalog-"));
  runtimeDir = join(workDir, "runtime");
  stubBinDir = join(workDir, "bin");
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(stubBinDir, { recursive: true });
  const dockerPath = join(stubBinDir, "docker");
  writeFileSync(dockerPath, STUB_DOCKER_SCRIPT);
  chmodSync(dockerPath, 0o755);
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
  ]),
  STUB_WORKER_ENV_JSON: JSON.stringify([
    "FEATURE_NOVEL_CATALOG_SYNC=false",
    "NOVEL_CATALOG_SYNC_ALLOW_WRITE=false",
    "WORKER_TASK_ALLOWLIST=credential.validate.v1,credential.supersede.v1,catalog_scan,home_carousel.compute.v1",
  ]),
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
});

describe("X8 gate command: the three-way pre-check catches drift the reference implementation cannot", () => {
  it("fails closed when the persisted state says the gate is open but the containers actually have it closed", () => {
    // Reproduces this repo's confirmed real drift as of this work order:
    // catalog-gate.state = apply, but both running containers actually have
    // FEATURE_NOVEL_CATALOG_SYNC=false / NOVEL_CATALOG_SYNC_ALLOW_WRITE=false.
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
});

describe("X8 gate command: plan mode is the default and produces zero writes", () => {
  it("does not touch the gate state file's mtime, or its content, without --apply", () => {
    writeIdentity();
    writeGateState("closed");
    const before = gateStateFileStat();
    const beforeContent = readFileSync(join(runtimeDir, "catalog-gate.state"), "utf8");
    const result = runGate(["on"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("X8_GATE_PLAN=PASS");
    expect(result.stdout).toContain("No production-like action was executed");
    const after = gateStateFileStat();
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(join(runtimeDir, "catalog-gate.state"), "utf8")).toBe(beforeContent);
  });

  it("does not create a recreate marker (i.e. never calls compose up) in plan mode", () => {
    writeIdentity();
    writeGateState("closed");
    const marker = join(runtimeDir, "recreate-marker.env");
    runGate(["on"]);
    expect(() => statSync(marker)).toThrow();
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
    const before = gateStateFileStat();
    const result = runGate(["status"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("X8_CATALOG_GATE=closed");
    expect(result.stdout).toContain("X8_CATALOG_GATE_CONTAINER_CHECK=match");
    expect(gateStateFileStat().mtimeMs).toBe(before.mtimeMs);
  });

  it("reports drift (but still exits 0, a warning not a failure) when the container disagrees with the state file", () => {
    writeGateState("apply"); // expects true/true; HAPPY_STUB_ENV containers are false/false
    const result = runGate(["status"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("X8_CATALOG_GATE_CONTAINER_CHECK=drift");
    expect(result.stderr).toContain("X8 catalog-write gate drift");
  });

  it("never creates the identity file, the secrets directory, or any other side effect", () => {
    writeGateState("closed");
    runGate(["status"]);
    expect(() => statSync(join(runtimeDir, "release-identity.json"))).toThrow();
    expect(() => statSync(join(runtimeDir, "secrets"))).toThrow();
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

  it("leaves the state file completely untouched when the recreate itself fails", () => {
    writeIdentity();
    writeGateState("closed");
    const before = gateStateFileStat();
    const result = runGate(["on", "--apply"], { STUB_RECREATE_EXIT: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("recreate failed");
    expect(result.stderr).toContain("left unchanged at 'closed'");
    expect(gateStateFileStat().mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(join(runtimeDir, "catalog-gate.state"), "utf8").trim()).toBe("closed");
  });

  it("fails post-recreate verification (and still does not write state) when the recreated image digest is wrong", () => {
    writeIdentity();
    writeGateState("closed");
    const before = gateStateFileStat();
    const result = runGate(["on", "--apply"], { STUB_POST_IMAGE: "sha256:" + "7".repeat(64) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("post-recreate verification failed");
    expect(result.stderr).toContain("image drifted after recreate");
    expect(gateStateFileStat().mtimeMs).toBe(before.mtimeMs);
  });

  it("fails post-recreate verification when a non-gate identity-relevant key (WORKER_TASK_ALLOWLIST) drifted after recreate", () => {
    // 4.4 acceptance: "正常路径执行一次开闸: ... 任务白名单、领取授权角色、双因素
    // 强制、镜像摘要,前后逐项相同" -- this is the direct behavioral test for
    // that clause, not just an inference from the rendered-diff-gate.
    writeIdentity();
    writeGateState("closed");
    const before = gateStateFileStat();
    const result = runGate(["on", "--apply"], { STUB_POST_WORKER_ALLOWLIST_OVERRIDE: "some_other_allowlist" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("post-recreate verification failed");
    expect(result.stderr).toContain("WORKER_TASK_ALLOWLIST drifted after recreate");
    expect(gateStateFileStat().mtimeMs).toBe(before.mtimeMs);
  });
});
