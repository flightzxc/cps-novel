import { describe, expect, it } from "vitest";

import { computeHomeCarouselInTx } from "@/server/home-carousel";

import { FakeHomeCarouselDb, type FakeArticle } from "./support";

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

function seedSixOldArticles(db: FakeHomeCarouselDb) {
  for (let i = 0; i < 6; i += 1) {
    db.seedArticle(article({
      id: `article-${i}`,
      novelId: `novel-${i}`,
      updatedAt: new Date(NOW.getTime() - i * DAY - 90 * DAY),
      publishedAt: new Date(NOW.getTime() - i * DAY - 90 * DAY),
    }));
  }
}

describe("computeHomeCarouselInTx honors carouselConfigJson (PR6 fix B-1 #3)", () => {
  it("slotCount caps how many candidates/serving rows are produced", async () => {
    const dbDefault = new FakeHomeCarouselDb();
    seedSixOldArticles(dbDefault);
    const resultDefault = await computeHomeCarouselInTx(dbDefault.asTransactionClient(), { locale: "en", source: "manual", now: NOW });
    expect(resultDefault.count).toBe(5); // DEFAULT_HOME_CAROUSEL_CONFIG.slotCount

    const dbSmall = new FakeHomeCarouselDb();
    dbSmall.carouselConfigJson = { slotCount: 2 };
    seedSixOldArticles(dbSmall);
    const resultSmall = await computeHomeCarouselInTx(dbSmall.asTransactionClient(), { locale: "en", source: "manual", now: NOW });
    expect(resultSmall.count).toBe(2);
    expect(dbSmall.serving).toHaveLength(2);
  });

  it("newNovelWindowDays gates which candidates count as new_novel", async () => {
    const dbInWindow = new FakeHomeCarouselDb();
    dbInWindow.carouselConfigJson = { newNovelWindowDays: 14 };
    dbInWindow.seedArticle(article({ id: "fresh", novelId: "novel-fresh", publishedAt: new Date(NOW.getTime() - 1 * DAY), updatedAt: new Date(NOW.getTime() - 1 * DAY) }));
    seedSixOldArticles(dbInWindow);
    await computeHomeCarouselInTx(dbInWindow.asTransactionClient(), { locale: "en", source: "manual", now: NOW });
    const freshCandidateInWindow = dbInWindow.candidates.find((row) => row.novelId === "novel-fresh");
    expect(freshCandidateInWindow?.source).toBe("new_novel");

    const dbOutsideWindow = new FakeHomeCarouselDb();
    dbOutsideWindow.carouselConfigJson = { newNovelWindowDays: 0 };
    dbOutsideWindow.seedArticle(article({ id: "fresh", novelId: "novel-fresh", publishedAt: new Date(NOW.getTime() - 1 * DAY), updatedAt: new Date(NOW.getTime() - 1 * DAY) }));
    seedSixOldArticles(dbOutsideWindow);
    await computeHomeCarouselInTx(dbOutsideWindow.asTransactionClient(), { locale: "en", source: "manual", now: NOW });
    const freshCandidateOutsideWindow = dbOutsideWindow.candidates.find((row) => row.novelId === "novel-fresh");
    expect(freshCandidateOutsideWindow?.source).toBe("recency");
  });

  it("newSlotCount=0 folds an in-window article into recency instead of reserving a new_novel slot", async () => {
    const db = new FakeHomeCarouselDb();
    db.carouselConfigJson = { newSlotCount: 0 };
    db.seedArticle(article({ id: "fresh", novelId: "novel-fresh", publishedAt: new Date(NOW.getTime() - 1 * DAY), updatedAt: new Date(NOW.getTime() - 1 * DAY) }));
    seedSixOldArticles(db);
    await computeHomeCarouselInTx(db.asTransactionClient(), { locale: "en", source: "manual", now: NOW });
    expect(db.candidates.some((row) => row.source === "new_novel")).toBe(false);
  });

  it("cron:<businessDate> is idempotent: a same-day repeat hits P2002 and returns skipped_duplicate", async () => {
    const db = new FakeHomeCarouselDb();
    seedSixOldArticles(db);
    const first = await computeHomeCarouselInTx(db.asTransactionClient(), { locale: "en", source: "cron", now: NOW });
    expect(first.status).toBe("success");
    const second = await computeHomeCarouselInTx(db.asTransactionClient(), { locale: "en", source: "cron", now: NOW });
    expect(second).toEqual({ status: "skipped_duplicate" });
    expect(db.batches.size).toBe(1);
  });

  // L10N P5 (矩阵 #13, F). Mutation ② target: dropping `locale` from the
  // cron idempotency key (`cron:<businessDate>` instead of
  // `cron:<businessDate>:<locale>`) — that would make this test fail with
  // `second.status !== "success"` (the ru compute would collide with en's
  // already-created HomeCarouselAutoBatch row and get wrongly classified
  // as a same-day repeat).
  it("cron:<businessDate>:<locale> is per-locale: en and ru computes on the same business date do NOT collide with each other", async () => {
    const db = new FakeHomeCarouselDb();
    db.seedArticle(article({ id: "article-en", novelId: "novel-en", locale: "en" }));
    db.seedArticle(article({ id: "article-ru", novelId: "novel-ru", locale: "ru" }));

    const en = await computeHomeCarouselInTx(db.asTransactionClient(), { locale: "en", source: "cron", now: NOW });
    expect(en.status).toBe("success");
    const ru = await computeHomeCarouselInTx(db.asTransactionClient(), { locale: "ru", source: "cron", now: NOW });
    expect(ru.status).toBe("success");

    expect(db.batches.size).toBe(2);
    const uniqueKeys = [...db.batches.values()].map((batch) => batch.uniqueKey).sort();
    expect(uniqueKeys).toEqual(["cron:2026-09-06:en", "cron:2026-09-06:ru"]);

    // Each locale's own repeat still correctly dedupes against itself.
    const enRepeat = await computeHomeCarouselInTx(db.asTransactionClient(), { locale: "en", source: "cron", now: NOW });
    expect(enRepeat).toEqual({ status: "skipped_duplicate" });
    const ruRepeat = await computeHomeCarouselInTx(db.asTransactionClient(), { locale: "ru", source: "cron", now: NOW });
    expect(ruRepeat).toEqual({ status: "skipped_duplicate" });
    expect(db.batches.size).toBe(2);
  });

  it("revenueEnabled cannot be turned on through stored config (compute never sees a revenue branch)", async () => {
    const db = new FakeHomeCarouselDb();
    db.carouselConfigJson = { revenueEnabled: true };
    seedSixOldArticles(db);
    const result = await computeHomeCarouselInTx(db.asTransactionClient(), { locale: "en", source: "manual", now: NOW });
    expect(result.status).toBe("success");
    expect(dbBatchParams(db)).toMatchObject({ revenueEnabled: false });
  });
});

// C-25 review fix: the candidate query now applies `buildPublicListArticleWhere`
// (same "list surface" fragment as `src/lib/site/home-carousel-service.ts`'s
// `fallbackRows`) so a `hidden`/`seo_only` Article can never be written into
// `home_carousel_serving` — see `src/server/home-carousel/service.ts`'s
// `computeHomeCarouselInTx`.
describe("computeHomeCarouselInTx honors Article.seoVisibility (C-25 review fix)", () => {
  // Same `as unknown as NodeJS.ProcessEnv` convention as this repo's other
  // C-25 flag tests (tests/backend/publication/visibility.test.ts,
  // tests/backend/publication/access.test.ts).
  const FLAG_ON = { FEATURE_ARTICLE_SEO_VISIBILITY: "true" } as unknown as NodeJS.ProcessEnv;

  function seedVisibilityFixture(db: FakeHomeCarouselDb) {
    db.seedArticle(article({ id: "article-public", novelId: "novel-public", seoVisibility: "public" }));
    db.seedArticle(article({ id: "article-hidden", novelId: "novel-hidden", seoVisibility: "hidden" }));
    db.seedArticle(article({ id: "article-seo-only", novelId: "novel-seo-only", seoVisibility: "seo_only" }));
  }

  it("flag on: excludes hidden and seo_only candidates from the batch and from serving", async () => {
    const db = new FakeHomeCarouselDb();
    seedVisibilityFixture(db);
    const result = await computeHomeCarouselInTx(db.asTransactionClient(), { locale: "en", source: "manual", now: NOW, env: FLAG_ON });
    expect(result.status).toBe("success");
    expect(db.candidates.map((row) => row.novelId)).toEqual(["novel-public"]);
    expect(db.serving.map((row) => row.novelId)).toEqual(["novel-public"]);
  });

  it("flag off (default): hidden/seo_only Articles are read as public, matching pre-C-25 behavior", async () => {
    const db = new FakeHomeCarouselDb();
    seedVisibilityFixture(db);
    const result = await computeHomeCarouselInTx(db.asTransactionClient(), { locale: "en", source: "manual", now: NOW });
    expect(result.status).toBe("success");
    expect(db.candidates.map((row) => row.novelId).sort()).toEqual(["novel-hidden", "novel-public", "novel-seo-only"]);
    expect(db.serving.map((row) => row.novelId).sort()).toEqual(["novel-hidden", "novel-public", "novel-seo-only"]);
  });
});

function dbBatchParams(db: FakeHomeCarouselDb) {
  const [batch] = [...db.batches.values()];
  return batch.params as Record<string, unknown>;
}
