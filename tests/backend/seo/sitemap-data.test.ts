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
