import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * D-9a (施工工单_D9_up数据库准备原子化与镜像保留_2026-09-09.md 三.3) contract
 * tests for prepare_database()'s atomicity guarantees. The 2026-09-08
 * outage's root cause (施工工单二.2/2.2): grants.sql REVOKEs every
 * application role's privileges up front, then re-GRANTs them line by line,
 * and the psql invocation that ran it committed each statement separately
 * -- a mid-file failure (disk full, connection drop, a table the current
 * migration never finished creating) could leave the REVOKE half committed
 * and the GRANT half never applied, stripping the STILL-RUNNING previous
 * release's database access out from under it. This suite locks down the
 * fix: nothing in prepare_database() may leave the currently running
 * release worse off than it was before a failed `up` started.
 *
 * Three properties are asserted here (a fourth -- grants.sql itself now
 * running under --single-transaction -- is asserted directly against
 * infra/postgres/grants.sql and the real invocation in
 * tests/backend/runtime/x8-production-like-contract.test.ts, alongside this
 * work order's disk-preflight-before-roles.sql ordering assertion):
 *   1. A disk-preflight gate (闸B) refuses BEFORE any DDL/role statement is
 *      sent, the moment free space is below X8_MIN_FREE_KIB_DB.
 *   2. Every OTHER failure path in prepare_database() restores the
 *      CURRENTLY RUNNING release's own grants.sql (read via real `git show`
 *      against the release identity's recorded gitCommit -- never this
 *      worktree's own copy, see 施工工单 2.3's documented boundary on why
 *      that would just fail again), prints a fixed two-line
 *      X8_DB_PREP_FAILED_AT=<step>/X8_DB_PREP_GRANTS_INTACT=<yes|no|n/a>
 *      status block to stderr, and never swallows the original exit code.
 *   3. The failure marker x8_mark_identity_deploy_failed() writes records
 *      which step was reached and whether grants were confirmed intact.
 *
 * Sources the FULL scripts/x8-production-like.sh (safe to source -- its CLI
 * dispatch only runs when the file is executed directly, per that file's
 * own comment) and calls prepare_database()/x8_mark_identity_deploy_failed()
 * directly against a stub `docker` on PATH, the same pattern
 * tests/backend/runtime/x8-identity-lifecycle.test.ts already uses for the
 * candidate/promote chain. Never a real daemon, never a real Postgres
 * server, never a real migration -- and never a stubbed `git`: this deploy
 * identity's "running release" is a real commit in THIS repository (its own
 * HEAD at the time this suite was written), so
 * x8_restore_grants_for_running_release() exercises real `git show` against
 * real repository history, exactly as it will in production.
 */

const STUB_DOCKER_SCRIPT = readFileSync(
  resolve(import.meta.dirname, "fixtures/x8-db-prep-stub-docker.sh"),
  "utf8",
);
const root = resolve(import.meta.dirname, "../../..");
const launcher = resolve(root, "scripts/x8-production-like.sh");

const ROLES = ["migration_owner", "web_app", "worker_app", "scheduler_app", "analyst_ro", "backup_role"] as const;

// A real commit in this repository, guaranteed to contain
// infra/postgres/grants.sql -- x8_restore_grants_for_running_release() must
// replay the RUNNING release's own grants.sql (施工工单 3.2③), never this
// worktree's, so this deliberately exercises real `git show` rather than
// faking git out too.
const RUNNING_RELEASE_COMMIT = "0a8f15096c7adc5dc53f84f6087245d92481231f";

let workDir: string;
let runtimeDir: string;
let secretDir: string;
let stubBinDir: string;
let stubLogDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "x8-db-prep-"));
  runtimeDir = join(workDir, "runtime");
  secretDir = join(workDir, "secrets");
  stubBinDir = join(workDir, "bin");
  stubLogDir = join(workDir, "stub-log");
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(secretDir, { recursive: true });
  mkdirSync(stubBinDir, { recursive: true });
  mkdirSync(stubLogDir, { recursive: true });
  const dockerPath = join(stubBinDir, "docker");
  writeFileSync(dockerPath, STUB_DOCKER_SCRIPT);
  chmodSync(dockerPath, 0o755);
  for (const role of ROLES) {
    // 48 lowercase hex characters -- x8_align_db_role_passwords() validates
    // this shape before it will issue any ALTER ROLE, same fixture value
    // tests/backend/runtime/x8-role-password-alignment.test.ts already uses.
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
      P1_12_COMPOSE_PROJECT: "cps-novel-x8-local",
      P1_12_MIGRATION_DATABASE_URL: "postgresql://migration_owner:x@postgres:5432/cps_novel?schema=public",
      CPS_NOVEL_APP_IMAGE: "cps-novel:0.1.0-test",
      // Same suggested default the real x8_export_static_topology() ships
      // (施工工单 3.2① 表), spelled out explicitly here because this test
      // never calls prepare_x8_environment() (which is what normally
      // applies that default) -- it calls prepare_database() directly.
      X8_MIN_FREE_KIB_DB: "2097152",
      STUB_LOG_DIR: stubLogDir,
      ...envVarsForRoles(),
      ...envOverrides,
    },
  });
}

// `if prepare_database; then status=0; else status=$?; fi` (rather than a
// bare `prepare_database; status=$?`) is required, not stylistic: sourcing
// scripts/x8-production-like.sh brings `set -euo pipefail` into THIS shell,
// so a bare failing simple command would abort the script immediately,
// before the next line ever captured its exit status.
const CALL_PREPARE_DATABASE = `
  source "${launcher}"
  if prepare_database; then
    status=0
  else
    status=$?
  fi
  echo "PREPARE_DATABASE_EXIT=$status"
  exit "$status"
`;

function writeRunningIdentity(gitCommit = RUNNING_RELEASE_COMMIT) {
  writeFileSync(join(runtimeDir, "release-identity.json"), JSON.stringify({ gitCommit }));
}

function stdinDumpNames(): string[] {
  try {
    return readdirSync(stubLogDir)
      .filter((name) => name.startsWith("psql-stdin-"))
      .sort();
  } catch {
    return [];
  }
}

function stdinDumpContent(name: string): string {
  return readFileSync(join(stubLogDir, name), "utf8");
}

describe("D-9a: prepare_database() atomicity", () => {
  it("restores the running release's grants.sql (via --single-transaction) when migrate deploy fails", () => {
    writeRunningIdentity();
    const result = run(CALL_PREPARE_DATABASE, { STUB_MIGRATE_EXIT: "1" });
    const dumps = stdinDumpNames();
    expect(dumps.length, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBeGreaterThan(0);
    const revokeDumpName = dumps.find((name) => stdinDumpContent(name).includes("REVOKE CREATE ON SCHEMA public FROM PUBLIC"));
    expect(revokeDumpName, `no stdin dump replayed grants.sql; dumps: ${dumps.join(", ") || "<none>"}`).toBeTruthy();
    const argvName = revokeDumpName!.replace(/^psql-stdin-/, "psql-argv-").replace(/\.sql$/, ".txt");
    const argv = readFileSync(join(stubLogDir, argvName), "utf8");
    expect(argv).toContain("--single-transaction");
  });

  it("prints the fixed X8_DB_PREP_FAILED_AT/X8_DB_PREP_GRANTS_INTACT status lines when migrate deploy fails", () => {
    writeRunningIdentity();
    const result = run(CALL_PREPARE_DATABASE, { STUB_MIGRATE_EXIT: "1" });
    expect(result.stderr).toContain("X8_DB_PREP_FAILED_AT=migrate_deploy");
    expect(result.stderr).toContain("X8_DB_PREP_GRANTS_INTACT=yes");
  });

  it("never swallows the original migrate-deploy exit code behind the grants restore", () => {
    writeRunningIdentity();
    const result = run(CALL_PREPARE_DATABASE, { STUB_MIGRATE_EXIT: "3" });
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(3);
    expect(result.stdout).toContain("PREPARE_DATABASE_EXIT=3");
  });

  it("reports n/a and makes zero grants-replay attempts on the very first ever `up` (no committed identity)", () => {
    // Deliberately no release-identity.json written -- models a worktree
    // where `up` has never succeeded before.
    const result = run(CALL_PREPARE_DATABASE, { STUB_MIGRATE_EXIT: "1" });
    expect(result.stderr).toContain("X8_DB_PREP_FAILED_AT=migrate_deploy");
    expect(result.stderr).toContain("X8_DB_PREP_GRANTS_INTACT=n/a");
    const dumps = stdinDumpNames();
    const replayedGrants = dumps.some((name) => stdinDumpContent(name).includes("REVOKE CREATE ON SCHEMA public FROM PUBLIC"));
    expect(replayedGrants, `unexpected grants.sql replay on a first-ever up; dumps: ${dumps.join(", ")}`).toBe(false);
  });

  it("gate B refuses before any DDL/role statement when free space is below X8_MIN_FREE_KIB_DB", () => {
    writeRunningIdentity();
    // X8_MIN_FREE_KIB_DB defaults to 2,097,152 KiB in this suite's env;
    // 1,000,000 KiB is comfortably below it.
    const result = run(CALL_PREPARE_DATABASE, { STUB_DF_AVAILABLE_KIB: "1000000" });
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(69);
    expect(result.stderr).toContain("X8_DB_PREP_FAILED_AT=disk_preflight");
    const dumps = stdinDumpNames();
    expect(dumps, `expected zero stdin-fed psql calls once gate B refuses; got: ${dumps.join(", ")}`).toHaveLength(0);
    // Broader than the stdin-only dumps above: covers the --file (roles.sql)
    // and --command (role-existence check) shapes too, which never get a
    // numbered psql-stdin-*/psql-argv-* pair of their own -- this is the
    // literal "not a single DDL/role statement went out" assertion.
    expect(existsSync(join(stubLogDir, "psql-calls.log")), "expected zero psql invocations of any shape once gate B refuses").toBe(false);
  });

  it("gate B passes through untouched when free space is at or above the threshold (does not itself block a healthy run)", () => {
    writeRunningIdentity();
    // Space is fine, but migrate deploy still fails downstream -- proves
    // gate B did not eat the failure or silently short-circuit later steps.
    const result = run(CALL_PREPARE_DATABASE, { STUB_DF_AVAILABLE_KIB: "9999999", STUB_MIGRATE_EXIT: "1" });
    expect(result.stderr).not.toContain("X8_DB_PREP_FAILED_AT=disk_preflight");
    expect(result.stderr).toContain("X8_DB_PREP_FAILED_AT=migrate_deploy");
  });

  it("records the step reached and the grants-intact status in the failure marker", () => {
    const script = `
      source "${launcher}"
      X8_DB_PREP_STEP=grants
      X8_DB_GRANTS_INTACT=yes
      x8_mark_identity_deploy_failed "simulated D-9a test failure"
    `;
    const result = run(script);
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    const marker = readFileSync(join(runtimeDir, "release-identity.failed.txt"), "utf8");
    expect(marker).toContain("db_prep_step=grants");
    expect(marker).toContain("db_prep_grants_intact=yes");
  });

  it("the failure marker defaults to <not reached>/unknown when prepare_database() never ran at all", () => {
    const script = `
      source "${launcher}"
      x8_mark_identity_deploy_failed "simulated failure before prepare_database ever ran"
    `;
    const result = run(script);
    expect(result.status).toBe(0);
    const marker = readFileSync(join(runtimeDir, "release-identity.failed.txt"), "utf8");
    expect(marker).toContain("db_prep_step=<not reached>");
    expect(marker).toContain("db_prep_grants_intact=unknown");
  });

  it("a grants.sql failure under --single-transaction is reported intact without a second, redundant replay", () => {
    // The grants.sql step itself failing is the one case where the
    // *original* invocation's own rollback already restores the pre-attempt
    // state (施工工单 3.2③: "不要再重放一次") -- so unlike migrate_deploy,
    // extension, or role_network_verify failing, this must NOT produce a
    // second stdin replay dump.
    writeRunningIdentity();
    const result = run(CALL_PREPARE_DATABASE, { STUB_GRANTS_REPLAY_EXIT: "1" });
    expect(result.stderr).toContain("X8_DB_PREP_FAILED_AT=grants");
    expect(result.stderr).toContain("X8_DB_PREP_GRANTS_INTACT=yes");
    // Exactly one stdin-fed psql call: the ALTER ROLE heredoc from
    // x8_align_db_role_passwords() runs earlier and always succeeds in this
    // suite's stub; grants.sql itself is the failing (and only other)
    // stdin-fed call, and no restore replay should follow it.
    const dumps = stdinDumpNames();
    const grantsAttempts = dumps.filter((name) => stdinDumpContent(name).includes("REVOKE CREATE ON SCHEMA public FROM PUBLIC"));
    expect(grantsAttempts, `expected exactly one grants.sql attempt (no redundant replay); got: ${grantsAttempts.join(", ")}`).toHaveLength(1);
  });

  it("prints a copy-pasteable recovery command referencing the running release's commit when grants could not be confirmed intact", () => {
    writeRunningIdentity();
    // The primary replay AND the fallback-to-worktree replay both fail --
    // the only way X8_DB_PREP_GRANTS_INTACT ends up "no" in this stub.
    const result = run(CALL_PREPARE_DATABASE, { STUB_MIGRATE_EXIT: "1", STUB_GRANTS_REPLAY_EXIT: "1" });
    expect(result.stderr).toContain("X8_DB_PREP_GRANTS_INTACT=no");
    expect(result.stderr).toContain(`git -C`);
    expect(result.stderr).toContain(`show ${RUNNING_RELEASE_COMMIT}:infra/postgres/grants.sql`);
    expect(result.stderr).toContain("--single-transaction");
  });
});

/**
 * D-9a / D-9b handoff seam: gate A (x8_disk_preflight_before_build(), 施工
 * 工单 3.2① "顺序是：先测一次 -> 低于告警线就调 D-9b 的 gc -> 再测一次 -> 仍
 * 低于硬线则拒绝执行"). x8_gc() itself is D-9b's function and does not exist
 * on this branch (D-9a and D-9b are two independent, parallel commits --
 * see scripts/x8-production-like.sh's own comment on
 * x8_disk_preflight_before_build()). These tests stand up a bash STUB
 * `x8_gc` function (never D-9b's real implementation, which this worktree
 * does not have) to prove gate A calls it exactly when the work order says
 * to -- guarded by `declare -F x8_gc >/dev/null` so the same call site is
 * inert today and becomes live the moment D-9b's real x8_gc() lands on the
 * same branch.
 */
describe("D-9a: gate A (disk preflight before build) x8_gc handoff seam", () => {
  const GC_LOG = "x8-gc-calls.log";

  function gcCallLines(): string[] {
    const path = join(stubLogDir, GC_LOG);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0);
  }

  function callDiskPreflight(defineStubGc: boolean): string {
    const stub = defineStubGc
      ? `
      x8_gc() {
        { printf 'CALLED:'; printf ' %s' "$@"; printf '\\n'; } >> "$STUB_LOG_DIR/${GC_LOG}"
        return 0
      }
    `
      : "";
    return `
      source "${launcher}"
      ${stub}
      if x8_disk_preflight_before_build; then
        status=0
      else
        status=$?
      fi
      echo "DISK_PREFLIGHT_EXIT=$status"
      exit "$status"
    `;
  }

  // 8 GiB / 15 GiB, the work order's own suggested X8_MIN_FREE_KIB_BUILD /
  // X8_WARN_FREE_KIB_BUILD defaults (施工工单 3.2 表) -- spelled out
  // explicitly here because this suite calls x8_disk_preflight_before_build()
  // directly, never x8_export_static_topology() (which is what normally
  // applies those defaults).
  const HARD_MIN_KIB = "8388608";
  const WARN_KIB = "15728640";

  it("does not call x8_gc when free space is at or above the warn threshold", () => {
    const result = run(callDiskPreflight(true), {
      X8_MIN_FREE_KIB_BUILD: HARD_MIN_KIB,
      X8_WARN_FREE_KIB_BUILD: WARN_KIB,
      STUB_DF_AVAILABLE_KIB: "20000000",
    });
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stderr).not.toContain("below the warn threshold");
    expect(gcCallLines(), "x8_gc must not be called when space is already healthy").toHaveLength(0);
  });

  it("calls x8_gc --auto when free space is below the warn threshold but still above the hard line", () => {
    const result = run(callDiskPreflight(true), {
      X8_MIN_FREE_KIB_BUILD: HARD_MIN_KIB,
      X8_WARN_FREE_KIB_BUILD: WARN_KIB,
      STUB_DF_AVAILABLE_KIB: "10000000",
    });
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stderr).toContain("below the warn threshold");
    const calls = gcCallLines();
    expect(calls, `expected exactly one x8_gc call; stderr:\n${result.stderr}`).toHaveLength(1);
    expect(calls[0]).toContain("--auto");
  });

  it("refuses at the hard line without calling x8_gc when it is not defined (this branch does not ship D-9b's function)", () => {
    const result = run(callDiskPreflight(false), {
      X8_MIN_FREE_KIB_BUILD: HARD_MIN_KIB,
      X8_WARN_FREE_KIB_BUILD: WARN_KIB,
      STUB_DF_AVAILABLE_KIB: "1000000",
    });
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(69);
    expect(result.stderr).toContain("not available on this branch");
    expect(gcCallLines()).toHaveLength(0);
  });

  it("still refuses at the hard line even after calling x8_gc, when the stubbed space never actually improves", () => {
    // Proves gate A's hard refusal is driven by x8_require_free_disk_kib()'s
    // OWN re-measurement, not by gc's exit status -- this stub's df output is
    // static, so "gc ran" alone must never be treated as "space is now fine".
    const result = run(callDiskPreflight(true), {
      X8_MIN_FREE_KIB_BUILD: HARD_MIN_KIB,
      X8_WARN_FREE_KIB_BUILD: WARN_KIB,
      STUB_DF_AVAILABLE_KIB: "1000000",
    });
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(69);
    expect(gcCallLines()).toHaveLength(1);
  });
});
