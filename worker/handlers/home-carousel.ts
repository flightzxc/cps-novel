import type { PrismaClient } from "@prisma/client";
import { createHandlerRegistry, type TaskHandler } from "../../src/lib/tasks";
import { SITE_LOCALES } from "../../src/lib/locale/locale-canonical";
import { computeHomeCarouselInTx, HOME_CAROUSEL_TASK_TYPE } from "../../src/server/home-carousel";

export function createHomeCarouselHandler(db: PrismaClient): TaskHandler {
  void db;
  return async ({ lease }) => {
    const payload = lease.payload as { locale?: unknown; source?: unknown; actorId?: unknown };
    // L10N P5 (矩阵 #13): was `payload?.locale !== "en"` — a hardcoded
    // single-locale gate that would have rejected every item a
    // multi-locale cron run enqueues (`buildHomeCarouselCronTaskInput`
    // now emits one item per active locale, not just `en`) with
    // `home_carousel_payload_invalid`. Membership in `SITE_LOCALES` is the
    // same registered-locale bar `enqueueHomeCarouselCompute` (the manual
    // trigger, `src/server/home-carousel/service.ts`) already lets any
    // caller-supplied `locale` through with no gate of its own — this
    // handler is the one place in the whole compute path that validated
    // the value at all, so it keeps doing that, just against the real
    // registry instead of a single literal.
    if (
      typeof payload?.locale !== "string" ||
      !(SITE_LOCALES as readonly string[]).includes(payload.locale) ||
      (payload.source !== "manual" && payload.source !== "cron")
    ) {
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
