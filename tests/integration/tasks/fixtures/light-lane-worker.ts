/** Disposable load driver: real worker loop/store; local HTTP replaces claim business work. */
import { PrismaClient } from "@prisma/client";
import { buildWorkerAllowlist, createHandlerRegistry } from "../../../../src/lib/tasks";
import { runWorker } from "../../../../worker/runtime";
import { createSitemapRefreshWorkerHandlers } from "../../../../worker/handlers/sitemap-refresh";

const prisma = new PrismaClient();
const controller = new AbortController();
process.on("SIGTERM", () => controller.abort());
const handlers = createHandlerRegistry({
  ...createSitemapRefreshWorkerHandlers(prisma, { rootDir: process.env.SITEMAP_STATIC_DIR }),
  "promo_link.claim.v1": { family: "generic", maxAttempts: 1, handler: async () => {
    const response = await fetch(process.env.WO5_MOCK_UPSTREAM!);
    if (!response.ok) throw new Error("local_upstream_failed");
    return { status: "success" };
  } },
});
process.send?.({ event: "ready" });
process.once("message", async () => {
  try {
    await runWorker({ prisma, handlers, allowlist: buildWorkerAllowlist(process.env.WORKER_TASK_ALLOWLIST, handlers),
      workerId: process.env.WORKER_ID!, pollMs: 1000, signal: controller.signal });
  } finally { await prisma.$disconnect(); }
});
