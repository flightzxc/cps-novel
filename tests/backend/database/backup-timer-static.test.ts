import { execFileSync, spawnSync } from "node:child_process";
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
) {
  const pgpassSource = path.join(mkTestDir("backup-timer-pgpass-"), "backup.pgpass");
  writeFileSync(pgpassSource, "*:*:*:backup_role:drill\n");

  return spawnSync("bash", [scriptPath, "--once"], {
    env: {
      ...process.env,
      X8_BACKUP_OUTPUT_DIR: dirs.outputDir,
      X8_BACKUP_PGPASS_SOURCE: pgpassSource,
      X8_TIMER_SCRIPT_DIR: shims.scriptDir,
      X8_TIMER_BASE_BACKUP_DIR: dirs.baseBackupDir,
      X8_TIMER_STATE_DIR: dirs.stateDir,
      X8_TIMER_LOGICAL_BACKUP_SCRIPT: shims.logicalScript,
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
});
