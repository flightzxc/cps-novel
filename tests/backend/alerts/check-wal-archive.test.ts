import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// Fake `docker` for `docker exec <container> du -sb <path>`. Selects a byte
// count by the requested path when the path-specific env var is set (so the
// aggregate "everything healthy" test can give the archive-capacity and
// pg_wal-bloat judgements different, independently-controlled numbers in
// the same process); otherwise falls back to a single generic value.
// DOCKER_SHIM_EXIT simulates the exec itself failing (fail-closed path).
const DOCKER_DU_SHIM = `#!/usr/bin/env bash
set -u
if [[ "\${DOCKER_SHIM_EXIT:-0}" != "0" ]]; then
  echo "shim: simulated docker exec failure" >&2
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
  env: NodeJS.ProcessEnv,
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

describe("check-wal-archive.sh: judgement 1 -- WAL archive directory capacity", () => {
  it("healthy (bytes well under max) does not fire", () => {
    const binDir = makeBin({ docker: DOCKER_DU_SHIM });
    const { fireTotal, output } = runCheck(
      "check_wal_archive_capacity",
      { ALERT_WAL_ARCHIVE_MAX_BYTES: "1000000000", DOCKER_SHIM_DU_BYTES: "1000" },
      binDir,
    );
    expect(fireTotal).toBe(0);
    expect(output).not.toContain("ALERT key=wal_archive_capacity");
  });

  it("bytes >= max fires wal_archive_capacity_over", () => {
    const binDir = makeBin({ docker: DOCKER_DU_SHIM });
    const { fireTotal, output } = runCheck(
      "check_wal_archive_capacity",
      { ALERT_WAL_ARCHIVE_MAX_BYTES: "1000", DOCKER_SHIM_DU_BYTES: "1000000" },
      binDir,
    );
    expect(fireTotal).toBe(1);
    expect(output).toContain("ALERT key=wal_archive_capacity_over");
  });

  it("a failed docker exec fails closed with wal_archive_capacity_unreadable", () => {
    const binDir = makeBin({ docker: DOCKER_DU_SHIM });
    const { fireTotal, output } = runCheck(
      "check_wal_archive_capacity",
      { DOCKER_SHIM_EXIT: "1" },
      binDir,
    );
    expect(fireTotal).toBe(1);
    expect(output).toContain("ALERT key=wal_archive_capacity_unreadable");
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

describe("check-wal-archive.sh: judgement 4 -- pg_wal directory size", () => {
  it("healthy (bytes well under max) does not fire", () => {
    const binDir = makeBin({ docker: DOCKER_DU_SHIM });
    const { fireTotal, output } = runCheck(
      "check_pg_wal_bloat",
      { ALERT_PG_WAL_MAX_BYTES: "1000000000", DOCKER_SHIM_DU_BYTES: "1000" },
      binDir,
    );
    expect(fireTotal).toBe(0);
    expect(output).not.toContain("ALERT key=pg_wal");
  });

  it("bytes > max fires pg_wal_bloat", () => {
    const binDir = makeBin({ docker: DOCKER_DU_SHIM });
    const { fireTotal, output } = runCheck(
      "check_pg_wal_bloat",
      { ALERT_PG_WAL_MAX_BYTES: "1000", DOCKER_SHIM_DU_BYTES: "1000000" },
      binDir,
    );
    expect(fireTotal).toBe(1);
    expect(output).toContain("ALERT key=pg_wal_bloat");
  });

  it("a failed docker exec fails closed with pg_wal_unreadable", () => {
    const binDir = makeBin({ docker: DOCKER_DU_SHIM });
    const { fireTotal, output } = runCheck("check_pg_wal_bloat", { DOCKER_SHIM_EXIT: "1" }, binDir);
    expect(fireTotal).toBe(1);
    expect(output).toContain("ALERT key=pg_wal_unreadable");
  });
});

describe("check-wal-archive.sh: run_wal_archive_checks() aggregate", () => {
  it("a fully healthy environment fires zero alerts across all four judgements", () => {
    const binDir = makeBin({ docker: DOCKER_DU_SHIM, psql: PSQL_SHIM });
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
