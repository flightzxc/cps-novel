import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { BASE_IMAGE_BAKED_KEYS, CATALOG_GATE_ENV_KEYS, diffRenderedConfigs, findActualDrift, formatDrift, formatEntry } from "../../../scripts/lib/x8-gate-diff.mjs";

const root = resolve(import.meta.dirname, "../../..");
const diffScript = resolve(root, "scripts/lib/x8-gate-diff.mjs");

/**
 * X8 release-identity gate work order (2026-09-05), 施工项一 4.3(五), amended
 * by the 2026-09-06 patch work order (决策一: reconciliation is now full,
 * not a curated whitelist; P1-5: top-level compose fields are compared too).
 * Both comparisons are pure, so they are exercised directly here with plain
 * objects -- no docker, no bash, no filesystem beyond the CLI smoke test at
 * the bottom.
 */
describe("x8-gate-diff: diffRenderedConfigs", () => {
  const baseline = {
    name: "cps-novel-x8-local",
    networks: { runtime: { name: "cps_novel_x8_runtime" } },
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

  // P1-5: the terminal auditor's real-world reproduction was "rename the
  // top-level network and the comparator reports nothing" -- this repo's
  // baseline/candidate renders never differed anywhere except `services`
  // before the patch, so this is the direct regression test for the fix,
  // not an inference from the service-level cases above.
  it("P1-5: flags a top-level field change (e.g. a renamed network) that no per-service comparison would ever see", () => {
    const candidate = JSON.parse(JSON.stringify(baseline));
    candidate.networks.runtime.name = "some_other_network_name";

    const { unauthorized } = diffRenderedConfigs(baseline, candidate, [
      "FEATURE_NOVEL_CATALOG_SYNC",
      "NOVEL_CATALOG_SYNC_ALLOW_WRITE",
    ]);
    expect(unauthorized).toHaveLength(1);
    expect(unauthorized[0].service).toBe("(top-level)");
  });

  it("P1-5: flags a top-level `name` (compose project) change", () => {
    const candidate = JSON.parse(JSON.stringify(baseline));
    candidate.name = "some-other-project";

    const { unauthorized } = diffRenderedConfigs(baseline, candidate, [
      "FEATURE_NOVEL_CATALOG_SYNC",
      "NOVEL_CATALOG_SYNC_ALLOW_WRITE",
    ]);
    expect(unauthorized).toHaveLength(1);
    expect(unauthorized[0].service).toBe("(top-level)");
  });

  it("P1-5: no false positive when only the requested gate keys change and everything else (top-level included) is untouched", () => {
    const candidate = JSON.parse(JSON.stringify(baseline));
    candidate.services.web.environment.FEATURE_NOVEL_CATALOG_SYNC = "true";
    candidate.services.worker.environment.FEATURE_NOVEL_CATALOG_SYNC = "true";

    const { unauthorized } = diffRenderedConfigs(baseline, candidate, [
      "FEATURE_NOVEL_CATALOG_SYNC",
      "NOVEL_CATALOG_SYNC_ALLOW_WRITE",
    ]);
    expect(unauthorized).toEqual([]);
  });
});

describe("x8-gate-diff: findActualDrift (决策一 -- full reconciliation, no curated whitelist)", () => {
  const baselineServices = {
    web: { environment: { FEATURE_NOVEL_CATALOG_SYNC: "true", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true", PROMO_CLAIM_ROLES: "super_admin", ADMIN_TWO_FACTOR_ENFORCEMENT: "true" } },
    worker: { environment: { FEATURE_NOVEL_CATALOG_SYNC: "true", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true", WORKER_TASK_ALLOWLIST: "catalog_scan" } },
  };

  it("reproduces this repo's confirmed real drift: state file says open, containers say closed", () => {
    // Mirrors the exact live drift read from cps-novel-x8-local-web-1 /
    // -worker-1 during the original work order (gate state file = apply,
    // running containers = false/false).
    const actualByService = {
      web: { FEATURE_NOVEL_CATALOG_SYNC: "false", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "false", PROMO_CLAIM_ROLES: "super_admin", ADMIN_TWO_FACTOR_ENFORCEMENT: "false" },
      worker: { FEATURE_NOVEL_CATALOG_SYNC: "false", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "false", WORKER_TASK_ALLOWLIST: "catalog_scan" },
    };
    const drift = findActualDrift(baselineServices, actualByService, { services: ["web", "worker"] });
    const keys = drift.map((entry) => `${entry.service}.${entry.key}`).sort();
    // ADMIN_TWO_FACTOR_ENFORCEMENT also drifted in this fixture (baseline
    // true, actual false) and must be reported alongside the two
    // catalog-write flags -- proves this is a real per-key diff, not just
    // the two gate keys hardcoded in.
    expect(keys).toEqual([
      "web.ADMIN_TWO_FACTOR_ENFORCEMENT",
      "web.FEATURE_NOVEL_CATALOG_SYNC",
      "web.NOVEL_CATALOG_SYNC_ALLOW_WRITE",
      "worker.FEATURE_NOVEL_CATALOG_SYNC",
      "worker.NOVEL_CATALOG_SYNC_ALLOW_WRITE",
    ]);
  });

  it("passes when the running containers agree with the persisted baseline exactly", () => {
    const actualByService = {
      web: { FEATURE_NOVEL_CATALOG_SYNC: "true", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true", PROMO_CLAIM_ROLES: "super_admin", ADMIN_TWO_FACTOR_ENFORCEMENT: "true" },
      worker: { FEATURE_NOVEL_CATALOG_SYNC: "true", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true", WORKER_TASK_ALLOWLIST: "catalog_scan" },
    };
    expect(findActualDrift(baselineServices, actualByService, { services: ["web", "worker"] })).toEqual([]);
  });

  // P0-3: the pre-patch version hard-coded exactly 7 keys to check
  // (FEATURE_NOVEL_CATALOG_SYNC/NOVEL_CATALOG_SYNC_ALLOW_WRITE x2 services,
  // PROMO_CLAIM_ROLES, ADMIN_TWO_FACTOR_ENFORCEMENT, WORKER_TASK_ALLOWLIST)
  // and silently ignored everything else the baseline render actually
  // declared. These two are the terminal auditor's named examples.
  it("P0-3: catches drift in the promo-link double-gate, a key the old 7-key whitelist never covered", () => {
    const baseline = {
      worker: { environment: { FEATURE_NOVEL_CATALOG_SYNC: "true", WORKER_TASK_ALLOWLIST: "catalog_scan", FEATURE_PROMO_LINK_CLAIM: "false", PROMO_LINK_CLAIM_ALLOW_WRITE: "false" } },
    };
    const actual = { worker: { FEATURE_NOVEL_CATALOG_SYNC: "true", WORKER_TASK_ALLOWLIST: "catalog_scan", FEATURE_PROMO_LINK_CLAIM: "true", PROMO_LINK_CLAIM_ALLOW_WRITE: "true" } };
    const drift = findActualDrift(baseline, actual, { services: ["worker"] });
    expect(drift.map((e) => e.key).sort()).toEqual(["FEATURE_PROMO_LINK_CLAIM", "PROMO_LINK_CLAIM_ALLOW_WRITE"]);
  });

  it("P0-3: catches drift in the preview source allowlist, also never covered by the old whitelist", () => {
    const baseline = { web: { environment: { FEATURE_NOVEL_CATALOG_SYNC: "true", MOBOREADER_PREVIEW_SOURCE_APP_CODES: "changdu" } } };
    const actual = { web: { FEATURE_NOVEL_CATALOG_SYNC: "true", MOBOREADER_PREVIEW_SOURCE_APP_CODES: "" } };
    const drift = findActualDrift(baseline, actual, { services: ["web"] });
    expect(drift).toEqual([{ service: "web", key: "MOBOREADER_PREVIEW_SOURCE_APP_CODES", expected: "changdu", actual: "" }]);
  });

  // P0-4: fail-closed on all three disagreement shapes, not just "value
  // differs". The pre-patch version's exact bug was `if (expected ===
  // undefined) continue;` -- silently skipping any key the curated list
  // didn't ask about, which is a different bug from "the baseline itself
  // doesn't declare this key" (now handled by full enumeration) but the
  // *symptom* -- a key present nowhere in the check -- is the same failure
  // mode this whole section pins down.
  it("P0-4: fails closed when the baseline declares a key the container is missing entirely", () => {
    const drift = findActualDrift(
      { web: { environment: { FEATURE_NOVEL_CATALOG_SYNC: "true" } } },
      { web: {} },
      { services: ["web"] },
    );
    expect(drift).toEqual([{ service: "web", key: "FEATURE_NOVEL_CATALOG_SYNC", expected: "true", actual: "<missing from container>" }]);
  });

  it("P0-4: fails closed when the container has a key the baseline never declared, and it is not on the exemption list", () => {
    const drift = findActualDrift(
      { web: { environment: { FEATURE_NOVEL_CATALOG_SYNC: "true" } } },
      { web: { FEATURE_NOVEL_CATALOG_SYNC: "true", SOME_SURPRISE_VAR: "unexpected" } },
      { services: ["web"] },
    );
    expect(drift).toEqual([{ service: "web", key: "SOME_SURPRISE_VAR", expected: "<not declared in baseline render>", actual: "unexpected" }]);
  });

  it("P0-4: fails closed (not a vacuous pass) when an entire service is missing from the baseline render", () => {
    const drift = findActualDrift({}, { web: { FEATURE_NOVEL_CATALOG_SYNC: "true" } }, { services: ["web"] });
    expect(drift).toEqual([{ service: "web", key: "(service)", expected: "<declared in baseline render>", actual: "<missing from baseline render>" }]);
  });

  it("P0-4: fails closed (not a vacuous pass) when the actual side has no readable environment for a service at all", () => {
    const drift = findActualDrift({ web: { environment: { FEATURE_NOVEL_CATALOG_SYNC: "true" } } }, {}, { services: ["web"] });
    expect(drift).toEqual([{ service: "web", key: "(service)", expected: "<running container>", actual: "<no container / unreadable environment>" }]);
  });

  it("throws rather than silently reconciling nothing when called with an empty services list", () => {
    expect(() => findActualDrift(baselineServices, {}, { services: [] })).toThrow(/non-empty/);
  });

  it("treats a missing actual value as an explicit 'missing from container', not a silent pass", () => {
    const drift = findActualDrift(
      { web: { environment: { FEATURE_NOVEL_CATALOG_SYNC: "true" } } },
      { web: {} },
      { services: ["web"] },
    );
    expect(drift).toEqual([{ service: "web", key: "FEATURE_NOVEL_CATALOG_SYNC", expected: "true", actual: "<missing from container>" }]);
  });

  // The exemption list itself must be explicit, documented, and pinned by a
  // test -- "决策一": "豁免必须是显式的、带注释说明理由的短名单,且豁免本身要有
  // 测试钉住".
  describe("BASE_IMAGE_BAKED_KEYS exemption (documented, short, tested)", () => {
    it("is the exact short list this patch empirically confirmed against the real running containers", () => {
      expect([...BASE_IMAGE_BAKED_KEYS].sort()).toEqual(
        ["HOSTNAME", "NEXT_TELEMETRY_DISABLED", "NODE_VERSION", "PATH", "PORT", "YARN_VERSION"].sort(),
      );
    });

    it("does not flag an exempted key present only in the container WHEN its value matches the image's own baked default", () => {
      const drift = findActualDrift(
        { worker: { environment: { FEATURE_NOVEL_CATALOG_SYNC: "true" } } },
        { worker: { FEATURE_NOVEL_CATALOG_SYNC: "true", PATH: "/usr/bin", NODE_VERSION: "20.20.2" } },
        {
          services: ["worker"],
          allowedExtraKeys: BASE_IMAGE_BAKED_KEYS,
          imageBakedEnv: { PATH: "/usr/bin", NODE_VERSION: "20.20.2" },
        },
      );
      expect(drift).toEqual([]);
    });

    // Terminal review, release-identity gate second round, finding 一: this
    // is the direct regression test. Before the fix, `allowedExtra.has(key)`
    // alone made this a bare `continue` -- ANY value was accepted for an
    // exempted key, on the theory that the image-digest check already pins
    // it. That theory is false: a container can be CREATED with an env
    // override for a key that also happens to be baked into the image
    // (`docker run -e` / a compose `environment:` entry), which changes
    // nothing about `.Image`'s digest at all. The exemption must only cover
    // "the container has exactly what the image bakes in by default", not
    // "the container has anything at all".
    it("finding 一: FLAGS an exempted key whose actual value diverges from the image's own baked default (was previously accepted unconditionally)", () => {
      const drift = findActualDrift(
        { worker: { environment: { FEATURE_NOVEL_CATALOG_SYNC: "true" } } },
        { worker: { FEATURE_NOVEL_CATALOG_SYNC: "true", PATH: "/usr/bin" } },
        {
          services: ["worker"],
          allowedExtraKeys: BASE_IMAGE_BAKED_KEYS,
          // The image itself bakes in a DIFFERENT default than what the
          // container was actually created with.
          imageBakedEnv: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
        },
      );
      expect(drift).toEqual([
        {
          service: "worker",
          key: "PATH",
          expected: "<image-baked default: /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin>",
          actual: "/usr/bin",
        },
      ]);
    });

    it("finding 一: FLAGS an exempted key when imageBakedEnv was never resolved for it at all (fail closed, not a silent pass)", () => {
      const drift = findActualDrift(
        { worker: { environment: { FEATURE_NOVEL_CATALOG_SYNC: "true" } } },
        { worker: { FEATURE_NOVEL_CATALOG_SYNC: "true", PATH: "/usr/bin" } },
        { services: ["worker"], allowedExtraKeys: BASE_IMAGE_BAKED_KEYS, imageBakedEnv: {} },
      );
      expect(drift).toEqual([
        {
          service: "worker",
          key: "PATH",
          expected: "<not declared in baseline render, and not baked into the identity-bound image either>",
          actual: "/usr/bin",
        },
      ]);
    });

    it("still flags a non-exempted extra key even when the exemption list is supplied", () => {
      const drift = findActualDrift(
        { worker: { environment: { FEATURE_NOVEL_CATALOG_SYNC: "true" } } },
        { worker: { FEATURE_NOVEL_CATALOG_SYNC: "true", PATH: "/usr/bin", ANOTHER_SURPRISE: "x" } },
        { services: ["worker"], allowedExtraKeys: BASE_IMAGE_BAKED_KEYS, imageBakedEnv: { PATH: "/usr/bin" } },
      );
      expect(drift).toEqual([{ service: "worker", key: "ANOTHER_SURPRISE", expected: "<not declared in baseline render>", actual: "x" }]);
    });

    it("without an exemption list at all, even PATH is flagged (proves the exemption is opt-in, not implicit)", () => {
      const drift = findActualDrift(
        { worker: { environment: { FEATURE_NOVEL_CATALOG_SYNC: "true" } } },
        { worker: { FEATURE_NOVEL_CATALOG_SYNC: "true", PATH: "/usr/bin" } },
        { services: ["worker"] },
      );
      expect(drift).toEqual([{ service: "worker", key: "PATH", expected: "<not declared in baseline render>", actual: "/usr/bin" }]);
    });
  });

  // 2026-09-06 patch (second round), group 4: the per-key loop only ever
  // visits keys that appear in the UNION of the baseline render's declared
  // keys and the actual container's keys -- a key declared on NEITHER side
  // (e.g. a future docker-compose.yml edit that drops
  // FEATURE_NOVEL_CATALOG_SYNC from a service's `environment:` block
  // entirely) is simply absent from that union and the loop never sees it,
  // a silent vacuous pass for exactly the two variables this whole gate
  // command exists to police. requiredKeys closes that gap.
  describe("requiredKeys (group 4: fail closed when a required key is declared on NEITHER side)", () => {
    it("CATALOG_GATE_ENV_KEYS is exactly the two catalog-write double-gate variables", () => {
      expect([...CATALOG_GATE_ENV_KEYS].sort()).toEqual(["FEATURE_NOVEL_CATALOG_SYNC", "NOVEL_CATALOG_SYNC_ALLOW_WRITE"]);
    });

    it("fails closed when a required key is absent from BOTH the baseline render and the actual container", () => {
      const drift = findActualDrift(
        { web: { environment: { SOME_OTHER_KEY: "x" } } },
        { web: { SOME_OTHER_KEY: "x" } },
        { services: ["web"], requiredKeys: ["FEATURE_NOVEL_CATALOG_SYNC"] },
      );
      expect(drift).toEqual([
        {
          service: "web",
          key: "FEATURE_NOVEL_CATALOG_SYNC",
          expected: "<required key, but declared in neither the baseline render nor the actual container>",
          actual: "<absent from both>",
        },
      ]);
    });

    it("does not double-report a required key that IS declared on at least one side -- the normal per-key check already covers it", () => {
      const drift = findActualDrift(
        { web: { environment: { FEATURE_NOVEL_CATALOG_SYNC: "true" } } },
        { web: {} },
        { services: ["web"], requiredKeys: ["FEATURE_NOVEL_CATALOG_SYNC"] },
      );
      expect(drift).toEqual([{ service: "web", key: "FEATURE_NOVEL_CATALOG_SYNC", expected: "true", actual: "<missing from container>" }]);
    });

    it("without requiredKeys at all, a key absent from both sides is silently invisible (documents the exact blind spot requiredKeys closes)", () => {
      const drift = findActualDrift({ web: { environment: {} } }, { web: {} }, { services: ["web"] });
      expect(drift).toEqual([]);
    });
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

  it("P1-5: exits 1 via the CLI too when only a top-level field differs", () => {
    dir = mkdtempSync(join(tmpdir(), "x8-gate-diff-cli-"));
    try {
      const baseline = write("baseline.json", { name: "cps-novel-x8-local", services: { web: { environment: { FEATURE_NOVEL_CATALOG_SYNC: "false" } } } });
      const candidate = write("candidate.json", { name: "renamed-project", services: { web: { environment: { FEATURE_NOVEL_CATALOG_SYNC: "false" } } } });
      const result = spawnSync("node", [diffScript, "rendered", baseline, candidate, "FEATURE_NOVEL_CATALOG_SYNC"], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("(top-level)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 on actual-container drift and 0 when it matches", () => {
    dir = mkdtempSync(join(tmpdir(), "x8-gate-diff-cli-"));
    try {
      const baseline = write("baseline.json", { services: { web: { environment: { FEATURE_NOVEL_CATALOG_SYNC: "true" } } } });
      const spec = write("spec.json", { services: ["web"] });
      const actualMismatch = write("actual-mismatch.json", { web: { FEATURE_NOVEL_CATALOG_SYNC: "false" } });
      const mismatch = spawnSync("node", [diffScript, "actual", baseline, actualMismatch, spec], { encoding: "utf8" });
      expect(mismatch.status).toBe(1);
      expect(mismatch.stderr).toContain("ACTUAL_CONTAINER_DRIFT");

      const actualMatch = write("actual-match.json", { web: { FEATURE_NOVEL_CATALOG_SYNC: "true" } });
      const match = spawnSync("node", [diffScript, "actual", baseline, actualMatch, spec], { encoding: "utf8" });
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
