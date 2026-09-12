import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import type { TaskHandlerContext, TaskLease } from "@/lib/tasks";
import { SITE_LOCALES } from "@/lib/locale/locale-canonical";

import { createHomeCarouselHandler } from "../../../worker/handlers/home-carousel";

/**
 * L10N P5 (矩阵 #13): `createHomeCarouselHandler` used to hardcode
 * `payload?.locale !== "en"` — a validation gate that would have rejected
 * every non-`en` item a multi-locale cron run enqueues
 * (`buildHomeCarouselCronTaskInput`, `src/server/home-carousel/service.ts`)
 * with `home_carousel_payload_invalid`, even though nothing downstream of
 * the gate (`computeHomeCarouselInTx`) is `en`-specific at all. This file
 * never existed before P5 — the handler had zero unit coverage.
 *
 * `protectedWrite` deliberately not exercised here (it needs a real
 * `Prisma.TransactionClient` and duplicates `compute.test.ts`'s own
 * coverage of `computeHomeCarouselInTx`) — this file is scoped to the
 * validation gate itself.
 */

function lease(payload: unknown): TaskLease {
  return {
    family: "generic",
    taskType: "home_carousel.compute.v1",
    mode: "apply",
    itemId: "item-1",
    taskId: "task-1",
    workerId: "worker-1",
    executionToken: "token-1",
    leaseEpoch: 1n,
    attemptCount: 1,
    lockedUntil: new Date(),
    payload,
  };
}

function context(payload: unknown): TaskHandlerContext {
  return { lease: lease(payload), mode: "apply", signal: new AbortController().signal, heartbeat: async () => true };
}

describe("createHomeCarouselHandler — locale payload validation (L10N P5)", () => {
  const handler = createHomeCarouselHandler({} as PrismaClient);

  it("accepts every registered SITE_LOCALES member, not just en", async () => {
    for (const locale of SITE_LOCALES) {
      const outcome = await handler(context({ locale, source: "cron" }));
      expect(outcome.status, `locale ${locale}`).toBe("success");
      expect(outcome.protectedWrite, `locale ${locale}`).toBeTypeOf("function");
    }
  });

  // Mutation guard for §4's own regression: reverting the check back to
  // `payload?.locale !== "en"` would make this go red (ru rejected).
  it("a real non-en site locale (ru) is accepted — the mutation target this test would catch", async () => {
    const outcome = await handler(context({ locale: "ru", source: "cron" }));
    expect(outcome.status).toBe("success");
  });

  it("rejects a locale that is not a registered SITE_LOCALES member (e.g. it, fil — resolved by channel-language.ts but not a site locale)", async () => {
    const outcome = await handler(context({ locale: "it", source: "cron" }));
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatchObject({ code: "home_carousel_payload_invalid" });
  });

  it("rejects a non-string locale", async () => {
    const outcome = await handler(context({ locale: 3, source: "cron" }));
    expect(outcome.status).toBe("failed");
  });

  it("rejects a missing/undefined locale", async () => {
    const outcome = await handler(context({ source: "cron" }));
    expect(outcome.status).toBe("failed");
  });

  it("still rejects an invalid source (locale check alone is not sufficient)", async () => {
    const outcome = await handler(context({ locale: "en", source: "not_a_real_source" }));
    expect(outcome.status).toBe("failed");
  });
});
