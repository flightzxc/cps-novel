import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const STUB_DOCKER_SCRIPT = readFileSync(resolve(import.meta.dirname, "fixtures/x8-gate-stub-docker.sh"), "utf8");

/**
 * 2026-09-06 patch (second round), group 1: the terminal review found that
 * every existing test for the release-identity write/promote machinery only
 * ever exercised it by hand-writing the files a real `up` would have left
 * behind (writeIdentity()/writeGateState() in x8-gate-catalog.test.ts) and
 * checking how the GATE command reads them afterward -- nothing actually
 * ran the candidate-write -> health-check -> promote-or-fail chain itself.
 * This file does exactly that, by sourcing scripts/x8-production-like.sh
 * (safe now that its CLI dispatch is guarded to only run when the file is
 * executed directly, not sourced -- see that file's own comment) and
 * calling its real functions in the same sequence up_x8() does:
 *   write_x8_identity_candidate -> [trap armed] -> x8_wait_services_healthy
 *   -> promote_x8_identity_candidate
 * against a stub `docker` on PATH -- never a real daemon, never real
 * containers.
 */

const root = resolve(import.meta.dirname, "../../..");
const launcher = resolve(root, "scripts/x8-production-like.sh");

let workDir: string;
let runtimeDir: string;
let stubBinDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "x8-identity-lifecycle-"));
  runtimeDir = join(workDir, "runtime");
  stubBinDir = join(workDir, "bin");
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(stubBinDir, { recursive: true });
  const dockerPath = join(stubBinDir, "docker");
  writeFileSync(dockerPath, STUB_DOCKER_SCRIPT);
  chmodSync(dockerPath, 0o755);
});

afterEach(() => {
  // A test that deliberately chmod's runtimeDir read-only always restores
  // it in its own try/finally before this runs -- this is just the normal
  // cleanup path.
  rmSync(workDir, { recursive: true, force: true });
});

const IMAGE_REF = "cps-novel:0.1.0-lifecycle-test";
const IMAGE_ID = "sha256:" + "4".repeat(64);

const BASE_ENV = {
  CPS_NOVEL_APP_IMAGE: IMAGE_REF,
  APP_VERSION: "9.9.9-lifecycle",
  GIT_COMMIT: "c".repeat(40),
  X8_LEVEL: "0",
  P1_12_COMPOSE_PROJECT: "cps-novel-x8-local",
  BUILD_DATE: "2026-09-06T00:00:00.000Z",
  // Finding 三 (release-identity gate second round): write_x8_identity_candidate()
  // now also freezes X8_ADMIN_DOMAIN and CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION
  // into the identity payload (levelEnv itself is resolved by calling the
  // REAL x8_level_config() against this repo's own scripts/lib/x8-levels.json,
  // which needs no stubbing since it is a pure, already-committed file read).
  // These two stand in for what prepare_x8_environment() would have already
  // exported by the time a real `up` reaches write_x8_identity_candidate(),
  // exactly like the other hand-set vars in this fixture already do.
  X8_ADMIN_DOMAIN: "zbcwf.novel.test",
  CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION: "1",
  STUB_IMAGE_REF: IMAGE_REF,
  STUB_IMAGE_ID: IMAGE_ID,
  STUB_WEB_CONTAINER_ID: "stub-web-1",
  STUB_WORKER_CONTAINER_ID: "stub-worker-1",
  STUB_SCHEDULER_CONTAINER_ID: "stub-scheduler-1",
  X8_GATE_READY_RETRIES: "1",
  X8_GATE_READY_SLEEP_SECONDS: "0",
};

function runLifecycle(script: string, envOverrides: Record<string, string | undefined> = {}) {
  return spawnSync("bash", ["-c", script], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${stubBinDir}:${process.env.PATH}`,
      X8_RUNTIME_DIR: runtimeDir,
      ...BASE_ENV,
      ...envOverrides,
    },
  });
}

function identityFilePath() {
  return join(runtimeDir, "release-identity.json");
}

function candidateFilePath() {
  return join(runtimeDir, "release-identity.candidate.json");
}

function failureMarkerPath() {
  return join(runtimeDir, "release-identity.failed.txt");
}

describe("X8 release identity lifecycle: candidate write -> health check -> promote (group 1)", () => {
  it("promotes the candidate to the committed identity once every service reports healthy", () => {
    const script = `
      set -euo pipefail
      source "${launcher}"
      write_x8_identity_candidate
      X8_IDENTITY_DEPLOY_IN_PROGRESS=1
      trap 'x8_up_exit_trap' EXIT
      x8_wait_services_healthy web worker scheduler
      promote_x8_identity_candidate
      echo "LIFECYCLE_DONE=1"
    `;
    const result = runLifecycle(script);
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("LIFECYCLE_DONE=1");
    const identity = JSON.parse(readFileSync(identityFilePath(), "utf8"));
    expect(identity.appVersion).toBe("9.9.9-lifecycle");
    expect(identity.imageDigest).toBe(IMAGE_ID);
    // The candidate is consumed (renamed away) by a successful promotion,
    // and no failure marker was ever written.
    expect(() => statSync(candidateFilePath())).toThrow();
    expect(() => statSync(failureMarkerPath())).toThrow();
    // Finding 三: write_x8_identity_candidate() now freezes the FULL X8_LEVEL
    // configuration and the two remaining ambient-inherited defaults into
    // the identity, at schemaVersion 2.
    expect(identity.schemaVersion).toBe(2);
    expect(identity.adminDomain).toBe("zbcwf.novel.test");
    expect(identity.credentialActiveKeyVersion).toBe("1");
    // Level "0" real values from the repo's own scripts/lib/x8-levels.json --
    // proves levelEnv is the ACTUAL resolved table content, not a placeholder.
    expect(identity.levelEnv).toMatchObject({
      WORKER_TASK_ALLOWLIST: "credential.validate.v1,credential.supersede.v1,catalog_scan,home_carousel.compute.v1",
      PROMO_CLAIM_ROLES: "",
      ADMIN_TWO_FACTOR_ENFORCEMENT: "true",
      ADMIN_LOCAL_IDENTITY_SEED: "",
      FEATURE_PROMO_LINK_CLAIM: "false",
    });
  });

  // This is the direct reproduction of the incident named in the work
  // order: "worker 起来就退出、web 正常时，身份仍会被提升为已提交". Web and
  // scheduler report healthy; worker never does. Before this patch, nothing
  // in `up` checked worker's health at all (only web, indirectly, via the
  // later HTTP probes) -- x8_wait_services_healthy() is the fix, and this
  // is its regression test: revert the `x8_wait_services_healthy web worker
  // scheduler` call in up_x8() (or the function itself) and this goes green
  // for the wrong reason (LIFECYCLE_DONE=1, identity promoted) instead of
  // failing before promotion.
  it("does NOT promote when worker never reports healthy, even though web and scheduler do", () => {
    const script = `
      set -euo pipefail
      source "${launcher}"
      write_x8_identity_candidate
      X8_IDENTITY_DEPLOY_IN_PROGRESS=1
      trap 'x8_up_exit_trap' EXIT
      x8_wait_services_healthy web worker scheduler
      promote_x8_identity_candidate
      echo "LIFECYCLE_DONE=1"
    `;
    const result = runLifecycle(script, { STUB_WORKER_HEALTH: "unhealthy" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("LIFECYCLE_DONE=1");
    // Never promoted: no committed identity file at all (this was the
    // first-ever deploy in this throwaway runtime dir).
    expect(() => statSync(identityFilePath())).toThrow();
    expect(result.stderr).toContain("did not report healthy");
    // The failure marker records what happened and says the (nonexistent)
    // previously committed identity was left untouched -- accurate here,
    // since there never was one.
    const marker = readFileSync(failureMarkerPath(), "utf8");
    expect(marker).toContain("candidate identity was written but before it was promoted");
    expect(marker).toContain("previously_committed_identity=<none");
  });

  it("a service that never even started (no container at all) fails the same way as one that started but never became healthy", () => {
    const script = `
      set -euo pipefail
      source "${launcher}"
      write_x8_identity_candidate
      X8_IDENTITY_DEPLOY_IN_PROGRESS=1
      trap 'x8_up_exit_trap' EXIT
      x8_wait_services_healthy web worker scheduler
      promote_x8_identity_candidate
      echo "LIFECYCLE_DONE=1"
    `;
    const result = runLifecycle(script, { STUB_SCHEDULER_CONTAINER_ID: "" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("LIFECYCLE_DONE=1");
    expect(() => statSync(identityFilePath())).toThrow();
    expect(result.stderr).toContain("scheduler container does not exist");
  });

  it("leaves a PRE-EXISTING committed identity byte-for-byte untouched when the new deploy fails the health check", () => {
    const previousIdentity = {
      schemaVersion: 1,
      appVersion: "1.0.0-previous",
      gitCommit: "b".repeat(40),
      level: "0",
      imageRef: "cps-novel:1.0.0-previous",
      imageDigest: "sha256:" + "5".repeat(64),
      composeProject: "cps-novel-x8-local",
      composeConfigFiles: ["/fixture/docker-compose.yml", "/fixture/infra/production-like/docker-compose.yml"],
      buildDate: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:01.000Z",
    };
    writeFileSync(identityFilePath(), JSON.stringify(previousIdentity, null, 2));
    const before = readFileSync(identityFilePath(), "utf8");

    const script = `
      set -euo pipefail
      source "${launcher}"
      write_x8_identity_candidate
      X8_IDENTITY_DEPLOY_IN_PROGRESS=1
      trap 'x8_up_exit_trap' EXIT
      x8_wait_services_healthy web worker scheduler
      promote_x8_identity_candidate
      echo "LIFECYCLE_DONE=1"
    `;
    const result = runLifecycle(script, { STUB_WORKER_HEALTH: "unhealthy" });
    expect(result.status).not.toBe(0);
    expect(readFileSync(identityFilePath(), "utf8")).toBe(before);
    const marker = readFileSync(failureMarkerPath(), "utf8");
    expect(marker).toContain("previously_committed_identity_left_untouched_at=");
  });

  // Group 1 bullet 2 (promote_x8_identity_candidate ordering): a failure
  // AFTER a successful promotion (modeling e.g. `x8_compose up -d
  // backup-timer` failing, or any other later step in up_x8()) must never
  // retroactively make the EXIT trap claim the committed identity "was left
  // untouched" -- it was not; it was already committed. Revert
  // promote_x8_identity_candidate() to clear X8_IDENTITY_DEPLOY_IN_PROGRESS
  // as a SEPARATE statement in the caller (the pre-patch shape) rather than
  // as its own first action after the `mv` succeeds, and this goes red: a
  // failure marker appears, falsely claiming the identity was never
  // committed.
  it("group 1 bullet 2: a failure AFTER promotion succeeds never produces a failure marker that falsely claims the identity was left untouched", () => {
    const script = `
      set -euo pipefail
      source "${launcher}"
      write_x8_identity_candidate
      X8_IDENTITY_DEPLOY_IN_PROGRESS=1
      trap 'x8_up_exit_trap' EXIT
      x8_wait_services_healthy web worker scheduler
      promote_x8_identity_candidate
      false
    `;
    const result = runLifecycle(script);
    expect(result.status).not.toBe(0);
    // The identity WAS committed -- promotion itself succeeded.
    const identity = JSON.parse(readFileSync(identityFilePath(), "utf8"));
    expect(identity.appVersion).toBe("9.9.9-lifecycle");
    // ... so no failure marker should exist claiming otherwise.
    expect(() => statSync(failureMarkerPath())).toThrow();
  });

  // Group 1 bullet 3: x8_mark_identity_deploy_failed()'s own write must
  // never mask the ORIGINAL exit status the EXIT trap exists to preserve.
  // Verified by hand before writing this test: a bare `{ ...; } >"$temporary"`
  // whose redirect TARGET cannot even be opened (e.g. a read-only directory)
  // does NOT actually trip `set -e` in bash (3.2 or 5.x -- checked both) --
  // that specific failure shape turns out to be one of bash's few documented
  // `errexit` exemptions, so it would not have discriminated the fix from
  // the bug. What DOES trip `set -e` inside that block is an ordinary INNER
  // command failing -- here, `cat "$X8_IDENTITY_CANDIDATE_FILE"` failing
  // because the candidate is present (passes the function's own `[[ -f ]]`
  // check) but unreadable, which is exactly the class of failure ("the
  // runtime directory briefly unwritable, disk full, a TOCTOU race deleting
  // or permission-mangling the candidate mid-write, ...") the source
  // comment names.
  it("group 1 bullet 3: a failure partway through writing the failure marker never masks the ORIGINAL exit status", () => {
    const script = `
      set -euo pipefail
      source "${launcher}"
      write_x8_identity_candidate
      chmod 000 "$X8_IDENTITY_CANDIDATE_FILE"
      X8_IDENTITY_DEPLOY_IN_PROGRESS=1
      trap 'x8_up_exit_trap' EXIT
      exit 42
    `;
    const result = runLifecycle(script);
    try {
      expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(42);
    } finally {
      // Restore read/write so afterEach's rmSync can delete it.
      try {
        chmodSync(candidateFilePath(), 0o600);
      } catch {
        // Candidate was never created (an unrelated failure) -- nothing to restore.
      }
    }
  });

  it("ships valid shell (sourcing this file must never itself dispatch a subcommand)", () => {
    const script = `
      set -euo pipefail
      source "${launcher}"
      echo "SOURCED_WITHOUT_DISPATCH=1"
    `;
    const result = spawnSync("bash", ["-c", script], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, X8_RUNTIME_DIR: runtimeDir },
    });
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("SOURCED_WITHOUT_DISPATCH=1");
    // If the dispatch guard regressed, sourcing with zero args would hit
    // `usage()`, which prints to stderr and exits 64 before this script's
    // own echo ever ran.
    expect(result.stdout).not.toContain("usage:");
  });
});
