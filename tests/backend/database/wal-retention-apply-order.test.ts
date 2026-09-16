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

// Regression coverage for the WAL retention rehearsal (2026-09-16) v2 fix
// round: scripts/db/wal-retention.sh's apply-time ordering invariant (mark
// RETIRED -> pg_archivecleanup -d -> rm -rf the retired dir) and two of its
// fail-closed refusal paths (plan_failed, anchor_not_in_archive). No Docker
// here -- pg_archivecleanup is shimmed via a PATH override so this runs
// anywhere `bash` does.
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

// A minimal but real pg_archivecleanup stand-in. `-n` lists (and `-d`
// deletes) every 24-hex archive file that sorts before the anchor argument
// -- exactly pg_archivecleanup's own OLDESTKEPTWALFILE contract for a
// single timeline. Two env-var hooks make it useful as a test double:
//   SHIM_FAIL_PLAN=1   -> `-n` prints an error and exits 1 (never lists
//                         anything), to exercise wal-retention.sh's
//                         plan_failed refusal.
//   SHIM_LOG_FILE + SHIM_B1_DIR -> on every `-d` invocation, before doing
//                         any deleting, append whether SHIM_B1_DIR still
//                         exists and whether SHIM_B1_DIR/RETIRED already
//                         exists -- the apply-ordering invariant under test.
const PG_ARCHIVECLEANUP_SHIM = `#!/usr/bin/env bash
set -u
mode="\${1:-}"
archive_dir="\${2:-}"
anchor="\${3:-}"

if [[ "$mode" == "-d" && -n "\${SHIM_LOG_FILE:-}" ]]; then
  b1_dir="\${SHIM_B1_DIR:-/nonexistent-shim-check}"
  {
    if [[ -d "$b1_dir" ]]; then echo "b1_dir_exists=yes"; else echo "b1_dir_exists=no"; fi
    if [[ -f "$b1_dir/RETIRED" ]]; then echo "b1_retired_exists=yes"; else echo "b1_retired_exists=no"; fi
  } >> "$SHIM_LOG_FILE"
fi

if [[ "$mode" == "-n" && "\${SHIM_FAIL_PLAN:-0}" == "1" ]]; then
  echo "shim: simulated pg_archivecleanup -n failure" >&2
  exit 1
fi

files=()
for f in "$archive_dir"/*; do
  [[ -e "$f" ]] || continue
  name="$(basename "$f")"
  [[ "$name" =~ ^[0-9A-F]{24}$ ]] || continue
  if [[ "$name" < "$anchor" ]]; then
    files+=("$f")
  fi
done

case "$mode" in
  -n)
    for f in "\${files[@]}"; do printf '%s\\n' "$f"; done
    exit 0
    ;;
  -d)
    for f in "\${files[@]}"; do
      rm -f "$f"
      printf 'pg_archivecleanup: removing file "%s"\\n' "$f"
    done
    exit 0
    ;;
  *)
    echo "shim: unsupported mode $mode" >&2
    exit 1
    ;;
esac
`;

function makeShimBin(): string {
  const binDir = mkTestDir("wal-retention-shim-bin-");
  const shimPath = path.join(binDir, "pg_archivecleanup");
  writeFileSync(shimPath, PG_ARCHIVECLEANUP_SHIM);
  chmodSync(shimPath, 0o755);
  return binDir;
}

function writeVerifiedBase(baseDir: string, name: string, startWal: string): string {
  const dir = path.join(baseDir, name);
  mkdirSync(dir, { recursive: true });
  const nowEpoch = Math.floor(Date.now() / 1000);
  writeFileSync(
    path.join(dir, "VERIFIED"),
    [
      "verified_at=2026-09-16T00:00:00Z",
      `verified_epoch=${nowEpoch}`,
      "manifest_sha256=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      `start_wal=${startWal}`,
      "start_timeline=1",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(dir, "backup_manifest"),
    JSON.stringify({
      "PG_VERSION": "16",
      "WAL-Ranges": [{ Timeline: 1, "Start-LSN": "0/1000028", "End-LSN": "0/2000000" }],
    }),
  );
  return dir;
}

// B1 < B2(anchor) < B3, all on timeline 1, all comfortably fresh
// (verified_epoch = now). --keep-base 2 retires B1 and keeps B2+B3, with B2
// as the anchor -- matching the real rehearsal's own B1/B2/B3 shape.
const B1_WAL = "000000010000000000000001";
const ANCHOR_WAL = "00000001000000000000000B";
const B3_WAL = "000000010000000000000015";

function setupBaseAndArchive(): { baseDir: string; archiveDir: string; b1Dir: string } {
  const baseDir = mkTestDir("wal-retention-base-");
  const archiveDir = mkTestDir("wal-retention-archive-");
  const b1Dir = writeVerifiedBase(baseDir, "B1", B1_WAL);
  writeVerifiedBase(baseDir, "B2", ANCHOR_WAL);
  writeVerifiedBase(baseDir, "B3", B3_WAL);

  // 10 segments strictly before the anchor (0x01..0x0A) -- these are what
  // the plan should delete -- plus the anchor itself (0x0B) and one segment
  // after it (0x0C) that must survive.
  for (let n = 1; n <= 0x0a; n += 1) {
    const name = `00000001${"0".repeat(8)}${n.toString(16).toUpperCase().padStart(8, "0")}`;
    writeFileSync(path.join(archiveDir, name), `payload ${name}`);
  }
  writeFileSync(path.join(archiveDir, ANCHOR_WAL), "payload anchor");
  writeFileSync(path.join(archiveDir, "00000001000000000000000C"), "payload after anchor");

  return { baseDir, archiveDir, b1Dir };
}

function runWalRetention(args: string[], extraEnv: NodeJS.ProcessEnv, binDir: string) {
  return spawnSync("bash", [scriptPath, ...args], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

describe("wal-retention.sh apply ordering and refusal paths", () => {
  it("marks RETIRED and keeps the directory in place until AFTER pg_archivecleanup -d runs, then removes it", () => {
    const { baseDir, archiveDir, b1Dir } = setupBaseAndArchive();
    const binDir = makeShimBin();
    const logFile = path.join(mkTestDir("wal-retention-log-"), "shim.log");

    const result = runWalRetention(
      ["--archive-dir", archiveDir, "--base-backup-dir", baseDir, "--keep-base", "2", "--apply"],
      { SHIM_LOG_FILE: logFile, SHIM_B1_DIR: b1Dir },
      binDir,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("WAL_RETENTION=APPLIED deleted=10 anchor=" + ANCHOR_WAL);

    // The invariant under test: AT THE MOMENT -d ran, RETIRED already
    // existed (step 1 happened first) and B1's directory itself was still
    // there (step 3 -- the rm -rf -- had not happened yet).
    expect(existsSync(logFile)).toBe(true);
    const log = readFileSync(logFile, "utf8");
    expect(log).toContain("b1_dir_exists=yes");
    expect(log).toContain("b1_retired_exists=yes");

    // After the whole run, B1 is actually gone.
    expect(existsSync(b1Dir)).toBe(false);
    expect(existsSync(path.join(baseDir, "B2"))).toBe(true);
    expect(existsSync(path.join(baseDir, "B3"))).toBe(true);

    // State persisted for the next run's delete_surge_guard.
    const statePath = path.join(baseDir, ".wal-retention.state");
    expect(existsSync(statePath)).toBe(true);
    expect(readFileSync(statePath, "utf8")).toContain("last_deleted_count=10");
  });

  it("refuses with plan_failed and deletes nothing when pg_archivecleanup -n exits non-zero", () => {
    const { baseDir, archiveDir, b1Dir } = setupBaseAndArchive();
    const binDir = makeShimBin();

    const result = runWalRetention(
      ["--archive-dir", archiveDir, "--base-backup-dir", baseDir, "--keep-base", "2", "--apply"],
      { SHIM_FAIL_PLAN: "1" },
      binDir,
    );

    expect(result.status).toBe(65);
    expect(result.stdout).toContain("WAL_RETENTION=REFUSED reason=plan_failed");

    // Nothing was touched: plan_failed is detected before RETIRED is ever
    // written, let alone before any directory or archive file is removed.
    expect(existsSync(b1Dir)).toBe(true);
    expect(existsSync(path.join(b1Dir, "RETIRED"))).toBe(false);
    expect(existsSync(path.join(archiveDir, B1_WAL))).toBe(true);
  });

  it("refuses with anchor_not_in_archive when the archive doesn't hold the anchor segment", () => {
    const baseDir = mkTestDir("wal-retention-base-");
    const archiveDir = mkTestDir("wal-retention-archive-");
    const b1Dir = writeVerifiedBase(baseDir, "B1", B1_WAL);
    writeVerifiedBase(baseDir, "B2", ANCHOR_WAL);
    writeVerifiedBase(baseDir, "B3", B3_WAL);
    // Archive has plenty of segments, but never the anchor (00000001...0B)
    // itself -- exactly the real rehearsal's P0 finding (evidence
    // step4-apply.log): the plan can look plausible while the one segment
    // every kept backup actually depends on was never archived.
    for (let n = 1; n <= 0x0a; n += 1) {
      const name = `00000001${"0".repeat(8)}${n.toString(16).toUpperCase().padStart(8, "0")}`;
      writeFileSync(path.join(archiveDir, name), `payload ${name}`);
    }
    const binDir = makeShimBin();
    const logFile = path.join(mkTestDir("wal-retention-log-"), "shim.log");

    const result = runWalRetention(
      ["--archive-dir", archiveDir, "--base-backup-dir", baseDir, "--keep-base", "2", "--apply"],
      { SHIM_LOG_FILE: logFile, SHIM_B1_DIR: b1Dir },
      binDir,
    );

    expect(result.status).toBe(65);
    expect(result.stderr + result.stdout).toContain("WAL_RETENTION=REFUSED reason=anchor_not_in_archive");

    // The refusal happens before the plan is even computed -- the shim's
    // -n/-d were never invoked, so the log file it would have written to
    // never got created.
    expect(existsSync(logFile)).toBe(false);
    expect(existsSync(b1Dir)).toBe(true);
    expect(existsSync(path.join(b1Dir, "RETIRED"))).toBe(false);
  });
});
