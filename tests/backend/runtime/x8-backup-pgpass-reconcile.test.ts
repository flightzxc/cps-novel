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
  // P1-2 (Opus review 2026-09-18): the two canonical rows now sort FIRST,
  // ahead of every preserved line -- a structural second line of defense
  // under libpq's first-match-wins pgpass semantics, on top of the
  // shadowing-rule removal covered separately below.
  it("preserves an unrelated pgpass record byte-for-byte, after the two canonical rows", () => {
    writeFileSync(pgpassPath(), "otherhost:5432:otherdb:otheruser:otherpw\n");
    chmodSync(pgpassPath(), 0o600);
    const result = runReconcile("x8_reconcile_backup_pgpass");
    expect(result.status, result.stderr).toBe(0);
    const lines = readFileSync(pgpassPath(), "utf8").split("\n").filter(Boolean);
    expect(lines).toEqual([
      `postgres:5432:cps_novel:backup_role:${TEST_PASSWORD}`,
      `postgres:5432:replication:backup_role:${TEST_PASSWORD}`,
      "otherhost:5432:otherdb:otheruser:otherpw",
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

describe("x8_reconcile_backup_pgpass: P1-2 shadowing-wildcard rule removal", () => {
  // Opus review 2026-09-18, P1-2: a pre-existing broader rule (host and/or
  // port and/or db field written as a literal `*`, or an already-narrower
  // field combination such as `postgres:*:replication:backup_role:`) can
  // shadow one of the two canonical rows under libpq's first-match-wins
  // pgpass matching -- it must be removed on every reconcile pass, not
  // just the two byte-for-byte canonical prefixes. A line outside that
  // exact 4-field shape (different case, e.g.) cannot shadow anything
  // under libpq's exact-text matching and must be left alone.
  it("removes every shadowing-shape row, keeps an unrelated row and an approximate near-miss row, warns with the exact count, and puts the canonical rows first", () => {
    writeFileSync(
      pgpassPath(),
      [
        `postgres:5432:*:backup_role:OLD`,
        `*:*:*:backup_role:OLD2`,
        `postgres:*:replication:backup_role:OLD3`,
        "unrelated:5432:otherdb:otheruser:otherpw",
        "POSTGRES:5432:cps_novel:backup_role:x",
        "",
      ].join("\n"),
    );
    chmodSync(pgpassPath(), 0o600);

    const result = runReconcile("x8_reconcile_backup_pgpass");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("X8_BACKUP_PGPASS_WARN=removed_shadowing_rules count=3");

    const lines = readFileSync(pgpassPath(), "utf8").split("\n").filter(Boolean);
    // Canonical rows at line 1 and 2, in that order.
    expect(lines[0]).toBe(`postgres:5432:cps_novel:backup_role:${TEST_PASSWORD}`);
    expect(lines[1]).toBe(`postgres:5432:replication:backup_role:${TEST_PASSWORD}`);
    // The unrelated row and the case-mismatched near-miss row both survive
    // -- neither can shadow the canonical rows under libpq's exact-text
    // matching, so this function has no basis to remove either.
    expect(lines).toContain("unrelated:5432:otherdb:otheruser:otherpw");
    expect(lines).toContain("POSTGRES:5432:cps_novel:backup_role:x");
    // None of the three wildcard-shaped stale rows survive.
    expect(lines).not.toContain("postgres:5432:*:backup_role:OLD");
    expect(lines).not.toContain("*:*:*:backup_role:OLD2");
    expect(lines).not.toContain("postgres:*:replication:backup_role:OLD3");
    expect(lines).toHaveLength(4);
  });

  // A no-op rerun of scenarios B/D/E never removes anything but the two
  // exact canonical prefixes -- that is routine upgrade/rotation churn, not
  // a stray shadowing rule, and must never trigger the WARN line.
  it("does not warn when only the two exact canonical prefixes are rewritten", () => {
    writeFileSync(pgpassPath(), `postgres:5432:cps_novel:backup_role:${TEST_PASSWORD}\n`);
    chmodSync(pgpassPath(), 0o600);
    const result = runReconcile("x8_reconcile_backup_pgpass");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("X8_BACKUP_PGPASS_WARN");
  });
});

describe("x8_reconcile_backup_pgpass: P2-1 unreadable existing file is refused, not overwritten", () => {
  it("returns 65 and leaves the file's bytes untouched when the file exists but this process cannot read it", () => {
    writeFileSync(pgpassPath(), "otherhost:5432:otherdb:otheruser:otherpw\n");
    chmodSync(pgpassPath(), 0o000);
    try {
      const result = runReconcile("x8_reconcile_backup_pgpass");
      expect(result.status).toBe(65);
      expect(result.stderr).toContain("not readable");
    } finally {
      chmodSync(pgpassPath(), 0o600);
    }
    // Bytes are exactly what was written before the refused call -- nothing
    // was overwritten, nothing was appended.
    expect(readFileSync(pgpassPath(), "utf8")).toBe("otherhost:5432:otherdb:otheruser:otherpw\n");
  });
});

describe("x8_reconcile_backup_pgpass: P2-4 no-trailing-newline fallback", () => {
  // The `while IFS= read -r line || [[ -n "$line" ]]; do ... done <file`
  // idiom's `|| [[ -n "$line" ]]` clause is what keeps a file's last line
  // alive when the file has no trailing newline (`read` still populates
  // `$line` and returns non-zero on EOF with no delimiter). Without that
  // clause the loop body would simply never run for that final line, and
  // an unrelated last line with no trailing newline would silently vanish
  // from the reconciled file instead of being preserved.
  it("preserves an unrelated line that has no trailing newline", () => {
    writeFileSync(pgpassPath(), "otherhost:5432:otherdb:otheruser:otherpw"); // no trailing \n
    chmodSync(pgpassPath(), 0o600);
    const result = runReconcile("x8_reconcile_backup_pgpass");
    expect(result.status, result.stderr).toBe(0);
    const lines = readFileSync(pgpassPath(), "utf8").split("\n").filter(Boolean);
    expect(lines).toEqual([
      `postgres:5432:cps_novel:backup_role:${TEST_PASSWORD}`,
      `postgres:5432:replication:backup_role:${TEST_PASSWORD}`,
      "otherhost:5432:otherdb:otheruser:otherpw",
    ]);
  });
});
