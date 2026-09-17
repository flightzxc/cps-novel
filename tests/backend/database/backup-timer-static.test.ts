import { execFileSync, spawnSync } from "node:child_process";
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

// Gate 5-Dev: infra/production-like/backup-timer.sh's run_backup() expanded
// from one step (logical backup) to four (logical backup -> physical base
// backup -> its verification -> a read-only wal-gc-x8.sh dry-run plan). This
// file covers both the static contract (the four step tokens exist in the
// right order, wal-gc-x8.sh is never invoked with an apply flag) and the
// runtime behaviour of the physical-backup skip/create decision, via PATH-
// independent env overrides (X8_TIMER_SCRIPT_DIR/X8_TIMER_BASE_BACKUP_DIR/
// X8_TIMER_STATE_DIR/X8_TIMER_LOGICAL_BACKUP_SCRIPT) that only a test ever
// sets -- the real compose wiring never passes any of them, so production
// always gets the hard-coded in-container defaults.
const root = process.cwd();
const scriptPath = path.resolve(root, "infra/production-like/backup-timer.sh");
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

describe("backup-timer.sh: static contracts (Gate 5-Dev four-step loop)", () => {
  it("is syntactically valid bash", () => {
    execFileSync("bash", ["-n", scriptPath]);
  });

  it("declares the four BACKUP_TIMER_STEP tokens in order, and never invokes wal-gc-x8.sh with an apply flag", () => {
    const idx1 = scriptSource.indexOf("BACKUP_TIMER_STEP=1_LOGICAL_BACKUP");
    const idx2 = scriptSource.indexOf("BACKUP_TIMER_STEP=2_PHYSICAL_BASE_BACKUP");
    const idx3 = scriptSource.indexOf("BACKUP_TIMER_STEP=3_PHYSICAL_BASE_VERIFY");
    const idx4 = scriptSource.indexOf("BACKUP_TIMER_STEP=4_WAL_GC_DRY_RUN");
    expect(idx1).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(idx1);
    expect(idx3).toBeGreaterThan(idx2);
    expect(idx4).toBeGreaterThan(idx3);

    // The whole file, not just the wal-gc-x8.sh call site: this is a
    // deliberately blunt guard against ever reintroducing a real apply run
    // into the unattended daily loop, however indirectly.
    expect(scriptSource).not.toContain("--apply");
  });

  it("defaults X8_BASE_BACKUP_MIN_INTERVAL_SECONDS to 72000 and declares the SKIPPED_RECENT/DISABLED/SKIPPED tokens", () => {
    expect(scriptSource).toContain("X8_BASE_BACKUP_MIN_INTERVAL_SECONDS:=72000");
    expect(scriptSource).toContain("SKIPPED_RECENT");
    expect(scriptSource).toContain("PHYSICAL_BASE_BACKUP=DISABLED");
    expect(scriptSource).toContain("PHYSICAL_BASE_VERIFY=SKIPPED");
  });

  // Gate 5 review fix (P1-2): --logical-only stops run_backup() after step 1.
  it("declares --logical-only and the BACKUP_TIMER_MODE=logical_only token, gated on the same flag the argument parser sets", () => {
    expect(scriptSource).toContain("--logical-only");
    expect(scriptSource).toContain("BACKUP_TIMER_MODE=logical_only");
    expect(scriptSource).toMatch(/BACKUP_TIMER_LOGICAL_ONLY:-false.*==.*true/);
  });

  // Gate 5 review fix (env-override gate, "Opus 建议"): compose must never
  // set X8_TIMER_TEST_MODE -- it is the switch that lets the X8_TIMER_*
  // family (script dir / base-backup dir / state dir / logical-backup
  // script path / max cycles) actually redirect run_backup(), and it exists
  // ONLY for this test file.
  it("compose and the env helper never set X8_TIMER_TEST_MODE", () => {
    const compose = readFileSync(path.resolve(root, "infra/production-like/docker-compose.yml"), "utf8");
    const envHelper = readFileSync(path.resolve(root, "scripts/lib/x8-production-like-env.sh"), "utf8");
    expect(compose).not.toContain("X8_TIMER_TEST_MODE");
    expect(envHelper).not.toContain("X8_TIMER_TEST_MODE");
  });

  it("gates every X8_TIMER_* override behind X8_TIMER_TEST_MODE, warning override_ignored otherwise", () => {
    expect(scriptSource).toContain("x8_timer_apply_override");
    expect(scriptSource).toContain("BACKUP_TIMER_WARN=override_ignored name=${var_name}");
    expect(scriptSource).toContain('X8_TIMER_TEST_MODE:-0}" == "1"');
    for (const varName of [
      "X8_TIMER_SCRIPT_DIR",
      "X8_TIMER_BASE_BACKUP_DIR",
      "X8_TIMER_STATE_DIR",
      "X8_TIMER_LOGICAL_BACKUP_SCRIPT",
      "X8_TIMER_MAX_CYCLES",
    ]) {
      expect(scriptSource).toContain(`x8_timer_apply_override ${varName} `);
    }
  });
});

// ---- behaviour: the physical-backup skip/create decision, via shims -------

function writeShim(filePath: string, content: string): void {
  writeFileSync(filePath, content);
  chmodSync(filePath, 0o755);
}

interface ShimOptions {
  physicalExit?: number;
  verifyExit?: number;
  walgcOutput?: string;
  walgcExit?: number;
}

function makeShims(opts: ShimOptions = {}): {
  scriptDir: string;
  logicalScript: string;
  callLog: string;
} {
  const scriptDir = mkTestDir("backup-timer-scripts-");
  const logicalScript = path.join(mkTestDir("backup-timer-logical-"), "backup-logical.sh");
  const callLog = path.join(mkTestDir("backup-timer-callog-"), "calls.log");
  writeFileSync(callLog, "");

  writeShim(
    logicalScript,
    `#!/usr/bin/env bash\nset -u\necho "logical $*" >> "${callLog}"\necho "LOGICAL_BACKUP=PASS"\nexit 0\n`,
  );
  writeShim(
    path.join(scriptDir, "backup-physical-base.sh"),
    `#!/usr/bin/env bash\nset -u\necho "physical $*" >> "${callLog}"\necho "PHYSICAL_BASE_BACKUP=CREATED_NOT_PITR_VALIDATED"\nexit ${opts.physicalExit ?? 0}\n`,
  );
  writeShim(
    path.join(scriptDir, "verify-physical-base.sh"),
    `#!/usr/bin/env bash\nset -u\necho "verify $*" >> "${callLog}"\necho "PHYSICAL_BASE_VERIFY=PASS"\nexit ${opts.verifyExit ?? 0}\n`,
  );
  const walgcOutput = opts.walgcOutput ?? "WAL_RETENTION=DRY_RUN planned_delete=0";
  writeShim(
    path.join(scriptDir, "wal-gc-x8.sh"),
    `#!/usr/bin/env bash\nset -u\necho "walgc $*" >> "${callLog}"\necho "${walgcOutput}"\nexit ${opts.walgcExit ?? 0}\n`,
  );

  return { scriptDir, logicalScript, callLog };
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

function runOnce(
  shims: { scriptDir: string; logicalScript: string },
  extraEnv: NodeJS.ProcessEnv,
  dirs: { baseBackupDir: string; stateDir: string; outputDir: string },
  extraArgs: string[] = [],
) {
  const pgpassSource = path.join(mkTestDir("backup-timer-pgpass-"), "backup.pgpass");
  writeFileSync(pgpassSource, "*:*:*:backup_role:drill\n");

  return spawnSync("bash", [scriptPath, "--once", ...extraArgs], {
    env: {
      ...process.env,
      X8_BACKUP_OUTPUT_DIR: dirs.outputDir,
      X8_BACKUP_PGPASS_SOURCE: pgpassSource,
      X8_TIMER_SCRIPT_DIR: shims.scriptDir,
      X8_TIMER_BASE_BACKUP_DIR: dirs.baseBackupDir,
      X8_TIMER_STATE_DIR: dirs.stateDir,
      X8_TIMER_LOGICAL_BACKUP_SCRIPT: shims.logicalScript,
      // Gate 5 review fix (env-override gate): every X8_TIMER_* override
      // above only takes effect when this is "1" -- every existing
      // behaviour test in this file relies on the shims actually being
      // used, so they all need it set. Tests exercising the *ungated*
      // (production) path override this back out explicitly.
      X8_TIMER_TEST_MODE: "1",
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

describe("backup-timer.sh --once: physical base-backup skip/create decision (Gate 5-Dev)", () => {
  it("a recent VERIFIED backup (10min old, default 72000s min-interval) -> SKIPPED_RECENT, physical/verify never called, both markers touched", () => {
    const shims = makeShims();
    const baseBackupDir = mkTestDir("backup-timer-basebackups-");
    const stateDir = mkTestDir("backup-timer-state-");
    const outputDir = mkTestDir("backup-timer-output-");
    writeVerifiedBackup(baseBackupDir, "20260917T035414Z", 600);

    const result = runOnce(shims, {}, { baseBackupDir, stateDir, outputDir });

    expect(result.status).toBe(0);
    const callLog = readFileSync(shims.callLog, "utf8");
    expect(callLog).not.toContain("physical ");
    expect(callLog).not.toContain("verify ");
    expect(callLog).toContain("walgc ");
    // wal-gc-x8.sh is invoked with only --json -- never an apply flag.
    const walgcLine = callLog.split("\n").find((l) => l.startsWith("walgc "));
    expect(walgcLine).toBeDefined();
    expect(walgcLine).not.toContain("--apply");

    expect(result.stdout).toContain("PHYSICAL_BASE_BACKUP=SKIPPED_RECENT");
    expect(existsSync(path.join(stateDir, "x8-backup-last-success"))).toBe(true);
    expect(existsSync(path.join(stateDir, "x8-base-backup-last-success"))).toBe(true);
  });

  it("a stale VERIFIED backup (25h old, older than default 72000s=20h min-interval) -> CREATED, physical+verify both called", () => {
    const shims = makeShims();
    const baseBackupDir = mkTestDir("backup-timer-basebackups-");
    const stateDir = mkTestDir("backup-timer-state-");
    const outputDir = mkTestDir("backup-timer-output-");
    writeVerifiedBackup(baseBackupDir, "20260916T000000Z", 90000);

    const result = runOnce(shims, {}, { baseBackupDir, stateDir, outputDir });

    expect(result.status).toBe(0);
    const callLog = readFileSync(shims.callLog, "utf8");
    expect(callLog).toContain("physical ");
    expect(callLog).toContain("verify ");
    expect(result.stdout).toContain("PHYSICAL_BASE_BACKUP=CREATED_NOT_PITR_VALIDATED");
    expect(result.stdout).toContain("PHYSICAL_BASE_VERIFY=PASS");
    expect(existsSync(path.join(stateDir, "x8-backup-last-success"))).toBe(true);
    expect(existsSync(path.join(stateDir, "x8-base-backup-last-success"))).toBe(true);
  });

  it("X8_BACKUP_PHYSICAL_ENABLED=false -> DISABLED, physical/verify never called, the base-backup marker is NOT touched", () => {
    const shims = makeShims();
    const baseBackupDir = mkTestDir("backup-timer-basebackups-");
    const stateDir = mkTestDir("backup-timer-state-");
    const outputDir = mkTestDir("backup-timer-output-");

    const result = runOnce(
      shims,
      { X8_BACKUP_PHYSICAL_ENABLED: "false" },
      { baseBackupDir, stateDir, outputDir },
    );

    expect(result.status).toBe(0);
    const callLog = readFileSync(shims.callLog, "utf8");
    expect(callLog).not.toContain("physical ");
    expect(callLog).not.toContain("verify ");
    expect(result.stdout).toContain("PHYSICAL_BASE_BACKUP=DISABLED");
    expect(result.stdout).toContain("PHYSICAL_BASE_VERIFY=SKIPPED");
    expect(existsSync(path.join(stateDir, "x8-backup-last-success"))).toBe(true);
    expect(existsSync(path.join(stateDir, "x8-base-backup-last-success"))).toBe(false);
  });

  it("a WAL_RETENTION=REFUSED wal-gc-x8.sh plan fails the whole run (non-zero exit), but the logical-backup marker is still touched", () => {
    const shims = makeShims({
      walgcOutput: "WAL_RETENTION=REFUSED reason=x",
      walgcExit: 65,
    });
    const baseBackupDir = mkTestDir("backup-timer-basebackups-");
    const stateDir = mkTestDir("backup-timer-state-");
    const outputDir = mkTestDir("backup-timer-output-");

    const result = runOnce(
      shims,
      { X8_BACKUP_PHYSICAL_ENABLED: "false" },
      { baseBackupDir, stateDir, outputDir },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("WAL_RETENTION=REFUSED reason=x");
    // Step 1 already succeeded before step 4 failed -- its marker survives.
    expect(existsSync(path.join(stateDir, "x8-backup-last-success"))).toBe(true);
  });

  // Gate 5 review fix (P2): a VERIFIED marker missing (or with a malformed)
  // verified_epoch line is treated as "no valid backup" -- same fail-safe
  // direction as before -- but now warns about it instead of silently
  // skipping, so an operator can tell WHY a directory was never eligible as
  // the anchor.
  it("a VERIFIED marker with no valid verified_epoch line is treated as no valid backup and warns", () => {
    const shims = makeShims();
    const baseBackupDir = mkTestDir("backup-timer-basebackups-malformed-");
    const stateDir = mkTestDir("backup-timer-state-malformed-");
    const outputDir = mkTestDir("backup-timer-output-malformed-");
    const dirName = "20260917T035414Z";
    const dir = path.join(baseBackupDir, dirName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "VERIFIED"), "verified_at=2026-09-17T00:00:00Z\nmanifest_sha256=deadbeef\n");

    const result = runOnce(shims, {}, { baseBackupDir, stateDir, outputDir });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`BACKUP_TIMER_WARN=verified_malformed name=${dirName}`);
    // Treated as "no valid backup" -- a fresh physical backup is taken, not
    // skipped as if the malformed marker were a valid recent one.
    expect(result.stdout).toContain("PHYSICAL_BASE_BACKUP=CREATED_NOT_PITR_VALIDATED");
    const callLog = readFileSync(shims.callLog, "utf8");
    expect(callLog).toContain("physical ");
  });
});

// Gate 5 review fix (F-3): BACKUP_TIMER_LOGICAL_ONLY must never drift in
// from the environment -- only --logical-only on the command line may set
// it. Before this fix, run_backup() read `${BACKUP_TIMER_LOGICAL_ONLY:-false}`
// with no unconditional reset first, so a stray BACKUP_TIMER_LOGICAL_ONLY=true
// already present in the process environment (an operator's shell, a leaked
// env file, compose env-file inheritance) would silently short-circuit
// every --once/run-on-start/loop invocation into logical-only mode with no
// flag on the command line to explain why.
describe("backup-timer.sh --once: BACKUP_TIMER_LOGICAL_ONLY must not drift in from the environment (Gate 5 review fix F-3)", () => {
  it("BACKUP_TIMER_LOGICAL_ONLY=true in the environment, without --logical-only on the command line, is ignored -- all four steps still run", () => {
    const shims = makeShims();
    const baseBackupDir = mkTestDir("backup-timer-basebackups-f3-");
    const stateDir = mkTestDir("backup-timer-state-f3-");
    const outputDir = mkTestDir("backup-timer-output-f3-");

    const result = runOnce(
      shims,
      { BACKUP_TIMER_LOGICAL_ONLY: "true" },
      { baseBackupDir, stateDir, outputDir },
    );

    expect(result.status).toBe(0);
    const callLog = readFileSync(shims.callLog, "utf8");
    expect(callLog).toContain("physical ");
    expect(callLog).toContain("verify ");
    expect(callLog).toContain("walgc ");
    expect(result.stdout).not.toContain("BACKUP_TIMER_MODE=logical_only");
  });
});

describe("backup-timer.sh --once --logical-only (Gate 5 review fix P1-2)", () => {
  it("runs only the logical-backup step, prints BACKUP_TIMER_MODE=logical_only, and touches only the logical marker", () => {
    const shims = makeShims();
    const baseBackupDir = mkTestDir("backup-timer-basebackups-logical-only-");
    const stateDir = mkTestDir("backup-timer-state-logical-only-");
    const outputDir = mkTestDir("backup-timer-output-logical-only-");

    const result = runOnce(shims, {}, { baseBackupDir, stateDir, outputDir }, ["--logical-only"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("BACKUP_TIMER_MODE=logical_only");
    const callLog = readFileSync(shims.callLog, "utf8");
    expect(callLog).toContain("logical ");
    expect(callLog).not.toContain("physical ");
    expect(callLog).not.toContain("verify ");
    expect(callLog).not.toContain("walgc ");
    expect(existsSync(path.join(stateDir, "x8-backup-last-success"))).toBe(true);
    expect(existsSync(path.join(stateDir, "x8-base-backup-last-success"))).toBe(false);
  });

  it("without X8_TIMER_TEST_MODE, an X8_TIMER_LOGICAL_BACKUP_SCRIPT override is ignored and the hard-coded default path is invoked instead", () => {
    const outputDir = mkTestDir("backup-timer-output-ignored-");
    const pgpassSource = path.join(mkTestDir("backup-timer-pgpass-ignored-"), "backup.pgpass");
    writeFileSync(pgpassSource, "*:*:*:backup_role:drill\n");
    const shimDir = mkTestDir("backup-timer-logical-ignored-");
    const shimScript = path.join(shimDir, "backup-logical.sh");
    writeShim(shimScript, `#!/usr/bin/env bash\necho "SHOULD_NOT_RUN"\nexit 0\n`);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      X8_BACKUP_OUTPUT_DIR: outputDir,
      X8_BACKUP_PGPASS_SOURCE: pgpassSource,
      X8_TIMER_LOGICAL_BACKUP_SCRIPT: shimScript,
    };
    // Deliberately no X8_TIMER_TEST_MODE -- and strip one out of the
    // inherited environment too, in case this suite is ever run with it set
    // in the shell (it must not be, per the compose/env-helper assertion
    // above, but a test asserting the ungated path should not depend on
    // that being true elsewhere).
    delete env.X8_TIMER_TEST_MODE;

    const result = spawnSync("bash", [scriptPath, "--once", "--logical-only"], { env, encoding: "utf8" });

    expect(result.stdout).toContain("BACKUP_TIMER_WARN=override_ignored name=X8_TIMER_LOGICAL_BACKUP_SCRIPT");
    expect(result.stdout).toContain("BACKUP_TIMER_MODE=logical_only");
    expect(result.stdout).not.toContain("SHOULD_NOT_RUN");
    // The default in-container path was attempted instead of the shim, and
    // fails on this host because that path does not exist here.
    expect(result.stderr).toContain("/opt/cps-novel-x8/backup-logical.sh");
    expect(result.status).not.toBe(0);
  });
});

// Gate 5 review fix (P2): retains only the most recent 30
// wal-gc-dry-run-*.txt reports, by COUNT (not age).
describe("backup-timer.sh: wal-gc-dry-run-*.txt report retention (Gate 5 review fix P2)", () => {
  it("prunes down to the 30 most recent reports after a run that adds a new one", () => {
    const shims = makeShims();
    const baseBackupDir = mkTestDir("backup-timer-basebackups-prune-");
    const stateDir = mkTestDir("backup-timer-state-prune-");
    const outputDir = mkTestDir("backup-timer-output-prune-");
    // 35 old reports, all with an earlier (and therefore lexicographically
    // and chronologically smaller) UTC stamp than any report this run
    // itself would produce.
    for (let i = 0; i < 35; i++) {
      const stamp = `202601${String(i + 1).padStart(2, "0")}T000000Z`;
      writeFileSync(path.join(outputDir, `wal-gc-dry-run-${stamp}.txt`), "old report\n");
    }

    const result = runOnce(shims, { X8_BACKUP_PHYSICAL_ENABLED: "false" }, { baseBackupDir, stateDir, outputDir });

    expect(result.status).toBe(0);
    const remaining = readdirSync(outputDir)
      .filter((f) => f.startsWith("wal-gc-dry-run-"))
      .sort();
    expect(remaining).toHaveLength(30);
    expect(remaining).not.toContain("wal-gc-dry-run-20260101T000000Z.txt");
    // The newest surviving report is this run's own (a 2026-09 stamp),
    // sorting after every pre-seeded 2026-01 report.
    expect(remaining[remaining.length - 1]).not.toMatch(/^wal-gc-dry-run-202601/);
  });
});

// Gate 5 review fix (P1-6): the forever loop (not --once) must DEGRADE
// instead of crash-restart when only steps 2-4 fail. X8_TIMER_MAX_CYCLES
// (test-mode only) caps the loop so this test never has to babysit or kill
// a real `while true` process.
describe("backup-timer.sh forever loop: DEGRADED on steps 2-4 failure (Gate 5 review fix P1-6)", () => {
  it("prints BACKUP_TIMER_RUN=DEGRADED and keeps looping (does not exit non-zero) when only step 4 fails", () => {
    const shims = makeShims({ walgcOutput: "WAL_RETENTION=REFUSED reason=x", walgcExit: 65 });
    const baseBackupDir = mkTestDir("backup-timer-basebackups-loop-");
    const stateDir = mkTestDir("backup-timer-state-loop-");
    const outputDir = mkTestDir("backup-timer-output-loop-");
    const pgpassSource = path.join(mkTestDir("backup-timer-pgpass-loop-"), "backup.pgpass");
    writeFileSync(pgpassSource, "*:*:*:backup_role:drill\n");

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        X8_BACKUP_OUTPUT_DIR: outputDir,
        X8_BACKUP_PGPASS_SOURCE: pgpassSource,
        X8_TIMER_SCRIPT_DIR: shims.scriptDir,
        X8_TIMER_BASE_BACKUP_DIR: baseBackupDir,
        X8_TIMER_STATE_DIR: stateDir,
        X8_TIMER_LOGICAL_BACKUP_SCRIPT: shims.logicalScript,
        X8_TIMER_TEST_MODE: "1",
        X8_TIMER_MAX_CYCLES: "2",
        X8_BACKUP_RUN_ON_START: "false",
        X8_BACKUP_INTERVAL_SECONDS: "1",
        X8_BACKUP_PHYSICAL_ENABLED: "false",
      },
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.status).toBe(0);
    const callLog = readFileSync(shims.callLog, "utf8");
    const logicalCalls = callLog.split("\n").filter((l) => l.startsWith("logical ")).length;
    // Exactly one logical-backup invocation per loop cycle -- proof this is
    // the ordinary sleep-then-run cadence, not a crash/restart loop running
    // far more often than X8_BACKUP_INTERVAL_SECONDS intends.
    expect(logicalCalls).toBe(2);
    expect(result.stdout).toContain("BACKUP_TIMER_RUN=DEGRADED failed_steps=4");
    expect(result.stdout).not.toContain("BACKUP_TIMER_RUN=CRASH");
    expect(result.stdout).toContain("BACKUP_TIMER_TEST_MAX_CYCLES_REACHED=2");
  });

  it("a step-1 (logical backup) failure still exits non-zero instead of DEGRADED (compose restart semantics preserved)", () => {
    const shims = makeShims();
    const baseBackupDir = mkTestDir("backup-timer-basebackups-loop-crash-");
    const stateDir = mkTestDir("backup-timer-state-loop-crash-");
    const outputDir = mkTestDir("backup-timer-output-loop-crash-");
    const brokenLogical = path.join(mkTestDir("backup-timer-logical-broken-"), "backup-logical.sh");
    writeShim(brokenLogical, `#!/usr/bin/env bash\necho "LOGICAL_BACKUP=PASS_NOT" >&2\nexit 3\n`);
    const pgpassSource = path.join(mkTestDir("backup-timer-pgpass-loop-crash-"), "backup.pgpass");
    writeFileSync(pgpassSource, "*:*:*:backup_role:drill\n");

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        X8_BACKUP_OUTPUT_DIR: outputDir,
        X8_BACKUP_PGPASS_SOURCE: pgpassSource,
        X8_TIMER_SCRIPT_DIR: shims.scriptDir,
        X8_TIMER_BASE_BACKUP_DIR: baseBackupDir,
        X8_TIMER_STATE_DIR: stateDir,
        X8_TIMER_LOGICAL_BACKUP_SCRIPT: brokenLogical,
        X8_TIMER_TEST_MODE: "1",
        X8_TIMER_MAX_CYCLES: "5",
        X8_BACKUP_RUN_ON_START: "true",
        X8_BACKUP_INTERVAL_SECONDS: "1",
        X8_BACKUP_PHYSICAL_ENABLED: "false",
      },
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("BACKUP_TIMER_RUN=DEGRADED");
    expect(result.stdout).not.toContain("BACKUP_TIMER_TEST_MAX_CYCLES_REACHED");
  });
});

// Gate 5 review fix (F-2): the two run_backup() success markers
// (x8-backup-last-success, x8-base-backup-last-success) are now each
// isolated `touch` probes -- a marker write failure (e.g. a full or
// read-only X8_TIMER_STATE_DIR) prints BACKUP_TIMER_WARN=marker_not_written
// and counts as its own failed step, instead of either being silently
// swallowed (pre-fix: an unguarded `touch` under this file's own `set -e`
// would have crashed the whole run with no diagnostic) or masquerading as a
// step-1 logical-backup failure.
describe("backup-timer.sh: marker-write isolation (Gate 5 review fix F-2)", () => {
  it("--once: a read-only X8_TIMER_STATE_DIR prints BACKUP_TIMER_WARN=marker_not_written and exits non-zero", () => {
    const shims = makeShims();
    const baseBackupDir = mkTestDir("backup-timer-basebackups-f2-once-");
    const stateDir = mkTestDir("backup-timer-state-f2-once-");
    const outputDir = mkTestDir("backup-timer-output-f2-once-");
    chmodSync(stateDir, 0o555);

    let result: ReturnType<typeof runOnce>;
    try {
      result = runOnce(
        shims,
        { X8_BACKUP_PHYSICAL_ENABLED: "false" },
        { baseBackupDir, stateDir, outputDir },
      );
    } finally {
      chmodSync(stateDir, 0o755);
    }

    expect(result.stdout).toContain("BACKUP_TIMER_WARN=marker_not_written");
    expect(result.stdout).toContain(`marker=${path.join(stateDir, "x8-backup-last-success")}`);
    expect(result.status).not.toBe(0);
  });

  it("forever loop: a read-only X8_TIMER_STATE_DIR still prints BACKUP_TIMER_RUN=DEGRADED and exits 0 (does not crash-restart)", () => {
    const shims = makeShims();
    const baseBackupDir = mkTestDir("backup-timer-basebackups-f2-loop-");
    const stateDir = mkTestDir("backup-timer-state-f2-loop-");
    const outputDir = mkTestDir("backup-timer-output-f2-loop-");
    const pgpassSource = path.join(mkTestDir("backup-timer-pgpass-f2-loop-"), "backup.pgpass");
    writeFileSync(pgpassSource, "*:*:*:backup_role:drill\n");
    chmodSync(stateDir, 0o555);

    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync("bash", [scriptPath], {
        env: {
          ...process.env,
          X8_BACKUP_OUTPUT_DIR: outputDir,
          X8_BACKUP_PGPASS_SOURCE: pgpassSource,
          X8_TIMER_SCRIPT_DIR: shims.scriptDir,
          X8_TIMER_BASE_BACKUP_DIR: baseBackupDir,
          X8_TIMER_STATE_DIR: stateDir,
          X8_TIMER_LOGICAL_BACKUP_SCRIPT: shims.logicalScript,
          X8_TIMER_TEST_MODE: "1",
          X8_TIMER_MAX_CYCLES: "1",
          X8_BACKUP_RUN_ON_START: "false",
          X8_BACKUP_INTERVAL_SECONDS: "1",
          X8_BACKUP_PHYSICAL_ENABLED: "false",
        },
        encoding: "utf8",
        timeout: 30000,
      });
    } finally {
      chmodSync(stateDir, 0o755);
    }

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("BACKUP_TIMER_WARN=marker_not_written");
    expect(result.stdout).toContain("BACKUP_TIMER_RUN=DEGRADED");
  });
});
