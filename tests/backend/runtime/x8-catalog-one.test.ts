import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  PATH_A_CATALOG_COORDINATES,
  parseCatalogOneArgs,
  runCatalogOne,
} from "../../../scripts/x8-catalog-one";

const root = resolve(import.meta.dirname, "../../..");
const launcher = readFileSync(resolve(root, "scripts/x8-production-like.sh"), "utf8");

describe("X8 Path-A catalog-one boundary", () => {
  const options = {
    taskId: "00000000-0000-4000-8000-000000000001",
    itemId: "00000000-0000-4000-8000-000000000002",
    actor: "path-a-operator",
  };
  const args = ["--task-id", options.taskId, "--item-id", options.itemId, "--actor", options.actor];
  const env = {
    NODE_ENV: "test",
    P1_12_COMPOSE_PROJECT: "cps-novel-x8-local",
    SITE_URL: "https://novel.test",
    FEATURE_NOVEL_CATALOG_SYNC: "true",
    NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true",
    WORKER_TASK_ALLOWLIST: "catalog_scan",
  } satisfies NodeJS.ProcessEnv;

  it("freezes the one-page request and one-attempt budget", () => {
    expect(PATH_A_CATALOG_COORDINATES).toEqual({ page: 1, pageSize: 20, projectType: 1, maxAttempts: 1 });
    expect(parseCatalogOneArgs(args)).toEqual(options);
    for (const invalid of [[], args.slice(0, 4), [...args, "--unknown", "value"], [...args.slice(0, 5), "Bearer secret"]]) {
      expect(() => parseCatalogOneArgs(invalid)).toThrow();
    }
  });

  it.each([
    [{ FEATURE_NOVEL_CATALOG_SYNC: "false" }, "catalog_write_gates_closed"],
    [{ NOVEL_CATALOG_SYNC_ALLOW_WRITE: "false" }, "catalog_write_gates_closed"],
    [{ WORKER_TASK_ALLOWLIST: "moboreader.preview_refresh.v1" }, "catalog_only_allowlist_required"],
    [{ P1_12_COMPOSE_PROJECT: "production" }, "local_topology_required"],
    [{ SITE_URL: "https://other.example" }, "local_topology_required"],
  ])("blocks before database or upstream access: %j", async (overrides, reason) => {
    const db = { $queryRaw: vi.fn() };
    expect(await runCatalogOne(db as never, options, { env: { ...env, ...overrides }, logger: () => undefined }))
      .toEqual({ outcome: "blocked", reason });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("requires the exact task coordinates before consumption", async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{ role: "worker_app" }]),
      catalogScanTaskItem: {
        findUnique: vi.fn().mockResolvedValue({
          taskId: options.taskId,
          pageIndex: 2,
          status: "pending",
          task: { mode: "apply", status: "pending", pageStart: 2, pageEnd: 2, pageSize: 20, projectType: 1 },
        }),
      },
    };
    expect(await runCatalogOne(db as never, options, { env, logger: () => undefined }))
      .toEqual({ outcome: "not_consumed", reason: "target_or_coordinates_not_eligible" });
  });

  it("runs only in a disposable worker after the permanent worker is stopped", () => {
    const entry = launcher.slice(launcher.indexOf("catalog_one()"), launcher.indexOf("accept_x8()"));
    expect(entry).toContain("x8_compose ps -q worker");
    expect(entry).toContain("operator_image=\"$(docker inspect --format '{{.Config.Image}}' \"$web_container\")\"");
    expect(entry).toContain("CPS_NOVEL_APP_IMAGE=\"$operator_image\" x8_compose run");
    expect(entry).toContain("WORKER_TASK_ALLOWLIST=catalog_scan");
    expect(entry).toContain("scripts/x8-catalog-one.ts");
    expect(entry).toContain("src/lib/adapters/moboreader.ts:/app/src/lib/adapters/moboreader.ts:ro");
    expect(entry).not.toContain("write_x8_gate_state");
  });
});
