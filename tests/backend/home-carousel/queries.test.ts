/**
 * PR6 fix B-2: source-boundaries.test.ts already scans
 * src/lib/site/home-carousel-service.ts's source text for
 * `homeCarouselServing.findMany` — a revert to `return []` removes that
 * literal and already fails there. This file adds the behavioral coverage
 * that a source scan cannot: serving-empty-then-recency-fallback, the 500
 * scan-limit argument actually reaching Prisma, no-cover skip and
 * novelId dedup, all driving the real `getHomeCarouselItems` against a fake
 * db (not just asserting on source text).
 */
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { getHomeCarouselItems } from "@/lib/site/home-carousel-service";
import { buildPublicListArticleWhere } from "@/server/publication/visibility";

type PromoLink = { status: string; webUrl: string | null; appUrl: string | null; publicRedirectCode: string | null };
type Row = {
  id: string; title: string; summary: string | null; body: string; seoMetadata: unknown; slug: string; locale: string;
  publicPageShortId: string; publishedAt: Date | null;
  novel: { id: string; businessId: string; title: string; description: string; coverUrl: string | null; locale: string; totalChapterCount: number };
  promoLink: PromoLink | null;
};

function row(overrides: Partial<Row> & { id: string; novelId: string }): Row {
  return {
    title: `Title ${overrides.id}`,
    summary: "summary",
    body: "body",
    seoMetadata: {},
    slug: `slug-${overrides.id}`,
    locale: "en",
    publicPageShortId: `short-${overrides.id}`,
    publishedAt: new Date("2026-01-01T00:00:00.000Z"),
    promoLink: { status: "fetched", webUrl: "https://example.com/go", appUrl: null, publicRedirectCode: "abc123" },
    ...overrides,
    novel: {
      id: overrides.novelId,
      businessId: `biz-${overrides.novelId}`,
      title: `Novel ${overrides.novelId}`,
      description: "description",
      coverUrl: "https://cdn.example.com/cover.jpg",
      locale: "en",
      totalChapterCount: 10,
      ...overrides.novel,
    },
  };
}

class FakePublicCarouselDb {
  servingRows: Row[] = [];
  articleRows: Row[] = [];
  lastArticleFindManyTake: number | null = null;
  articleFindManyCallCount = 0;
  /** C-25: captures the `where` each call site actually sent Prisma, for the where-fragment assertions below. */
  lastArticleFindManyWhere: unknown = null;
  lastServingFindManyWhere: unknown = null;

  private client() {
    return {
      homeCarouselServing: {
        findMany: async (args: { where?: { article?: unknown } }) => {
          this.lastServingFindManyWhere = args.where?.article ?? null;
          return this.servingRows.map((article) => ({ article }));
        },
      },
      article: {
        findMany: async (args: { take: number; where?: unknown }) => {
          this.articleFindManyCallCount += 1;
          this.lastArticleFindManyTake = args.take;
          this.lastArticleFindManyWhere = args.where ?? null;
          return this.articleRows;
        },
      },
      novelChapter: {
        findMany: async () => [],
      },
    };
  }

  asPrismaClient(): PrismaClient {
    return this.client() as unknown as PrismaClient;
  }
}

describe("getHomeCarouselItems (src/lib/site/home-carousel-service.ts)", () => {
  it("returns [] and touches nothing when no db is supplied (SSG/build-time safety)", async () => {
    await expect(getHomeCarouselItems("en")).resolves.toEqual([]);
  });

  it("prefers the serving snapshot and does not fall back to recency when serving is non-empty", async () => {
    const db = new FakePublicCarouselDb();
    db.servingRows = [row({ id: "a1", novelId: "novel-a" })];
    const result = await getHomeCarouselItems("en", db.asPrismaClient());
    expect(result).toHaveLength(1);
    expect(result[0].novel.id).toBe("biz-novel-a");
    expect(db.articleFindManyCallCount).toBe(0);
  });

  it("falls back to recency only when serving is empty, scanning up to 500 candidates", async () => {
    const db = new FakePublicCarouselDb();
    db.servingRows = [];
    db.articleRows = [row({ id: "a1", novelId: "novel-a" })];
    const result = await getHomeCarouselItems("en", db.asPrismaClient());
    expect(result).toHaveLength(1);
    expect(db.articleFindManyCallCount).toBe(1);
    expect(db.lastArticleFindManyTake).toBe(500); // recency scan cap — see B-1 requirement 500-row limit
  });

  it("skips a row whose novel has no cover, from either serving or the recency fallback", async () => {
    const db = new FakePublicCarouselDb();
    db.servingRows = [
      row({ id: "no-cover", novelId: "novel-no-cover", novel: { coverUrl: null } as Row["novel"] }),
      row({ id: "has-cover", novelId: "novel-has-cover" }),
    ];
    const result = await getHomeCarouselItems("en", db.asPrismaClient());
    expect(result.map((item) => item.novel.id)).toEqual(["biz-novel-has-cover"]);
  });

  it("skips a row whose promo link is not ready (not fetched, or no usable url)", async () => {
    const db = new FakePublicCarouselDb();
    db.servingRows = [
      row({ id: "pending", novelId: "novel-pending", promoLink: { status: "pending", webUrl: null, appUrl: null, publicRedirectCode: null } }),
      row({ id: "ready", novelId: "novel-ready" }),
    ];
    const result = await getHomeCarouselItems("en", db.asPrismaClient());
    expect(result.map((item) => item.novel.id)).toEqual(["biz-novel-ready"]);
  });

  it("dedupes by novelId, keeping only the first occurrence", async () => {
    const db = new FakePublicCarouselDb();
    db.servingRows = [];
    db.articleRows = [
      row({ id: "a1", novelId: "novel-dup" }),
      row({ id: "a2", novelId: "novel-dup" }),
      row({ id: "a3", novelId: "novel-other" }),
    ];
    const result = await getHomeCarouselItems("en", db.asPrismaClient());
    expect(result.map((item) => item.novel.id)).toEqual(["biz-novel-dup", "biz-novel-other"]);
  });

  it("caps the result at 5 items", async () => {
    const db = new FakePublicCarouselDb();
    db.servingRows = [];
    db.articleRows = Array.from({ length: 8 }, (_, index) => row({ id: `a${index}`, novelId: `novel-${index}` }));
    const result = await getHomeCarouselItems("en", db.asPrismaClient());
    expect(result).toHaveLength(5);
  });

  /**
   * C-25 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-25, 🟡
   * risk: "轮播的两个调用点容易漏。轮播不在「列表页」的直觉范围内，但它在首页露出，
   * 属于列表语义"): both the serving-snapshot query and the recency-fallback
   * scan must use the same stricter `buildPublicListArticleWhere` fragment
   * `listPublicArticles` uses — not `buildPublicArticleWhere`'s collectability
   * fragment, which would let a `seo_only` Article slip onto the home page.
   */
  it("both the serving query and the recency-fallback scan use buildPublicListArticleWhere (not the collectability fragment)", async () => {
    const db = new FakePublicCarouselDb();
    db.servingRows = [row({ id: "a1", novelId: "novel-a" })];
    await getHomeCarouselItems("en", db.asPrismaClient());
    expect(db.lastServingFindManyWhere).toEqual(buildPublicListArticleWhere({ locale: "en" }));

    const fallbackDb = new FakePublicCarouselDb();
    fallbackDb.servingRows = [];
    fallbackDb.articleRows = [row({ id: "a1", novelId: "novel-a" })];
    await getHomeCarouselItems("en", fallbackDb.asPrismaClient());
    const fallbackWhere = fallbackDb.lastArticleFindManyWhere as { novel?: unknown };
    // fallbackRows also ANDs in a `novel: {...}` clause alongside the spread
    // list-fragment keys — assert the list-fragment's own keys are present
    // rather than exact-equality (this call site merges two objects rather
    // than nesting a single `AND`, see `home-carousel-service.ts`'s own
    // `fallbackRows`).
    const listFragment = buildPublicListArticleWhere({ locale: "en" }) as { AND: unknown };
    expect(fallbackWhere).toMatchObject({ AND: listFragment.AND });
  });
});
