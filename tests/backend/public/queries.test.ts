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

/**
 * 2026-09-30（短码语种纠正，照搬短剧站 v8.5.1 `getDramaDetailBySlug`）：
 * `resolvePublicArticleBySlugParam` 现在**按短码**找文章（短码是页面身份，语种
 * 前缀与 slug 只是展示），找到已发布文章后比对 URL 里的语种/slug 与文章真实的：
 * 一致 → `published`；不一致 → `redirect`（页面 308 到规范地址）。
 *
 * 因此本块所有 fixture 行都带 `locale`/`slug`（真实库里这两列恒有值，旧 fixture
 * 因为当时按 (locale, slug) 查询、行里没有它们）；"短码不符即 not_found" 的旧用例
 * 换成"短码找不到即 not_found"——语义随需求改变，不是放宽：下架/撤回/hidden 等
 * 判定口径、以及"下架/撤回只对规范 URL 生效"这些断言都保持原样（见各用例）。
 */
function accessRow(overrides: Record<string, unknown> = {}) {
  return {
    title: "Lantern",
    locale: "en",
    slug: "lantern",
    publicPageShortId: "abc123",
    id: "article-1",
    novelId: "novel-1",
    status: "published",
    novel: { status: "published" },
    promoLink: READY_PROMO,
    ...overrides,
  };
}

function dbReturning(row: ReturnType<typeof accessRow> | null) {
  return { article: { findFirst: vi.fn().mockResolvedValue(row) } } as unknown as PrismaClient;
}

describe("resolvePublicArticleBySlugParam", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("returns not_found when the slug param cannot be parsed", async () => {
    const db = { article: { findFirst: vi.fn() } } as unknown as PrismaClient;
    await expect(resolvePublicArticleBySlugParam(db, "no-short-id", "en")).resolves.toEqual({
      kind: "not_found",
    });
    expect(db.article.findFirst).not.toHaveBeenCalled();
  });

  it("returns not_found when no article carries the short id — the URL's locale/slug cannot conjure one", async () => {
    const db = dbReturning(null);
    await expect(resolvePublicArticleBySlugParam(db, "lantern-pabc123", "en")).resolves.toEqual({
      kind: "not_found",
    });
    expect(db.article.findFirst).toHaveBeenCalledTimes(1);
  });

  it("looks the article up by short id alone (not by locale + slug)", async () => {
    const db = dbReturning(accessRow());
    await resolvePublicArticleBySlugParam(db, "lantern-pabc123", "ko");
    expect(vi.mocked(db.article.findFirst).mock.calls[0]![0]).toMatchObject({
      where: { AND: [{ deletedAt: null }, { publicPageShortId: "abc123" }] },
    });
  });

  it("returns published when access, locale and slug all match the URL", async () => {
    const db = dbReturning(accessRow());
    await expect(resolvePublicArticleBySlugParam(db, "lantern-pabc123", "en")).resolves.toEqual({
      kind: "published",
      articleId: "article-1",
      novelId: "novel-1",
      slugPart: "lantern",
      shortId: "abc123",
      title: "Lantern",
    });
    expect(db.article.findFirst).toHaveBeenCalledTimes(1);
  });

  it("wrong locale prefix: the short id finds a published article whose locale differs -> redirect to its canonical locale (CPS redirectToCanonical), not 404", async () => {
    // The Korean edition's path grafted onto the bare (en) tree — exactly what
    // the old prefix-swap locale switcher produced.
    const db = dbReturning(accessRow({ locale: "ko", slug: "deungdae-jigi" }));
    await expect(resolvePublicArticleBySlugParam(db, "deungdae-jigi-pabc123", "en")).resolves.toEqual({
      kind: "redirect",
      locale: "ko",
      slugPart: "deungdae-jigi",
      shortId: "abc123",
      title: "Lantern",
    });
  });

  it("stale slug part: right locale, slug renamed since the URL was issued -> redirect to the current slug", async () => {
    const db = dbReturning(accessRow({ slug: "lantern-keeper" }));
    await expect(resolvePublicArticleBySlugParam(db, "lantern-pabc123", "en")).resolves.toEqual({
      kind: "redirect",
      locale: "en",
      slugPart: "lantern-keeper",
      shortId: "abc123",
      title: "Lantern",
    });
  });

  it("both the locale prefix and the slug part are wrong -> still a single redirect to the canonical address", async () => {
    const db = dbReturning(accessRow({ locale: "fr", slug: "la-lanterne" }));
    await expect(resolvePublicArticleBySlugParam(db, "lantern-pabc123", "ko")).resolves.toEqual({
      kind: "redirect",
      locale: "fr",
      slugPart: "la-lanterne",
      shortId: "abc123",
      title: "Lantern",
    });
  });

  it("an article stored under an unregistered locale has no canonical address to redirect to -> not_found, never a redirect into /{unknown}/novel/…", async () => {
    const db = dbReturning(accessRow({ locale: "xx-unregistered" }));
    await expect(resolvePublicArticleBySlugParam(db, "lantern-pabc123", "en")).resolves.toEqual({
      kind: "not_found",
    });
  });

  it.each([
    ["draft", "published", "public", READY_PROMO, "not_found"],
    ["published", "published", "hidden", READY_PROMO, "not_found"],
    ["published", "published", "seo_only", READY_PROMO, "published"],
    ["published", "published", "public", BLANK_PROMO, "unavailable"],
    ["published", "takedown", "public", READY_PROMO, "takedown"],
  ])("keeps visibility for %s/%s/%s", async (status, novelStatus, seoVisibility, promoLink, kind) => {
    vi.stubEnv("FEATURE_ARTICLE_SEO_VISIBILITY", "true");
    const findFirst = vi.fn().mockResolvedValue(
      accessRow({ id: "a", novelId: "n", status, seoVisibility, novel: { status: novelStatus }, promoLink }),
    );
    const db = { article: { findFirst } } as unknown as PrismaClient;
    const result = await resolvePublicArticleBySlugParam(db, "lantern-pabc123", "en");
    expect(result.kind).toBe(kind);
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst.mock.calls[0][0]).toMatchObject({
      where: { AND: [{ deletedAt: null }, { publicPageShortId: "abc123" }] },
      select: { title: true, publicPageShortId: true, promoLink: { select: { status: true, webUrl: true, appUrl: true } } },
    });
  });

  it("returns unavailable / takedown from the foundation access check", async () => {
    await expect(
      resolvePublicArticleBySlugParam(dbReturning(accessRow({ status: "takedown" })), "lantern-pabc123", "en"),
    ).resolves.toEqual({ kind: "takedown", title: "Lantern" });

    await expect(
      resolvePublicArticleBySlugParam(dbReturning(accessRow({ status: "unpublished" })), "lantern-pabc123", "en"),
    ).resolves.toEqual({ kind: "unavailable", title: "Lantern" });
  });

  it("unavailable / takedown only apply at the article's own canonical URL: a wrong locale prefix or a stale slug is a plain not_found, never a redirect that would confirm a non-public article exists (unchanged from before — those URLs used to find no row at all)", async () => {
    for (const status of ["unpublished", "takedown"]) {
      await expect(
        resolvePublicArticleBySlugParam(dbReturning(accessRow({ status, locale: "ko" })), "lantern-pabc123", "en"),
      ).resolves.toEqual({ kind: "not_found" });
      await expect(
        resolvePublicArticleBySlugParam(dbReturning(accessRow({ status, slug: "renamed" })), "lantern-pabc123", "en"),
      ).resolves.toEqual({ kind: "not_found" });
    }
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
