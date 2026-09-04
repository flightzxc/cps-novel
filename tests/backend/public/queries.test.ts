import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  getPublicNovelDetail,
  listPublicArticles,
  paginateCards,
  resolvePublicArticleBySlugParam,
} from "@/lib/site/queries";
import { buildPublicArticleWhere } from "@/server/publication/visibility";

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

describe("listPublicArticles", () => {
  it("pre-filters with buildPublicArticleWhere then drops rows that fail isPromoReady", async () => {
    const findMany = vi.fn().mockResolvedValue([listed(), listed({ id: "article-2", promoLink: BLANK_PROMO })]);
    const db = { article: { findMany }, $queryRaw: vi.fn().mockResolvedValue([]) } as unknown as PrismaClient;

    const cards = await listPublicArticles(db, "en");
    expect(findMany.mock.calls[0][0].where).toEqual(buildPublicArticleWhere({ locale: "en" }));
    expect(cards).toHaveLength(1);
    expect(cards[0]?.id).toBe("biz-1");
    expect(JSON.stringify(cards)).not.toMatch(/webUrl|upstreamCode/);
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
