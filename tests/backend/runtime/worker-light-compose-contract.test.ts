import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { APPROVED_LIGHT_TASK_TYPES, validateWorkerLaneEnvironment } from "@/lib/tasks/worker-lanes.mjs";

const files = ["docker-compose.yml", "infra/preproduction/docker-compose.yml", "infra/production-like/docker-compose.yml"];
const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME };
for (const file of files) {
  for (const match of readFileSync(file, "utf8").matchAll(/\$\{([A-Z0-9_]+):\?/g)) env[match[1]] = "/tmp/wo5-compose-fixture";
}
Object.assign(env, {
  CPS_NOVEL_APP_IMAGE: "cps-novel:wo5-test", APP_VERSION: "0.4.5", GIT_COMMIT: "a".repeat(40),
  SITE_URL: "https://example.test", TZ: "Asia/Tokyo", BUILD_DATE: "2026-09-26T00:00:00Z",
  WORKER_ID: "main-test", WORKER_LIGHT_ID: "light-test", WORKER_LANE: "main",
  WORKER_TASK_ALLOWLIST: "catalog_scan", WORKER_LIGHT_TASK_ALLOWLIST: APPROVED_LIGHT_TASK_TYPES.join(","),
});

describe("worker-light rendered deployment contract", () => {
  it.each([undefined, files[1], files[2]])("preserves shared runtime and maps lane variables: %s", overlay => {
    const args = ["compose", "-f", files[0], ...(overlay ? ["-f", overlay] : []), "config", "--format", "json"];
    const result = spawnSync("docker", args, { env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const services = JSON.parse(result.stdout).services;
    const main = services.worker; const light = services["worker-light"];
    validateWorkerLaneEnvironment(env);
    expect(light.environment.WORKER_TASK_ALLOWLIST).toBe(env.WORKER_LIGHT_TASK_ALLOWLIST);
    expect(light.environment.WORKER_ID).toBe(env.WORKER_LIGHT_ID);
    expect(light.environment.WORKER_LANE).toBe("light");
    const sharedEnvironment = (environment: Record<string, string>) => Object.fromEntries(
      Object.entries(environment).filter(([key]) => !["WORKER_ID", "WORKER_TASK_ALLOWLIST", "WORKER_LANE", "NODE_OPTIONS"].includes(key)),
    );
    const shared = sharedEnvironment(main.environment);
    const lightShared = sharedEnvironment(light.environment);
    expect(lightShared).toEqual(shared);
    for (const key of ["image", "command", "healthcheck", "logging", "secrets", "volumes", "stop_grace_period"]) expect(light[key], key).toEqual(main[key]);
    if (overlay === files[1]) { expect(light.build).toBeUndefined(); expect(light.pull_policy).toBe("never"); }
    // Capacity work order (Owner 2026-09-27): NODE_OPTIONS is excluded from
    // sharedEnvironment() above like the other lane-specific keys, but
    // unlike those (which are always set on both services), NODE_OPTIONS is
    // ONLY set by the preproduction overlay's own capacity mem_limit/heap
    // budget (infra/preproduction/docker-compose.yml) -- neither the base
    // compose file nor infra/production-like/docker-compose.yml (local X8
    // rehearsal, deliberately not synced to this capacity work, see that
    // file's own README section) set it at all. worker-light legitimately
    // gets a SMALLER heap cap than worker (768 vs 1536 MiB, matching its
    // smaller 1g vs 2g mem_limit), so asserting equality here would be
    // asserting the wrong thing -- this asserts the actual intended values
    // instead, so a value silently drifting to match worker's (defeating
    // worker-light's whole point) or a value from this overlay leaking into
    // the other two files would both be caught.
    if (overlay === files[1]) {
      expect(main.environment.NODE_OPTIONS).toBe("--max-old-space-size=1536");
      expect(light.environment.NODE_OPTIONS).toBe("--max-old-space-size=768");
    } else {
      expect(main.environment.NODE_OPTIONS).toBeUndefined();
      expect(light.environment.NODE_OPTIONS).toBeUndefined();
    }
  });
});
