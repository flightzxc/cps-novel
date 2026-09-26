import type { PrismaClient } from "@prisma/client";
import { isSitemapAutoRefreshEnabled, isSitemapAutoRefreshWriteAllowed } from "../../src/lib/flags";
import { createHandlerRegistry, type TaskHandler } from "../../src/lib/tasks";
import { enqueueSitemapRefresh } from "../../src/lib/tasks/sitemap-refresh";
import { SITEMAP_DAILY_FALLBACK_TASK_TYPE } from "../../src/lib/tasks/periodic-sweep";

export function createSitemapDailyFallbackHandler(env: NodeJS.ProcessEnv = process.env): TaskHandler {
  return async ({ lease }) => ({
    status: "success",
    protectedWrite: async tx => {
      if (!isSitemapAutoRefreshEnabled(env) || !isSitemapAutoRefreshWriteAllowed(env)) {
        return { status: "success", result: { decision: "write_gate_closed", message: "写闸关闭、跳过" } };
      }
      const result = await enqueueSitemapRefresh({ reason: "daily_fallback", triggeredBy: lease.workerId }, tx, { env });
      return { status: "success", result: { ...result, reason: "daily_fallback" } };
    },
  });
}
export function createSitemapDailyFallbackWorkerHandlers(_db: PrismaClient) {
  return createHandlerRegistry({
    [SITEMAP_DAILY_FALLBACK_TASK_TYPE]: { family: "generic", maxAttempts: 3, handler: createSitemapDailyFallbackHandler() },
  });
}
