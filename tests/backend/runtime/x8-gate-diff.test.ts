import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { diffRenderedConfigs, findActualDrift, formatDrift, formatEntry } from "../../../scripts/lib/x8-gate-diff.mjs";

const root = resolve(import.meta.dirname, "../../..");
const diffScript = resolve(root, "scripts/lib/x8-gate-diff.mjs");

/**
 * X8 release-identity gate work order (2026-09-05), 施工项一 4.3(五). These
 * two functions are the core of the gate command's pre-check: the rendered
 * config gate (borrowed from the reference CPS short-drama implementation)
 * and the three-way "actual container" leg this repo's version adds on top
 * of it. Both are pure, so they are exercised directly here with plain
 * objects -- no docker, no bash, no filesystem beyond the CLI smoke test at
 * the bottom.
 */
describe("x8-gate-diff: diffRenderedConfigs", () => {
  const baseline = {
    services: {
      web: { image: "cps-novel:0.1.0-abc1234", environment: { FEATURE_NOVEL_CATALOG_SYNC: "false", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "false", PROMO_CLAIM_ROLES: "super_admin" } },
      worker: { image: "cps-novel:0.1.0-abc1234", environment: { FEATURE_NOVEL_CATALOG_SYNC: "false", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "false", WORKER_TASK_ALLOWLIST: "catalog_scan" } },
    },
  };

  it("reports only the authorized keys as changed when nothing else moves", () => {
    const candidate = JSON.parse(JSON.stringify(baseline));
    candidate.services.web.environment.FEATURE_NOVEL_CATALOG_SYNC = "true";
    candidate.services.web.environment.NOVEL_CATALOG_SYNC_ALLOW_WRITE = "true";
    candidate.services.worker.environment.FEATURE_NOVEL_CATALOG_SYNC = "true";
    candidate.services.worker.environment.NOVEL_CATALOG_SYNC_ALLOW_WRITE = "true";

    const { unauthorized, changed } = diffRenderedConfigs(baseline, candidate, [
      "FEATURE_NOVEL_CATALOG_SYNC",
      "NOVEL_CATALOG_SYNC_ALLOW_WRITE",
    ]);
    expect(unauthorized).toEqual([]);
    expect(changed).toHaveLength(4);
    expect(changed.map((entry) => entry.key).sort()).toEqual([
      "FEATURE_NOVEL_CATALOG_SYNC",
      "FEATURE_NOVEL_CATALOG_SYNC",
      "NOVEL_CATALOG_SYNC_ALLOW_WRITE",
      "NOVEL_CATALOG_SYNC_ALLOW_WRITE",
    ]);
  });

  it("fails closed when a field outside the requested flags would also change", () => {
    const candidate = JSON.parse(JSON.stringify(baseline));
    candidate.services.web.environment.FEATURE_NOVEL_CATALOG_SYNC = "true";
    candidate.services.web.environment.NOVEL_CATALOG_SYNC_ALLOW_WRITE = "true";
    // Simulates exactly the real-world bug class this work order is about:
    // a context-recomputed variable (the promo:claim capability grant) that
    // silently moved along with the intended flag flip.
    candidate.services.web.environment.PROMO_CLAIM_ROLES = "";

    const { unauthorized } = diffRenderedConfigs(baseline, candidate, [
      "FEATURE_NOVEL_CATALOG_SYNC",
      "NOVEL_CATALOG_SYNC_ALLOW_WRITE",
    ]);
    expect(unauthorized).toHaveLength(1);
    expect(unauthorized[0]).toMatchObject({ service: "web", key: "PROMO_CLAIM_ROLES", from: "super_admin", to: "" });
  });

  it("also flags a change to the service definition outside of `environment`", () => {
    const candidate = JSON.parse(JSON.stringify(baseline));
    candidate.services.web.image = "cps-novel:0.1.0-9999999";

    const { unauthorized } = diffRenderedConfigs(baseline, candidate, [
      "FEATURE_NOVEL_CATALOG_SYNC",
      "NOVEL_CATALOG_SYNC_ALLOW_WRITE",
    ]);
    expect(unauthorized).toHaveLength(1);
    expect(unauthorized[0].service).toBe("web");
    expect(unauthorized[0].key).toBe("(service definition)");
  });

  it("treats no rendered difference as a legitimate (empty) result", () => {
    const { unauthorized, changed } = diffRenderedConfigs(baseline, baseline, [
      "FEATURE_NOVEL_CATALOG_SYNC",
      "NOVEL_CATALOG_SYNC_ALLOW_WRITE",
    ]);
    expect(unauthorized).toEqual([]);
    expect(changed).toEqual([]);
  });
});

describe("x8-gate-diff: findActualDrift", () => {
  const keysByService = {
    web: ["FEATURE_NOVEL_CATALOG_SYNC", "NOVEL_CATALOG_SYNC_ALLOW_WRITE", "PROMO_CLAIM_ROLES", "ADMIN_TWO_FACTOR_ENFORCEMENT"],
    worker: ["FEATURE_NOVEL_CATALOG_SYNC", "NOVEL_CATALOG_SYNC_ALLOW_WRITE", "WORKER_TASK_ALLOWLIST"],
  };
  const baselineServices = {
    web: { environment: { FEATURE_NOVEL_CATALOG_SYNC: "true", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true", PROMO_CLAIM_ROLES: "super_admin", ADMIN_TWO_FACTOR_ENFORCEMENT: "true" } },
    worker: { environment: { FEATURE_NOVEL_CATALOG_SYNC: "true", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true", WORKER_TASK_ALLOWLIST: "catalog_scan" } },
  };

  it("reproduces this repo's confirmed real drift: state file says open, containers say closed", () => {
    // Mirrors the exact live drift read from cps-novel-x8-local-web-1 /
    // -worker-1 during this work order (gate state file = apply, running
    // containers = false/false).
    const actualByService = {
      web: { FEATURE_NOVEL_CATALOG_SYNC: "false", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "false", PROMO_CLAIM_ROLES: "super_admin", ADMIN_TWO_FACTOR_ENFORCEMENT: "false" },
      worker: { FEATURE_NOVEL_CATALOG_SYNC: "false", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "false", WORKER_TASK_ALLOWLIST: "catalog_scan" },
    };
    const drift = findActualDrift(baselineServices, actualByService, keysByService);
    const keys = drift.map((entry) => `${entry.service}.${entry.key}`).sort();
    // ADMIN_TWO_FACTOR_ENFORCEMENT also drifted in this fixture (baseline
    // true, actual false) and must be reported alongside the two
    // catalog-write flags -- proves this is a real per-key diff over the
    // curated identity-relevant keys, not just those two hardcoded in.
    expect(keys).toEqual([
      "web.ADMIN_TWO_FACTOR_ENFORCEMENT",
      "web.FEATURE_NOVEL_CATALOG_SYNC",
      "web.NOVEL_CATALOG_SYNC_ALLOW_WRITE",
      "worker.FEATURE_NOVEL_CATALOG_SYNC",
      "worker.NOVEL_CATALOG_SYNC_ALLOW_WRITE",
    ]);
  });

  it("passes when the running containers agree with the persisted baseline", () => {
    const actualByService = {
      web: { FEATURE_NOVEL_CATALOG_SYNC: "true", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true", PROMO_CLAIM_ROLES: "super_admin", ADMIN_TWO_FACTOR_ENFORCEMENT: "true" },
      worker: { FEATURE_NOVEL_CATALOG_SYNC: "true", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true", WORKER_TASK_ALLOWLIST: "catalog_scan" },
    };
    expect(findActualDrift(baselineServices, actualByService, keysByService)).toEqual([]);
  });

  it("skips a key the baseline render never set for that service (e.g. WORKER_TASK_ALLOWLIST on web)", () => {
    const drift = findActualDrift(
      { web: { environment: {} } },
      { web: { WORKER_TASK_ALLOWLIST: "anything" } },
      { web: ["WORKER_TASK_ALLOWLIST"] },
    );
    expect(drift).toEqual([]);
  });

  it("treats a missing actual value as an empty string, not a pass", () => {
    const drift = findActualDrift(
      { web: { environment: { FEATURE_NOVEL_CATALOG_SYNC: "true" } } },
      { web: {} },
      { web: ["FEATURE_NOVEL_CATALOG_SYNC"] },
    );
    expect(drift).toEqual([{ service: "web", key: "FEATURE_NOVEL_CATALOG_SYNC", expected: "true", actual: "" }]);
  });
});

describe("x8-gate-diff: formatting", () => {
  it("formats a rendered-diff entry and a drift entry legibly", () => {
    expect(formatEntry({ service: "web", key: "FEATURE_NOVEL_CATALOG_SYNC", from: "false", to: "true" })).toBe(
      'web.FEATURE_NOVEL_CATALOG_SYNC: "false" -> "true"',
    );
    expect(formatDrift({ service: "web", key: "FEATURE_NOVEL_CATALOG_SYNC", expected: "true", actual: "false" })).toBe(
      'web.FEATURE_NOVEL_CATALOG_SYNC: baseline="true" actual="false"',
    );
  });
});

describe("x8-gate-diff: CLI", () => {
  let dir: string;

  const write = (name: string, content: unknown) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(content));
    return path;
  };

  it("exits 0 and prints the change when the rendered diff is authorized", () => {
    dir = mkdtempSync(join(tmpdir(), "x8-gate-diff-cli-"));
    try {
      const baseline = write("baseline.json", { services: { web: { environment: { FEATURE_NOVEL_CATALOG_SYNC: "false" } } } });
      const candidate = write("candidate.json", { services: { web: { environment: { FEATURE_NOVEL_CATALOG_SYNC: "true" } } } });
      const result = spawnSync("node", [diffScript, "rendered", baseline, candidate, "FEATURE_NOVEL_CATALOG_SYNC"], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("FEATURE_NOVEL_CATALOG_SYNC");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 and prints the unauthorized fields on stderr when the diff is not authorized", () => {
    dir = mkdtempSync(join(tmpdir(), "x8-gate-diff-cli-"));
    try {
      const baseline = write("baseline.json", { services: { web: { environment: { FEATURE_NOVEL_CATALOG_SYNC: "false", OTHER: "a" } } } });
      const candidate = write("candidate.json", { services: { web: { environment: { FEATURE_NOVEL_CATALOG_SYNC: "true", OTHER: "b" } } } });
      const result = spawnSync("node", [diffScript, "rendered", baseline, candidate, "FEATURE_NOVEL_CATALOG_SYNC"], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("UNAUTHORIZED_RENDER_DIFF");
      expect(result.stderr).toContain("OTHER");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 on actual-container drift and 0 when it matches", () => {
    dir = mkdtempSync(join(tmpdir(), "x8-gate-diff-cli-"));
    try {
      const baseline = write("baseline.json", { services: { web: { environment: { FEATURE_NOVEL_CATALOG_SYNC: "true" } } } });
      const keys = write("keys.json", { web: ["FEATURE_NOVEL_CATALOG_SYNC"] });
      const actualMismatch = write("actual-mismatch.json", { web: { FEATURE_NOVEL_CATALOG_SYNC: "false" } });
      const mismatch = spawnSync("node", [diffScript, "actual", baseline, actualMismatch, keys], { encoding: "utf8" });
      expect(mismatch.status).toBe(1);
      expect(mismatch.stderr).toContain("ACTUAL_CONTAINER_DRIFT");

      const actualMatch = write("actual-match.json", { web: { FEATURE_NOVEL_CATALOG_SYNC: "true" } });
      const match = spawnSync("node", [diffScript, "actual", baseline, actualMatch, keys], { encoding: "utf8" });
      expect(match.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown mode with usage-error exit code 64", () => {
    const result = spawnSync("node", [diffScript, "bogus"], { encoding: "utf8" });
    expect(result.status).toBe(64);
    expect(result.stderr).toContain("unknown x8-gate-diff mode");
  });

  it("is syntactically valid and importable as an ES module", () => {
    execFileSync("node", ["--check", diffScript]);
  });
});
