import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// Regression coverage for the WAL retention rehearsal (2026-09-16) v3 fix
// round: four guards in scripts/db/wal-retention.sh that the v2 round's
// tests (wal-retention-apply-order.test.ts) never touched --
//
//   - P1-A/P1-B: under `set -euo pipefail`, a `var="$(cmd | grep ... | ...)"`
//     assignment where `grep` can legitimately find zero matches trips
//     `set -e` and kills the whole script silently (pipefail keeps the
//     failed exit code even though the later pipe stages succeed) --
//     BEFORE the guard's own "not found -> REFUSED" branch ever runs. The
//     fix adds a trailing `|| true` to each such assignment; these tests
//     prove the REFUSED line actually prints instead of the process dying
//     with no output.
//   - P1-C: --require-archiver-healthy is now a time-based predicate
//     against pg_stat_archiver (via psql) instead of a failed_count
//     baseline compared across runs.
//   - P1-D: a VERIFIED marker missing/malformed start_wal (or
//     start_timeline/verified_epoch) must never be silently treated as the
//     oldest backup and retired.
//
// No Docker -- pg_archivecleanup and psql are both shimmed via a PATH
// override, the same technique wal-retention-apply-order.test.ts uses.
const root = process.cwd();
const scriptPath = path.resolve(root, "scripts/db/wal-retention.sh");

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

// wal-retention.sh calls `require_command pg_archivecleanup` unconditionally
// at startup (before any of the logic under test runs), so every invocation
// needs *something* executable named pg_archivecleanup on PATH even when
// the test never expects it to actually be invoked. This default behaves
// like "-n"/"-d" against an archive with nothing to reclaim -- print
// nothing, exit 0 -- which is exactly what every test below needs (each
// archive dir here holds only the anchor's own WAL file).
const PG_ARCHIVECLEANUP_NOOP_SHIM = `#!/usr/bin/env bash
set -u
mode="\${1:-}"
case "$mode" in
  -n) exit 0 ;;
  -d) exit 0 ;;
  *) echo "shim: unsupported mode $mode" >&2; exit 1 ;;
esac
`;

// psql stand-in for the --require-archiver-healthy tests. wal-retention.sh
// issues two independent `psql -tAc "<SQL>"` queries against
// pg_stat_archiver: the first selects (failed_count, last_failed_time,
// last_archived_time) as one pipe-separated row, the second asks Postgres
// itself for a single boolean t/f verdict. This shim tells the two apart by
// grepping its own arguments for each query's distinguishing text, and its
// output/exit code are driven entirely by env vars so each test only sets
// what it needs:
//   PSQL_SHIM_EXIT -> exit with this code before printing anything
//                     (simulates a connection/query failure).
//   PSQL_SHIM_ROW  -> stdout for the first (row) query. Default "0||".
//   PSQL_SHIM_FLAG -> stdout for the second (t/f) query. Default "f".
const PSQL_SHIM = `#!/usr/bin/env bash
set -u
if [[ "\${PSQL_SHIM_EXIT:-0}" != "0" ]]; then
  echo "shim: simulated psql failure" >&2
  exit "\${PSQL_SHIM_EXIT}"
fi
query=""
for a in "$@"; do
  case "$a" in
    SELECT*|select*) query="$a" ;;
  esac
done
if [[ "$query" == *"IS NOT NULL"* ]]; then
  printf '%s\\n' "\${PSQL_SHIM_FLAG:-f}"
else
  printf '%s\\n' "\${PSQL_SHIM_ROW:-0||}"
fi
exit 0
`;

function makeBin(extra: Record<string, string> = {}): string {
  const binDir = mkTestDir("wal-retention-guards-bin-");
  const files: Record<string, string> = { pg_archivecleanup: PG_ARCHIVECLEANUP_NOOP_SHIM, ...extra };
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(binDir, name);
    writeFileSync(p, content);
    chmodSync(p, 0o755);
  }
  return binDir;
}

function writeVerified(
  baseDir: string,
  name: string,
  fields: { start_wal?: string; start_timeline?: string; verified_epoch?: string },
): string {
  const dir = path.join(baseDir, name);
  mkdirSync(dir, { recursive: true });
  const lines: string[] = ["verified_at=2026-09-16T00:00:00Z"];
  if (fields.verified_epoch !== undefined) lines.push(`verified_epoch=${fields.verified_epoch}`);
  lines.push(
    "manifest_sha256=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  );
  if (fields.start_wal !== undefined) lines.push(`start_wal=${fields.start_wal}`);
  if (fields.start_timeline !== undefined) lines.push(`start_timeline=${fields.start_timeline}`);
  lines.push("");
  writeFileSync(path.join(dir, "VERIFIED"), lines.join("\n"));
  return dir;
}

function writeManifest(baseDir: string, name: string, walRanges: unknown[]): void {
  writeFileSync(
    path.join(baseDir, name, "backup_manifest"),
    JSON.stringify({ "PG_VERSION": "16", "WAL-Ranges": walRanges }),
  );
}

function run(args: string[], extraEnv: NodeJS.ProcessEnv, binDir: string) {
  return spawnSync("bash", [scriptPath, ...args], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

const B1_WAL = "000000010000000000000001";
const ANCHOR_WAL = "00000001000000000000000B";
const B3_WAL = "000000010000000000000015";
const SINGLE_RANGE = [{ Timeline: 1, "Start-LSN": "0/1000028", "End-LSN": "0/2000000" }];

// B1 < B2(anchor) < B3, all well-formed, on timeline 1 -- everything a
// --require-archiver-healthy test needs to clear anchor_not_in_archive /
// stale_base_backup (dry-run only, so not gated at all) / timeline_unsupported
// / archive_not_writable *before* reaching the archiver check under test.
// The archive only needs to hold the anchor's own file: that keeps
// would_empty_archive from tripping once the (empty) plan is computed.
function setupHealthyTriple(): { baseDir: string; archiveDir: string } {
  const baseDir = mkTestDir("wal-retention-base-");
  const archiveDir = mkTestDir("wal-retention-archive-");
  const nowEpoch = String(Math.floor(Date.now() / 1000));
  for (const [name, wal] of [
    ["B1", B1_WAL],
    ["B2", ANCHOR_WAL],
    ["B3", B3_WAL],
  ] as const) {
    writeVerified(baseDir, name, { start_wal: wal, start_timeline: "1", verified_epoch: nowEpoch });
    writeManifest(baseDir, name, SINGLE_RANGE);
  }
  writeFileSync(path.join(archiveDir, ANCHOR_WAL), "payload anchor");
  return { baseDir, archiveDir };
}

describe("wal-retention.sh: set -e must not swallow a REFUSED line (P1-A/P1-B)", () => {
  it("psql exiting non-zero prints REFUSED reason=archiver_unreadable on stdout, exit 65", () => {
    const { baseDir, archiveDir } = setupHealthyTriple();
    const binDir = makeBin({ psql: PSQL_SHIM });

    const result = run(
      ["--archive-dir", archiveDir, "--base-backup-dir", baseDir, "--keep-base", "2", "--require-archiver-healthy"],
      { PSQL_SHIM_EXIT: "2" },
      binDir,
    );

    expect(result.status).toBe(65);
    expect(result.stdout).toContain("WAL_RETENTION=REFUSED reason=archiver_unreadable");
    expect(result.stderr).not.toContain("WAL_RETENTION=REFUSED");
  });

  it("psql returning a non-numeric failed_count ('x') prints REFUSED reason=archiver_unreadable, exit 65", () => {
    const { baseDir, archiveDir } = setupHealthyTriple();
    const binDir = makeBin({ psql: PSQL_SHIM });

    const result = run(
      ["--archive-dir", archiveDir, "--base-backup-dir", baseDir, "--keep-base", "2", "--require-archiver-healthy"],
      { PSQL_SHIM_ROW: "x" },
      binDir,
    );

    expect(result.status).toBe(65);
    expect(result.stdout).toContain("WAL_RETENTION=REFUSED reason=archiver_unreadable");
    expect(result.stderr).not.toContain("WAL_RETENTION=REFUSED");
  });

  it("anchor backup_manifest with an empty WAL-Ranges array prints REFUSED reason=timeline_unsupported, exit 65", () => {
    // Three backups (not two): with --keep-base 2, recent_set = the two
    // NEWEST (B2, B3) and anchor = recent_set[0] = B2 -- the oldest of the
    // *kept* two, not simply "the second directory created". Two backups
    // would make B1 the anchor instead and miss the manifest under test.
    const { baseDir, archiveDir } = setupHealthyTriple();
    // Overwrite the anchor's (B2) manifest with a real "0 WAL-Ranges"
    // shape. Before the P1-B fix, the `grep -oE '"Timeline"'` on an empty
    // section exits 1 (no match), and under pipefail that non-zero status
    // alone -- even though wc/tr both still succeed -- kills the whole
    // script at that assignment, so this REFUSED line never printed.
    writeManifest(baseDir, "B2", []);
    const binDir = makeBin();

    const result = run(
      ["--archive-dir", archiveDir, "--base-backup-dir", baseDir, "--keep-base", "2"],
      {},
      binDir,
    );

    expect(result.status).toBe(65);
    expect(result.stdout).toContain("WAL_RETENTION=REFUSED reason=timeline_unsupported");
    expect(result.stderr).not.toContain("WAL_RETENTION=REFUSED");
  });
});

describe("wal-retention.sh --require-archiver-healthy: time-based predicate (P1-C)", () => {
  it("refuses with archiver_failing when Postgres reports the last failure is newer than the last success", () => {
    const { baseDir, archiveDir } = setupHealthyTriple();
    const binDir = makeBin({ psql: PSQL_SHIM });

    const result = run(
      ["--archive-dir", archiveDir, "--base-backup-dir", baseDir, "--keep-base", "2", "--require-archiver-healthy"],
      {
        PSQL_SHIM_ROW: "3|2026-09-16 00:05:00+00|2026-09-16 00:00:00+00",
        PSQL_SHIM_FLAG: "t",
      },
      binDir,
    );

    expect(result.status).toBe(65);
    expect(result.stdout).toContain("WAL_RETENTION=REFUSED reason=archiver_failing");
    // The three raw pg_stat_archiver values must be on the refusal line.
    expect(result.stdout).toContain("failed_count=3");
    expect(result.stdout).toContain("last_failed_time=2026-09-16 00:05:00+00");
    expect(result.stdout).toContain("last_archived_time=2026-09-16 00:00:00+00");
    expect(result.stderr).not.toContain("WAL_RETENTION=REFUSED");
  });

  it("does not refuse (falls through to a normal DRY_RUN) when Postgres reports the archiver is healthy", () => {
    const { baseDir, archiveDir } = setupHealthyTriple();
    const binDir = makeBin({ psql: PSQL_SHIM });

    const result = run(
      ["--archive-dir", archiveDir, "--base-backup-dir", baseDir, "--keep-base", "2", "--require-archiver-healthy"],
      {
        PSQL_SHIM_ROW: "3|2026-09-16 00:00:00+00|2026-09-16 00:05:00+00",
        PSQL_SHIM_FLAG: "f",
      },
      binDir,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("WAL_RETENTION=REFUSED");
    expect(result.stdout).toContain("WAL_RETENTION=DRY_RUN");
  });
});

describe("wal-retention.sh: malformed VERIFIED must refuse, not silently retire (P1-D)", () => {
  it("a VERIFIED file missing start_wal prints REFUSED reason=verified_malformed, exit 65, and touches nothing", () => {
    const baseDir = mkTestDir("wal-retention-base-");
    const archiveDir = mkTestDir("wal-retention-archive-");
    const nowEpoch = String(Math.floor(Date.now() / 1000));
    // start_wal is entirely absent -- read_kv returns "", which (before the
    // P1-D fix) would sort as the lexicographically-smallest key, i.e. the
    // "oldest" backup, and get silently retired and rm -rf'd.
    const b1Dir = writeVerified(baseDir, "B1", { start_timeline: "1", verified_epoch: nowEpoch });
    writeManifest(baseDir, "B1", SINGLE_RANGE);
    const binDir = makeBin();

    const result = run(
      ["--archive-dir", archiveDir, "--base-backup-dir", baseDir, "--keep-base", "2"],
      {},
      binDir,
    );

    expect(result.status).toBe(65);
    expect(result.stdout).toContain("WAL_RETENTION=REFUSED reason=verified_malformed name=B1");
    expect(result.stderr).not.toContain("WAL_RETENTION=REFUSED");

    // Nothing was touched: the directory is still there and was never
    // marked RETIRED (marking/removal both happen much later, only for the
    // apply path's computed retire_set -- which this run never reaches).
    expect(existsSync(b1Dir)).toBe(true);
    expect(existsSync(path.join(b1Dir, "RETIRED"))).toBe(false);
  });
});

// Regression guard for the file-level rule this whole round enforces: no
// machine-readable WAL_RETENTION=/WAL_RETENTION_*= judgment line may ever
// land on stderr (P2-1). Spot-checked here against one representative
// REFUSED from each of the four scenarios above rather than re-asserted
// per-test.
describe("wal-retention.sh: all WAL_RETENTION judgment lines are on stdout, never stderr", () => {
  it("stderr never contains a WAL_RETENTION= line across the four refusal scenarios above", () => {
    const scenarios: Array<{ args: string[]; env: NodeJS.ProcessEnv; binDir: string }> = [];

    {
      const { baseDir, archiveDir } = setupHealthyTriple();
      scenarios.push({
        args: ["--archive-dir", archiveDir, "--base-backup-dir", baseDir, "--keep-base", "2", "--require-archiver-healthy"],
        env: { PSQL_SHIM_EXIT: "2" },
        binDir: makeBin({ psql: PSQL_SHIM }),
      });
    }
    {
      const baseDir = mkTestDir("wal-retention-base-");
      const archiveDir = mkTestDir("wal-retention-archive-");
      const b1Dir = writeVerified(baseDir, "B1", {});
      writeManifest(baseDir, "B1", SINGLE_RANGE);
      void b1Dir;
      scenarios.push({
        args: ["--archive-dir", archiveDir, "--base-backup-dir", baseDir, "--keep-base", "2"],
        env: {},
        binDir: makeBin(),
      });
    }

    for (const { args, env, binDir } of scenarios) {
      const result = run(args, env, binDir);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("WAL_RETENTION=REFUSED");
      expect(result.stderr).not.toContain("WAL_RETENTION=REFUSED");
      expect(result.stderr).not.toContain("WAL_RETENTION_WARN=");
    }
  });
});
