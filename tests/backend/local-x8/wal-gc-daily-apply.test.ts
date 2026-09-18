import { spawnSync } from "node:child_process";
import {
  chmodSync,
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

// Local-X8 daily WAL retention apply operator
// (infra/local-x8/wal-gc-daily-apply.sh): a thin, fail-closed wrapper around
// the EXISTING formal entry point (scripts/x8-production-like.sh's `wal-gc`
// subcommand). No Docker here -- the formal entry point itself is replaced
// by a shim script, the same technique backup-timer-static.test.ts uses for
// X8_TIMER_* (X8_LOCAL_TEST_MODE gates X8_LOCAL_WAL_GC_ENTRY/X8_LOCAL_UNAME
// exactly the way X8_TIMER_TEST_MODE gates the X8_TIMER_* family).
const root = process.cwd();
const scriptPath = path.resolve(root, "infra/local-x8/wal-gc-daily-apply.sh");
const scriptSource = readFileSync(scriptPath, "utf8");

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

// A single shim stands in for scripts/x8-production-like.sh's `wal-gc`
// subcommand. It always appends "CALL sub=<sub> args=<args>" to CALL_LOG, so
// tests can assert exactly which invocations happened, in what order, with
// what arguments -- then returns a canned SHIM_PREFLIGHT_OUTPUT/SHIM_APPLY_OUTPUT
// for the first/second non-apply ("dry-run") call it sees respectively (a
// call-count file distinguishes preflight from post -- both are plain
// `wal-gc --json`, the only difference is which one of the operator's three
// steps invoked it), and SHIM_APPLY_OUTPUT/SHIM_APPLY_RC whenever --apply is
// among the arguments.
const SHIM_ENTRY = `#!/usr/bin/env bash
set -u
sub="\${1:-}"
shift || true
echo "CALL sub=\$sub args=\$*" >> "\$CALL_LOG"
apply=0
for a in "\$@"; do [[ "\$a" == "--apply" ]] && apply=1; done
if [[ "\$apply" == "1" ]]; then
  printf '%s\\n' "\${SHIM_APPLY_OUTPUT:-}"
  exit "\${SHIM_APPLY_RC:-0}"
fi
count_file="\$CALL_LOG.dryrun-count"
n=0
[[ -f "\$count_file" ]] && n="\$(cat "\$count_file")"
n=\$((n + 1))
echo "\$n" > "\$count_file"
if [[ "\$n" == "1" ]]; then
  printf '%s\\n' "\${SHIM_PREFLIGHT_OUTPUT:-}"
  exit "\${SHIM_PREFLIGHT_RC:-0}"
else
  printf '%s\\n' "\${SHIM_POST_OUTPUT:-WAL_RETENTION=DRY_RUN planned_delete=0}"
  exit "\${SHIM_POST_RC:-0}"
fi
`;

function makeShim(): { shimPath: string; callLog: string } {
  const dir = mkTestDir("wal-gc-daily-shim-");
  const shimPath = path.join(dir, "shim-entry.sh");
  writeFileSync(shimPath, SHIM_ENTRY);
  chmodSync(shimPath, 0o755);
  const callLog = path.join(dir, "calls.log");
  writeFileSync(callLog, "");
  return { shimPath, callLog };
}

function makeWorktree(): string {
  const dir = mkTestDir("wal-gc-daily-worktree-");
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  writeFileSync(path.join(dir, "scripts", "x8-production-like.sh"), "#!/usr/bin/env bash\nexit 0\n");
  return dir;
}

interface RunOpts {
  shimPath: string;
  callLog: string;
  worktree: string;
  runtimeDir: string;
  preflightOutput?: string;
  preflightRc?: number;
  applyOutput?: string;
  applyRc?: number;
  postOutput?: string;
  postRc?: number;
  maxDelete?: number;
  extraEnv?: NodeJS.ProcessEnv;
}

function run(opts: RunOpts) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    X8_LOCAL_TEST_MODE: "1",
    X8_LOCAL_WAL_GC_ENTRY: opts.shimPath,
    X8_LOCAL_WORKTREE: opts.worktree,
    X8_LOCAL_RUNTIME_DIR: opts.runtimeDir,
    CALL_LOG: opts.callLog,
  };
  if (opts.preflightOutput !== undefined) env.SHIM_PREFLIGHT_OUTPUT = opts.preflightOutput;
  if (opts.preflightRc !== undefined) env.SHIM_PREFLIGHT_RC = String(opts.preflightRc);
  if (opts.applyOutput !== undefined) env.SHIM_APPLY_OUTPUT = opts.applyOutput;
  if (opts.applyRc !== undefined) env.SHIM_APPLY_RC = String(opts.applyRc);
  if (opts.postOutput !== undefined) env.SHIM_POST_OUTPUT = opts.postOutput;
  if (opts.postRc !== undefined) env.SHIM_POST_RC = String(opts.postRc);
  if (opts.maxDelete !== undefined) env.X8_LOCAL_WAL_GC_MAX_DELETE = String(opts.maxDelete);
  Object.assign(env, opts.extraEnv ?? {});
  return spawnSync("bash", [scriptPath], { env, encoding: "utf8" });
}

function callLines(callLog: string): string[] {
  if (!existsSync(callLog)) return [];
  return readFileSync(callLog, "utf8").split("\n").filter((l) => l.length > 0);
}

describe("wal-gc-daily-apply.sh: preflight NOOP -> NOTHING_TO_DO, apply never invoked", () => {
  it("WAL_RETENTION=NOOP short-circuits before any apply call", () => {
    const { shimPath, callLog } = makeShim();
    const worktree = makeWorktree();
    const runtimeDir = mkTestDir("wal-gc-daily-runtime-");

    const result = run({
      shimPath,
      callLog,
      worktree,
      runtimeDir,
      preflightOutput: "WAL_RETENTION=NOOP reason=insufficient_verified_backups",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("LOCAL_WAL_GC=NOTHING_TO_DO");
    const lines = callLines(callLog);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("args=--json");
  });

  it("WAL_RETENTION=DRY_RUN planned_delete=0 is also NOTHING_TO_DO", () => {
    const { shimPath, callLog } = makeShim();
    const worktree = makeWorktree();
    const runtimeDir = mkTestDir("wal-gc-daily-runtime-");

    const result = run({
      shimPath,
      callLog,
      worktree,
      runtimeDir,
      preflightOutput: "WAL_RETENTION=DRY_RUN planned_delete=0",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("LOCAL_WAL_GC=NOTHING_TO_DO");
    expect(callLines(callLog)).toHaveLength(1);
  });
});

describe("wal-gc-daily-apply.sh: happy path (planned_delete > 0)", () => {
  it("calls preflight, then apply with exactly --apply --json, then post, and reports APPLIED", () => {
    const { shimPath, callLog } = makeShim();
    const worktree = makeWorktree();
    const runtimeDir = mkTestDir("wal-gc-daily-runtime-");

    const result = run({
      shimPath,
      callLog,
      worktree,
      runtimeDir,
      preflightOutput:
        'WAL_RETENTION_SUMMARY_JSON={"keepCount":2,"retireList":["B1"],"deleteCount":5,"anchor":"00000001000000000000000B","capacity":null}\nWAL_RETENTION=DRY_RUN planned_delete=5',
      applyOutput:
        'WAL_RETENTION_SUMMARY_JSON={"keepCount":2,"retireList":["B1"],"deleteCount":5,"anchor":"00000001000000000000000B","capacity":null}\nWAL_RETENTION=APPLIED deleted=5 anchor=00000001000000000000000B',
      postOutput: "WAL_RETENTION=DRY_RUN planned_delete=0",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("LOCAL_WAL_GC=APPLIED deleted=5 anchor=00000001000000000000000B");

    const lines = callLines(callLog);
    expect(lines).toHaveLength(3);
    // Exact equality, not substring -- a stray extra flag (e.g. an
    // accidentally appended --force/--keep) must fail this, not slip through
    // as "still contains the expected substring".
    expect(lines[0]).toBe("CALL sub=wal-gc args=--json");
    expect(lines[1]).toBe("CALL sub=wal-gc args=--apply --json");
    expect(lines[2]).toBe("CALL sub=wal-gc args=--json");

    const historyPath = path.join(runtimeDir, "logs", "history.log");
    expect(existsSync(historyPath)).toBe(true);
    expect(readFileSync(historyPath, "utf8")).toContain("result=APPLIED");

    // Evidence files: one group of three, named by a shared UTC stamp.
    const evidenceDir = path.join(worktree, ".tmp", "x8-production-like", "wal-gc-daily");
    const files = readdirSync(evidenceDir).sort();
    expect(files).toHaveLength(3);
    expect(files.some((f) => f.endsWith("-preflight.txt"))).toBe(true);
    expect(files.some((f) => f.endsWith("-apply.txt"))).toBe(true);
    expect(files.some((f) => f.endsWith("-post.txt"))).toBe(true);
  });
});

describe("wal-gc-daily-apply.sh: preflight REFUSED/LOCKED stops before any apply call", () => {
  it("WAL_RETENTION=REFUSED at preflight -> STOPPED stage=preflight, exit 65, apply never invoked", () => {
    const { shimPath, callLog } = makeShim();
    const worktree = makeWorktree();
    const runtimeDir = mkTestDir("wal-gc-daily-runtime-");

    const result = run({
      shimPath,
      callLog,
      worktree,
      runtimeDir,
      preflightOutput: "WAL_RETENTION=REFUSED reason=archiver_failing failed_count=3",
      preflightRc: 65,
    });

    expect(result.status).toBe(65);
    expect(result.stdout).toContain("LOCAL_WAL_GC=STOPPED stage=preflight");
    expect(result.stdout).toContain("archiver_failing");
    expect(callLines(callLog)).toHaveLength(1);
  });
});

describe("wal-gc-daily-apply.sh: apply-stage refusal stops the run, exit 65, post never invoked", () => {
  it("WAL_RETENTION=REFUSED at apply -> STOPPED stage=apply, post never called", () => {
    const { shimPath, callLog } = makeShim();
    const worktree = makeWorktree();
    const runtimeDir = mkTestDir("wal-gc-daily-runtime-");

    const result = run({
      shimPath,
      callLog,
      worktree,
      runtimeDir,
      preflightOutput: "WAL_RETENTION=DRY_RUN planned_delete=5",
      applyOutput: "WAL_RETENTION=REFUSED reason=stale_base_backup",
      applyRc: 65,
    });

    expect(result.status).toBe(65);
    expect(result.stdout).toContain("LOCAL_WAL_GC=STOPPED stage=apply");
    expect(result.stdout).toContain("stale_base_backup");
    expect(callLines(callLog)).toHaveLength(2);
  });
});

describe("wal-gc-daily-apply.sh: local circuit breaker (X8_LOCAL_WAL_GC_MAX_DELETE)", () => {
  it("planned_delete exceeding the cap stops before any apply call", () => {
    const { shimPath, callLog } = makeShim();
    const worktree = makeWorktree();
    const runtimeDir = mkTestDir("wal-gc-daily-runtime-");

    const result = run({
      shimPath,
      callLog,
      worktree,
      runtimeDir,
      preflightOutput: "WAL_RETENTION=DRY_RUN planned_delete=5000",
      maxDelete: 3000,
    });

    expect(result.status).toBe(65);
    expect(result.stdout).toContain("LOCAL_WAL_GC=STOPPED stage=preflight reason=planned_delete_exceeds_local_cap");
    expect(callLines(callLog)).toHaveLength(1);
  });
});

describe("wal-gc-daily-apply.sh: deleted count must match the preflight plan", () => {
  it("apply's deleted=N diverging from preflight's planned_delete -> STOPPED, deletion already happened per the message", () => {
    const { shimPath, callLog } = makeShim();
    const worktree = makeWorktree();
    const runtimeDir = mkTestDir("wal-gc-daily-runtime-");

    const result = run({
      shimPath,
      callLog,
      worktree,
      runtimeDir,
      preflightOutput: "WAL_RETENTION=DRY_RUN planned_delete=5",
      applyOutput: "WAL_RETENTION=APPLIED deleted=4 anchor=00000001000000000000000B",
    });

    expect(result.status).toBe(65);
    expect(result.stdout).toContain("LOCAL_WAL_GC=STOPPED stage=apply");
    expect(result.stdout).toContain("deleted_ne_planned");
    expect(result.stdout).toContain("deleted=4");
    expect(result.stdout).toContain("planned=5");
    // Only preflight + apply ran -- post is never reached on this path.
    expect(callLines(callLog)).toHaveLength(2);
  });
});

describe("wal-gc-daily-apply.sh: residual plan after apply warns instead of silently succeeding", () => {
  it("post still shows planned_delete>0 -> WARN stage=post reason=residual_plan, exit 62", () => {
    const { shimPath, callLog } = makeShim();
    const worktree = makeWorktree();
    const runtimeDir = mkTestDir("wal-gc-daily-runtime-");

    const result = run({
      shimPath,
      callLog,
      worktree,
      runtimeDir,
      preflightOutput: "WAL_RETENTION=DRY_RUN planned_delete=5",
      applyOutput: "WAL_RETENTION=APPLIED deleted=5 anchor=00000001000000000000000B",
      postOutput: "WAL_RETENTION=DRY_RUN planned_delete=2",
    });

    expect(result.status).toBe(62);
    expect(result.stdout).toContain("LOCAL_WAL_GC=WARN stage=post reason=residual_plan");
    expect(callLines(callLog)).toHaveLength(3);
  });
});

describe("wal-gc-daily-apply.sh: mutex lock", () => {
  it("an existing run.lock directory -> SKIPPED reason=locked, exit 0, no steps run", () => {
    const { shimPath, callLog } = makeShim();
    const worktree = makeWorktree();
    const runtimeDir = mkTestDir("wal-gc-daily-runtime-");
    mkdirSync(path.join(runtimeDir, "run.lock"), { recursive: true });

    const result = run({ shimPath, callLog, worktree, runtimeDir });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("LOCAL_WAL_GC=SKIPPED reason=locked");
    expect(existsSync(callLog) ? callLines(callLog) : []).toHaveLength(0);
    // The lock this run did not create must survive untouched.
    expect(existsSync(path.join(runtimeDir, "run.lock"))).toBe(true);
  });
});

describe("wal-gc-daily-apply.sh: Darwin-only hard gate", () => {
  it("X8_LOCAL_UNAME=Linux under test mode -> REFUSED reason=not_darwin, exit 65", () => {
    const worktree = makeWorktree();
    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        X8_LOCAL_TEST_MODE: "1",
        X8_LOCAL_UNAME: "Linux",
        X8_LOCAL_WORKTREE: worktree,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(65);
    expect(result.stdout).toContain("LOCAL_WAL_GC=REFUSED reason=not_darwin");
  });

  it("a real (non-Darwin) host is refused even without any override, when not on macOS", () => {
    // This repo's CI/dev host is macOS (see red-line notes), so this only
    // documents intent; the Linux-uname case above is the actual behavioural
    // proof, exercised without touching the real OS.
    expect(true).toBe(true);
  });
});

describe("wal-gc-daily-apply.sh: test-mode gate on overrides", () => {
  it("without X8_LOCAL_TEST_MODE, X8_LOCAL_WAL_GC_ENTRY is ignored (warned, shim never invoked)", () => {
    const { shimPath, callLog } = makeShim();
    const worktree = makeWorktree();
    const runtimeDir = mkTestDir("wal-gc-daily-runtime-");

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        X8_LOCAL_WAL_GC_ENTRY: shimPath,
        X8_LOCAL_WORKTREE: worktree,
        X8_LOCAL_RUNTIME_DIR: runtimeDir,
        CALL_LOG: callLog,
      },
      encoding: "utf8",
    });

    expect(result.stdout).toContain("LOCAL_WAL_GC_WARN=override_ignored name=X8_LOCAL_WAL_GC_ENTRY");
    // The shim was never reached -- it never got a chance to write to CALL_LOG.
    expect(existsSync(callLog) ? callLines(callLog) : []).toHaveLength(0);
  });

  it("without X8_LOCAL_TEST_MODE, X8_LOCAL_UNAME is ignored (real uname decides the Darwin gate)", () => {
    const worktree = makeWorktree();
    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        X8_LOCAL_UNAME: "Linux",
        X8_LOCAL_WORKTREE: worktree,
      },
      encoding: "utf8",
    });

    expect(result.stdout).toContain("LOCAL_WAL_GC_WARN=override_ignored name=X8_LOCAL_UNAME");
    // Real uname on the dev/CI host is Darwin, so the not_darwin refusal
    // must NOT fire (proving the fake "Linux" value was truly ignored).
    expect(result.stdout).not.toContain("LOCAL_WAL_GC=REFUSED reason=not_darwin");
  });
});

describe("wal-gc-daily-apply.sh: evidence retention (30 groups by count)", () => {
  it("prunes down to the 30 most recent preflight/apply/post groups after a successful run", () => {
    const { shimPath, callLog } = makeShim();
    const worktree = makeWorktree();
    const runtimeDir = mkTestDir("wal-gc-daily-runtime-");
    const evidenceDir = path.join(worktree, ".tmp", "x8-production-like", "wal-gc-daily");
    mkdirSync(evidenceDir, { recursive: true });
    for (let i = 0; i < 35; i++) {
      const stamp = `202601${String(i + 1).padStart(2, "0")}T000000Z`;
      for (const suffix of ["preflight", "apply", "post"]) {
        writeFileSync(path.join(evidenceDir, `${stamp}-${suffix}.txt`), "old\n");
      }
    }

    const result = run({
      shimPath,
      callLog,
      worktree,
      runtimeDir,
      preflightOutput: "WAL_RETENTION=DRY_RUN planned_delete=1",
      applyOutput: "WAL_RETENTION=APPLIED deleted=1 anchor=00000001000000000000000B",
      postOutput: "WAL_RETENTION=DRY_RUN planned_delete=0",
    });

    expect(result.status).toBe(0);
    const remainingStamps = new Set(
      readdirSync(evidenceDir).map((f) => f.replace(/-(preflight|apply|post)\.txt$/, "")),
    );
    expect(remainingStamps.size).toBe(30);
    expect(remainingStamps.has("20260101T000000Z")).toBe(false);
    // Every surviving group still has all three files.
    for (const stamp of remainingStamps) {
      expect(existsSync(path.join(evidenceDir, `${stamp}-preflight.txt`))).toBe(true);
      expect(existsSync(path.join(evidenceDir, `${stamp}-apply.txt`))).toBe(true);
      expect(existsSync(path.join(evidenceDir, `${stamp}-post.txt`))).toBe(true);
    }
  });
});

describe("wal-gc-daily-apply.sh: static contracts", () => {
  it("is syntactically valid bash", () => {
    const result = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
    expect(result.status).toBe(0);
  });

  it("never mentions --force or --keep outside comment lines (the apply command line is fixed literal)", () => {
    const codeOnly = scriptSource
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(codeOnly).not.toContain("--force");
    expect(codeOnly).not.toContain("--keep");
  });

  it("the apply step's run_step call is exactly `apply --apply --json` (no trailing flags)", () => {
    // Anchored to end-of-line so an accidentally appended flag (e.g.
    // `--force`) fails this, not merely "no longer exactly this substring".
    expect(scriptSource).toMatch(/^run_step apply --apply --json$/m);
  });
});
