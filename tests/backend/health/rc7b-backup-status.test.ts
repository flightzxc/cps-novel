import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_STALE_THRESHOLD_HOURS,
  evaluateBackupStatus,
} from "@/server/health/backup-status";

/**
 * RC-7b — `evaluateBackupStatus` semantics, ported from CPS `v8.3.6`
 * `src/lib/health-backup-status.ts` (`baseline_commit
 * 16f2e4cfca51f46af0dede899ecf6242a770bbd0`). Mirrors the DI/fixture style of
 * the neighbouring `p1-12-health-service.test.ts`: real temp files via
 * `mkdtemp` for the filesystem-shaped scenarios, injected `now`/reader
 * overrides only for the failure modes real fs cannot cheaply simulate
 * (hung reads, non-ENOENT errors).
 */

const NOW = Date.UTC(2026, 8, 3, 12, 0, 0); // 2026-09-03T12:00:00Z
const HOUR_MS = 60 * 60 * 1000;

const directories: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}

async function statusFile(dir: string, content: string): Promise<string> {
  const path = join(dir, "backup-status.json");
  await writeFile(path, content, "utf8");
  return path;
}

async function artifact(dir: string, name: string, mtime: Date, bytes = 1024): Promise<void> {
  const path = join(dir, name);
  await writeFile(path, "x".repeat(bytes), "utf8");
  await utimes(path, mtime, mtime);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("RC-7b evaluateBackupStatus", () => {
  it("returns unconfigured with source none when neither env is configured", async () => {
    const result = await evaluateBackupStatus({ now: () => NOW });
    expect(result).toEqual({ backupStatus: "unconfigured", checkedAt: new Date(NOW).toISOString(), ageHours: null, source: "none" });
  });

  it("returns ok from the status file when exitCode is 0 and fresh", async () => {
    const dir = await tempDir("rc7b-backup-status-ok-");
    const path = await statusFile(dir, JSON.stringify({ finishedAt: new Date(NOW - HOUR_MS).toISOString(), exitCode: 0 }));

    const result = await evaluateBackupStatus({ statusFilePath: path, now: () => NOW });

    expect(result.backupStatus).toBe("ok");
    expect(result.source).toBe("status_file");
    expect(result.ageHours).toBeCloseTo(1, 5);
  });

  it("returns failed from the status file when the last run's exitCode is non-zero, regardless of age", async () => {
    const dir = await tempDir("rc7b-backup-status-failed-exit-");
    const path = await statusFile(dir, JSON.stringify({ finishedAt: new Date(NOW - 1000).toISOString(), exitCode: 1 }));

    const result = await evaluateBackupStatus({ statusFilePath: path, now: () => NOW });

    expect(result).toMatchObject({ backupStatus: "failed", source: "status_file", ageHours: null });
  });

  it("returns failed when the status file is not valid JSON", async () => {
    const dir = await tempDir("rc7b-backup-status-corrupt-");
    const path = await statusFile(dir, "{not json");

    const result = await evaluateBackupStatus({ statusFilePath: path, now: () => NOW });

    expect(result).toMatchObject({ backupStatus: "failed", source: "status_file" });
  });

  it("returns failed when the status file is well-formed JSON but missing required fields", async () => {
    const dir = await tempDir("rc7b-backup-status-shape-");
    const path = await statusFile(dir, JSON.stringify({ somethingElse: true }));

    const result = await evaluateBackupStatus({ statusFilePath: path, now: () => NOW });

    expect(result).toMatchObject({ backupStatus: "failed", source: "status_file" });
  });

  it("returns failed when reading the status file errors for a reason other than missing", async () => {
    const result = await evaluateBackupStatus({
      statusFilePath: "/irrelevant/path.json",
      now: () => NOW,
      readStatusFile: async () => {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      },
    });

    expect(result).toMatchObject({ backupStatus: "failed", source: "status_file", ageHours: null });
  });

  it("returns failed when reading the status file hangs past the read timeout", async () => {
    const result = await evaluateBackupStatus({
      statusFilePath: "/irrelevant/path.json",
      now: () => NOW,
      readTimeoutMs: 10,
      readStatusFile: () => new Promise(() => undefined),
    });

    expect(result).toMatchObject({ backupStatus: "failed", source: "status_file", ageHours: null });
  });

  it(`treats age just under the ${DEFAULT_STALE_THRESHOLD_HOURS}h default threshold as ok`, async () => {
    const dir = await tempDir("rc7b-backup-status-boundary-ok-");
    const path = await statusFile(
      dir,
      JSON.stringify({ finishedAt: new Date(NOW - 25.9 * HOUR_MS).toISOString(), exitCode: 0 }),
    );

    const result = await evaluateBackupStatus({ statusFilePath: path, now: () => NOW });

    expect(result.backupStatus).toBe("ok");
    expect(result.ageHours).toBeCloseTo(25.9, 5);
  });

  it(`treats age just over the ${DEFAULT_STALE_THRESHOLD_HOURS}h default threshold as stale`, async () => {
    const dir = await tempDir("rc7b-backup-status-boundary-stale-");
    const path = await statusFile(
      dir,
      JSON.stringify({ finishedAt: new Date(NOW - 26.1 * HOUR_MS).toISOString(), exitCode: 0 }),
    );

    const result = await evaluateBackupStatus({ statusFilePath: path, now: () => NOW });

    expect(result.backupStatus).toBe("stale");
    expect(result.source).toBe("status_file");
    expect(result.ageHours).toBeCloseTo(26.1, 5);
  });

  it("falls back to the output directory when the status file does not exist", async () => {
    const missingStatusPath = join(tmpdir(), `rc7b-missing-status-${process.pid}-${Date.now()}.json`);
    const outputDir = await tempDir("rc7b-backup-output-fallback-");
    await artifact(outputDir, "cps-novel-x8-20260903T110000Z.dump", new Date(NOW - HOUR_MS));

    const result = await evaluateBackupStatus({ statusFilePath: missingStatusPath, outputDir, now: () => NOW });

    expect(result.backupStatus).toBe("ok");
    expect(result.source).toBe("output_dir");
  });

  it("prefers the status file over the output directory when both are configured", async () => {
    const dir = await tempDir("rc7b-backup-status-priority-");
    const path = await statusFile(dir, JSON.stringify({ finishedAt: new Date(NOW - HOUR_MS).toISOString(), exitCode: 0 }));
    const outputDir = await tempDir("rc7b-backup-output-priority-");
    // A stale artifact in the output dir must not affect the outcome — the
    // status file exists, so the output-dir fallback is never consulted.
    await artifact(outputDir, "cps-novel-x8-stale.dump", new Date(NOW - 200 * HOUR_MS));

    const result = await evaluateBackupStatus({ statusFilePath: path, outputDir, now: () => NOW });

    expect(result.backupStatus).toBe("ok");
    expect(result.source).toBe("status_file");
  });

  it("returns unconfigured when the output directory has no matching artifacts", async () => {
    const outputDir = await tempDir("rc7b-backup-output-empty-");
    await writeFile(join(outputDir, "readme.txt"), "not a backup", "utf8");

    const result = await evaluateBackupStatus({ outputDir, now: () => NOW });

    expect(result).toMatchObject({ backupStatus: "unconfigured", source: "none" });
  });

  it("excludes zero-byte artifacts from the output-directory fallback", async () => {
    const outputDir = await tempDir("rc7b-backup-output-zero-byte-");
    await artifact(outputDir, "cps-novel-x8-empty.dump", new Date(NOW - HOUR_MS), 0);

    const result = await evaluateBackupStatus({ outputDir, now: () => NOW });

    expect(result).toMatchObject({ backupStatus: "unconfigured", source: "none" });
  });

  it("reports stale from the output directory when the newest artifact is past the threshold", async () => {
    const outputDir = await tempDir("rc7b-backup-output-stale-");
    await artifact(outputDir, "cps-novel-x8-old.dump", new Date(NOW - 30 * HOUR_MS));

    const result = await evaluateBackupStatus({ outputDir, now: () => NOW });

    expect(result).toMatchObject({ backupStatus: "stale", source: "output_dir" });
  });

  it("picks the newest matching artifact by mtime, ignoring non-matching filenames", async () => {
    const outputDir = await tempDir("rc7b-backup-output-newest-");
    await artifact(outputDir, "cps-novel-x8-older.dump", new Date(NOW - 5 * HOUR_MS));
    await artifact(outputDir, "cps-novel-x8-newer.sql.gz", new Date(NOW - HOUR_MS));
    await writeFile(join(outputDir, "cps-novel-x8-latest.tmp"), "not a real artifact", "utf8");

    const result = await evaluateBackupStatus({ outputDir, now: () => NOW });

    expect(result.backupStatus).toBe("ok");
    expect(result.ageHours).toBeCloseTo(1, 1);
  });

  it("never includes a filesystem path or filename in the response", async () => {
    const dir = await tempDir("rc7b-backup-status-no-leak-");
    const path = await statusFile(dir, JSON.stringify({ finishedAt: new Date(NOW - HOUR_MS).toISOString(), exitCode: 0 }));
    const outputDir = await tempDir("rc7b-backup-output-no-leak-");
    await artifact(outputDir, "cps-novel-x8-secret-name.dump", new Date(NOW - HOUR_MS));

    for (const options of [
      { statusFilePath: path, now: () => NOW },
      { outputDir, now: () => NOW },
    ]) {
      const result = await evaluateBackupStatus(options);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(dir);
      expect(serialized).not.toContain(outputDir);
      expect(serialized).not.toContain("secret-name");
      expect(Object.keys(result).sort()).toEqual(["ageHours", "backupStatus", "checkedAt", "source"]);
    }
  });
});
