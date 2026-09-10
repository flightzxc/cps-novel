import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSitemapFamilyBuilder,
  getSitemapFileName,
  parseSitemapFileName,
  SITEMAP_TYPES,
} from "@/lib/seo/sitemap";
import { invalidateSiteSettingCache } from "@/server/site-settings/service";

/**
 * C-29 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-29):
 * `blogpage` sitemap family — the plan's own承重 risk item: "sitemap 文件名
 * 正则改漏一处（解析、分发、生成三处）... 三处必须同改并有测试." This file
 * covers all three: file-name parsing (`parseSitemapFileName`), family
 * dispatch (`createSitemapFamilyBuilder`'s `type === "blogpage"` branch),
 * and generation (entries produced from DB candidates). Also covers the
 * plan's own truth-table requirement: "草稿/已发布 × 三种可见性".
 */

function blogCandidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "blog-1",
    locale: "en",
    slug: "a-blog-post",
    title: "A blog post",
    status: "published",
    articleType: "blog_article",
    seoVisibility: "public",
    deletedAt: null,
    updatedAt: new Date("2026-08-05T12:30:00.000Z"),
    ...overrides,
  };
}

function db(rows: ReturnType<typeof blogCandidate>[]) {
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
  delete process.env.FEATURE_ARTICLE_BLOG;
  invalidateSiteSettingCache();
});

describe("SITEMAP_TYPES", () => {
  it("has four families, blogpage last", () => {
    expect(SITEMAP_TYPES).toEqual(["mainpage", "novelpage", "categorypage", "blogpage"]);
  });
});

describe("getSitemapFileName / parseSitemapFileName: blogpage", () => {
  it("round-trips blogpage file names", () => {
    const name = getSitemapFileName("blogpage", "en", 0);
    expect(name).toBe("site_blogpage_en.xml");
    expect(parseSitemapFileName(name)).toEqual({ type: "blogpage", locale: "en", index: 0 });
  });

  it("round-trips a sharded blogpage file name", () => {
    const name = getSitemapFileName("blogpage", "en", 1);
    expect(name).toBe("site_blogpage_en_1.xml");
    expect(parseSitemapFileName(name)).toEqual({ type: "blogpage", locale: "en", index: 1 });
  });

  it("parses all four known families correctly", () => {
    for (const type of ["mainpage", "novelpage", "categorypage", "blogpage"] as const) {
      expect(parseSitemapFileName(getSitemapFileName(type, "en", 0))?.type).toBe(type);
    }
  });

  it("rejects an unknown family", () => {
    expect(parseSitemapFileName("site_unknownpage_en.xml")).toBeNull();
  });
});

describe("Sitemap blog family builder", () => {
  it("C-29 开关: FEATURE_ARTICLE_BLOG off -> zero blogpage files, even with an eligible candidate in the DB", async () => {
    process.env.SITE_URL = "https://novel.example";
    // FEATURE_ARTICLE_BLOG deliberately left unset (off).
    const fixtureDb = db([blogCandidate()]);

    const files = await createSitemapFamilyBuilder(fixtureDb as never)({ type: "blogpage", locale: "en" });

    expect(files).toEqual([]);
    expect(fixtureDb.article.findMany).not.toHaveBeenCalled();
  });

  it("emits a blogpage file for a published, public blog Article when the flag is on", async () => {
    process.env.SITE_URL = "https://novel.example";
    process.env.FEATURE_ARTICLE_BLOG = "true";
    const fixtureDb = db([blogCandidate()]);

    const files = await createSitemapFamilyBuilder(fixtureDb as never)({ type: "blogpage", locale: "en" });

    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe("site_blogpage_en.xml");
    expect(files[0]!.entries).toEqual([{
      loc: "https://novel.example/blog/a-blog-post",
      lastmod: "2026-08-05T12:30:00.000Z",
      changefreq: "weekly",
      priority: 0.6,
    }]);
  });

  it("excludes a novel_article/listicle/guide row even if it were somehow returned by the DB query", async () => {
    process.env.SITE_URL = "https://novel.example";
    process.env.FEATURE_ARTICLE_BLOG = "true";
    const fixtureDb = db([
      blogCandidate(),
      blogCandidate({ id: "novel-row", slug: "a-novel", articleType: "novel_article" }),
      blogCandidate({ id: "listicle-row", slug: "a-listicle", articleType: "listicle" }),
    ]);

    const files = await createSitemapFamilyBuilder(fixtureDb as never)({ type: "blogpage", locale: "en" });

    // listicle IS in BLOG_FAMILY_ARTICLE_TYPES (registered for CPS-enum
    // parity, C-26) — only the novel_article row is excluded here.
    expect(files[0]!.entries.map((entry) => entry.loc)).toEqual([
      "https://novel.example/blog/a-blog-post",
      "https://novel.example/blog/a-listicle",
    ]);
  });

  /**
   * C-25 x C-29: the blog-family half of the plan's "草稿/已发布 × 三种可见性"
   * truth table — mirrors `./sitemap-data.test.ts`'s existing Novel-family
   * coverage of the same axes.
   */
  it("draft/unpublished/takedown blog Articles never appear regardless of seoVisibility", async () => {
    process.env.SITE_URL = "https://novel.example";
    process.env.FEATURE_ARTICLE_BLOG = "true";
    const fixtureDb = db([
      blogCandidate({ id: "draft", slug: "a-draft", status: "draft" }),
      blogCandidate({ id: "unpublished", slug: "an-unpublished", status: "unpublished" }),
      blogCandidate({ id: "takedown", slug: "a-takedown", status: "takedown" }),
      blogCandidate({ id: "deleted", slug: "a-deleted", deletedAt: new Date() }),
    ]);

    const files = await createSitemapFamilyBuilder(fixtureDb as never)({ type: "blogpage", locale: "en" });

    expect(files).toEqual([]);
  });

  it("C-25: excludes seoVisibility=hidden (both the DB pre-filter and the per-row recheck), keeps seo_only", async () => {
    process.env.SITE_URL = "https://novel.example";
    process.env.FEATURE_ARTICLE_BLOG = "true";
    process.env.FEATURE_ARTICLE_SEO_VISIBILITY = "true";
    const fixtureDb = db([
      blogCandidate({ seoVisibility: "public" }),
      blogCandidate({ id: "seo-only", slug: "seo-only-post", seoVisibility: "seo_only" }),
      blogCandidate({ id: "hidden", slug: "hidden-post", seoVisibility: "hidden" }),
    ]);

    const files = await createSitemapFamilyBuilder(fixtureDb as never)({ type: "blogpage", locale: "en" });

    expect(files[0]!.entries.map((entry) => entry.loc)).toEqual([
      "https://novel.example/blog/a-blog-post",
      "https://novel.example/blog/seo-only-post",
    ]);
    const query = fixtureDb.article.findMany.mock.calls[0]![0];
    expect(JSON.stringify(query.where)).toContain('"seoVisibility":{"not":"hidden"}');
  });

  it("C-25: the flag off degrades to including hidden (pre-C-25 shape)", async () => {
    process.env.SITE_URL = "https://novel.example";
    process.env.FEATURE_ARTICLE_BLOG = "true";
    // FEATURE_ARTICLE_SEO_VISIBILITY deliberately left unset.
    const fixtureDb = db([
      blogCandidate({ seoVisibility: "public" }),
      blogCandidate({ id: "hidden", slug: "hidden-post", seoVisibility: "hidden" }),
    ]);

    const files = await createSitemapFamilyBuilder(fixtureDb as never)({ type: "blogpage", locale: "en" });

    expect(files[0]!.entries).toHaveLength(2);
  });

  it("memoizes the blog candidate query per locale — a second blogpage call for the same locale does not re-query", async () => {
    process.env.SITE_URL = "https://novel.example";
    process.env.FEATURE_ARTICLE_BLOG = "true";
    const fixtureDb = db([blogCandidate()]);
    const builder = createSitemapFamilyBuilder(fixtureDb as never);

    await builder({ type: "blogpage", locale: "en" });
    await builder({ type: "blogpage", locale: "en" });

    expect(fixtureDb.article.findMany).toHaveBeenCalledTimes(1);
  });
});
