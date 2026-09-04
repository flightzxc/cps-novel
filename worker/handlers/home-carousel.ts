import type { PrismaClient } from "@prisma/client";
import { createHandlerRegistry, type TaskHandler } from "../../src/lib/tasks";
import { computeHomeCarouselInTx, HOME_CAROUSEL_TASK_TYPE } from "../../src/server/home-carousel";

export function createHomeCarouselHandler(db: PrismaClient): TaskHandler {
  void db;
  return async ({ lease }) => {
    const payload = lease.payload as { locale?: unknown; source?: unknown; actorId?: unknown };
    if (payload?.locale !== "en" || (payload.source !== "manual" && payload.source !== "cron")) {
      return { status: "failed", error: { code: "home_carousel_payload_invalid", message: "Home carousel payload is invalid" } };
    }
    const source = payload.source;
    return {
      status: "success",
      result: { accepted: true },
      protectedWrite: async (tx) => {
        await computeHomeCarouselInTx(tx, {
          locale: payload.locale as string,
          source,
          ...(typeof payload.actorId === "string" ? { actorId: payload.actorId } : {}),
        });
      },
    };
  };
}

export function createHomeCarouselWorkerHandlers(db: PrismaClient) {
  return createHandlerRegistry({ [HOME_CAROUSEL_TASK_TYPE]: { family: "generic", maxAttempts: 3, handler: createHomeCarouselHandler(db) } });
}
