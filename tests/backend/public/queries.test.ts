import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getPublicNovelDetail,
  listPublicArticles,
  listPublicCategories,
  paginateCards,
  resolvePublicArticleBySlugParam,
} from "@/lib/site/queries";
import { buildPublicListArticleWhere } from "@/server/publication/visibility";

const READY_PROMO = { status: "fetched", webUrl: "https://upstream.example/x", appUrl: null };
const BLANK_PROMO = { status: "fetched", webUrl: "   ", appUrl: " " };

function listed(overrides: Record<string, unknown> = {}) {
  return {
    id: "article-1",
    title: "Lantern",
    slug: "lantern",
    locale: "en",
    publicPageShortId: "abc123",
    publishedAt: new Date("2026-01-01T00:00:00Z"),
    novel: {
      id: "novel-1",
      businessId: "biz-1",
      title: "Lantern",
      description: "Desc",
      coverUrl: "/cover.jpg",
      locale: "en",
      totalChapterCount: 3,
    },
    promoLink: READY_PROMO,
    ...overrides,
  };
}

describe("resolvePublicArticleBySlugParam", () => {
  it("returns not_found when the slug param cannot be parsed", async () => {
    const db = { article: { findFirst: vi.fn() } } as unknown as PrismaClient;
    await expect(resolvePublicArticleBySlugParam(db, "no-short-id", "en")).resolves.toEqual({
      kind: "not_found",
    });
    expect(db.article.findFirst).not.toHaveBeenCalled();
  });

  it("returns not_found when the short id does not match", async () => {
    const db = {
      article: {
        findFirst: vi.fn().mockImplementation(async ({ select }: { select: Record<string, unknown> }) => {
          if ("publicPageShortId" in select) {
            return { id: "article-1", title: "Lantern", publicPageShortId: "otherid" };
          }
          return {
            id: "article-1",
            novelId: "novel-1",
            status: "published",
            novel: { status: "published" },
            promoLink: READY_PROMO,
          };
        }),
      },
    } as unknown as PrismaClient;

    await expect(
      resolvePublicArticleBySlugParam(db, "lantern-pabc123", "en"),
    ).resolves.toEqual({ kind: "not_found" });
  });

  it("returns published when access and short id both match", async () => {
    const db = {
      article: {
        findFirst: vi.fn().mockImplementation(async ({ select }: { select: Record<string, unknown> }) => {
          if ("publicPageShortId" in select) {
            return { id: "article-1", title: "Lantern", publicPageShortId: "abc123" };
          }
          return {
            id: "article-1",
            novelId: "novel-1",
            status: "published",
            novel: { status: "published" },
            promoLink: READY_PROMO,
          };
        }),
      },
    } as unknown as PrismaClient;

    await expect(resolvePublicArticleBySlugParam(db, "lantern-pabc123", "en")).resolves.toEqual({
      kind: "published",
      articleId: "article-1",
      novelId: "novel-1",
      slugPart: "lantern",
      shortId: "abc123",
      title: "Lantern",
    });
  });

  it("returns unavailable / takedown from the foundation access check", async () => {
    const takedownDb = {
      article: {
        findFirst: vi.fn().mockImplementation(async ({ select }: { select: Record<string, unknown> }) => {
          if ("publicPageShortId" in select) {
            return { id: "article-1", title: "Lantern", publicPageShortId: "abc123" };
          }
          return {
            id: "article-1",
            novelId: "novel-1",
            status: "takedown",
            novel: { status: "published" },
            promoLink: READY_PROMO,
          };
        }),
      },
    } as unknown as PrismaClient;
    await expect(resolvePublicArticleBySlugParam(takedownDb, "lantern-pabc123", "en")).resolves.toEqual({
      kind: "takedown",
      title: "Lantern",
    });

    const unpublishedDb = {
      article: {
        findFirst: vi.fn().mockImplementation(async ({ select }: { select: Record<string, unknown> }) => {
          if ("publicPageShortId" in select) {
            return { id: "article-1", title: "Lantern", publicPageShortId: "abc123" };
          }
          return {
            id: "article-1",
            novelId: "novel-1",
            status: "unpublished",
            novel: { status: "published" },
            promoLink: READY_PROMO,
          };
        }),
      },
    } as unknown as PrismaClient;
    await expect(resolvePublicArticleBySlugParam(unpublishedDb, "lantern-pabc123", "en")).resolves.toEqual({
      kind: "unavailable",
      title: "Lantern",
    });
  });
});

/**
 * C-25 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-25):
 * a `findMany` fake that actually *applies* the `where.seoVisibility`
 * sub-clause from `buildPublicListArticleWhere`, unlike this file's plain
 * `vi.fn().mockResolvedValue(rows)` doubles elsewhere — needed so the
 * exclusion tests below prove real end-to-end behavior (call args in, rows
 * out) rather than only asserting "called with the right where object" (that
 * shape-level proof already lives in `tests/backend/publication/
 * visibility.test.ts`'s C-25 truth table).
 */
function findManyApplyingSeoVisibility(rows: ReturnType<typeof listed>[]) {
  return vi.fn(async ({ where }: { where: { AND: [Record<string, unknown>, unknown] } }) => {
    const clause = where.AND[0].seoVisibility as string | { not?: string } | undefined;
    const seoVisibilityOf = (row: ReturnType<typeof listed>) => (row as { seoVisibility?: string }).seoVisibility;
    if (clause === undefined) return rows;
    if (typeof clause === "string") return rows.filter((row) => seoVisibilityOf(row) === clause);
    return rows.filter((row) => seoVisibilityOf(row) !== clause.not);
  });
}

describe("listPublicArticles", () => {
  it("pre-filters with buildPublicListArticleWhere then drops rows that fail isPromoReady", async () => {
    const findMany = vi.fn().mockResolvedValue([listed(), listed({ id: "article-2", promoLink: BLANK_PROMO })]);
    const db = { article: { findMany }, $queryRaw: vi.fn().mockResolvedValue([]) } as unknown as PrismaClient;

    const cards = await listPublicArticles(db, "en");
    // C-25: on-site listing calls the stricter "list" fragment, not the
    // collectability one sitemap/IndexNow use — see `visibility.ts`'s header
    // for why these are two different functions now.
    expect(findMany.mock.calls[0][0].where).toEqual(buildPublicListArticleWhere({ locale: "en" }));
    expect(cards).toHaveLength(1);
    expect(cards[0]?.id).toBe("biz-1");
    expect(JSON.stringify(cards)).not.toMatch(/webUrl|upstreamCode/);
  });

  /**
   * C-25: "公开侧改动…列表五个调用点…全部改走新的「列表用」片段" — this is the
   * headline self-check for that change: with the flag on, only the
   * `public` row survives `where.seoVisibility` filtering and reaches the
   * returned cards; `seo_only` and `hidden` are both gone from on-site
   * listing (unlike sitemap, which keeps `seo_only`).
   */
  describe("C-25: excludes seo_only and hidden (flag on)", () => {
    afterEach(() => {
      delete process.env.FEATURE_ARTICLE_SEO_VISIBILITY;
    });

    it("only the public row is returned", async () => {
      process.env.FEATURE_ARTICLE_SEO_VISIBILITY = "true";
      const rows = [
        listed({ id: "pub", seoVisibility: "public", novel: { id: "novel-pub", businessId: "biz-pub", title: "Pub", description: "d", coverUrl: "/c.jpg", locale: "en", totalChapterCount: 1 } }),
        listed({ id: "seo-only", seoVisibility: "seo_only", slug: "seo-only", novel: { id: "novel-seo-only", businessId: "biz-seo-only", title: "SeoOnly", description: "d", coverUrl: "/c.jpg", locale: "en", totalChapterCount: 1 } }),
        listed({ id: "hidden", seoVisibility: "hidden", slug: "hidden", novel: { id: "novel-hidden", businessId: "biz-hidden", title: "Hidden", description: "d", coverUrl: "/c.jpg", locale: "en", totalChapterCount: 1 } }),
      ];
      const db = {
        article: { findMany: findManyApplyingSeoVisibility(rows) },
        $queryRaw: vi.fn().mockResolvedValue([]),
      } as unknown as PrismaClient;

      const cards = await listPublicArticles(db, "en");

      expect(cards.map((card) => card.id)).toEqual(["biz-pub"]);
    });
  });
});

describe("listPublicCategories", () => {
  /**
   * C-25: "分类" enumeration must use the same stricter list-layer fragment
   * as `listPublicArticles` — a category that only exists because of a
   * `seo_only`/`hidden` Article's novel must not appear in `/category`'s own
   * filter chips (the deep per-row proof lives in `listPublicArticles`'s own
   * C-25 block above; `loadPublicTaxonomyByNovelIds` itself is a raw-SQL
   * `$queryRaw` call this file's fakes do not re-implement).
   */
  it("uses buildPublicListArticleWhere, not the collectability fragment", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = { article: { findMany }, $queryRaw: vi.fn().mockResolvedValue([]) } as unknown as PrismaClient;

    await listPublicCategories(db, "en");

    expect(findMany.mock.calls[0][0].where).toEqual(buildPublicListArticleWhere({ locale: "en" }));
  });
});

describe("getPublicNovelDetail", () => {
  it("returns null when the promo link is not ready", async () => {
    const db = {
      article: { findFirst: vi.fn().mockResolvedValue(listed({ promoLink: BLANK_PROMO })) },
      novelChapter: { findMany: vi.fn() },
    } as unknown as PrismaClient;
    await expect(getPublicNovelDetail(db, "article-1")).resolves.toBeNull();
    expect(db.novelChapter.findMany).not.toHaveBeenCalled();
  });
});

describe("paginateCards", () => {
  it("pages a bounded list", () => {
    const cards = Array.from({ length: 21 }, (_, index) => ({
      id: `n${index}`,
      title: `Book ${index}`,
      tags: [],
      href: `/novel/book-${index}-pxx`,
    }));
    const page2 = paginateCards(cards, 2);
    expect(page2.page).toBe(2);
    expect(page2.totalPages).toBe(2);
    expect(page2.novels).toHaveLength(1);
  });
});
