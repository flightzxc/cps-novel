import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_STALE_THRESHOLD_HOURS } from "@/server/health/backup-status";

/**
 * 2026-09-27 (Owner-approved, single infra change): `backup-timer` (infra/
 * preproduction/docker-compose.yml) sat Exited for 5 days (2026-09-22 ->
 * 2026-09-27) after an ops step stopped it post one-off backup. This
 * healthcheck would NOT have caught that (a stopped container has no health
 * status); it covers the other silent mode -- the container running while
 * the loop hangs or every run fails. `backup-loop.sh` writes a success
 * marker (`status_file=`) atomically, ONLY at the end of a fully successful
 * `run_once()` -- `set -euo pipefail` means a failed run never touches it.
 * The added healthcheck is healthy iff that marker file exists and is
 * younger than `DEFAULT_STALE_THRESHOLD_HOURS` (src/server/health/
 * backup-status.ts, the same number `/api/health/backup` uses for
 * staleness) -- the two must never drift apart.
 *
 * This test derives its expectations from the two real sources of truth
 * (backup-loop.sh's own `status_file=` assignment, and
 * DEFAULT_STALE_THRESHOLD_HOURS) rather than hard-coding the path or the
 * minute threshold, and proves the exact healthcheck shell command behaves
 * correctly against a real filesystem clock (fresh / missing / stale /
 * just-under-threshold), using the same `docker compose config` rendering
 * approach as the sibling preproduction contract tests (worker-light-
 * compose-contract.test.ts, preproduction-deployment-contract.test.ts) so
 * this test has no YAML-parsing dependency of its own.
 */

const root = process.cwd();
const composeFile = "infra/preproduction/docker-compose.yml";
const backupLoopFile = "infra/preproduction/backup-loop.sh";

function parseGoDurationToMinutes(duration: string): number {
  // Only needs to handle the subset `docker compose config --format json`
  // actually emits for a healthcheck's start_period ("1h0m0s", "90s",
  // "30m0s", ...): optional h/m/s components, each an integer or decimal.
  const match = duration.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  expect(match, `expected a Go-style duration string, got "${duration}"`).not.toBeNull();
  const [, h, m, s] = match!;
  return (Number(h ?? 0) * 60) + Number(m ?? 0) + (Number(s ?? 0) / 60);
}

describe("backup-timer freshness healthcheck contract", () => {
  let composeYaml: string;
  let backupLoopSource: string;
  let statusFilePath: string;
  let healthcheck: {
    test: string[];
    interval: string;
    timeout: string;
    retries: number;
    start_period: string;
  };

  beforeAll(async () => {
    composeYaml = await readFile(path.join(root, composeFile), "utf8");
    backupLoopSource = await readFile(path.join(root, backupLoopFile), "utf8");

    const statusFileMatch = backupLoopSource.match(/^status_file=(\S+)$/m);
    expect(statusFileMatch, "expected backup-loop.sh to declare status_file=<path>").not.toBeNull();
    statusFilePath = statusFileMatch![1];

    // Render the merged compose config the same way the sibling
    // "approved sitemap template renders into runtime services" test does
    // (preproduction-deployment-contract.test.ts): --env-file supplies
    // every `:-default`-bearing/placeholder value preprod.env.example
    // already carries, and only GIT_COMMIT / CPS_NOVEL_APP_IMAGE (both
    // deliberately excluded from that env file, see its own header
    // comment) need to be supplied on the command line.
    const result = spawnSync("docker", [
      "compose", "--env-file", "infra/preproduction/preprod.env.example",
      "-f", "docker-compose.yml", "-f", composeFile, "config", "--format", "json",
    ], {
      cwd: root,
      encoding: "utf8",
      env: {
        NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME,
        GIT_COMMIT: "845ca02ac9351163dd69b0de328b2d8aad1e012f",
        CPS_NOVEL_APP_IMAGE: "cps-novel:backup-timer-healthcheck-test",
      },
    });
    expect(result.status, both(result)).toBe(0);
    const config = JSON.parse(result.stdout);
    healthcheck = config.services["backup-timer"].healthcheck;
  });

  function both(r: { stdout: string | null; stderr: string | null }): string {
    return `${r.stdout ?? ""}${r.stderr ?? ""}`;
  }

  it("declares a CMD-SHELL healthcheck on backup-timer", () => {
    expect(healthcheck, "expected backup-timer to declare a healthcheck").toBeDefined();
    expect(healthcheck.test[0]).toBe("CMD-SHELL");
    expect(healthcheck.test).toHaveLength(2);
  });

  it("checks the exact status_file path backup-loop.sh writes on success", () => {
    expect(healthcheck.test[1]).toContain(statusFilePath);
  });

  it("uses a minute threshold equal to DEFAULT_STALE_THRESHOLD_HOURS * 60", () => {
    const expectedMinutes = DEFAULT_STALE_THRESHOLD_HOURS * 60;
    const match = healthcheck.test[1].match(/-mmin\s+-(\d+)/);
    expect(match, `expected a "-mmin -<minutes>" freshness test, got: ${healthcheck.test[1]}`).not.toBeNull();
    expect(Number(match![1])).toBe(expectedMinutes);
  });

  it("contains no $ in the healthcheck command (interpolation hazard)", () => {
    // Checked against the RAW source text, not the docker-compose-config
    // rendered JSON -- a stray `$` in the source is the actual hazard
    // (Compose would try to interpolate it at render time), and the
    // rendered JSON would look identical either way if there happened to
    // be nothing to substitute.
    const btIdx = composeYaml.indexOf("\n  backup-timer:\n");
    expect(btIdx, "expected a top-level backup-timer: service block").toBeGreaterThan(-1);
    const nextServiceIdx = composeYaml.indexOf("\nnetworks:", btIdx);
    expect(nextServiceIdx, "expected a top-level networks: key after backup-timer").toBeGreaterThan(btIdx);
    const block = composeYaml.slice(btIdx, nextServiceIdx);
    const healthcheckIdx = block.indexOf("healthcheck:");
    expect(healthcheckIdx, "expected a healthcheck: key inside backup-timer's block").toBeGreaterThan(-1);
    const testLineMatch = block.slice(healthcheckIdx).match(/test:\s*\[(.*)\]/);
    expect(testLineMatch, "expected a single-line test: [...] under backup-timer's healthcheck").not.toBeNull();
    expect(testLineMatch![1]).not.toContain("$");
  });

  it("gives the first run_once() (which may include a weekly base-backup + restore verification) at least 30 minutes before judging health", () => {
    expect(healthcheck.start_period, "expected a start_period on backup-timer's healthcheck").toBeTruthy();
    expect(parseGoDurationToMinutes(healthcheck.start_period)).toBeGreaterThanOrEqual(30);
  });

  describe("behavioral: the exact healthcheck command against a real filesystem clock", () => {
    const dirs: string[] = [];

    afterEach(async () => {
      while (dirs.length) {
        const dir = dirs.pop()!;
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });

    async function tempMarkerPath(): Promise<string> {
      const dir = await mkdtemp(path.join(tmpdir(), "backup-timer-healthcheck-"));
      dirs.push(dir);
      return path.join(dir, "last-success.json");
    }

    /** Substitutes the real marker path in the exact rendered command with a temp path, verbatim otherwise. */
    function commandFor(markerPath: string): string {
      expect(healthcheck.test[1].includes(statusFilePath), "expected the rendered command to contain the exact status_file path").toBe(true);
      return healthcheck.test[1].split(statusFilePath).join(markerPath);
    }

    function run(markerPath: string): { status: number | null; stdout: string; stderr: string } {
      const result = spawnSync("sh", ["-c", commandFor(markerPath)], { encoding: "utf8" });
      return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    }

    it("passes (exit 0) for a fresh marker file", async () => {
      const markerPath = await tempMarkerPath();
      await writeFile(markerPath, '{"finishedAt":"2026-09-27T00:00:00Z","exitCode":0}\n', "utf8");
      const result = run(markerPath);
      expect(result.status, both(result)).toBe(0);
    });

    it("fails (non-zero) when the marker file is missing", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "backup-timer-healthcheck-"));
      dirs.push(dir);
      const markerPath = path.join(dir, "last-success.json"); // never written
      const result = run(markerPath);
      expect(result.status).not.toBe(0);
    });

    it("fails (non-zero) when the marker is 27h old (past the 26h threshold)", async () => {
      const markerPath = await tempMarkerPath();
      await writeFile(markerPath, '{"finishedAt":"2026-09-26T00:00:00Z","exitCode":0}\n', "utf8");
      const stale = new Date(Date.now() - 27 * 60 * 60 * 1000);
      await utimes(markerPath, stale, stale);
      const result = run(markerPath);
      expect(result.status).not.toBe(0);
    });

    it("passes (exit 0) when the marker is 25h old (still under the 26h threshold)", async () => {
      const markerPath = await tempMarkerPath();
      await writeFile(markerPath, '{"finishedAt":"...","exitCode":0}\n', "utf8");
      const fresh = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await utimes(markerPath, fresh, fresh);
      const result = run(markerPath);
      expect(result.status, both(result)).toBe(0);
    });
  });
});
