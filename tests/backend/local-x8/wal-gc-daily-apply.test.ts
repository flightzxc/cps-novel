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
    // Opus review fixup 2026-09-18 (P2-5): history.log's result token must
    // say "before delete" -- preflight is always a dry-run, nothing was
    // ever touched.
    const historyPath = path.join(runtimeDir, "logs", "history.log");
    expect(readFileSync(historyPath, "utf8")).toContain("result=STOPPED_BEFORE_DELETE");
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
    // Opus review fixup 2026-09-18 (P2-5): a REFUSED apply response means
    // wal-retention.sh refused before its own delete step ever ran.
    const historyPath = path.join(runtimeDir, "logs", "history.log");
    expect(readFileSync(historyPath, "utf8")).toContain("result=STOPPED_BEFORE_DELETE");
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
    // Opus review fixup 2026-09-18 (P2-5): WAL_RETENTION=APPLIED was already
    // printed by the (shimmed) apply step before this mismatch is even
    // noticed -- the delete already happened, so history must say AFTER,
    // not BEFORE.
    const historyPath = path.join(runtimeDir, "logs", "history.log");
    expect(readFileSync(historyPath, "utf8")).toContain("result=STOPPED_AFTER_DELETE");
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
    // Opus review fixup 2026-09-18 (P2-5): apply already succeeded by the
    // time post's residual plan is noticed -- the delete already happened.
    const historyPath = path.join(runtimeDir, "logs", "history.log");
    expect(readFileSync(historyPath, "utf8")).toContain("result=WARN_AFTER_DELETE reason=residual_plan");
  });
});

// Opus review fixup 2026-09-18 (P2-4): post-stage REFUSED/LOCKED/non-zero
// exit is a DIFFERENT failure from "there is still a residual plan" (the
// describe block directly above) and must be reported/logged as such, not
// silently folded into "residual_plan".
describe("wal-gc-daily-apply.sh: post-stage refusal after a successful apply (P2-4)", () => {
  it("post output WAL_RETENTION=REFUSED -> WARN stage=post reason=<original line>, exit 62, history WARN_AFTER_DELETE", () => {
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
      postOutput: "WAL_RETENTION=REFUSED reason=archiver_failing failed_count=1",
    });

    expect(result.status).toBe(62);
    expect(result.stdout).toContain("LOCAL_WAL_GC=WARN stage=post");
    expect(result.stdout).toContain("archiver_failing");
    expect(result.stdout).not.toContain("residual_plan");
    expect(callLines(callLog)).toHaveLength(3);
    const historyPath = path.join(runtimeDir, "logs", "history.log");
    expect(readFileSync(historyPath, "utf8")).toContain("result=WARN_AFTER_DELETE");
  });

  it("post command exits non-zero with no recognizable token -> WARN stage=post reason=post_command_exit_N, exit 62", () => {
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
      postOutput: "some unexpected crash output",
      postRc: 13,
    });

    expect(result.status).toBe(62);
    expect(result.stdout).toContain("LOCAL_WAL_GC=WARN stage=post");
    expect(result.stdout).toContain("post_command_exit_13");
    expect(result.stdout).not.toContain("residual_plan");
    expect(callLines(callLog)).toHaveLength(3);
    const historyPath = path.join(runtimeDir, "logs", "history.log");
    expect(readFileSync(historyPath, "utf8")).toContain("result=WARN_AFTER_DELETE");
  });
});

// Opus review fixup 2026-09-18 (P2-3): anchor extraction no longer shells
// out to `node -e` -- these prove the fallback path (no
// WAL_RETENTION_SUMMARY_JSON at all) and the no-Node-on-PATH path both still
// reach APPLIED.
describe("wal-gc-daily-apply.sh: anchor parsing has no Node runtime dependency (P2-3)", () => {
  it("apply output with no WAL_RETENTION_SUMMARY_JSON at all -> still APPLIED, anchor=UNKNOWN, history recorded", () => {
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
      postOutput: "WAL_RETENTION=DRY_RUN planned_delete=0",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("LOCAL_WAL_GC=APPLIED deleted=5 anchor=UNKNOWN");
    const historyPath = path.join(runtimeDir, "logs", "history.log");
    expect(readFileSync(historyPath, "utf8")).toContain("result=APPLIED");
  });

  it("a PATH with no node binary (only /bin:/usr/bin) still reaches APPLIED end to end", () => {
    const { shimPath, callLog } = makeShim();
    const worktree = makeWorktree();
    const runtimeDir = mkTestDir("wal-gc-daily-runtime-");

    // This repo's dev/CI host keeps node under /usr/local/bin (Homebrew) or
    // an nvm path, never under /bin or /usr/bin -- so restricting PATH to
    // exactly those two directories is a real, portable "no node anywhere
    // on PATH" environment on macOS, not a hand-picked fake. It still needs
    // to be a WORKING PATH for the script's own coreutils (mkdir, date,
    // find, sed, sort, rm, grep, cut, git, and bash itself, since the shim's
    // #!/usr/bin/env bash shebang resolves "bash" via this same PATH) --
    // literally shipping only 4 binaries would fail for reasons unrelated to
    // the thing this test exists to prove.
    const result = run({
      shimPath,
      callLog,
      worktree,
      runtimeDir,
      preflightOutput: "WAL_RETENTION=DRY_RUN planned_delete=5",
      applyOutput: "WAL_RETENTION=APPLIED deleted=5 anchor=00000001000000000000000B",
      postOutput: "WAL_RETENTION=DRY_RUN planned_delete=0",
      extraEnv: { PATH: "/bin:/usr/bin" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("LOCAL_WAL_GC=APPLIED deleted=5 anchor=UNKNOWN");
    const historyPath = path.join(runtimeDir, "logs", "history.log");
    expect(readFileSync(historyPath, "utf8")).toContain("result=APPLIED");
  });
});

// Opus review fixup 2026-09-18 (P2-9): additional branch coverage the
// original test suite was missing.
describe("wal-gc-daily-apply.sh: additional branch coverage (P2-9)", () => {
  it("apply output WAL_RETENTION_WARN=reconcile_mismatch -> STOPPED_AFTER_DELETE, post never invoked, exit 65", () => {
    const { shimPath, callLog } = makeShim();
    const worktree = makeWorktree();
    const runtimeDir = mkTestDir("wal-gc-daily-runtime-");

    const result = run({
      shimPath,
      callLog,
      worktree,
      runtimeDir,
      preflightOutput: "WAL_RETENTION=DRY_RUN planned_delete=5",
      applyOutput: "WAL_RETENTION_WARN=reconcile_mismatch deleted=3 planned=5",
      applyRc: 62,
    });

    expect(result.status).toBe(65);
    expect(result.stdout).toContain("LOCAL_WAL_GC=STOPPED stage=apply");
    expect(result.stdout).toContain("reconcile_mismatch");
    // Only preflight + apply ran -- post must never be invoked once the
    // archive is in this (potentially inconsistent) state.
    expect(callLines(callLog)).toHaveLength(2);
    const historyPath = path.join(runtimeDir, "logs", "history.log");
    expect(readFileSync(historyPath, "utf8")).toContain("result=STOPPED_AFTER_DELETE");
  });

  it("P1_12_COMPOSE_PROJECT=other -> REFUSED reason=not_local_project, before any call, history REFUSED", () => {
    const { shimPath, callLog } = makeShim();
    const worktree = makeWorktree();
    const runtimeDir = mkTestDir("wal-gc-daily-runtime-");

    const result = run({
      shimPath,
      callLog,
      worktree,
      runtimeDir,
      extraEnv: { P1_12_COMPOSE_PROJECT: "other" },
    });

    expect(result.status).toBe(65);
    expect(result.stdout).toContain("LOCAL_WAL_GC=REFUSED reason=not_local_project");
    expect(existsSync(callLog) ? callLines(callLog) : []).toHaveLength(0);
    const historyPath = path.join(runtimeDir, "logs", "history.log");
    expect(readFileSync(historyPath, "utf8")).toContain("result=REFUSED reason=not_local_project");
  });

  it("a relative X8_LOCAL_WORKTREE -> REFUSED reason=x8_local_worktree_not_absolute, history REFUSED", () => {
    const { callLog } = makeShim();
    const runtimeDir = mkTestDir("wal-gc-daily-runtime-");

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        X8_LOCAL_TEST_MODE: "1",
        X8_LOCAL_WORKTREE: "relative/worktree/path",
        X8_LOCAL_RUNTIME_DIR: runtimeDir,
        CALL_LOG: callLog,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(65);
    expect(result.stdout).toContain("LOCAL_WAL_GC=REFUSED reason=x8_local_worktree_not_absolute");
    const historyPath = path.join(runtimeDir, "logs", "history.log");
    expect(readFileSync(historyPath, "utf8")).toContain(
      "result=REFUSED reason=x8_local_worktree_not_absolute",
    );
  });

  it("preflight output that is unparseable (no REFUSED/NOOP/DRY_RUN token) -> STOPPED, apply never invoked", () => {
    const { shimPath, callLog } = makeShim();
    const worktree = makeWorktree();
    const runtimeDir = mkTestDir("wal-gc-daily-runtime-");

    const result = run({
      shimPath,
      callLog,
      worktree,
      runtimeDir,
      preflightOutput: "some garbage output with no recognizable token",
    });

    expect(result.status).toBe(65);
    expect(result.stdout).toContain("LOCAL_WAL_GC=STOPPED stage=preflight reason=unparseable_preflight_output");
    expect(callLines(callLog)).toHaveLength(1);
    const historyPath = path.join(runtimeDir, "logs", "history.log");
    expect(readFileSync(historyPath, "utf8")).toContain("result=STOPPED_BEFORE_DELETE");
  });

  it("apply command exits rc=125 with no recognizable token -> STOPPED, reason=apply_command_exit_125", () => {
    const { shimPath, callLog } = makeShim();
    const worktree = makeWorktree();
    const runtimeDir = mkTestDir("wal-gc-daily-runtime-");

    const result = run({
      shimPath,
      callLog,
      worktree,
      runtimeDir,
      preflightOutput: "WAL_RETENTION=DRY_RUN planned_delete=5",
      applyOutput: "some unexpected crash output with no token",
      applyRc: 125,
    });

    expect(result.status).toBe(65);
    expect(result.stdout).toContain("LOCAL_WAL_GC=STOPPED stage=apply reason=\"apply_command_exit_125\"");
    expect(callLines(callLog)).toHaveLength(2);
    const historyPath = path.join(runtimeDir, "logs", "history.log");
    expect(readFileSync(historyPath, "utf8")).toContain("result=STOPPED_AFTER_DELETE");
  });
});

// Opus review fixup 2026-09-18 (P2-6): evidence pruning used to only run on
// the two success exit paths (NOTHING_TO_DO / APPLIED) -- a STOPPED/WARN run
// left its own evidence group behind without ever counting toward, or being
// trimmed by, the 30-group cap.
describe("wal-gc-daily-apply.sh: evidence pruning also runs on STOPPED/WARN exit paths (P2-6)", () => {
  it("35 pre-existing evidence groups + one STOPPED run -> pruned down to 30", () => {
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
      preflightOutput: "WAL_RETENTION=REFUSED reason=archiver_failing failed_count=1",
    });

    expect(result.status).toBe(65);
    const remainingStamps = new Set(
      readdirSync(evidenceDir).map((f) => f.replace(/-(preflight|apply|post)\.txt$/, "")),
    );
    expect(remainingStamps.size).toBe(30);
    expect(remainingStamps.has("20260101T000000Z")).toBe(false);
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
    // Opus review fixup 2026-09-18 (P2-5): a SKIPPED run now also leaves a
    // history.log trace (previously it left none at all).
    const historyPath = path.join(runtimeDir, "logs", "history.log");
    expect(existsSync(historyPath)).toBe(true);
    expect(readFileSync(historyPath, "utf8")).toContain("result=SKIPPED reason=locked");
  });
});

describe("wal-gc-daily-apply.sh: Darwin-only hard gate", () => {
  it("X8_LOCAL_UNAME=Linux under test mode -> REFUSED reason=not_darwin, exit 65, history logs REFUSED", () => {
    const worktree = makeWorktree();
    // Opus review fixup 2026-09-18 (P2-8/P2-13): runtime dir creation +
    // history.log now happen before this hard gate runs (P2-13), so this
    // spawn -- like every other one in this file -- must pin
    // X8_LOCAL_RUNTIME_DIR to a throwaway directory. Without it, this test
    // would touch the real default (~/Library/Application
    // Support/CPSNovelX8WalGc) on every run, which is exactly the test
    // pollution this work order's own audit found sitting in that real
    // directory.
    const runtimeDir = mkTestDir("wal-gc-daily-runtime-");
    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        X8_LOCAL_TEST_MODE: "1",
        X8_LOCAL_UNAME: "Linux",
        X8_LOCAL_WORKTREE: worktree,
        X8_LOCAL_RUNTIME_DIR: runtimeDir,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(65);
    expect(result.stdout).toContain("LOCAL_WAL_GC=REFUSED reason=not_darwin");
    const historyPath = path.join(runtimeDir, "logs", "history.log");
    expect(existsSync(historyPath)).toBe(true);
    expect(readFileSync(historyPath, "utf8")).toContain("result=REFUSED reason=not_darwin");
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
    // Opus review fixup 2026-09-18 (P2-8): this run is NOT in test mode, so
    // it proceeds past every hard gate on the real host (Darwin) and all
    // the way into run_step, which -- since X8_LOCAL_WAL_GC_ENTRY is also
    // not honored outside test mode -- actually execs the fake worktree's
    // stub scripts/x8-production-like.sh. Real runtime dir isolation matters
    // even more here than in the gate-only tests above.
    const runtimeDir = mkTestDir("wal-gc-daily-runtime-");
    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        X8_LOCAL_UNAME: "Linux",
        X8_LOCAL_WORKTREE: worktree,
        X8_LOCAL_RUNTIME_DIR: runtimeDir,
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

// Opus review fixup 2026-09-18 (P2-8): this SUT's runtime dir is
// `$HOME/Library/Application Support/CPSNovelX8WalGc` by default -- any
// spawnSync of this script in THIS test file that forgets to override
// X8_LOCAL_RUNTIME_DIR touches that real directory on the machine running
// the suite (exactly the pollution this work order's own audit found sitting
// there). This self-check statically proves every spawnSync call site in
// this very file, and the one `run()` helper function every other test case
// goes through, mentions X8_LOCAL_RUNTIME_DIR somewhere in its own body --
// it cannot prove the VALUE is a real throwaway directory (that is what the
// individual tests' own runtimeDir/mkTestDir usage is for), only that no
// call site can compile while omitting the override entirely.
describe("wal-gc-daily-apply.test.ts: self-check (every spawnSync call sets X8_LOCAL_RUNTIME_DIR)", () => {
  const selfPath = path.resolve(root, "tests/backend/local-x8/wal-gc-daily-apply.test.ts");
  const selfSource = readFileSync(selfPath, "utf8");

  // Extracts the source text of a brace-delimited block starting at the
  // first "{" at or after `fromIdx`, balancing nested braces (a plain regex
  // cannot do this correctly for arbitrarily nested TS object/function
  // bodies).
  function extractBraceBlock(source: string, fromIdx: number): string {
    const start = source.indexOf("{", fromIdx);
    if (start === -1) throw new Error("no opening brace found");
    let depth = 0;
    for (let i = start; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
    throw new Error("unbalanced braces");
  }

  it("every it(...)/it.each(...) callback body containing spawnSync( also mentions X8_LOCAL_RUNTIME_DIR", () => {
    const itCallRegex = /\bit(?:\.each\([\s\S]*?\))?\(\s*["'`]/g;
    let match: RegExpExecArray | null;
    let checked = 0;
    while ((match = itCallRegex.exec(selfSource)) !== null) {
      const block = extractBraceBlock(selfSource, match.index);
      // `bash -n <script>` is a syntax-only check -- it never executes the
      // script (nothing is spawned/run), so there is no runtime dir to
      // pollute and no X8_LOCAL_RUNTIME_DIR override is meaningful here.
      const isSyntaxCheckOnly = /spawnSync\(\s*"bash",\s*\["-n"/.test(block);
      if (block.includes("spawnSync(") && !isSyntaxCheckOnly) {
        checked++;
        const nameEnd = selfSource.indexOf("\n", match.index);
        const testName = selfSource.slice(match.index, Math.min(nameEnd, match.index + 120));
        expect(block, `test starting "${testName.trim()}..." calls spawnSync without X8_LOCAL_RUNTIME_DIR`).toContain(
          "X8_LOCAL_RUNTIME_DIR",
        );
      }
    }
    // A regression that deleted every raw spawnSync from this file (leaving
    // only the run() helper's internal call, which this test checks
    // separately below) would make this loop check nothing and the test
    // would pass vacuously -- guard against that.
    expect(checked).toBeGreaterThan(0);
  });

  it("the run() helper function body itself mentions both spawnSync( and X8_LOCAL_RUNTIME_DIR", () => {
    const fnIdx = selfSource.indexOf("function run(opts: RunOpts)");
    expect(fnIdx).toBeGreaterThanOrEqual(0);
    const block = extractBraceBlock(selfSource, fnIdx);
    expect(block).toContain("spawnSync(");
    expect(block).toContain("X8_LOCAL_RUNTIME_DIR");
  });
});
