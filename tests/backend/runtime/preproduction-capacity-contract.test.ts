import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Capacity work order (Owner 2026-09-27): haiyue-vps is both preproduction
// and the eventual production host -- 4 vCPU, 16 GiB RAM, no swap, SSD (see
// infra/preproduction/README.md's "Capacity" section for the full measured
// baseline and every value's rationale). This contract test is the
// regression guard for that tuning: nothing previously asserted
// mem_limit/shm_size/NODE_OPTIONS at all, so a future edit silently
// dropping one, or accidentally syncing it into the wrong overlay, would
// otherwise only be caught by someone reading the compose files by eye.

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const files = [
  "docker-compose.yml",
  "infra/preproduction/docker-compose.yml",
  "infra/production-like/docker-compose.yml",
] as const;

function dummyEnvFor(activeFiles: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME };
  for (const file of activeFiles) {
    for (const match of read(file).matchAll(/\$\{([A-Z0-9_]+):\?/g)) {
      env[match[1]] = "/tmp/capacity-contract-fixture";
    }
  }
  Object.assign(env, {
    CPS_NOVEL_APP_IMAGE: "cps-novel:capacity-contract-test",
    APP_VERSION: "0.1.0",
    GIT_COMMIT: "a".repeat(40),
    BUILD_DATE: "2026-09-27T00:00:00Z",
    NEXT_PUBLIC_BUILD_VERSION: "v0.1.0",
    P1_12_COMPOSE_PROJECT: "cps-novel-capacity-contract",
    SITE_URL: "https://novel.example",
    TZ: "Asia/Tokyo",
    TRACKING_HASH_SALT: "capacity-contract-salt",
    TOTP_ENCRYPTION_KEY: "capacity-contract-totp",
    CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION: "1",
    WORKER_TASK_ALLOWLIST: "credential.validate.v1,credential.supersede.v1,catalog_scan",
    WORKER_LIGHT_ID: "capacity-light",
    WORKER_LIGHT_TASK_ALLOWLIST: "sitemap_refresh,sitemap.daily_fallback.v1,home_carousel.compute.v1",
  });
  return env;
}

const dockerComposeAvailable = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;

function renderServices(overlay: string | undefined): Record<string, any> {
  const activeFiles = overlay ? [files[0], overlay] : [files[0]];
  const args = ["compose", "-f", resolve(root, files[0]), ...(overlay ? ["-f", resolve(root, overlay)] : []), "config", "--format", "json"];
  const result = spawnSync("docker", args, { cwd: root, env: dummyEnvFor(activeFiles), encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout).services;
}

describe("Capacity: postgresql.conf.example static contract", () => {
  const conf = read("infra/postgres/pitr/postgresql.conf.example");

  it("tunes memory/planner GUCs to the 16 GiB haiyue-vps baseline", () => {
    expect(conf).toContain("shared_buffers = 4GB");
    expect(conf).toContain("effective_cache_size = 10GB");
    expect(conf).toContain("work_mem = 16MB");
    expect(conf).toContain("maintenance_work_mem = 512MB");
    expect(conf).toContain("random_page_cost = 1.1");
    expect(conf).toContain("effective_io_concurrency = 200");
    expect(conf).toContain("max_parallel_workers_per_gather = 2");
    expect(conf).toContain("max_worker_processes = 8");
    expect(conf).toContain("max_parallel_workers = 4");
    // max_connections stays at the pre-existing value -- explicitly NOT
    // raised or lowered; the connection-budget algebra justifying "unchanged"
    // lives in this file's own comment directly above the setting.
    expect(conf).toContain("max_connections = 100");
    expect((conf.match(/^max_connections = /gm) ?? [])).toHaveLength(1);
  });
});

describe.skipIf(!dockerComposeAvailable)("Capacity: rendered compose contract", () => {
  it("preproduction overlay: postgres gets shm_size but no mem_limit; app services get mem_limit + matching NODE_OPTIONS", () => {
    const services = renderServices(files[1]);
    // `docker compose config --format json` serializes shm_size as a
    // string, unlike mem_limit below (a number) -- confirmed empirically
    // against Compose v5.0.1's actual output rather than assumed.
    expect(services.postgres.shm_size).toBe("1073741824");
    expect(services.postgres.mem_limit).toBeUndefined();

    const expectations: Record<string, { mem_limit: number; heapMiB: number }> = {
      web: { mem_limit: 2 * 1024 * 1024 * 1024, heapMiB: 1536 },
      worker: { mem_limit: 2 * 1024 * 1024 * 1024, heapMiB: 1536 },
      "worker-light": { mem_limit: 1 * 1024 * 1024 * 1024, heapMiB: 768 },
      scheduler: { mem_limit: 512 * 1024 * 1024, heapMiB: 384 },
    };
    for (const [name, expected] of Object.entries(expectations)) {
      const service = services[name];
      // `docker compose config --format json` serializes mem_limit as a
      // string too (same as shm_size above) -- confirmed empirically, not
      // assumed from the YAML-mode output shape.
      expect(service.mem_limit, `${name}.mem_limit`).toBe(String(expected.mem_limit));
      expect(service.environment.NODE_OPTIONS, `${name}.NODE_OPTIONS`).toBe(`--max-old-space-size=${expected.heapMiB}`);
      // 75%-of-limit rule, checked arithmetically rather than just against a
      // literal -- a future mem_limit edit that forgets to update the
      // matching NODE_OPTIONS is caught even if someone changes both
      // numbers to something new but forgets to keep the ratio.
      const heapBytes = expected.heapMiB * 1024 * 1024;
      expect(heapBytes / expected.mem_limit).toBeCloseTo(0.75, 2);
    }
  });

  it("production-like overlay (local X8 rehearsal): capacity tuning is deliberately NOT synced", () => {
    const services = renderServices(files[2]);
    expect(services.postgres.shm_size).toBeUndefined();
    for (const name of ["web", "worker", "worker-light", "scheduler"]) {
      expect(services[name].mem_limit, `${name}.mem_limit`).toBeUndefined();
      expect(services[name].environment.NODE_OPTIONS, `${name}.NODE_OPTIONS`).toBeUndefined();
    }
  });

  it("base compose file alone carries none of this -- the tuning is preproduction-overlay-only", () => {
    const services = renderServices(undefined);
    expect(services.postgres.shm_size).toBeUndefined();
    for (const name of ["web", "worker", "worker-light", "scheduler"]) {
      expect(services[name].mem_limit, `${name}.mem_limit`).toBeUndefined();
      expect(services[name].environment.NODE_OPTIONS, `${name}.NODE_OPTIONS`).toBeUndefined();
    }
  });
});
