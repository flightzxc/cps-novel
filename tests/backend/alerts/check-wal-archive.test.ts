import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// Gate 5-Dev: infra/production-like/alerts/check-wal-archive.sh's four
// judgements (archive capacity, pg_stat_archiver health, physical base
// backup freshness, pg_wal size). No Docker, no live Postgres -- `docker`
// and `psql` are both PATH-shimmed, same technique
// tests/backend/database/wal-retention-guards.test.ts uses for pg_archivecleanup/
// psql. This worktree's own rules forbid `docker exec` against the live
// cps-novel-x8-local-* stack under any circumstance (only read-only `docker
// inspect` is allowed), so a fake `docker` executable is the only compliant
// way to control what `du -sb` reports.
//
// Each check function is exercised through a tiny generated harness script
// that sources check-wal-archive.sh (never executing its own
// BASH_SOURCE-guarded main, same as how run-all.sh/drill.sh source it),
// resets the fire counter, calls exactly one function, then prints it --
// alert-lib.sh's alert_fire_total is a file-backed counter specifically so a
// caller never has to parse log text to know whether an alert fired.
const root = process.cwd();
const scriptPath = path.resolve(root, "infra/production-like/alerts/check-wal-archive.sh");

const createdDirs: string[] = [];
function mkTestDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0, createdDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeShim(filePath: string, content: string): void {
  writeFileSync(filePath, content);
  chmodSync(filePath, 0o755);
}

// Fake `docker` supporting the two subcommands check-wal-archive.sh issues:
// `docker exec <container> du -sb <path>` (judgements 1/4) and
// `docker inspect <container> --format ...` (judgement 3's mount
// resolution, Gate 5 review fix P1-5). `exec du` selects a byte count by the
// requested path when the path-specific env var is set (so the aggregate
// "everything healthy" test can give the archive-capacity and pg_wal-bloat
// judgements different, independently-controlled numbers in the same
// process); otherwise falls back to a single generic value.
// DOCKER_SHIM_EXIT simulates the exec itself failing (fail-closed path);
// DOCKER_SHIM_INSPECT_MOUNT_SOURCE controls what `inspect --format` prints
// (empty/unset = no matching mount, same as a real container missing it).
const DOCKER_SHIM = `#!/usr/bin/env bash
set -u
if [[ "\${DOCKER_SHIM_EXIT:-0}" != "0" ]]; then
  echo "shim: simulated docker failure" >&2
  exit "\${DOCKER_SHIM_EXIT}"
fi
if [[ "\${1:-}" == "exec" && "\${3:-}" == "du" ]]; then
  path_arg="\${5:-}"
  if [[ "\$path_arg" == "/var/lib/postgresql/wal-archive" && -n "\${DOCKER_SHIM_ARCHIVE_BYTES:-}" ]]; then
    bytes="\$DOCKER_SHIM_ARCHIVE_BYTES"
  elif [[ "\$path_arg" == "/var/lib/postgresql/data/pg_wal" && -n "\${DOCKER_SHIM_PGWAL_BYTES:-}" ]]; then
    bytes="\$DOCKER_SHIM_PGWAL_BYTES"
  else
    bytes="\${DOCKER_SHIM_DU_BYTES:-0}"
  fi
  printf '%s\\t%s\\n' "\$bytes" "\$path_arg"
  exit 0
fi
if [[ "\${1:-}" == "inspect" ]]; then
  printf '%s' "\${DOCKER_SHIM_INSPECT_MOUNT_SOURCE:-}"
  exit 0
fi
echo "shim: unsupported docker invocation: \$*" >&2
exit 1
`;

// Fake `psql` for check_wal_archiver_health()'s single query. Unlike
// wal-retention.sh (two distinct queries), this checker only ever issues
// one, so the shim does not need to branch on query text.
const PSQL_SHIM = `#!/usr/bin/env bash
set -u
if [[ "\${PSQL_SHIM_EXIT:-0}" != "0" ]]; then
  echo "shim: simulated psql failure" >&2
  exit "\${PSQL_SHIM_EXIT}"
fi
printf '%s\\n' "\${PSQL_SHIM_FLAG:-f}"
exit 0
`;

function makeBin(extra: Record<string, string> = {}): string {
  const binDir = mkTestDir("check-wal-archive-bin-");
  for (const [name, content] of Object.entries(extra)) {
    writeShim(path.join(binDir, name), content);
  }
  return binDir;
}

function writeVerifiedBackup(baseBackupDir: string, name: string, verifiedEpochSecondsAgo: number): void {
  const dir = path.join(baseBackupDir, name);
  mkdirSync(dir, { recursive: true });
  const epoch = Math.floor(Date.now() / 1000) - verifiedEpochSecondsAgo;
  writeFileSync(
    path.join(dir, "VERIFIED"),
    `verified_at=2026-09-17T00:00:00Z\nverified_epoch=${epoch}\nmanifest_sha256=deadbeef\nstart_wal=000000010000000000000001\nstart_timeline=1\n`,
  );
}

// Runs exactly one function from check-wal-archive.sh (or, for the
// aggregate test, run_wal_archive_checks itself) in a fresh harness process
// and reports how many alerts fired this run via alert_fire_total, plus the
// combined stdout+stderr for asserting on the specific alert key.
function runCheck(
  fnName: string,
  // Next 16 (node_modules/next/types/global.d.ts:23) declares NODE_ENV as a
  // REQUIRED readonly member of NodeJS.ProcessEnv, so an object literal
  // holding only the overrides a test wants is no longer assignable to it.
  // This never was a complete ProcessEnv anyway -- it is spread ON TOP of
  // one below -- so the override map is the accurate type, and the call
  // sites keep passing exactly what they always passed.
  env: Record<string, string | undefined>,
  binDir?: string,
): { fireTotal: number; output: string; status: number | null } {
  const stateDir = mkTestDir("check-wal-archive-state-");
  const harnessDir = mkTestDir("check-wal-archive-harness-");
  const harness = path.join(harnessDir, "harness.sh");
  writeShim(
    harness,
    `#!/usr/bin/env bash
set -euo pipefail
source "${scriptPath}"
alert_fire_total_reset
${fnName} || true
printf 'FIRE_TOTAL=%s\\n' "$(alert_fire_total)"
`,
  );

  const result = spawnSync("bash", [harness], {
    env: {
      ...process.env,
      PATH: binDir ? `${binDir}:${process.env.PATH ?? ""}` : process.env.PATH,
      DRY_RUN: "1",
      ALERT_STATE_DIR: stateDir,
      ...env,
    },
    encoding: "utf8",
  });

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const match = output.match(/FIRE_TOTAL=(\d+)/);
  return {
    fireTotal: match ? Number(match[1]) : -1,
    output,
    status: result.status,
  };
}

describe("check-wal-archive.sh: static contracts", () => {
  it("is syntactically valid bash", () => {
    execFileSync("bash", ["-n", scriptPath]);
  });
});

describe("check-wal-archive.sh: judgement 1 -- WAL archive directory capacity", () => {
  it("healthy (bytes well under max) does not fire", () => {
    const binDir = makeBin({ docker: DOCKER_SHIM });
    const { fireTotal, output } = runCheck(
      "check_wal_archive_capacity",
      { ALERT_WAL_ARCHIVE_MAX_BYTES: "1000000000", DOCKER_SHIM_DU_BYTES: "1000" },
      binDir,
    );
    expect(fireTotal).toBe(0);
    expect(output).not.toContain("ALERT key=wal_archive_capacity");
  });

  it("bytes >= max fires wal_archive_capacity_over", () => {
    const binDir = makeBin({ docker: DOCKER_SHIM });
    const { fireTotal, output } = runCheck(
      "check_wal_archive_capacity",
      { ALERT_WAL_ARCHIVE_MAX_BYTES: "1000", DOCKER_SHIM_DU_BYTES: "1000000" },
      binDir,
    );
    expect(fireTotal).toBe(1);
    expect(output).toContain("ALERT key=wal_archive_capacity_over");
  });

  it("a failed docker exec fails closed with wal_archive_capacity_unreadable", () => {
    const binDir = makeBin({ docker: DOCKER_SHIM });
    const { fireTotal, output } = runCheck(
      "check_wal_archive_capacity",
      { DOCKER_SHIM_EXIT: "1" },
      binDir,
    );
    expect(fireTotal).toBe(1);
    expect(output).toContain("ALERT key=wal_archive_capacity_unreadable");
  });

  // Gate 5 review fix (P2): non-numeric `du` output (not just a failed exec)
  // must also fail closed -- the awk/regex parse path, not the exit-code
  // path.
  it("non-numeric du output fails closed with wal_archive_capacity_unreadable", () => {
    const binDir = makeBin({ docker: DOCKER_SHIM });
    const { fireTotal, output } = runCheck(
      "check_wal_archive_capacity",
      { DOCKER_SHIM_DU_BYTES: "not-a-number" },
      binDir,
    );
    expect(fireTotal).toBe(1);
    expect(output).toContain("ALERT key=wal_archive_capacity_unreadable");
  });

  // Gate 5 review fix (P2): these three severity tiers are mutually
  // exclusive judgements of the same byte count -- whichever tier fires,
  // the other two (plus _unreadable) must be recovered, so a previously-open
  // alert for a tier this run has moved away from does not stay stuck open
  // forever. In DRY_RUN mode (this harness always sets it) alert_recover
  // never deletes the debounce file, it only logs what it WOULD clear --
  // exactly the signal this test asserts on.
  it("firing wal_archive_capacity_over logs a would-clear for the degraded/warn/unreadable debounce keys", () => {
    const stateDir = mkTestDir("check-wal-archive-state-tiers-");
    for (const key of ["wal_archive_capacity_degraded", "wal_archive_capacity_warn", "wal_archive_capacity_unreadable"]) {
      writeFileSync(path.join(stateDir, `${key}.last_sent`), "1\n");
    }
    const binDir = makeBin({ docker: DOCKER_SHIM });
    const { output } = runCheck(
      "check_wal_archive_capacity",
      { ALERT_WAL_ARCHIVE_MAX_BYTES: "1000", DOCKER_SHIM_DU_BYTES: "1000000", ALERT_STATE_DIR: stateDir },
      binDir,
    );
    expect(output).toContain("ALERT key=wal_archive_capacity_over");
    expect(output).toContain("[DRY_RUN] would clear debounce state for key=wal_archive_capacity_degraded");
    expect(output).toContain("[DRY_RUN] would clear debounce state for key=wal_archive_capacity_warn");
    expect(output).toContain("[DRY_RUN] would clear debounce state for key=wal_archive_capacity_unreadable");
  });
});

describe("check-wal-archive.sh: judgement 2 -- pg_stat_archiver health", () => {
  it("healthy (psql reports f) does not fire", () => {
    const binDir = makeBin({ psql: PSQL_SHIM });
    const { fireTotal, output } = runCheck(
      "check_wal_archiver_health",
      { ALERT_DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test", PSQL_SHIM_FLAG: "f" },
      binDir,
    );
    expect(fireTotal).toBe(0);
    expect(output).not.toContain("ALERT key=wal_archiver");
  });

  it("psql reports t (last failure newer than last success) fires wal_archiver_failing", () => {
    const binDir = makeBin({ psql: PSQL_SHIM });
    const { fireTotal, output } = runCheck(
      "check_wal_archiver_health",
      { ALERT_DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test", PSQL_SHIM_FLAG: "t" },
      binDir,
    );
    expect(fireTotal).toBe(1);
    expect(output).toContain("ALERT key=wal_archiver_failing");
  });

  it("ALERT_DATABASE_URL unset fails closed with wal_archiver_unreadable (no psql call needed)", () => {
    const { fireTotal, output } = runCheck("check_wal_archiver_health", {});
    expect(fireTotal).toBe(1);
    expect(output).toContain("ALERT key=wal_archiver_unreadable");
  });

  it("a failed psql connection fails closed with wal_archiver_unreadable", () => {
    const binDir = makeBin({ psql: PSQL_SHIM });
    const { fireTotal, output } = runCheck(
      "check_wal_archiver_health",
      { ALERT_DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test", PSQL_SHIM_EXIT: "2" },
      binDir,
    );
    expect(fireTotal).toBe(1);
    expect(output).toContain("ALERT key=wal_archiver_unreadable");
  });
});

// Gate 5 review fix (P1-1): check-wal-archive.sh's judgement 2 predicate
// must be byte-identical to scripts/db/wal-retention.sh's own
// --require-archiver-healthy second query -- the header comment on both
// files says "copied verbatim, not reinvented", so this proves it rather
// than trusting the comment.
describe("check-wal-archive.sh: judgement 2 predicate matches wal-retention.sh byte-for-byte (P1-1)", () => {
  const PREDICATE_RE =
    /SELECT \(last_failed_time IS NOT NULL AND \(last_archived_time IS NULL OR last_failed_time > last_archived_time\)\) FROM pg_stat_archiver/;

  it("the SQL predicate text is byte-identical in both scripts", () => {
    const checkSource = readFileSync(scriptPath, "utf8");
    const walRetentionSource = readFileSync(
      path.resolve(root, "scripts/db/wal-retention.sh"),
      "utf8",
    );
    const checkMatch = checkSource.match(PREDICATE_RE);
    const walRetentionMatch = walRetentionSource.match(PREDICATE_RE);
    expect(checkMatch?.[0]).toBeTruthy();
    expect(walRetentionMatch?.[0]).toBeTruthy();
    expect(checkMatch?.[0]).toBe(walRetentionMatch?.[0]);
  });

  // Behavioural companion to the static byte-match above: a psql shim that
  // echoes back the exact SQL text it was invoked with, so this asserts on
  // what check_wal_archiver_health() actually SENDS at runtime, not just
  // what the source file happens to contain -- and specifically on the `>`
  // direction (last_failed_time newer than last_archived_time), the part a
  // sign-flip typo would silently invert.
  it("check_wal_archiver_health() issues a query containing last_failed_time > last_archived_time", () => {
    const binDir = makeBin({});
    const sqlLog = path.join(mkTestDir("check-wal-archive-sql-log-"), "psql-calls.log");
    writeShim(
      path.join(binDir, "psql"),
      `#!/usr/bin/env bash\nset -u\nprintf '%s\\n' "$*" >> "${sqlLog}"\nprintf '%s\\n' "\${PSQL_SHIM_FLAG:-f}"\nexit 0\n`,
    );
    const { fireTotal } = runCheck(
      "check_wal_archiver_health",
      { ALERT_DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test", PSQL_SHIM_FLAG: "f" },
      binDir,
    );
    expect(fireTotal).toBe(0);
    const sqlCalls = readFileSync(sqlLog, "utf8");
    expect(sqlCalls).toContain("last_failed_time > last_archived_time");
  });
});

describe("check-wal-archive.sh: judgement 3 -- physical base backup freshness", () => {
  it("a fresh VERIFIED marker (10min old, default 93600s threshold) does not fire", () => {
    const baseBackupDir = mkTestDir("check-wal-archive-basebackup-");
    writeVerifiedBackup(baseBackupDir, "20260917T035414Z", 600);
    const { fireTotal, output } = runCheck("check_physical_base_backup_freshness", {
      ALERT_BASE_BACKUP_DIR: baseBackupDir,
    });
    expect(fireTotal).toBe(0);
    expect(output).not.toContain("ALERT key=base_backup");
  });

  it("an empty directory (no VERIFIED marker anywhere) fires base_backup_missing", () => {
    const baseBackupDir = mkTestDir("check-wal-archive-basebackup-empty-");
    const { fireTotal, output } = runCheck("check_physical_base_backup_freshness", {
      ALERT_BASE_BACKUP_DIR: baseBackupDir,
    });
    expect(fireTotal).toBe(1);
    expect(output).toContain("ALERT key=base_backup_missing");
  });

  it("a stale VERIFIED marker (30h old, threshold 93600s=26h) fires base_backup_stale", () => {
    const baseBackupDir = mkTestDir("check-wal-archive-basebackup-stale-");
    writeVerifiedBackup(baseBackupDir, "20260916T000000Z", 30 * 3600);
    const { fireTotal, output } = runCheck("check_physical_base_backup_freshness", {
      ALERT_BASE_BACKUP_DIR: baseBackupDir,
    });
    expect(fireTotal).toBe(1);
    expect(output).toContain("ALERT key=base_backup_stale");
  });
});

// Gate 5 review fix (P1-5): when ALERT_BASE_BACKUP_DIR is left unset, the
// directory is resolved from ALERT_POSTGRES_CONTAINER_NAME's own
// `docker inspect` mount table instead of a hard-coded worktree-relative
// fallback (removed entirely).
describe("check-wal-archive.sh: judgement 3 -- ALERT_BASE_BACKUP_DIR resolution from container mounts (P1-5)", () => {
  it("unset ALERT_BASE_BACKUP_DIR resolves the host path via docker inspect mounts", () => {
    const baseBackupDir = mkTestDir("check-wal-archive-basebackup-resolved-");
    writeVerifiedBackup(baseBackupDir, "20260917T035414Z", 600);
    const binDir = makeBin({ docker: DOCKER_SHIM });
    const { fireTotal, output } = runCheck(
      "check_physical_base_backup_freshness",
      { DOCKER_SHIM_INSPECT_MOUNT_SOURCE: baseBackupDir },
      binDir,
    );
    expect(fireTotal).toBe(0);
    expect(output).not.toContain("ALERT key=base_backup");
  });

  it("a /host_mnt/-prefixed mount source (Docker Desktop for macOS) is retried with the prefix stripped", () => {
    const baseBackupDir = mkTestDir("check-wal-archive-basebackup-hostmnt-");
    writeVerifiedBackup(baseBackupDir, "20260917T035414Z", 600);
    const binDir = makeBin({ docker: DOCKER_SHIM });
    const { fireTotal, output } = runCheck(
      "check_physical_base_backup_freshness",
      { DOCKER_SHIM_INSPECT_MOUNT_SOURCE: `/host_mnt${baseBackupDir}` },
      binDir,
    );
    expect(fireTotal).toBe(0);
    expect(output).not.toContain("ALERT key=base_backup");
  });

  it("an empty docker inspect result (no matching mount) fires base_backup_dir_unresolved, not base_backup_missing", () => {
    const binDir = makeBin({ docker: DOCKER_SHIM });
    const { fireTotal, output } = runCheck(
      "check_physical_base_backup_freshness",
      { DOCKER_SHIM_INSPECT_MOUNT_SOURCE: "" },
      binDir,
    );
    expect(fireTotal).toBe(1);
    expect(output).toContain("ALERT key=base_backup_dir_unresolved");
    expect(output).not.toContain("ALERT key=base_backup_missing");
  });

  it("a failed docker inspect (nonzero exit) also fires base_backup_dir_unresolved", () => {
    const binDir = makeBin({ docker: DOCKER_SHIM });
    const { fireTotal, output } = runCheck(
      "check_physical_base_backup_freshness",
      { DOCKER_SHIM_EXIT: "1" },
      binDir,
    );
    expect(fireTotal).toBe(1);
    expect(output).toContain("ALERT key=base_backup_dir_unresolved");
  });

  it("an explicit ALERT_BASE_BACKUP_DIR bypasses docker inspect entirely (no docker on PATH needed)", () => {
    const baseBackupDir = mkTestDir("check-wal-archive-basebackup-explicit-");
    writeVerifiedBackup(baseBackupDir, "20260917T035414Z", 600);
    // Deliberately no docker shim on PATH at all: if the check tried to call
    // docker despite ALERT_BASE_BACKUP_DIR already being set, this would
    // fail with "command not found", proving the explicit setting really
    // does skip resolution altogether.
    const { fireTotal, output } = runCheck("check_physical_base_backup_freshness", {
      ALERT_BASE_BACKUP_DIR: baseBackupDir,
    });
    expect(fireTotal).toBe(0);
    expect(output).not.toContain("ALERT key=");
  });
});

describe("check-wal-archive.sh: judgement 4 -- pg_wal directory size", () => {
  it("healthy (bytes well under max) does not fire", () => {
    const binDir = makeBin({ docker: DOCKER_SHIM });
    const { fireTotal, output } = runCheck(
      "check_pg_wal_bloat",
      { ALERT_PG_WAL_MAX_BYTES: "1000000000", DOCKER_SHIM_DU_BYTES: "1000" },
      binDir,
    );
    expect(fireTotal).toBe(0);
    expect(output).not.toContain("ALERT key=pg_wal");
  });

  it("bytes > max fires pg_wal_bloat", () => {
    const binDir = makeBin({ docker: DOCKER_SHIM });
    const { fireTotal, output } = runCheck(
      "check_pg_wal_bloat",
      { ALERT_PG_WAL_MAX_BYTES: "1000", DOCKER_SHIM_DU_BYTES: "1000000" },
      binDir,
    );
    expect(fireTotal).toBe(1);
    expect(output).toContain("ALERT key=pg_wal_bloat");
  });

  it("a failed docker exec fails closed with pg_wal_unreadable", () => {
    const binDir = makeBin({ docker: DOCKER_SHIM });
    const { fireTotal, output } = runCheck("check_pg_wal_bloat", { DOCKER_SHIM_EXIT: "1" }, binDir);
    expect(fireTotal).toBe(1);
    expect(output).toContain("ALERT key=pg_wal_unreadable");
  });

  // Gate 5 review fix (P2): non-numeric `du` output (not just a failed exec)
  // must also fail closed.
  it("non-numeric du output fails closed with pg_wal_unreadable", () => {
    const binDir = makeBin({ docker: DOCKER_SHIM });
    const { fireTotal, output } = runCheck(
      "check_pg_wal_bloat",
      { DOCKER_SHIM_DU_BYTES: "not-a-number" },
      binDir,
    );
    expect(fireTotal).toBe(1);
    expect(output).toContain("ALERT key=pg_wal_unreadable");
  });
});

describe("check-wal-archive.sh: run_wal_archive_checks() aggregate", () => {
  it("a fully healthy environment fires zero alerts across all four judgements", () => {
    const binDir = makeBin({ docker: DOCKER_SHIM, psql: PSQL_SHIM });
    const baseBackupDir = mkTestDir("check-wal-archive-basebackup-healthy-");
    writeVerifiedBackup(baseBackupDir, "20260917T035414Z", 600);

    const { fireTotal, status, output } = runCheck(
      "run_wal_archive_checks",
      {
        ALERT_DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
        PSQL_SHIM_FLAG: "f",
        ALERT_WAL_ARCHIVE_MAX_BYTES: "1000000000",
        ALERT_PG_WAL_MAX_BYTES: "1000000000",
        DOCKER_SHIM_ARCHIVE_BYTES: "1000",
        DOCKER_SHIM_PGWAL_BYTES: "1000",
        ALERT_BASE_BACKUP_DIR: baseBackupDir,
      },
      binDir,
    );

    expect(fireTotal).toBe(0);
    expect(output).not.toContain("ALERT key=");
    expect(status).toBe(0);
  });
});
