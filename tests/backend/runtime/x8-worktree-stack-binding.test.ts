import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * 施工工单_PhaseD_安全与运行态收口_2026-09-06.md D-4: `up` / `gate` must refuse
 * to operate on a compose project already running from a DIFFERENT
 * worktree, before touching any container. This sources
 * scripts/x8-production-like.sh (safe to source -- its CLI dispatch is
 * guarded to only run when the file is executed directly, see that file's
 * own comment) and calls x8_assert_worktree_stack_binding() directly
 * against a stub `docker` on PATH, exactly the three scenarios the doc
 * names: mismatched labels -> reject; matching labels -> pass; no running
 * container at all -> pass.
 */

const STUB_DOCKER_SCRIPT = readFileSync(resolve(import.meta.dirname, "fixtures/x8-gate-stub-docker.sh"), "utf8");
const root = resolve(import.meta.dirname, "../../..");
const launcher = resolve(root, "scripts/x8-production-like.sh");

let workDir: string;
let runtimeDir: string;
let stubBinDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "x8-worktree-binding-"));
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

function run(script: string, envOverrides: Record<string, string | undefined> = {}) {
  return spawnSync("bash", ["-c", script], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${stubBinDir}:${process.env.PATH}`,
      X8_RUNTIME_DIR: runtimeDir,
      ...envOverrides,
    },
  });
}

describe("X8 D-4 worktree <-> stack binding pre-flight", () => {
  it("passes silently when no container is running under the compose project at all", () => {
    const script = `
      set -euo pipefail
      source "${launcher}"
      x8_assert_worktree_stack_binding "cps-novel-x8-local" "$X8_PROJECT_ROOT" "$(x8_expected_compose_config_files)"
      echo "BINDING_CHECK_PASSED=1"
    `;
    const result = run(script);
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("BINDING_CHECK_PASSED=1");
  });

  it("passes when a running container's labels are set (from inside the shell) to match this worktree exactly", () => {
    const script = `
      set -euo pipefail
      source "${launcher}"
      export STUB_FOREIGN_PROJECT_CONTAINER_ID="foreign-container-1"
      export STUB_FOREIGN_PROJECT_NAME="cps-novel-x8-local"
      export STUB_FOREIGN_PROJECT_LABEL_WORKING_DIR="$X8_PROJECT_ROOT"
      export STUB_FOREIGN_PROJECT_LABEL_CONFIG_FILES="$(x8_expected_compose_config_files)"
      x8_assert_worktree_stack_binding "cps-novel-x8-local" "$X8_PROJECT_ROOT" "$(x8_expected_compose_config_files)"
      echo "BINDING_CHECK_PASSED=1"
    `;
    const result = run(script);
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("BINDING_CHECK_PASSED=1");
  });

  it("rejects when a running container's labels point at a different worktree root", () => {
    const script = `
      set -euo pipefail
      source "${launcher}"
      export STUB_FOREIGN_PROJECT_CONTAINER_ID="foreign-container-1"
      export STUB_FOREIGN_PROJECT_NAME="cps-novel-x8-local"
      export STUB_FOREIGN_PROJECT_LABEL_WORKING_DIR="/Users/someone/other-worktree"
      export STUB_FOREIGN_PROJECT_LABEL_CONFIG_FILES="/Users/someone/other-worktree/docker-compose.yml,/Users/someone/other-worktree/infra/production-like/docker-compose.yml"
      if x8_assert_worktree_stack_binding "cps-novel-x8-local" "$X8_PROJECT_ROOT" "$(x8_expected_compose_config_files)"; then
        echo "BINDING_CHECK_UNEXPECTEDLY_PASSED=1"
      else
        echo "BINDING_CHECK_REJECTED=1"
      fi
    `;
    const result = run(script);
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("BINDING_CHECK_REJECTED=1");
    expect(result.stdout).not.toContain("BINDING_CHECK_UNEXPECTEDLY_PASSED=1");
    expect(result.stderr).toContain("already running from a different worktree");
    expect(result.stderr).toContain("/Users/someone/other-worktree");
  });

  it("rejects when the project name matches but only the config_files label differs", () => {
    const script = `
      set -euo pipefail
      source "${launcher}"
      export STUB_FOREIGN_PROJECT_CONTAINER_ID="foreign-container-1"
      export STUB_FOREIGN_PROJECT_NAME="cps-novel-x8-local"
      export STUB_FOREIGN_PROJECT_LABEL_WORKING_DIR="$X8_PROJECT_ROOT"
      export STUB_FOREIGN_PROJECT_LABEL_CONFIG_FILES="/tampered/docker-compose.yml"
      if x8_assert_worktree_stack_binding "cps-novel-x8-local" "$X8_PROJECT_ROOT" "$(x8_expected_compose_config_files)"; then
        echo "BINDING_CHECK_UNEXPECTEDLY_PASSED=1"
      else
        echo "BINDING_CHECK_REJECTED=1"
      fi
    `;
    const result = run(script);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("BINDING_CHECK_REJECTED=1");
  });

  it("up_x8's real entry point calls the binding check before build_app_image/prepare_database (source-level wiring proof)", () => {
    const launcherSource = readFileSync(launcher, "utf8");
    const upStart = launcherSource.indexOf("\nup_x8()");
    expect(upStart).toBeGreaterThan(0);
    const bindingCallIndex = launcherSource.indexOf("x8_assert_worktree_stack_binding", upStart);
    const buildIndex = launcherSource.indexOf("build_app_image", upStart);
    const prepareDbIndex = launcherSource.indexOf("prepare_database", upStart);
    expect(bindingCallIndex).toBeGreaterThan(upStart);
    expect(bindingCallIndex).toBeLessThan(buildIndex);
    expect(bindingCallIndex).toBeLessThan(prepareDbIndex);
  });

  it("gate_catalog_status and gate_catalog_recreate also call the binding check", () => {
    const launcherSource = readFileSync(launcher, "utf8");
    const statusStart = launcherSource.indexOf("\ngate_catalog_status()");
    const statusEnd = launcherSource.indexOf("\n}\n", statusStart);
    expect(statusStart).toBeGreaterThan(0);
    expect(launcherSource.slice(statusStart, statusEnd)).toContain("x8_assert_worktree_stack_binding");

    const recreateStart = launcherSource.indexOf("\ngate_catalog_recreate()");
    expect(recreateStart).toBeGreaterThan(0);
    expect(launcherSource.slice(recreateStart, recreateStart + 2000)).toContain("x8_assert_worktree_stack_binding");
  });
});
