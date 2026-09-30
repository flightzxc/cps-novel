import type { PrismaClient } from "@prisma/client";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getPublicCategoryPage } from "@/lib/site/category-queries";
import { loadPublicTaxonomyByNovelIds } from "@/lib/site/public-taxonomy";
import { buildPublicArticleWhere } from "@/server/publication/visibility";
import { createSitemapFamilyBuilder } from "@/lib/seo/sitemap";

const article = {
  id: "article-1", title: "Lantern", slug: "lantern", locale: "en",
  publicPageShortId: "abc123", publishedAt: new Date("2026-09-01T00:00:00Z"), summary: "Summary",
  novel: { id: "11111111-1111-4111-8111-111111111111", businessId: "biz-1", title: "Lantern", description: "Desc", coverUrl: "/cover.jpg", locale: "en", totalChapterCount: 3 },
  promoLink: { status: "fetched", webUrl: "https://upstream.example/book", appUrl: null },
};
const tagRow = {
  novel_id: article.novel.id,
  id: "22222222-2222-4222-8222-222222222222",
  slug: "fantasy",
  requested_display_name: "Fantasy",
  en_display_name: "Fantasy",
  zh_display_name: "奇幻",
  sort_order: 7,
  updated_at: new Date("2026-09-02T00:00:00Z"),
};

afterEach(() => vi.unstubAllEnvs());

describe("public category queries · CPS category semantics on CanonicalTag", () => {
  it("uses the central published-only predicate and returns a populated category", async () => {
    const findMany = vi.fn().mockResolvedValue([article]);
    const db = {
      canonicalTag: { findFirst: vi.fn().mockResolvedValue({
        id: tagRow.id, slug: tagRow.slug, status: "active", canonicalDefinition: "Fantasy novels",
        sortOrder: tagRow.sort_order, updatedAt: tagRow.updated_at,
        translations: [{ locale: "en", displayName: "Fantasy" }],
      }) },
      article: { findMany },
      $queryRaw: vi.fn().mockResolvedValue([tagRow]),
    } as unknown as PrismaClient;
    const result = await getPublicCategoryPage(db, "en", "fantasy", 1);
    expect(findMany.mock.calls[0][0].where).toEqual(buildPublicArticleWhere({ locale: "en" }));
    expect(result?.category.name).toBe("Fantasy");
    expect(result?.category.description).toBeNull();
    expect(result?.novels[0]?.tags).toEqual([expect.objectContaining({ slug: "fantasy" })]);
  });

  it("404 contract: an active category with no published/promo-ready book returns null", async () => {
    const db = {
      canonicalTag: { findFirst: vi.fn().mockResolvedValue({
        id: tagRow.id, slug: tagRow.slug, status: "active", canonicalDefinition: "Fantasy", sortOrder: 7,
        updatedAt: tagRow.updated_at, translations: [],
      }) },
      article: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: vi.fn(),
    } as unknown as PrismaClient;
    await expect(getPublicCategoryPage(db, "en", "fantasy", 1)).resolves.toBeNull();
  });

  it("manual FULL_SNAPSHOT overrides mapping (including empty); automatic/missing state derives mapping and excludes auto", async () => {
    vi.stubEnv("FEATURE_NOVEL_TAG_AUTO", "false");
    const query = vi.fn().mockResolvedValue([tagRow]);
    const result = await loadPublicTaxonomyByNovelIds({ $queryRaw: query } as unknown as PrismaClient, [article.novel.id], "en");
    const sql = (query.mock.calls[0][0] as { strings: readonly string[] }).strings.join(" ");
    expect(sql).toContain("nct.source = 'manual'");
    expect(sql).toContain("nts.mode = 'manual'");
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("source_label_mapping");
    expect(sql).toContain("en.locale = 'en'");
    expect(sql).toContain("zh.locale = 'zh'");
    expect(sql).not.toContain("nct.source = 'auto'");
    expect(JSON.stringify(result.get(article.novel.id))).not.toMatch(/rawToken|externalLabel|sourceLabel/i);
  });

  it("includes only the current auto run when enabled, with mapped priority", async () => {
    vi.stubEnv("FEATURE_NOVEL_TAG_AUTO", "true");
    const query = vi.fn().mockResolvedValue([tagRow]);
    await loadPublicTaxonomyByNovelIds({ $queryRaw: query } as unknown as PrismaClient, [article.novel.id], "en");
    const sql = query.mock.calls[0][0].strings.join(" ");
    expect(sql).toContain("nct.source = 'auto'");
    expect(sql).toContain("nct.classification_run_id = nts.current_auto_run_id");
    expect(sql).toContain("mapped.canonical_tag_id = automatic.canonical_tag_id");
    expect(sql).toContain("target_source_item AS MATERIALIZED");
  });

  it("keeps AUTO_WRITE_AUTHORIZED=NO: public consumers contain no auto mutation call", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src/lib/site/public-taxonomy.ts"), "utf8");
    expect(source).not.toMatch(/replaceAutoTagSnapshot|novelCanonicalTag\.(create|update|upsert)/);
  });

  // 运营 V2（Owner 2026-09-30）：分类页并入 mainpage——分类条目跟在首页后面，判定不变。
  it("category entries (now inside mainpage, after the home page) include only tags backed by a visible published book", async () => {
    process.env.SITE_URL = "https://novel.example";
    const db = {
      article: { findMany: vi.fn().mockResolvedValue([{
        ...article, status: "published", updatedAt: new Date("2026-09-03T00:00:00Z"), deletedAt: null,
        novel: { id: article.novel.id, status: "published", deletedAt: null, coverUrl: "/cover.jpg" },
        promoLink: { ...article.promoLink, deletedAt: null },
      }]) },
      siteSetting: { findUnique: vi.fn().mockResolvedValue({
        siteName: "Fixture", siteDescription: "", homeMetaTitle: "", homeMetaDescription: "", defaultOgImage: "",
        googleSearchConsoleVerification: "", footerCopyrightText: "", footerDisclaimerText: "", friendLinks: [],
        indexNowHost: "", indexNowKey: "", indexNowKeyLocation: "", ga4MeasurementId: null,
        yandexVerification: "", yandexMetricaId: null, updatedAt: new Date("2026-09-01T00:00:00Z"),
      }) },
      $queryRaw: vi.fn().mockResolvedValue([tagRow]),
    } as unknown as PrismaClient;
    const files = await createSitemapFamilyBuilder(db)({ type: "mainpage", locale: "en" });
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("site_mainpage_en.xml");
    expect(files[0]?.entries).toEqual([
      expect.objectContaining({ loc: "https://novel.example", priority: 1 }),
      expect.objectContaining({ loc: expect.stringContaining("/category/fantasy"), priority: 0.7 }),
    ]);

    // No tag has any public membership -> mainpage is just the home page (the locale still has a book).
    (db.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const emptyBuilder = createSitemapFamilyBuilder(db);
    const homeOnly = await emptyBuilder({ type: "mainpage", locale: "en" });
    expect(homeOnly[0]?.entries).toEqual([expect.objectContaining({ loc: "https://novel.example" })]);
    delete process.env.SITE_URL;
  });
});
