import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { buildWorkerAllowlist, createHandlerRegistry } from "@/lib/tasks";
import { runWorker } from "../../../worker/runtime/worker";
const state = vi.hoisted(() => ({ queue: [] as string[], order: [] as string[], controller: new AbortController(), claims: 0 }));
vi.mock("@/lib/tasks", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/tasks")>();
  return { ...actual,
    recoverExpiredItem: vi.fn().mockResolvedValue(null),
    heartbeatTaskItem: vi.fn().mockResolvedValue(true),
    finalizeTaskItem: vi.fn().mockResolvedValue(undefined),
    claimPendingItem: vi.fn(async (_db, input) => {
      state.claims++;
      const index = state.queue.findIndex(type => input.taskTypes.includes(type));
      if (index < 0) { if (!state.queue.length) state.controller.abort(); return null; }
      const [taskType] = state.queue.splice(index, 1);
      return { family: "generic", taskType, mode: "apply", taskId: "task", itemId: "item", executionToken: "token", leaseEpoch: 1n, attemptCount: 1, workerId: "test", payload: {} };
    }),
  };
});
const delivery = "indexnow_delivery";
const short = "sitemap_refresh";
async function drain(queue: string[], lane: "light" | "main", types = [short, delivery]) {
  state.queue = [...queue]; state.order = []; state.claims = 0; state.controller = new AbortController();
  const handlers = createHandlerRegistry(Object.fromEntries(types.map(type => [type, { family: "generic" as const,
    handler: async () => { state.order.push(type); return { status: "success" as const }; },
  }])));
  await runWorker({ prisma: {} as PrismaClient, handlers, allowlist: buildWorkerAllowlist(types.join(","), handlers),
    workerId: "test", lane, signal: state.controller.signal });
  return state.order;
}
describe("light two-group fairness using the worker drain loop", () => {
  it("interleaves busy groups instead of draining delivery FIFO first", async () => {
    expect(await drain([delivery, delivery, delivery, short, short], "light")).toEqual([short, delivery, short, delivery, delivery]);
  });
  it.each([[delivery, delivery], [short, short], []])("does not stall when a group is empty: %j", async (...queue) => {
    expect(await drain(queue, "light")).toEqual(queue);
  });
  it("preserves main FIFO across ordinary task types", async () => {
    expect(await drain(["catalog_scan", "catalog_scan", "promo_link.claim.v1"], "main", ["catalog_scan", "promo_link.claim.v1"])).toEqual(["catalog_scan", "catalog_scan", "promo_link.claim.v1"]);
  });
  it("a light worker with only one enabled group still drains it", async () => {
    expect(await drain([delivery, delivery], "light", [delivery])).toEqual([delivery, delivery]);
  });
});
