import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSitemapFamilyBuilder,
  renderUrlSetXml,
  SITEMAP_ARTICLE_LOAD_CHUNK_SIZE,
} from "@/lib/seo/sitemap";
import { invalidateSiteSettingCache } from "@/server/site-settings/service";

/**
 * 站点地图规模缺陷（2026-10-06）：每个语种的公开文章不能一次 `findMany` 读完（select 带组合外键关系
 * `promoLink`，一次取回的行数一多就撞 54001 / 32,767 绑定变量上限），要按 id 游标分块读。
 * 这里用「认 take 与 id 游标」的内存替身验证查询形状与结果；真实库规模验收见
 * `tests/integration/tasks/sitemap-scale-postgres.test.ts`。
 */

type FindManyArgs = {
  where: { AND?: Array<Record<string, unknown>> } & Record<string, unknown>;
  select: Record<string, unknown>;
  orderBy: unknown;
  take?: number;
};

function novelRow(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `article-${String(index).padStart(5, "0")}`,
    locale: "en",
    slug: `novel-${index}`,
    publicPageShortId: `s${index}`,
    title: `Novel ${index}`,
    status: "published",
    seoVisibility: "public",
    deletedAt: null,
    updatedAt: new Date(Date.UTC(2026, 7, 5, 0, 0, index)),
    novel: { id: `novel-${index}`, status: "published", deletedAt: null, coverUrl: `/covers/${index}.webp` },
    promoLink: { status: "fetched", webUrl: `https://promo.example/${index}`, appUrl: null, deletedAt: null },
    ...overrides,
  };
}

function blogRow(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `blog-${String(index).padStart(5, "0")}`,
    locale: "en",
    slug: `post-${index}`,
    title: `Post ${index}`,
    status: "published",
    articleType: "blog_article",
    seoVisibility: "public",
    deletedAt: null,
    updatedAt: new Date(Date.UTC(2026, 7, 5, 0, 0, index)),
    ...overrides,
  };
}

/** 从 where 里找 `{ id: { gt } }` 子句（第 2 块起才有）。 */
function cursorOf(where: FindManyArgs["where"]): string | undefined {
  const clause = where.AND?.find((part) => typeof part.id === "object" && part.id !== null && "gt" in (part.id as object));
  return clause ? (clause.id as { gt: string }).gt : undefined;
}

function db(articles: ReadonlyArray<{ id: string }>) {
  const sorted = [...articles].sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    article: {
      findMany: vi.fn(async (args: FindManyArgs) => {
        // 与真数据库一致：只认 `id > 游标`（第 2 块起）与 `take`；基础过滤条件在这里不模拟（行都是可见的）。
        const after = cursorOf(args.where);
        const rest = after === undefined ? sorted : sorted.filter((row) => row.id > after);
        return rest.slice(0, args.take ?? rest.length);
      }),
    },
    novelChapter: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn().mockResolvedValue([]),
    siteSetting: {
      findUnique: vi.fn().mockResolvedValue({
        siteName: "Fixture", siteDescription: "", homeMetaTitle: "", homeMetaDescription: "", defaultOgImage: "",
        googleSearchConsoleVerification: "", footerCopyrightText: "", footerDisclaimerText: "", friendLinks: [],
        indexNowHost: "", indexNowKey: "", indexNowKeyLocation: "", ga4MeasurementId: null,
        yandexVerification: "", yandexMetricaId: null,
        updatedAt: new Date("2026-08-04T00:00:00.000Z"),
      }),
    },
  };
}

afterEach(() => {
  delete process.env.SITE_URL;
  delete process.env.FEATURE_ARTICLE_BLOG;
  invalidateSiteSettingCache();
});

describe("sitemap family builder · id-cursor chunked article loading", () => {
  it("reads novel candidates one chunk at a time: first page keeps the original where, later pages AND id > last id, always id asc", async () => {
    process.env.SITE_URL = "https://novel.example";
    const fixtureDb = db(Array.from({ length: 5 }, (_, index) => novelRow(index)));
    const files = await createSitemapFamilyBuilder(fixtureDb as never, process.env, { articleLoadChunkSize: 2 })({
      type: "novelpage", locale: "en",
    });

    const calls = fixtureDb.article.findMany.mock.calls.map(([args]) => args);
    expect(calls).toHaveLength(3); // 2 + 2 + 1：最后一块不满即停
    expect(calls.map((args) => args.take)).toEqual([2, 2, 2]);
    expect(calls.every((args) => JSON.stringify(args.orderBy) === JSON.stringify({ id: "asc" }))).toBe(true);
    expect(cursorOf(calls[0]!.where)).toBeUndefined();
    expect(cursorOf(calls[1]!.where)).toBe("article-00001");
    expect(cursorOf(calls[2]!.where)).toBe("article-00003");
    // 第 1 块的 where 与改前逐字相同（没有被套上游标条件）；后面各块是 { AND: [原 where, { id: { gt } }] }。
    expect(calls[1]!.where.AND![0]).toEqual(calls[0]!.where);
    // 组合外键关系照旧在 select 里（分块治的是「一次取多少行」，不是不要这个关系）。
    expect(calls[0]!.select).toHaveProperty("promoLink");

    expect(files).toHaveLength(1);
    expect(files[0]!.entries.map((entry) => entry.loc)).toEqual(
      Array.from({ length: 5 }, (_, index) => `https://novel.example/novel/novel-${index}-ps${index}`),
    );
  });

  it("uses SITEMAP_ARTICLE_LOAD_CHUNK_SIZE by default, and that size stays far below the measured composite-FK failure threshold", async () => {
    process.env.SITE_URL = "https://novel.example";
    // 实测门槛：PostgreSQL 16.14 默认 max_stack_depth 下 7,281 组元组起 54001（事故现场 6,835 组）。
    expect(SITEMAP_ARTICLE_LOAD_CHUNK_SIZE).toBeGreaterThanOrEqual(1);
    expect(SITEMAP_ARTICLE_LOAD_CHUNK_SIZE).toBeLessThanOrEqual(1_000);
    const fixtureDb = db([novelRow(0)]);
    await createSitemapFamilyBuilder(fixtureDb as never)({ type: "novelpage", locale: "en" });
    expect(fixtureDb.article.findMany.mock.calls[0]![0].take).toBe(SITEMAP_ARTICLE_LOAD_CHUNK_SIZE);
  });

  it("a locale larger than one default chunk is served by several bounded queries and loses/duplicates nothing", async () => {
    process.env.SITE_URL = "https://novel.example";
    const total = SITEMAP_ARTICLE_LOAD_CHUNK_SIZE * 2 + 7;
    const fixtureDb = db(Array.from({ length: total }, (_, index) => novelRow(index)));
    const files = await createSitemapFamilyBuilder(fixtureDb as never)({ type: "novelpage", locale: "en" });
    expect(fixtureDb.article.findMany).toHaveBeenCalledTimes(3);
    const locs = files.flatMap((file) => file.entries.map((entry) => entry.loc));
    expect(locs).toHaveLength(total);
    expect(new Set(locs).size).toBe(total);
  });

  it("application-layer recheck still applies per row across chunk boundaries", async () => {
    process.env.SITE_URL = "https://novel.example";
    const rows = Array.from({ length: 6 }, (_, index) => novelRow(index));
    rows[1] = novelRow(1, { promoLink: { status: "fetched", webUrl: "   ", appUrl: null, deletedAt: null } });
    rows[2] = novelRow(2, { status: "draft" });
    rows[3] = novelRow(3, { deletedAt: new Date() });
    const files = await createSitemapFamilyBuilder(db(rows) as never, process.env, { articleLoadChunkSize: 2 })({
      type: "novelpage", locale: "en",
    });
    expect(files[0]!.entries.map((entry) => entry.loc)).toEqual([
      "https://novel.example/novel/novel-0-ps0",
      "https://novel.example/novel/novel-4-ps4",
      "https://novel.example/novel/novel-5-ps5",
    ]);
  });

  it("rendered XML is byte-identical for every chunk size (1, 2, 3, exactly the total, total+1, one-shot)", async () => {
    process.env.SITE_URL = "https://novel.example";
    process.env.FEATURE_ARTICLE_BLOG = "true";
    const rows = Array.from({ length: 9 }, (_, index) => novelRow(index));
    const blogs = Array.from({ length: 9 }, (_, index) => blogRow(index));
    const render = async (articleLoadChunkSize: number | undefined) => {
      // 小说与博客各用一个替身库（真库里由 where 区分家族，这里不模拟 where，所以数据分开放）。
      const novelDb = db(rows);
      const blogDb = db(blogs);
      const options = articleLoadChunkSize === undefined ? undefined : { articleLoadChunkSize };
      const novelFiles = await createSitemapFamilyBuilder(novelDb as never, process.env, options)({ type: "novelpage", locale: "en" });
      const mainFiles = await createSitemapFamilyBuilder(novelDb as never, process.env, options)({ type: "mainpage", locale: "en" });
      const blogFiles = await createSitemapFamilyBuilder(blogDb as never, process.env, options)({ type: "blogpage", locale: "en" });
      return [...mainFiles, ...novelFiles, ...blogFiles].map((file) => `${file.name}\n${file.lastmod}\n${renderUrlSetXml(file.entries)}`).join("\n----\n");
    };
    const baseline = await render(undefined);
    expect(baseline).toContain("novel-8-ps8");
    expect(baseline).toContain("/blog/post-8");
    for (const size of [1, 2, 3, 9, 10, 1_000_000]) {
      expect(await render(size), `chunk=${size}`).toBe(baseline);
    }
  });

  it("blog family is read in the same id-cursor chunks (scalar select, no relation), first page's where unchanged", async () => {
    process.env.SITE_URL = "https://novel.example";
    process.env.FEATURE_ARTICLE_BLOG = "true";
    const fixtureDb = db(Array.from({ length: 5 }, (_, index) => blogRow(index)));
    const files = await createSitemapFamilyBuilder(fixtureDb as never, process.env, { articleLoadChunkSize: 2 })({
      type: "blogpage", locale: "en",
    });
    const calls = fixtureDb.article.findMany.mock.calls.map(([args]) => args);
    expect(calls.map((args) => args.take)).toEqual([2, 2, 2]);
    expect(cursorOf(calls[0]!.where)).toBeUndefined();
    expect(cursorOf(calls[2]!.where)).toBe("blog-00003");
    expect(calls[0]!.select).not.toHaveProperty("promoLink");
    expect(files[0]!.entries.map((entry) => entry.loc)).toEqual(
      Array.from({ length: 5 }, (_, index) => `https://novel.example/blog/post-${index}`),
    );
  });

  it("rejects an invalid chunk size instead of degrading to a one-shot read", async () => {
    const fixtureDb = db([novelRow(0)]);
    await expect(createSitemapFamilyBuilder(fixtureDb as never, process.env, { articleLoadChunkSize: 0 })({
      type: "novelpage", locale: "en",
    })).rejects.toBeInstanceOf(RangeError);
    expect(fixtureDb.article.findMany).not.toHaveBeenCalled();
  });
});
