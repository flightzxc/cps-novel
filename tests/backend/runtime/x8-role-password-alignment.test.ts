import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * 施工工单_PhaseD_安全与运行态收口_2026-09-06.md D-2, 做法2: the network-side
 * scram-sha-256 verification step (x8_verify_db_role_passwords_via_network()
 * in scripts/lib/x8-production-like-env.sh) must fail closed the moment any
 * one of the six roles' passwords does not actually work over the network --
 * this is the "trust 通过但 scram 失败必须判失败" stub scenario the doc names.
 * Sources only scripts/lib/x8-production-like-env.sh (not the full
 * x8-production-like.sh) and calls the function directly against a stub
 * `docker` that models the one `docker run --entrypoint psql postgres:16.14`
 * shape it issues per role -- never a real daemon. The real-Postgres,
 * self-healing side of D-2 (align-then-verify against an actually
 * mismatched role password) is exercised separately in
 * scripts/run-phase-d-role-password-postgres-verification.sh.
 */

const STUB_DOCKER_SCRIPT = readFileSync(
  resolve(import.meta.dirname, "fixtures/x8-role-verify-stub-docker.sh"),
  "utf8",
);
const root = resolve(import.meta.dirname, "../../..");
const envHelper = resolve(root, "scripts/lib/x8-production-like-env.sh");

const ROLES = ["migration_owner", "web_app", "worker_app", "scheduler_app", "analyst_ro", "backup_role"] as const;

let workDir: string;
let runtimeDir: string;
let secretDir: string;
let stubBinDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "x8-role-verify-"));
  runtimeDir = join(workDir, "runtime");
  secretDir = join(workDir, "secrets");
  stubBinDir = join(workDir, "bin");
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(secretDir, { recursive: true });
  mkdirSync(stubBinDir, { recursive: true });
  const dockerPath = join(stubBinDir, "docker");
  writeFileSync(dockerPath, STUB_DOCKER_SCRIPT);
  chmodSync(dockerPath, 0o755);
  for (const role of ROLES) {
    // 48 lowercase hex characters, matching init-roles.sh's own
    // `^[0-9a-f]{48}$` shape -- x8_verify_db_role_passwords_via_network()
    // never validates the shape itself (x8_align_db_role_passwords() does),
    // but keeping it realistic costs nothing.
    writeFileSync(join(secretDir, `${role}.password`), "a".repeat(48));
  }
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function envVarsForRoles(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const role of ROLES) {
    vars[`P1_12_${role.toUpperCase()}_PASSWORD_FILE`] = join(secretDir, `${role}.password`);
  }
  return vars;
}

function run(script: string, envOverrides: Record<string, string | undefined> = {}) {
  return spawnSync("bash", ["-c", script], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${stubBinDir}:${process.env.PATH}`,
      X8_RUNTIME_DIR: runtimeDir,
      ...envVarsForRoles(),
      ...envOverrides,
    },
  });
}

describe("X8 D-2 network-side role password verification (stub)", () => {
  it("passes when every role's network connection succeeds", () => {
    const script = `
      set -euo pipefail
      source "${envHelper}"
      x8_verify_db_role_passwords_via_network
      echo "VERIFY_PASSED=1"
    `;
    const result = run(script);
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("VERIFY_PASSED=1");
  });

  it.each(ROLES)("fails closed and names the role when %s's network connection is rejected", (failingRole) => {
    const script = `
      set -euo pipefail
      source "${envHelper}"
      if x8_verify_db_role_passwords_via_network; then
        echo "VERIFY_UNEXPECTEDLY_PASSED=1"
      else
        echo "VERIFY_REJECTED=1"
      fi
    `;
    const result = run(script, { STUB_ROLE_VERIFY_FAIL_ROLE: failingRole });
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("VERIFY_REJECTED=1");
    expect(result.stdout).not.toContain("VERIFY_UNEXPECTEDLY_PASSED=1");
    expect(result.stderr).toContain(failingRole);
    expect(result.stderr).toContain("scram-sha-256 verification failed");
  });

  it("never falls back to a trust-style success when the network call itself is broken for every role", () => {
    // Simulates "trust 通过但 scram 失败" the other way around: even if SOME
    // other mechanism might have reported success (e.g. a `docker exec`
    // local-socket trust connection would, wrongly, for ANY password), this
    // function only ever asks the network path -- so a universally broken
    // network path fails closed for the very first role, not a silent pass.
    const script = `
      set -euo pipefail
      source "${envHelper}"
      if x8_verify_db_role_passwords_via_network; then
        echo "VERIFY_UNEXPECTEDLY_PASSED=1"
      else
        echo "VERIFY_REJECTED=1"
      fi
    `;
    const result = run(script, { STUB_ROLE_VERIFY_FAIL_ROLE: "migration_owner" });
    expect(result.stdout).toContain("VERIFY_REJECTED=1");
    expect(result.stdout).not.toContain("VERIFY_UNEXPECTEDLY_PASSED=1");
  });
});
