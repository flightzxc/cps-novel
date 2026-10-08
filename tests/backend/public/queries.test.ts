import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BROWSE_PAGE_SIZE,
  getPublicBrowsePage,
  getPublicNovelDetail,
  HOME_GRID_LIMIT,
  listHomeNovels,
  listPublicCategories,
  resolvePublicArticleBySlugParam,
} from "@/lib/site/queries";
import { clearPublicCategoryCountsCacheForTest } from "@/lib/site/public-list";

import { classifyPublicListQuery } from "../../fixtures/in-memory-public-db";

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
 * B-38（v0.5.13）：列表 / 分类 / 首页作品格不再把"最新 240 本"读进内存再在程序里过滤——它们是数据库分页，
 * 筛选语义（C-25 的 seo_only / hidden 排除、推广链接去空白等价、排序、并列、分类归属）由 `public-list.ts` 的 SQL 承担，
 * 单元层钉 SQL 形状（`tests/backend/site/public-list.test.ts`），语义由真实库用例证明
 * （`tests/integration/site/list-equivalence-postgres.test.ts`，含 seo_only / hidden 两种开关状态）。
 * 这里只钉 `queries.ts` 这一层的胶水：首页取前 HOME_GRID_LIMIT 本、全部作品页的页大小与页码、页脚分类的取法。
 */
function listDb(options: { total?: number; ids?: string[]; rows?: Array<ReturnType<typeof listed>> } = {}) {
  const kinds: string[] = [];
  const db = {
    article: { findMany: vi.fn().mockResolvedValue(options.rows ?? []) },
    $queryRaw: vi.fn(async (query: { text: string; values: readonly unknown[] }) => {
      const kind = classifyPublicListQuery(query);
      kinds.push(kind);
      if (kind === "page-ids") return (options.ids ?? []).map((id) => ({ id }));
      if (kind === "page-count") return [{ total: options.total ?? 0 }];
      return [];
    }),
  } as unknown as PrismaClient;
  return { db, kinds };
}

describe("全部作品页 / 首页作品格（数据库分页）", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("getPublicBrowsePage：页大小 BROWSE_PAGE_SIZE（20）；编号 + 总数两条原生 SQL，再按编号补全卡片", async () => {
    const { db, kinds } = listDb({ total: 21, ids: ["article-1"], rows: [listed()] });
    const page = await getPublicBrowsePage(db, "en", 2);
    expect(BROWSE_PAGE_SIZE).toBe(20);
    expect(kinds.filter((kind) => kind !== "taxonomy").sort()).toEqual(["page-count", "page-ids"]);
    expect(page).toMatchObject({ page: 2, totalPages: 2, totalCount: 21 });
    expect(page.novels.map((card) => card.id)).toEqual(["biz-1"]);
    expect(JSON.stringify(page.novels)).not.toMatch(/webUrl|upstreamCode/); // 卡片不携带上游链接
    expect(vi.mocked(db.article.findMany).mock.calls[0]![0]).toMatchObject({ where: { id: { in: ["article-1"] } } });
  });

  it("listHomeNovels：只取列表前 HOME_GRID_LIMIT 本（直接 LIMIT），不数总数、没有'先取一批再切片'", async () => {
    const { db, kinds } = listDb({ ids: ["article-1"], rows: [listed()] });
    const cards = await listHomeNovels(db, "en");
    expect(HOME_GRID_LIMIT).toBe(20);
    expect(cards).toHaveLength(1);
    expect(kinds).not.toContain("page-count");
    const idsCall = vi.mocked(db.$queryRaw).mock.calls.find((call) => classifyPublicListQuery(call[0] as never) === "page-ids")!;
    expect((idsCall[0] as { values: readonly unknown[] }).values.slice(-2)).toEqual([HOME_GRID_LIMIT, 0]);
  });

  it("没有书：第 1 页 200（空列表、totalPages 1），第 2 页由页面据 requested > totalPages 判 404", async () => {
    const { db } = listDb({ total: 0 });
    expect(await getPublicBrowsePage(db, "en", 1)).toMatchObject({ novels: [], page: 1, totalPages: 1, totalCount: 0 });
    expect(await getPublicBrowsePage(db, "en", 2)).toMatchObject({ novels: [], page: 2, totalPages: 1, totalCount: 0 });
  });
});

describe("listPublicCategories", () => {
  beforeEach(() => clearPublicCategoryCountsCacheForTest());
  afterEach(() => clearPublicCategoryCountsCacheForTest());

  /**
   * 页脚 / 首页题材导航 / 详情页可链接分类集合：读每语种每分类本数矩阵里该语种本数 > 0 的分类，再现读分类名
   * （请求语种 → en → zh → slug，链接带语种前缀），排序同 `listDistinctPublicTaxonomy`（sort_order，再 slug 按 en）。
   */
  it("该语种矩阵里的分类 → 现读分类名；其它语种的分类不出现；按 sort_order 再 slug 排序；链接带语种前缀", async () => {
    const tag = (id: string, slug: string, sortOrder: number, requested: string | null = null, zh: string | null = null) => ({
      id, slug, requested_display_name: requested, en_display_name: null, zh_display_name: zh,
      sort_order: sortOrder, updated_at: new Date("2026-09-01T00:00:00Z"),
    });
    const tagRows = [tag("t-b", "beta", 2, "베타"), tag("t-a", "alpha", 2, null, "阿尔法"), tag("t-z", "zeta", 1)];
    const queried: Array<{ kind: string; values: readonly unknown[] }> = [];
    const db = {
      $queryRaw: vi.fn(async (query: { text: string; values: readonly unknown[] }) => {
        const kind = classifyPublicListQuery(query);
        queried.push({ kind, values: query.values });
        if (kind === "matrix") {
          return [
            { locale: "ko", canonical_tag_id: "t-b", slug: "beta", n: 3 },
            { locale: "ko", canonical_tag_id: "t-a", slug: "alpha", n: 1 },
            { locale: "ko", canonical_tag_id: "t-z", slug: "zeta", n: 9 },
            { locale: "en", canonical_tag_id: "t-other", slug: "only-en", n: 5 },
          ];
        }
        if (kind === "totals") return [{ locale: "ko", n: 12 }, { locale: "en", n: 5 }];
        if (kind === "category-names") {
          const wanted = new Set(query.values.flat(Infinity) as unknown[]);
          return tagRows.filter((row) => wanted.has(row.id));
        }
        return [];
      }),
    } as unknown as PrismaClient;

    const categories = await listPublicCategories(db, "ko");
    expect(categories.map((category) => [category.slug, category.label, category.href])).toEqual([
      ["zeta", "zeta", "/ko/category/zeta"], // sort_order 1，没有译名 → slug
      ["alpha", "阿尔法", "/ko/category/alpha"], // 并列 sort_order 2 → 按 slug；请求语种无译名 → zh
      ["beta", "베타", "/ko/category/beta"],
    ]);
    // 名字只查了本语种有书的分类（only-en 没有被取名），且是现读（每次调用一条）。
    const names = queried.find((call) => call.kind === "category-names")!;
    expect(names.values.flat(Infinity)).toEqual(expect.arrayContaining(["t-b", "t-a", "t-z"]));
    expect(names.values.flat(Infinity)).not.toContain("t-other");
    await listPublicCategories(db, "ko");
    expect(queried.filter((call) => call.kind === "matrix")).toHaveLength(1); // 矩阵缓存命中
    expect(queried.filter((call) => call.kind === "category-names")).toHaveLength(2); // 名字不缓存
  });

  it("该语种没有书：空集合，不查分类名", async () => {
    const queried: string[] = [];
    const db = {
      $queryRaw: vi.fn(async (query: { text: string }) => {
        const kind = classifyPublicListQuery(query);
        queried.push(kind);
        return kind === "matrix" ? [{ locale: "en", canonical_tag_id: "t1", slug: "romance", n: 4 }] : [];
      }),
    } as unknown as PrismaClient;
    expect(await listPublicCategories(db, "ja")).toEqual([]);
    expect(queried).not.toContain("category-names");
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
