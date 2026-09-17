import { describe, expect, it } from "vitest";

import { CAROUSEL_SOURCES } from "@/domain/database-statuses";

import { NOW, FakeHomeCarouselDb } from "./support";

/**
 * Direct tests of `FakeHomeCarouselDb`'s `homeCarouselServing.createMany`
 * CHECK/uniqueness simulation (`tests/backend/home-carousel/support.ts`) —
 * the fake half of the `20260912100000_carousel_serving_source_check_fix`
 * schema-contract-drift fix. `compute.test.ts`/`merge.test.ts` only ever
 * exercise this through `computeHomeCarouselInTx`, which (after this fix)
 * never writes an invalid row — so the negative branches below are the only
 * place in this suite that actually calls the fake's `createMany` with a
 * row real PostgreSQL would reject, proving the simulation matches the real
 * `home_carousel_serving_source_check`/`carousel_serving_position_check`/
 * `carousel_serving_locale_position_key` constraints (not merely
 * self-consistent with whatever `service.ts` happens to write today).
 */
function row(overrides: Partial<{ locale: string; position: number; novelId: string; articleId: string; source: string; manualSlotId: string | null; batchId: string | null; mergedAt: Date }> = {}) {
  return {
    locale: "en",
    position: 1,
    novelId: "novel-1",
    articleId: "article-1",
    source: "manual",
    manualSlotId: null,
    batchId: null,
    mergedAt: NOW,
    ...overrides,
  };
}

describe("FakeHomeCarouselDb homeCarouselServing.createMany CHECK simulation", () => {
  it("accepts every CAROUSEL_SOURCES member", async () => {
    const db = new FakeHomeCarouselDb();
    const tx = db.asTransactionClient() as unknown as { homeCarouselServing: { createMany: (args: { data: unknown[] }) => Promise<{ count: number }> } };
    for (const [index, source] of CAROUSEL_SOURCES.entries()) {
      const result = await tx.homeCarouselServing.createMany({ data: [row({ position: index + 1, source })] });
      expect(result.count).toBe(1);
    }
    expect(db.serving.map((r) => r.source).sort()).toEqual([...CAROUSEL_SOURCES].sort());
  });

  it("rejects a source outside CAROUSEL_SOURCES with a CHECK-shaped error, same as real PostgreSQL 23514, and writes nothing", async () => {
    const db = new FakeHomeCarouselDb();
    const tx = db.asTransactionClient() as unknown as { homeCarouselServing: { createMany: (args: { data: unknown[] }) => Promise<{ count: number }> } };
    // "automatic" is the exact stale value the pre-fix CHECK used to allow
    // and no code path ever wrote — see database-statuses.ts's CAROUSEL_SOURCES
    // doc comment and the fix migration's own header.
    await expect(tx.homeCarouselServing.createMany({ data: [row({ source: "automatic" })] }))
      .rejects.toThrow(/home_carousel_serving_source_check/);
    expect(db.serving).toHaveLength(0);
  });

  it("rejects position <= 0", async () => {
    const db = new FakeHomeCarouselDb();
    const tx = db.asTransactionClient() as unknown as { homeCarouselServing: { createMany: (args: { data: unknown[] }) => Promise<{ count: number }> } };
    await expect(tx.homeCarouselServing.createMany({ data: [row({ position: 0 })] }))
      .rejects.toThrow(/carousel_serving_position_check/);
    expect(db.serving).toHaveLength(0);
  });

  it("rejects a (locale, position) that collides with an existing row", async () => {
    const db = new FakeHomeCarouselDb();
    const tx = db.asTransactionClient() as unknown as { homeCarouselServing: { createMany: (args: { data: unknown[] }) => Promise<{ count: number }> } };
    await tx.homeCarouselServing.createMany({ data: [row({ locale: "en", position: 1 })] });
    await expect(tx.homeCarouselServing.createMany({ data: [row({ locale: "en", position: 1, novelId: "novel-2", articleId: "article-2" })] }))
      .rejects.toThrow(/carousel_serving_locale_position_key/);
    expect(db.serving).toHaveLength(1);
  });

  it("rejects a (locale, position) collision within the same createMany batch (mirrors a real multi-row INSERT)", async () => {
    const db = new FakeHomeCarouselDb();
    const tx = db.asTransactionClient() as unknown as { homeCarouselServing: { createMany: (args: { data: unknown[] }) => Promise<{ count: number }> } };
    await expect(tx.homeCarouselServing.createMany({
      data: [row({ locale: "en", position: 1 }), row({ locale: "en", position: 1, novelId: "novel-2", articleId: "article-2" })],
    })).rejects.toThrow(/carousel_serving_locale_position_key/);
    expect(db.serving).toHaveLength(0);
  });

  it("is all-or-nothing: one bad row in a batch leaves every other row in that same batch uncommitted too", async () => {
    const db = new FakeHomeCarouselDb();
    const tx = db.asTransactionClient() as unknown as { homeCarouselServing: { createMany: (args: { data: unknown[] }) => Promise<{ count: number }> } };
    await expect(tx.homeCarouselServing.createMany({
      data: [row({ locale: "en", position: 1, source: "manual" }), row({ locale: "en", position: 2, source: "recency" }), row({ locale: "en", position: 3, source: "automatic" })],
    })).rejects.toThrow(/home_carousel_serving_source_check/);
    expect(db.serving).toHaveLength(0);
  });
});
