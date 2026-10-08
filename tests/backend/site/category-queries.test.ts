import type { PrismaClient } from "@prisma/client";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPublicCategoryPage } from "@/lib/site/category-queries";
import { clearPublicCategoryCountsCacheForTest } from "@/lib/site/public-list";
import { loadPublicTaxonomyByNovelIds } from "@/lib/site/public-taxonomy";
import { createSitemapFamilyBuilder } from "@/lib/seo/sitemap";

import { classifyPublicListQuery } from "../../fixtures/in-memory-public-db";

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
const tagRecord = {
  id: tagRow.id, slug: tagRow.slug, status: "active", canonicalDefinition: "Fantasy novels",
  sortOrder: tagRow.sort_order, updatedAt: tagRow.updated_at,
  translations: [{ locale: "en", displayName: "Fantasy" }],
};

beforeEach(() => clearPublicCategoryCountsCacheForTest());
afterEach(() => {
  vi.unstubAllEnvs();
  clearPublicCategoryCountsCacheForTest();
});

/** 分类页用的最小假库：按 SQL 结构分派 `$queryRaw`，补全卡片走 `article.findMany`。 */
function pageDb(options: { ids?: string[]; total?: number; tag?: typeof tagRecord | null }) {
  const statements: Array<{ kind: string; text: string; values: readonly unknown[] }> = [];
  const findMany = vi.fn().mockResolvedValue([article]);
  const queryRaw = vi.fn(async (query: { text: string; values: readonly unknown[] }) => {
    const kind = classifyPublicListQuery(query);
    statements.push({ kind, text: query.text, values: query.values });
    if (kind === "page-ids") return (options.ids ?? []).map((id) => ({ id }));
    if (kind === "page-count") return [{ total: options.total ?? 0 }];
    if (kind === "taxonomy") return [tagRow];
    return [];
  });
  const db = {
    canonicalTag: { findFirst: vi.fn().mockResolvedValue(options.tag === undefined ? tagRecord : options.tag) },
    article: { findMany },
    $queryRaw: queryRaw,
  } as unknown as PrismaClient;
  return { db, statements, findMany };
}

describe("public category queries · CPS category semantics on CanonicalTag", () => {
  it("原生 SQL 定'当前页编号 + 总数'，卡片用 ARTICLE_CARD_SELECT 按编号补全并按原顺序排好，再读归属表补标签", async () => {
    const { db, statements, findMany } = pageDb({ ids: ["article-1"], total: 1 });
    const result = await getPublicCategoryPage(db, "en", "fantasy", 1);

    expect(statements.map((statement) => statement.kind).sort()).toEqual(["page-count", "page-ids", "taxonomy"]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0]![0]).toMatchObject({ where: { id: { in: ["article-1"] } } });
    expect(findMany.mock.calls[0]![0].select.promoLink.select).not.toHaveProperty("publicRedirectCode"); // 卡片绝不携带公开跳转码
    expect(result?.category).toMatchObject({ slug: "fantasy", name: "Fantasy", description: null, sortOrder: 7 });
    expect(result).toMatchObject({ page: 1, totalPages: 1, totalCount: 1 });
    expect(result?.novels[0]?.tags).toEqual([expect.objectContaining({ slug: "fantasy" })]);

    // 分类 id 与分页参数作为绑定值传给原生 SQL（不拼进语句文本）；LIMIT 20、第 1 页 OFFSET 0。
    const idsStatement = statements.find((statement) => statement.kind === "page-ids")!;
    expect(idsStatement.values).toContain(tagRecord.id);
    expect(idsStatement.values.slice(-2)).toEqual([20, 0]);
    expect(idsStatement.text).not.toContain(tagRecord.id);
  });

  it("补全后按第一步返回的编号顺序排好（findMany 本身不保序）", async () => {
    const rows = ["c", "a", "b"].map((id) => ({ ...article, id, novel: { ...article.novel, id: `n-${id}`, businessId: `biz-${id}` }, slug: id }));
    const { db, findMany } = pageDb({ ids: ["a", "b", "c"], total: 3 });
    findMany.mockResolvedValue(rows);
    const result = await getPublicCategoryPage(db, "en", "fantasy", 1);
    expect(result?.novels.map((novel) => novel.id)).toEqual(["biz-a", "biz-b", "biz-c"]);
  });

  it("第 3 页：OFFSET = 40；总数 45 → 总页数 3，页码在范围内", async () => {
    const { db, statements } = pageDb({ ids: ["article-1"], total: 45 });
    const result = await getPublicCategoryPage(db, "en", "fantasy", 3);
    expect(result).toMatchObject({ page: 3, totalPages: 3, totalCount: 45 });
    expect(statements.find((statement) => statement.kind === "page-ids")!.values.slice(-2)).toEqual([20, 40]);
  });

  it("404 contract: an active category with no list-visible book (total 0) returns null — and nothing is hydrated", async () => {
    const { db, findMany } = pageDb({ ids: [], total: 0 });
    await expect(getPublicCategoryPage(db, "en", "fantasy", 1)).resolves.toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("404 contract: a page beyond the last page returns null (total 45 → 3 pages, page 4)", async () => {
    const { db } = pageDb({ ids: [], total: 45 });
    await expect(getPublicCategoryPage(db, "en", "fantasy", 4)).resolves.toBeNull();
  });

  it("404 contract: unknown / inactive category, empty or over-long slug → null without touching the list", async () => {
    const missing = pageDb({ tag: null });
    await expect(getPublicCategoryPage(missing.db, "en", "nope", 1)).resolves.toBeNull();
    expect(missing.statements).toEqual([]);
    const blank = pageDb({});
    await expect(getPublicCategoryPage(blank.db, "en", "   ", 1)).resolves.toBeNull();
    await expect(getPublicCategoryPage(blank.db, "en", "x".repeat(161), 1)).resolves.toBeNull();
    expect(blank.statements).toEqual([]);
    expect(blank.db.canonicalTag.findFirst).not.toHaveBeenCalled();
  });

  it("slug 规范化：首尾空白与大小写（页面入口的 trim / lowercase）", async () => {
    const { db } = pageDb({ ids: ["article-1"], total: 1 });
    await getPublicCategoryPage(db, "en", "  Fantasy ", 1);
    expect(vi.mocked(db.canonicalTag.findFirst).mock.calls[0]![0]).toMatchObject({ where: { slug: "fantasy", status: "active" } });
  });

  it("读归属表：自动标签开关作为绑定值（关 → false，开 → true），不写进 SQL 文本也不写进表", async () => {
    for (const flag of ["false", "true"]) {
      vi.stubEnv("FEATURE_NOVEL_TAG_AUTO", flag);
      const { db, statements } = pageDb({ ids: ["article-1"], total: 1 });
      await getPublicCategoryPage(db, "en", "fantasy", 1);
      for (const kind of ["page-ids", "page-count", "taxonomy"]) {
        const statement = statements.find((candidate) => candidate.kind === kind)!;
        expect(statement.values, `${kind} auto=${flag}`).toContain(flag === "true");
        expect(statement.values.includes(flag !== "true"), `${kind} auto=${flag}（不含相反值）`).toBe(false);
      }
    }
  });

  it("loadPublicTaxonomyByNovelIds 只读归属表：不再现场计算（规则 SQL 住在投影模块），不含任何规则片段与原始标签", async () => {
    vi.stubEnv("FEATURE_NOVEL_TAG_AUTO", "true");
    const query = vi.fn().mockResolvedValue([tagRow]);
    const result = await loadPublicTaxonomyByNovelIds({ $queryRaw: query } as unknown as PrismaClient, [article.novel.id], "en");
    const sql = (query.mock.calls[0]![0] as { strings: readonly string[] }).strings.join(" ").replace(/\s+/g, " ");
    expect(sql).toContain("FROM novel_effective_tag m");
    expect(sql).toContain("ct.status = 'active'");
    expect(sql).toContain("m.provenance <> 'auto' OR");
    expect(sql).toContain("ORDER BY m.novel_id, m.rank");
    expect(sql).toContain("en.locale = 'en'");
    expect(sql).toContain("zh.locale = 'zh'");
    for (const rule of ["source_label_mapping", "target_source_item", "novel_tag_state", "nct.source", "MATERIALIZED"]) {
      expect(sql, rule).not.toContain(rule);
    }
    expect(JSON.stringify(result.get(article.novel.id))).not.toMatch(/rawToken|externalLabel|sourceLabel/i);
    expect(result.get(article.novel.id)?.[0]).toMatchObject({ slug: "fantasy", label: "Fantasy", href: "/category/fantasy", sortOrder: 7 });
  });

  it("keeps AUTO_WRITE_AUTHORIZED=NO: public consumers contain no auto mutation call", async () => {
    for (const file of ["src/lib/site/public-taxonomy.ts", "src/lib/site/public-list.ts", "src/lib/site/category-queries.ts"]) {
      const source = await readFile(path.resolve(process.cwd(), file), "utf8");
      expect(source, file).not.toMatch(/replaceAutoTagSnapshot|novelCanonicalTag\.(create|update|upsert)|novel_effective_tag\s+(SET|VALUES)|INSERT INTO novel_effective_tag|DELETE FROM novel_effective_tag|UPDATE novel_effective_tag/);
    }
  });

  // 运营 V2（Owner 2026-09-30）：分类页并入 mainpage——分类条目跟在首页后面，判定不变。
  it("category entries (now inside mainpage, after the home page) include only tags backed by a list-visible published book", async () => {
    process.env.SITE_URL = "https://novel.example";
    const matrixRow = { locale: "en", canonical_tag_id: tagRow.id, slug: "fantasy", n: 1 };
    let matrix: unknown[] = [matrixRow];
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
      $queryRaw: vi.fn(async (query: { text: string }) => {
        const kind = classifyPublicListQuery(query);
        if (kind === "matrix") return matrix;
        if (kind === "totals") return [{ locale: "en", n: 1 }];
        return kind === "taxonomy" ? [tagRow] : [];
      }),
    } as unknown as PrismaClient;
    const files = await createSitemapFamilyBuilder(db)({ type: "mainpage", locale: "en" });
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("site_mainpage_en.xml");
    expect(files[0]?.entries).toEqual([
      expect.objectContaining({ loc: "https://novel.example", priority: 1 }),
      expect.objectContaining({ loc: expect.stringContaining("/category/fantasy"), priority: 0.7 }),
    ]);

    // 候选里有这个标签，但页面列表里没有书（例如书只是 seo_only：站点地图收、列表不收）→ 矩阵里没有 → 不列这个分类。
    matrix = [];
    const homeOnly = await createSitemapFamilyBuilder(db)({ type: "mainpage", locale: "en" });
    expect(homeOnly[0]?.entries).toEqual([expect.objectContaining({ loc: "https://novel.example" })]);

    // No tag has any membership at all -> mainpage is just the home page (the locale still has a book).
    (db.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => []);
    const emptyBuilder = createSitemapFamilyBuilder(db);
    const noTags = await emptyBuilder({ type: "mainpage", locale: "en" });
    expect(noTags[0]?.entries).toEqual([expect.objectContaining({ loc: "https://novel.example" })]);
    delete process.env.SITE_URL;
  });
});
