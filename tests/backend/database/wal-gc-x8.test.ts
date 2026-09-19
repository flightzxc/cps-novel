import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// Coverage for the WAL retention rehearsal's formal X8 entry point,
// scripts/db/wal-gc-x8.sh: it always calls wal-retention.sh with
// --require-archiver-healthy (never optional the way a raw wal-retention.sh
// invocation is), pins --archive-dir/--base-backup-dir to fixed in-container
// paths (only overridable here via env, for testing, never via a CLI flag),
// and rejects any argument outside {--apply, --keep-base, --json, --force}
// before ever touching wal-retention.sh. No Docker -- psql and
// pg_archivecleanup are both shimmed via a PATH override, same technique as
// wal-retention-guards.test.ts / wal-retention-apply-order.test.ts.
const root = process.cwd();
const scriptPath = path.resolve(root, "scripts/db/wal-gc-x8.sh");
const retentionScriptPath = path.resolve(root, "scripts/db/wal-retention.sh");
const x8ScriptPath = path.resolve(root, "scripts/x8-production-like.sh");

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

// Same NOOP pg_archivecleanup stand-in as wal-retention-guards.test.ts:
// wal-retention.sh calls `require_command pg_archivecleanup` unconditionally
// at startup, so every run needs *something* on PATH even when the
// archiver-health refusal is expected to fire long before any plan is
// computed.
const PG_ARCHIVECLEANUP_NOOP_SHIM = `#!/usr/bin/env bash
set -u
mode="\${1:-}"
case "$mode" in
  -n) exit 0 ;;
  -d) exit 0 ;;
  *) echo "shim: unsupported mode $mode" >&2; exit 1 ;;
esac
`;

// A minimal but real pg_archivecleanup stand-in for the one test (dry-run,
// healthy archiver) that needs planned_delete>0: `-n` lists every 24-hex
// archive file that sorts before the anchor argument, exactly
// pg_archivecleanup's own OLDESTKEPTWALFILE contract for a single timeline.
const PG_ARCHIVECLEANUP_REAL_SHIM = `#!/usr/bin/env bash
set -u
mode="\${1:-}"
archive_dir="\${2:-}"
anchor="\${3:-}"
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
    for f in "\${files[@]}"; do rm -f "$f"; done
    exit 0
    ;;
  *)
    echo "shim: unsupported mode $mode" >&2
    exit 1
    ;;
esac
`;

// Same psql stand-in as wal-retention-guards.test.ts. wal-retention.sh
// issues two independent `psql -tAc "<SQL>"` queries against
// pg_stat_archiver; this shim tells them apart by grepping its own
// arguments for each query's distinguishing text.
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
  const binDir = mkTestDir("wal-gc-x8-bin-");
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

const B1_WAL = "000000010000000000000001";
const ANCHOR_WAL = "00000001000000000000000B";
const B3_WAL = "000000010000000000000015";
const SINGLE_RANGE = [{ Timeline: 1, "Start-LSN": "0/1000028", "End-LSN": "0/2000000" }];

// Three VERIFIED base backups (B1 < B2(anchor) < B3, --keep-base 2 keeps
// B2+B3) plus an archive dir holding the anchor's own segment AND two
// deletable segments before it -- deletable segments so the dry-run test
// below can assert planned_delete>0, present-but-untouched in the refusal
// tests above it.
function setupTripleWithDeletableSegments(): { baseDir: string; archiveDir: string } {
  const baseDir = mkTestDir("wal-gc-x8-base-");
  const archiveDir = mkTestDir("wal-gc-x8-archive-");
  const nowEpoch = String(Math.floor(Date.now() / 1000));
  for (const [name, wal] of [
    ["B1", B1_WAL],
    ["B2", ANCHOR_WAL],
    ["B3", B3_WAL],
  ] as const) {
    writeVerified(baseDir, name, { start_wal: wal, start_timeline: "1", verified_epoch: nowEpoch });
    writeManifest(baseDir, name, SINGLE_RANGE);
  }
  writeFileSync(path.join(archiveDir, "000000010000000000000005"), "deletable 1");
  writeFileSync(path.join(archiveDir, "000000010000000000000008"), "deletable 2");
  writeFileSync(path.join(archiveDir, ANCHOR_WAL), "payload anchor");
  return { baseDir, archiveDir };
}

// Next 16 (node_modules/next/types/global.d.ts:23) declares NODE_ENV as a
// REQUIRED readonly member of NodeJS.ProcessEnv, so an object literal
// holding only the overrides a test wants is no longer assignable to it.
// This never was a complete ProcessEnv anyway -- it is spread ON TOP of
// one below -- so the override map is the accurate type, and the call
// sites keep passing exactly what they always passed.
function run(
  args: string[],
  extraEnv: Record<string, string | undefined>,
  binDir: string,
  archiveDir: string,
  baseDir: string,
) {
  return spawnSync("bash", [scriptPath, ...args], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      X8_WAL_ARCHIVE_DIR: archiveDir,
      X8_BASE_BACKUP_DIR_IN_CONTAINER: baseDir,
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

describe("wal-gc-x8.sh: --apply refuses when the archiver cannot be read, --force does not change that", () => {
  it("psql exiting non-zero (archiver unreadable) refuses, deletes nothing, no state file", () => {
    const { baseDir, archiveDir } = setupTripleWithDeletableSegments();
    const filesBefore = readdirSync(archiveDir).sort();
    // WAL-retention rollout work order 2026-09-17, P2-2/P2-3: this one case
    // (of the four in this describe block) uses the REAL pg_archivecleanup
    // shim, not the NOOP one every other case here uses. With the NOOP shim,
    // "archive file count unchanged" is trivially true regardless of
    // whether the refusal actually ran before reaching wal-retention.sh's
    // delete step -- -d is a no-op either way, so a regression that let
    // execution fall through past archiver_unreadable would still pass this
    // assertion. The REAL shim actually deletes matching files in -d mode,
    // so this is the one case in the block that can genuinely catch that
    // regression rather than only checking a marker file.
    const binDir = makeBin({ psql: PSQL_SHIM, pg_archivecleanup: PG_ARCHIVECLEANUP_REAL_SHIM });

    const result = run(["--apply", "--keep-base", "2"], { PSQL_SHIM_EXIT: "2" }, binDir, archiveDir, baseDir);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("WAL_RETENTION=REFUSED reason=archiver_unreadable");
    expect(existsSync(path.join(baseDir, "B1"))).toBe(true);
    expect(existsSync(path.join(baseDir, "B1", "RETIRED"))).toBe(false);
    expect(readdirSync(archiveDir).sort()).toEqual(filesBefore);
    expect(existsSync(path.join(baseDir, ".wal-retention.state"))).toBe(false);
  });

  it("psql reporting the archiver is failing refuses, deletes nothing, no state file", () => {
    const { baseDir, archiveDir } = setupTripleWithDeletableSegments();
    const filesBefore = readdirSync(archiveDir).sort();
    const binDir = makeBin({ psql: PSQL_SHIM });

    const result = run(
      ["--apply", "--keep-base", "2"],
      { PSQL_SHIM_ROW: "3|2026-09-17 00:05:00+00|2026-09-17 00:00:00+00", PSQL_SHIM_FLAG: "t" },
      binDir,
      archiveDir,
      baseDir,
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("WAL_RETENTION=REFUSED reason=archiver_failing");
    expect(existsSync(path.join(baseDir, "B1"))).toBe(true);
    expect(existsSync(path.join(baseDir, "B1", "RETIRED"))).toBe(false);
    expect(readdirSync(archiveDir).sort()).toEqual(filesBefore);
    expect(existsSync(path.join(baseDir, ".wal-retention.state"))).toBe(false);
  });

  it("--force does not change the archiver_unreadable refusal", () => {
    const { baseDir, archiveDir } = setupTripleWithDeletableSegments();
    const filesBefore = readdirSync(archiveDir).sort();
    const binDir = makeBin({ psql: PSQL_SHIM });

    const result = run(
      ["--apply", "--keep-base", "2", "--force"],
      { PSQL_SHIM_EXIT: "2" },
      binDir,
      archiveDir,
      baseDir,
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("WAL_RETENTION=REFUSED reason=archiver_unreadable");
    expect(existsSync(path.join(baseDir, "B1"))).toBe(true);
    expect(existsSync(path.join(baseDir, "B1", "RETIRED"))).toBe(false);
    expect(readdirSync(archiveDir).sort()).toEqual(filesBefore);
    expect(existsSync(path.join(baseDir, ".wal-retention.state"))).toBe(false);
  });

  it("--force does not change the archiver_failing refusal", () => {
    const { baseDir, archiveDir } = setupTripleWithDeletableSegments();
    const filesBefore = readdirSync(archiveDir).sort();
    const binDir = makeBin({ psql: PSQL_SHIM });

    const result = run(
      ["--apply", "--keep-base", "2", "--force"],
      { PSQL_SHIM_ROW: "3|2026-09-17 00:05:00+00|2026-09-17 00:00:00+00", PSQL_SHIM_FLAG: "t" },
      binDir,
      archiveDir,
      baseDir,
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("WAL_RETENTION=REFUSED reason=archiver_failing");
    expect(existsSync(path.join(baseDir, "B1"))).toBe(true);
    expect(existsSync(path.join(baseDir, "B1", "RETIRED"))).toBe(false);
    expect(readdirSync(archiveDir).sort()).toEqual(filesBefore);
    expect(existsSync(path.join(baseDir, ".wal-retention.state"))).toBe(false);
  });
});

describe("wal-gc-x8.sh: a healthy archiver falls through to a normal dry-run", () => {
  it("without --apply, reports DRY_RUN planned_delete>0 and deletes nothing", () => {
    const { baseDir, archiveDir } = setupTripleWithDeletableSegments();
    const filesBefore = readdirSync(archiveDir).sort();
    const binDir = makeBin({ psql: PSQL_SHIM, pg_archivecleanup: PG_ARCHIVECLEANUP_REAL_SHIM });

    const result = run(["--keep-base", "2"], { PSQL_SHIM_FLAG: "f" }, binDir, archiveDir, baseDir);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("WAL_RETENTION=REFUSED");
    expect(result.stdout).toMatch(/WAL_RETENTION=DRY_RUN planned_delete=[1-9]\d*/);
    expect(readdirSync(archiveDir).sort()).toEqual(filesBefore);
    expect(existsSync(path.join(baseDir, ".wal-retention.state"))).toBe(false);
  });
});

// WAL-retention rollout work order 2026-09-17, P2-9: --force silently
// disarms wal-retention.sh's delete_surge_guard for the whole run (see the
// wrapper's own header comment) -- printed on stdout, ahead of
// wal-retention.sh's own output, so it lands in the same evidence/log
// stream as whatever that run goes on to do, whether or not the guard
// would actually have fired this time.
describe("wal-gc-x8.sh: --force prints a disabled-guard notice before wal-retention.sh runs (P2-9)", () => {
  it("prints WAL_GC_X8_NOTICE=delete_surge_guard_disabled_for_this_run before WAL_RETENTION=APPLIED when --force is passed", () => {
    const { baseDir, archiveDir } = setupTripleWithDeletableSegments();
    const binDir = makeBin({ psql: PSQL_SHIM, pg_archivecleanup: PG_ARCHIVECLEANUP_REAL_SHIM });

    const result = run(
      ["--apply", "--keep-base", "2", "--force"],
      { PSQL_SHIM_FLAG: "f" },
      binDir,
      archiveDir,
      baseDir,
    );

    expect(result.status).toBe(0);
    const noticeIndex = result.stdout.indexOf("WAL_GC_X8_NOTICE=delete_surge_guard_disabled_for_this_run");
    const appliedIndex = result.stdout.indexOf("WAL_RETENTION=APPLIED");
    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    expect(appliedIndex).toBeGreaterThan(noticeIndex);
  });

  it("does not print the notice when --force is omitted", () => {
    const { baseDir, archiveDir } = setupTripleWithDeletableSegments();
    const binDir = makeBin({ psql: PSQL_SHIM, pg_archivecleanup: PG_ARCHIVECLEANUP_REAL_SHIM });

    const result = run(["--apply", "--keep-base", "2"], { PSQL_SHIM_FLAG: "f" }, binDir, archiveDir, baseDir);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("WAL_GC_X8_NOTICE=");
  });
});

describe("wal-gc-x8.sh: only {--apply, --keep-base, --json, --force} are accepted", () => {
  function mkWrapperCopyWithMarkerStub(): { copyDir: string; wrapperCopy: string; markerFile: string } {
    const copyDir = mkTestDir("wal-gc-x8-wrapper-copy-");
    const wrapperCopy = path.join(copyDir, "wal-gc-x8.sh");
    copyFileSync(scriptPath, wrapperCopy);
    chmodSync(wrapperCopy, 0o755);
    const markerFile = path.join(copyDir, "wal-retention.invoked");
    const stub = `#!/usr/bin/env bash\ntouch "${markerFile}"\nexit 0\n`;
    writeFileSync(path.join(copyDir, "wal-retention.sh"), stub);
    chmodSync(path.join(copyDir, "wal-retention.sh"), 0o755);
    return { copyDir, wrapperCopy, markerFile };
  }

  it.each([
    ["--require-archiver-healthy"],
    ["--no-require-archiver-healthy"],
    ["--archive-dir", "/some/dir"],
  ])("rejects %s with exit 64 and never invokes wal-retention.sh", (...args) => {
    const { wrapperCopy, markerFile } = mkWrapperCopyWithMarkerStub();

    const result = spawnSync("bash", [wrapperCopy, ...args], { encoding: "utf8" });

    expect(result.status).toBe(64);
    expect(existsSync(markerFile)).toBe(false);
  });

  // WAL-retention rollout work order 2026-09-17, P2-3: positive control for
  // the it.each block above. Every one of those cases only proves the
  // marker file is ABSENT -- on its own that is also exactly what a broken
  // wrapper that (say) always hit `usage` regardless of its arguments, or
  // never resolved wal-retention.sh at all, would produce. This proves the
  // opposite side: a legal argument set (one of each recognized flag) DOES
  // reach and invoke the stub, so "marker absent" in the rejection cases
  // above is actually load-bearing evidence of correct rejection, not an
  // artifact of the harness never being able to produce a marker at all.
  it("a legal argument set reaches and invokes wal-retention.sh (marker is created)", () => {
    const { wrapperCopy, markerFile } = mkWrapperCopyWithMarkerStub();

    const result = spawnSync(
      "bash",
      [wrapperCopy, "--apply", "--keep-base", "2", "--json", "--force"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(existsSync(markerFile)).toBe(true);
  });

  // Opus review fixup 2026-09-18 (P2-7): a *behavioural* companion to the
  // static "target=(...) contains --max-backup-age-seconds
  // X8_WAL_GC_MAX_BACKUP_AGE_SECONDS:-93600" assertion in
  // no-leak-static-guards.test.ts -- that one only proves the literal text
  // is present in the right place in the source; this one actually runs the
  // wrapper and captures what wal-retention.sh is invoked with, so a
  // regression that kept the source text but broke assembly of the
  // `target` array (e.g. a stray `unset`/reassignment before `exec`) would
  // still be caught here even though the static check would not notice.
  function mkWrapperCopyWithArgvCapture(): { wrapperCopy: string; argvFile: string } {
    const copyDir = mkTestDir("wal-gc-x8-wrapper-argv-");
    const wrapperCopy = path.join(copyDir, "wal-gc-x8.sh");
    copyFileSync(scriptPath, wrapperCopy);
    chmodSync(wrapperCopy, 0o755);
    const argvFile = path.join(copyDir, "wal-retention.argv");
    const stub = `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >"${argvFile}"\nexit 0\n`;
    writeFileSync(path.join(copyDir, "wal-retention.sh"), stub);
    chmodSync(path.join(copyDir, "wal-retention.sh"), 0o755);
    return { wrapperCopy, argvFile };
  }

  it("invokes wal-retention.sh with --max-backup-age-seconds 93600 when no override env var is set", () => {
    const { wrapperCopy, argvFile } = mkWrapperCopyWithArgvCapture();
    const env = { ...process.env };
    delete env.X8_WAL_GC_MAX_BACKUP_AGE_SECONDS;

    const result = spawnSync("bash", [wrapperCopy, "--keep-base", "2", "--json"], { env, encoding: "utf8" });

    expect(result.status).toBe(0);
    const argv = readFileSync(argvFile, "utf8");
    expect(argv).toContain("--max-backup-age-seconds 93600");
  });
});

describe("wal-gc-x8.sh / x8-production-like.sh: static contracts", () => {
  it("wal-gc-x8.sh unconditionally forces --require-archiver-healthy", () => {
    const content = readFileSync(scriptPath, "utf8");
    // Scoped to the fixed wal-retention.sh invocation itself (the
    // `target=(...)` array), not a bare substring search -- the file's own
    // header comment ALSO says "--require-archiver-healthy" in prose (to
    // explain the guarantee this test exists to enforce), so a plain
    // `.toContain` would keep passing even if the flag were deleted from
    // the actual invocation while that comment survived. This must find
    // the literal flag between `target=(` and that array's own closing
    // `)`, which is where wal-retention.sh is actually invoked.
    const targetMatch = content.match(/target=\([\s\S]*?--require-archiver-healthy[\s\S]*?\)/);
    expect(targetMatch).toBeTruthy();
    // It must be a fixed literal in the fixed wal-retention.sh invocation,
    // not a case arm in the argument parser below (which would mean a
    // caller could toggle it).
    const caseMatch = content.match(/case "\$1" in([\s\S]*?)esac/);
    expect(caseMatch).toBeTruthy();
    expect(caseMatch![1]).not.toContain("--require-archiver-healthy");
  });

  it("wal-gc-x8.sh resolves wal-retention.sh next to itself, not via PATH", () => {
    const content = readFileSync(scriptPath, "utf8");
    expect(content).toContain('script_dir="$(dirname "$0")"');
    expect(content).toContain('"$script_dir/wal-retention.sh"');
    expect(existsSync(retentionScriptPath)).toBe(true);
  });

  it("x8-production-like.sh's wal-gc entry calls wal-gc-x8.sh, never wal-retention.sh directly", () => {
    const content = readFileSync(x8ScriptPath, "utf8");
    const fnMatch = content.match(/\nwal_gc\(\) \{[\s\S]*?\n\}\n/);
    expect(fnMatch).toBeTruthy();
    const fnBody = fnMatch![0];
    expect(fnBody).toContain("wal-gc-x8.sh");
    expect(fnBody).not.toContain("wal-retention.sh");

    const dispatchMatch = content.match(/wal-gc\)\s*shift;\s*wal_gc "\$@" ;;/);
    expect(dispatchMatch).toBeTruthy();
  });
});
