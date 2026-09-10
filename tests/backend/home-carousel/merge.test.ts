import { describe, expect, it } from "vitest";

import { computeHomeCarouselInTx } from "@/server/home-carousel";

import { FakeHomeCarouselDb, type FakeArticle, type FakeManualSlot } from "./support";

const NOW = new Date("2026-09-05T19:00:00.000Z");
const DAY = 86_400_000;

function article(overrides: Partial<FakeArticle> & { id: string; novelId: string }): FakeArticle {
  return {
    locale: "en",
    status: "published",
    deletedAt: null,
    publishedAt: new Date(NOW.getTime() - 90 * DAY),
    updatedAt: new Date(NOW.getTime() - 90 * DAY),
    novel: { title: `Novel ${overrides.novelId}`, status: "published", deletedAt: null, coverUrl: "https://cdn.example.com/cover.jpg" },
    ...overrides,
  };
}

function manualSlot(overrides: Partial<FakeManualSlot> & { id: string; position: number; novelId: string; articleId: string }): FakeManualSlot {
  return {
    locale: "en",
    enabled: true,
    startsAt: null,
    endsAt: null,
    deletedAt: null,
    createdBy: "admin-1",
    updatedBy: "admin-1",
    ...overrides,
  };
}

describe("computeHomeCarouselInTx merge (PR6 fix B-2: dedup mutation must be caught)", () => {
  it("dedupes a novel that is both a manual slot and an auto candidate, keeping the manual entry", async () => {
    const db = new FakeHomeCarouselDb();
    db.seedArticle(article({ id: "shared-article", novelId: "novel-shared", updatedAt: NOW }));
    db.seedManualSlot(manualSlot({ id: "slot-1", position: 1, novelId: "novel-shared", articleId: "shared-article" }));
    for (let i = 0; i < 4; i += 1) {
      db.seedArticle(article({ id: `filler-${i}`, novelId: `novel-filler-${i}`, updatedAt: new Date(NOW.getTime() - (i + 1) * DAY) }));
    }

    await computeHomeCarouselInTx(db.asTransactionClient(), { locale: "en", source: "manual", now: NOW });

    const novelIds = db.serving.map((row) => row.novelId);
    expect(novelIds.filter((id) => id === "novel-shared")).toHaveLength(1);
    const sharedRow = db.serving.find((row) => row.novelId === "novel-shared");
    expect(sharedRow?.source).toBe("manual");
    expect(sharedRow?.position).toBe(1);
  });

  it("never emits duplicate novelIds in serving even with several overlapping manual slots and candidates", async () => {
    const db = new FakeHomeCarouselDb();
    db.carouselConfigJson = { slotCount: 4 };
    db.seedManualSlot(manualSlot({ id: "slot-1", position: 1, novelId: "novel-a", articleId: "article-a" }));
    db.seedManualSlot(manualSlot({ id: "slot-2", position: 2, novelId: "novel-b", articleId: "article-b" }));
    db.seedArticle(article({ id: "article-a", novelId: "novel-a", updatedAt: NOW }));
    db.seedArticle(article({ id: "article-b", novelId: "novel-b", updatedAt: new Date(NOW.getTime() - DAY) }));
    db.seedArticle(article({ id: "article-c", novelId: "novel-c", updatedAt: new Date(NOW.getTime() - 2 * DAY) }));

    await computeHomeCarouselInTx(db.asTransactionClient(), { locale: "en", source: "manual", now: NOW });

    const novelIds = db.serving.map((row) => row.novelId);
    expect(new Set(novelIds).size).toBe(novelIds.length);
    expect(novelIds).toEqual(["novel-a", "novel-b", "novel-c"]);
  });

  it("ranks manual slots first (by position), then new_novel, then recency", async () => {
    const db = new FakeHomeCarouselDb();
    db.carouselConfigJson = { newSlotCount: 1, newNovelWindowDays: 14 };
    db.seedManualSlot(manualSlot({ id: "slot-1", position: 1, novelId: "novel-manual", articleId: "article-manual" }));
    db.seedArticle(article({ id: "article-manual", novelId: "novel-manual", updatedAt: new Date(NOW.getTime() - 5 * DAY) }));
    db.seedArticle(article({ id: "article-fresh", novelId: "novel-fresh", publishedAt: new Date(NOW.getTime() - 1 * DAY), updatedAt: new Date(NOW.getTime() - 1 * DAY) }));
    db.seedArticle(article({ id: "article-old", novelId: "novel-old", updatedAt: new Date(NOW.getTime() - 60 * DAY) }));

    await computeHomeCarouselInTx(db.asTransactionClient(), { locale: "en", source: "manual", now: NOW });

    const bySource = Object.fromEntries(db.serving.map((row) => [row.novelId, row.source]));
    expect(bySource["novel-manual"]).toBe("manual");
    expect(bySource["novel-fresh"]).toBe("new_novel");
    expect(bySource["novel-old"]).toBe("recency");
    const positions = Object.fromEntries(db.serving.map((row) => [row.novelId, row.position]));
    expect(positions["novel-manual"]).toBeLessThan(positions["novel-fresh"]);
    expect(positions["novel-fresh"]).toBeLessThan(positions["novel-old"]);
  });
});
