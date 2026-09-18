import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * X8_BACKUP_PGPASS_RECONCILE_2026-09-18: `pg_basebackup`'s physical-
 * replication connection authenticates through libpq's pgpass matching,
 * where the connection's "database" field is the LITERAL string
 * "replication" -- never the real database name. The old backup.pgpass
 * generator (scripts/lib/x8-production-like-env.sh, before this fix) only
 * ever wrote a `postgres:5432:cps_novel:backup_role:<pw>` row (matching the
 * LOGICAL backup's `pg_dump -d cps_novel` connection), so pg_basebackup's
 * physical connection never found a matching pgpass row and failed with
 * "fe_sendauth: no password supplied" before a password was ever sent --
 * the server side (backup_role's REPLICATION attribute, pg_hba.conf) was
 * never the problem.
 *
 * This suite exercises `x8_reconcile_backup_pgpass()` (the same function
 * `prepare_x8_environment()` now calls unconditionally on every prepare,
 * not just "create if missing") as a real bash subprocess against the real
 * library file -- never a rewritten stand-in -- with X8_RUNTIME_DIR and
 * P1_12_BACKUP_ROLE_PASSWORD_FILE pointed at a throwaway fixture, so
 * nothing here ever touches a real secret. `prepare_p1_12_local_environment()`
 * / `prepare_x8_environment()` are deliberately never called: they would
 * also provision unrelated secrets/DB URLs this suite has no interest in.
 */

const root = resolve(import.meta.dirname, "../../..");
const envLib = resolve(root, "scripts/lib/x8-production-like-env.sh");

const TEST_PASSWORD = "pw-TEST-ONLY-initial-9f3a1c";
const ROTATED_PASSWORD = "pw-TEST-ONLY-ROTATED-7be204";

let workDir: string;
let runtimeDir: string;
let secretDir: string;
let passwordFile: string;

function pgpassPath() {
  return join(secretDir, "backup.pgpass");
}

// Runs a bash snippet (typically just `x8_reconcile_backup_pgpass`, but a
// caller may pass a multi-statement body to call it more than once, rotate
// the secret file in between, etc.) after sourcing the real env-lib and
// exporting P1_12_BACKUP_ROLE_PASSWORD_FILE at this test's fixture path --
// exactly the variable prepare_p1_12_local_environment() would normally
// have exported first.
function runReconcile(body: string, opts: { trace?: boolean; env?: Record<string, string | undefined> } = {}) {
  const script = `
    set -euo pipefail
    source "${envLib}"
    export P1_12_BACKUP_ROLE_PASSWORD_FILE="${passwordFile}"
    ${body}
  `;
  const args = opts.trace ? ["-x", "-c", script] : ["-c", script];
  return spawnSync("bash", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, X8_RUNTIME_DIR: runtimeDir, ...opts.env },
  });
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "x8-pgpass-reconcile-"));
  runtimeDir = join(workDir, "runtime");
  secretDir = join(runtimeDir, "secrets");
  mkdirSync(secretDir, { recursive: true });
  chmodSync(runtimeDir, 0o700);
  chmodSync(secretDir, 0o700);
  passwordFile = join(secretDir, "backup_role.password");
  writeFileSync(passwordFile, `${TEST_PASSWORD}\n`);
  chmodSync(passwordFile, 0o600);
});

afterEach(() => {
  // A couple of tests deliberately leave secretDir read-only (0o555) to
  // force a write failure -- restore write access first so rmSync can
  // actually clean the fixture up.
  try {
    chmodSync(secretDir, 0o700);
  } catch {
    /* directory may already be gone or already writable */
  }
  rmSync(workDir, { recursive: true, force: true });
});

describe("x8_reconcile_backup_pgpass: scenarios A-E", () => {
  // Scenario A: no file exists yet.
  it("A: with no existing file, writes exactly the two canonical rules, cps_novel then replication", () => {
    const result = runReconcile("x8_reconcile_backup_pgpass");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("X8_BACKUP_PGPASS=RECONCILED lines=2 backup_role_rules=2");
    const lines = readFileSync(pgpassPath(), "utf8").split("\n").filter(Boolean);
    expect(lines).toEqual([
      `postgres:5432:cps_novel:backup_role:${TEST_PASSWORD}`,
      `postgres:5432:replication:backup_role:${TEST_PASSWORD}`,
    ]);
  });

  // Scenario B: legacy single-line file (the old generator's only output).
  it("B: a legacy single-line cps_novel file upgrades to two rules, with no duplicate", () => {
    writeFileSync(pgpassPath(), `postgres:5432:cps_novel:backup_role:${TEST_PASSWORD}\n`);
    chmodSync(pgpassPath(), 0o600);
    const result = runReconcile("x8_reconcile_backup_pgpass");
    expect(result.status, result.stderr).toBe(0);
    const lines = readFileSync(pgpassPath(), "utf8").split("\n").filter(Boolean);
    expect(lines.filter((l) => l.startsWith("postgres:5432:cps_novel:backup_role:"))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("postgres:5432:replication:backup_role:"))).toHaveLength(1);
    expect(lines).toHaveLength(2);
  });

  // Scenario C: an already-reconciled file, rerun with nothing changed.
  it("C: a no-op rerun prints UNCHANGED and never touches the file's inode", () => {
    let result = runReconcile("x8_reconcile_backup_pgpass");
    expect(result.status, result.stderr).toBe(0);
    const inoBefore = statSync(pgpassPath()).ino;
    const mtimeBefore = statSync(pgpassPath()).mtimeMs;

    result = runReconcile("x8_reconcile_backup_pgpass");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr.trim()).toBe("X8_BACKUP_PGPASS=UNCHANGED");
    expect(result.stdout.trim()).toBe("");

    const after = statSync(pgpassPath());
    expect(after.ino).toBe(inoBefore);
    expect(after.mtimeMs).toBe(mtimeBefore);
  });

  // Scenario D: password rotation -- the secret file's content changes
  // between two prepare_x8_environment() calls.
  it("D: rotating the backup_role password updates both rules and drops the old password entirely", () => {
    let result = runReconcile("x8_reconcile_backup_pgpass");
    expect(result.status, result.stderr).toBe(0);

    writeFileSync(passwordFile, `${ROTATED_PASSWORD}\n`);
    result = runReconcile("x8_reconcile_backup_pgpass");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("X8_BACKUP_PGPASS=RECONCILED");

    const content = readFileSync(pgpassPath(), "utf8");
    expect(content).not.toContain(TEST_PASSWORD);
    const lines = content.split("\n").filter(Boolean);
    expect(lines).toEqual([
      `postgres:5432:cps_novel:backup_role:${ROTATED_PASSWORD}`,
      `postgres:5432:replication:backup_role:${ROTATED_PASSWORD}`,
    ]);
  });

  // Scenario E: duplicate + stale-password legacy rows in one file (two
  // cps_novel rows, one stale replication row) all collapse to one rule
  // each, using the CURRENT secret value, not whatever any of them carried.
  it("E: duplicate and stale-password legacy rows collapse to exactly one rule per database field", () => {
    writeFileSync(
      pgpassPath(),
      [
        `postgres:5432:cps_novel:backup_role:${TEST_PASSWORD}`,
        "postgres:5432:cps_novel:backup_role:pw-TEST-ONLY-dup-b21f",
        "postgres:5432:replication:backup_role:pw-TEST-ONLY-veryold-4d6a",
        "",
      ].join("\n"),
    );
    chmodSync(pgpassPath(), 0o600);
    const result = runReconcile("x8_reconcile_backup_pgpass");
    expect(result.status, result.stderr).toBe(0);
    const lines = readFileSync(pgpassPath(), "utf8").split("\n").filter(Boolean);
    expect(lines.filter((l) => l.startsWith("postgres:5432:cps_novel:backup_role:"))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("postgres:5432:replication:backup_role:"))).toHaveLength(1);
    expect(lines).toHaveLength(2);
    expect(readFileSync(pgpassPath(), "utf8")).not.toContain("pw-TEST-ONLY-dup-b21f");
    expect(readFileSync(pgpassPath(), "utf8")).not.toContain("pw-TEST-ONLY-veryold-4d6a");
  });
});

describe("x8_reconcile_backup_pgpass: file mode, no wildcard, no secret leak", () => {
  it("writes the pgpass file with mode 0600", () => {
    const result = runReconcile("x8_reconcile_backup_pgpass");
    expect(result.status, result.stderr).toBe(0);
    const mode = statSync(pgpassPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("never writes a wildcard database field -- only the two exact, narrow rules", () => {
    // Pre-seed a legacy row too, so the "never generalize into a wildcard"
    // property is checked on the reconcile path, not just a fresh file.
    writeFileSync(pgpassPath(), `postgres:5432:cps_novel:backup_role:${TEST_PASSWORD}\n`);
    chmodSync(pgpassPath(), 0o600);
    const result = runReconcile("x8_reconcile_backup_pgpass");
    expect(result.status, result.stderr).toBe(0);
    const content = readFileSync(pgpassPath(), "utf8");
    expect(content).not.toContain(":*:");
  });

  it("never prints the password, even with bash -x tracing re-enabled immediately before the call", () => {
    const result = runReconcile("set -x\nx8_reconcile_backup_pgpass\nset +x", { trace: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(TEST_PASSWORD);
    expect(result.stderr).not.toContain(TEST_PASSWORD);
  });
});

describe("x8_reconcile_backup_pgpass: unrelated records and atomicity", () => {
  it("preserves an unrelated pgpass record byte-for-byte, in its original position", () => {
    writeFileSync(pgpassPath(), "otherhost:5432:otherdb:otheruser:otherpw\n");
    chmodSync(pgpassPath(), 0o600);
    const result = runReconcile("x8_reconcile_backup_pgpass");
    expect(result.status, result.stderr).toBe(0);
    const lines = readFileSync(pgpassPath(), "utf8").split("\n").filter(Boolean);
    expect(lines).toEqual([
      "otherhost:5432:otherdb:otheruser:otherpw",
      `postgres:5432:cps_novel:backup_role:${TEST_PASSWORD}`,
      `postgres:5432:replication:backup_role:${TEST_PASSWORD}`,
    ]);
  });

  it("fails closed atomically when the secrets directory is not writable: original bytes untouched, no temp residue", () => {
    // Establish a baseline file first, then rotate the password so the next
    // call genuinely needs to write (an UNCHANGED no-op rerun would never
    // attempt a write at all, and so would prove nothing about atomicity).
    let result = runReconcile("x8_reconcile_backup_pgpass");
    expect(result.status, result.stderr).toBe(0);
    const before = readFileSync(pgpassPath());

    writeFileSync(passwordFile, `${ROTATED_PASSWORD}\n`);
    chmodSync(secretDir, 0o555);
    try {
      result = runReconcile("x8_reconcile_backup_pgpass");
      expect(result.status).not.toBe(0);
    } finally {
      chmodSync(secretDir, 0o700);
    }

    const after = readFileSync(pgpassPath());
    expect(after).toEqual(before);

    // Only the two files that were there before the failed write attempt --
    // no `backup.pgpass.XXXXXX`-shaped mktemp leftover.
    const entries = readdirSync(secretDir).sort();
    expect(entries).toEqual(["backup.pgpass", "backup_role.password"]);
  });
});
