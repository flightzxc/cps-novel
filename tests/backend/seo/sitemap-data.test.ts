import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSitemapFamilyBuilder,
  SITEMAP_SHARD_SIZE,
} from "@/lib/seo/sitemap";
import { invalidateSiteSettingCache } from "@/server/site-settings/service";

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "article-1",
    locale: "en",
    slug: "visible-title",
    publicPageShortId: "abc123",
    title: "Visible title",
    status: "published",
    deletedAt: null,
    updatedAt: new Date("2026-08-05T12:30:00.000Z"),
    novel: {
      status: "published",
      deletedAt: null,
      coverUrl: "/covers/visible.webp",
    },
    promoLink: {
      status: "fetched",
      webUrl: "https://promo.example/book",
      appUrl: null,
      deletedAt: null,
    },
    ...overrides,
  };
}

function db(rows: ReturnType<typeof candidate>[]) {
  return {
    article: { findMany: vi.fn().mockResolvedValue(rows) },
    siteSetting: {
      findUnique: vi.fn().mockResolvedValue({
        siteName: "Fixture",
        siteDescription: "",
        homeMetaTitle: "",
        homeMetaDescription: "",
        defaultOgImage: "",
        googleSearchConsoleVerification: "",
        footerCopyrightText: "",
        footerDisclaimerText: "",
        friendLinks: [],
        indexNowHost: "",
        indexNowKey: "",
        indexNowKeyLocation: "",
        ga4MeasurementId: null,
        updatedAt: new Date("2026-08-04T00:00:00.000Z"),
      }),
    },
  };
}

afterEach(() => {
  delete process.env.SITE_URL;
  delete process.env.FEATURE_ARTICLE_SEO_VISIBILITY;
  invalidateSiteSettingCache();
});

describe("Sitemap DB family builder", () => {
  it("uses a DB superset but applies trim-authoritative promo and publication filtering per row", async () => {
    process.env.SITE_URL = "https://novel.example";
    const fixtureDb = db([
      candidate(),
      candidate({ id: "whitespace", promoLink: { status: "fetched", webUrl: "   ", appUrl: null, deletedAt: null } }),
      candidate({ id: "draft", status: "draft" }),
      candidate({ id: "unpublished", status: "unpublished" }),
      candidate({ id: "takedown", novel: { status: "takedown", deletedAt: null, coverUrl: null } }),
      candidate({ id: "deleted-article", deletedAt: new Date() }),
      candidate({ id: "deleted-novel", novel: { status: "published", deletedAt: new Date(), coverUrl: null } }),
      candidate({ id: "deleted-promo", promoLink: { status: "fetched", webUrl: "https://promo.example", appUrl: null, deletedAt: new Date() } }),
    ]);

    const files = await createSitemapFamilyBuilder(fixtureDb as never)({
      type: "novelpage",
      locale: "en",
    });

    expect(files).toHaveLength(1);
    expect(files[0]!.entries).toEqual([{
      loc: "https://novel.example/novel/visible-title-pabc123",
      lastmod: "2026-08-05T12:30:00.000Z",
      changefreq: "weekly",
      priority: 0.9,
      imageUrl: "/covers/visible.webp",
      imageTitle: "Visible title",
    }]);
    expect(files[0]!.lastmod).toBe("2026-08-05T12:30:00.000Z");

    const query = fixtureDb.article.findMany.mock.calls[0]![0];
    expect(JSON.stringify(query.where)).toContain('"not":""');
    expect(JSON.stringify(query.where)).toContain('"deletedAt":null');
  });

  /**
   * C-25 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-25):
   * "sitemap：候选 where 追加「排除 hidden」，seo_only 照常进；同时在该文件的可见性
   * 逐行复核函数里补一条对应断言…新条件必须两侧都加，不能只加 DB 侧" — this fixture's
   * `findMany` mock ignores `where` and returns every row verbatim (same as
   * every other test in this file), so a `hidden` row surviving into
   * `files[0].entries` would only happen if the per-row `isVisibleCandidate`
   * recheck were missing; the `where`-string assertion below independently
   * pins the DB pre-filter side.
   */
  it("C-25: excludes seoVisibility=hidden (both the DB pre-filter and the per-row recheck), keeps seo_only", async () => {
    process.env.SITE_URL = "https://novel.example";
    process.env.FEATURE_ARTICLE_SEO_VISIBILITY = "true";
    const fixtureDb = db([
      candidate({ seoVisibility: "public" }),
      candidate({ id: "seo-only", slug: "seo-only", publicPageShortId: "seoonly1", seoVisibility: "seo_only" }),
      candidate({ id: "hidden", slug: "hidden-article", publicPageShortId: "hidden001", seoVisibility: "hidden" }),
    ]);

    const files = await createSitemapFamilyBuilder(fixtureDb as never)({
      type: "novelpage",
      locale: "en",
    });

    expect(files[0]!.entries.map((entry) => entry.loc)).toEqual([
      "https://novel.example/novel/visible-title-pabc123",
      "https://novel.example/novel/seo-only-pseoonly1",
    ]);

    const query = fixtureDb.article.findMany.mock.calls[0]![0];
    expect(JSON.stringify(query.where)).toContain('"seoVisibility":{"not":"hidden"}');
  });

  it("C-25: the flag off degrades to pre-C-25 behavior — hidden is NOT excluded", async () => {
    process.env.SITE_URL = "https://novel.example";
    // FEATURE_ARTICLE_SEO_VISIBILITY deliberately left unset.
    const fixtureDb = db([
      candidate({ seoVisibility: "public" }),
      candidate({ id: "hidden", slug: "hidden-article", publicPageShortId: "hidden001", seoVisibility: "hidden" }),
    ]);

    const files = await createSitemapFamilyBuilder(fixtureDb as never)({
      type: "novelpage",
      locale: "en",
    });

    expect(files[0]!.entries).toHaveLength(2);
    const query = fixtureDb.article.findMany.mock.calls[0]![0];
    expect(JSON.stringify(query.where)).not.toContain("seoVisibility");
  });

  it("uses PG Date values for home, Article, and shard lastmod", async () => {
    process.env.SITE_URL = "https://novel.example";
    const fixtureDb = db([
      candidate({ updatedAt: new Date("2026-08-03T00:00:00.000Z") }),
      candidate({ id: "newer", slug: "newer", publicPageShortId: "def456", updatedAt: new Date("2026-08-06T09:10:11.123Z") }),
    ]);
    const builder = createSitemapFamilyBuilder(fixtureDb as never);

    const home = await builder({ type: "mainpage", locale: "en" });
    const novels = await builder({ type: "novelpage", locale: "en" });

    expect(home[0]!.entries[0]).toMatchObject({
      loc: "https://novel.example",
      lastmod: "2026-08-06T09:10:11.123Z",
    });
    expect(novels[0]!.lastmod).toBe("2026-08-06T09:10:11.123Z");
    expect(fixtureDb.article.findMany).toHaveBeenCalledTimes(1);
    expect(fixtureDb.siteSetting.findUnique).toHaveBeenCalledTimes(1);
  });

  it("splits Novel URLs at the fixed 10,000-entry boundary", async () => {
    process.env.SITE_URL = "https://novel.example";
    const rows = Array.from({ length: SITEMAP_SHARD_SIZE + 1 }, (_, index) => candidate({
      id: `article-${index.toString().padStart(5, "0")}`,
      slug: `novel-${index}`,
      publicPageShortId: `id${index}`,
    }));
    const files = await createSitemapFamilyBuilder(db(rows) as never)({
      type: "novelpage",
      locale: "en",
    });

    expect(files.map((file) => file.name)).toEqual([
      "site_novelpage_en.xml",
      "site_novelpage_en_1.xml",
    ]);
    expect(files.map((file) => file.entries.length)).toEqual([10_000, 1]);
  });
});
