import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSitemapFamilyBuilder } from "@/lib/seo/sitemap";
import { getPublicCategoryPage, listPublicCategoryPageCounts } from "@/lib/site/category-queries";
import { clearPublicCategoryCountsCacheForTest } from "@/lib/site/public-list";

import { classifyPublicListQuery } from "../../fixtures/in-memory-public-db";

/**
 * B-38：站点地图的分类网址必须是分类页确实返回 200 的。
 *
 * 历史：分类页只在"最新 240 本"的内存窗口里按分类过滤，站点地图却按全部公开书目判定"这个分类下有没有书"，冷门分类的书
 * 全在窗口之外时，站点地图列了、页面 404。v0.5.13（数据库分页）起窗口没有了：分类页、站点地图、页脚、hreflang 用
 * `src/lib/site/public-list.ts` 里同一段列表可见性 / 分类归属 SQL——站点地图的"是否列、列几页"读不带缓存的每语种
 * 每分类本数矩阵（`listPublicCategoryPageCounts`），页面读同一段 SQL 的编号 + 总数。
 *
 * 这里用内存 db（按 SQL 结构分派、按绑定值求值）在默认的 `npm test` 里钉住站点地图这一层的**胶水**：
 *   - 页面没有列表可见书的分类（例如书只是 `seo_only`：站点地图候选收、列表不收）不列；
 *   - 有书的分类照列，`?page=N` 只到页面的总页数（= ceil(列表可见本数 / 20)，**不再截断**）；
 *   - 站点地图列出的每个网址，用 `getPublicCategoryPage` 查都不为 null（同一个 db、同一段筛选）；
 *   - 一个语种只读一次矩阵，与分类个数无关；其它家族（novelpage / blogpage）不碰矩阵。
 * 真实库（真实角色、真实约束、四种开关组合、每个语种）的同款用例：
 * `tests/integration/site/consistency-invariants-postgres.test.ts`。
 */

const SITE = "https://novel.example";
const BASE = Date.parse("2026-01-01T00:00:00.000Z");

type Row = ReturnType<typeof bookRow>;

function bookRow(locale: string, ordinal: number, listed = true) {
  const novelId = `novel-${locale}-${ordinal}`;
  return {
    id: `article-${locale}-${String(ordinal).padStart(4, "0")}`,
    title: `Book ${ordinal}`,
    slug: `book-${locale}-${ordinal}`,
    locale,
    publicPageShortId: `s${locale}${ordinal}`,
    publishedAt: new Date(BASE + ordinal * 1000),
    updatedAt: new Date(BASE + ordinal * 1000),
    summary: null as string | null,
    status: "published",
    seoVisibility: "public",
    deletedAt: null as Date | null,
    /** 夹具专用：false = 站点地图候选里有、列表里没有（例如 seo_only）。 */
    listed,
    novel: {
      id: novelId, businessId: `biz-${locale}-${ordinal}`, title: `Book ${ordinal}`, description: "Desc",
      coverUrl: `/covers/${ordinal}.webp`, locale, totalChapterCount: 3, status: "published", deletedAt: null as Date | null,
    },
    promoLink: { status: "fetched", webUrl: `https://promo.example/${ordinal}`, appUrl: null, deletedAt: null as Date | null },
  };
}

type Category = { slug: string; sortOrder: number; ordinals: readonly [number, number][] };

const tagId = (category: Category) => `00000000-0000-4000-8000-${String(category.sortOrder).padStart(12, "0")}`;

function ordinalOf(row: Row) {
  return Number(row.novel.id.split("-").at(-1));
}

function categoriesOf(row: Row, categories: readonly Category[]) {
  return categories.filter((category) => category.ordinals.some(([from, to]) => ordinalOf(row) >= from && ordinalOf(row) <= to));
}

function makeDb(input: { rows: Row[]; categories: readonly Category[] }) {
  const stats = { matrixQueries: 0, pageIdQueries: 0 };
  const findMany = vi.fn(async (args: { where: { id?: { in: string[] }; AND?: Array<Record<string, unknown>> } }) => {
    if (args.where.id?.in) {
      const wanted = new Set(args.where.id.in);
      return input.rows.filter((row) => wanted.has(row.id));
    }
    // 站点地图候选：全部公开可见行（按 id）。块大小 500 > 行数，一次读完。
    const locale = args.where.AND!.find((clause) => "locale" in clause)?.locale;
    return input.rows.filter((row) => row.locale === locale).sort((a, b) => a.id.localeCompare(b.id));
  });
  const db = {
    article: { findMany },
    novelChapter: { findMany: vi.fn().mockResolvedValue([]) },
    canonicalTag: {
      findFirst: vi.fn(async ({ where }: { where: { slug: string } }) => {
        const category = input.categories.find((candidate) => candidate.slug === where.slug);
        return category
          ? { id: tagId(category), slug: category.slug, status: "active", sortOrder: category.sortOrder,
              updatedAt: new Date("2025-01-01T00:00:00.000Z"), translations: [] }
          : null;
      }),
    },
    siteSetting: { findUnique: vi.fn().mockResolvedValue({
      siteName: "Fixture", siteDescription: "", homeMetaTitle: "", homeMetaDescription: "", defaultOgImage: "",
      googleSearchConsoleVerification: "", footerCopyrightText: "", footerDisclaimerText: "", friendLinks: [],
      indexNowHost: "", indexNowKey: "", indexNowKeyLocation: "", ga4MeasurementId: null,
      yandexVerification: "", yandexMetricaId: null, siteSearchEnabled: false, updatedAt: new Date("2025-06-01T00:00:00.000Z"),
    }) },
    $queryRaw: vi.fn(async (query: { text: string; values: readonly unknown[] }) => {
      const values = query.values;
      switch (classifyPublicListQuery(query)) {
        case "matrix": {
          stats.matrixQueries += 1;
          const locales = new Set(values.filter((value): value is string => typeof value === "string"));
          const tally = new Map<string, number>();
          for (const row of input.rows) {
            if (!row.listed || !locales.has(row.locale)) continue;
            for (const category of categoriesOf(row, input.categories)) {
              tally.set(`${row.locale}|${category.slug}`, (tally.get(`${row.locale}|${category.slug}`) ?? 0) + 1);
            }
          }
          return [...tally].map(([key, n]) => {
            const [locale, slug] = key.split("|") as [string, string];
            return { locale, canonical_tag_id: tagId(input.categories.find((c) => c.slug === slug)!), slug, n };
          });
        }
        case "totals": return [];
        case "page-ids":
        case "page-count": {
          const kind = classifyPublicListQuery(query);
          if (kind === "page-ids") stats.pageIdQueries += 1;
          const locale = values.find((value): value is string => typeof value === "string" && input.rows.some((row) => row.locale === value))!;
          const category = input.categories.find((candidate) => values.includes(tagId(candidate)));
          const listed = input.rows
            .filter((row) => row.locale === locale && row.listed && (!category || categoriesOf(row, input.categories).includes(category)))
            .sort((a, b) => b.publishedAt.valueOf() - a.publishedAt.valueOf() || a.id.localeCompare(b.id));
          if (kind === "page-count") return [{ total: listed.length }];
          const [limit, offset] = values.filter((value): value is number => typeof value === "number").slice(-2) as [number, number];
          return listed.slice(offset, offset + limit).map((row) => ({ id: row.id }));
        }
        case "taxonomy": {
          const wanted = new Set(values.flat(Infinity) as unknown[]);
          return input.rows.filter((row) => wanted.has(row.novel.id)).flatMap((row) =>
            categoriesOf(row, input.categories).map((category) => ({
              novel_id: row.novel.id, id: tagId(category), slug: category.slug,
              requested_display_name: category.slug, en_display_name: category.slug, zh_display_name: null,
              sort_order: category.sortOrder, updated_at: new Date("2025-01-01T00:00:00.000Z"),
            })));
        }
        default: return [];
      }
    }),
  };
  return { db: db as unknown as PrismaClient, stats };
}

function categoryLocs(entries: ReadonlyArray<{ loc: string }>) {
  return entries.map((entry) => entry.loc).filter((loc) => loc.includes("/category/"));
}

afterEach(() => {
  delete process.env.SITE_URL;
  clearPublicCategoryCountsCacheForTest();
});

describe("B-38 sitemap category URLs follow the category page's own list semantics (database pagination, no window)", () => {
  // en：300 本；序号 1..60 站点地图收、列表不收（例如 seo_only），61..300 进列表。
  const rows = Array.from({ length: 300 }, (_, index) => bookRow("en", index + 1, index + 1 > 60));
  const categories: Category[] = [
    { slug: "adventure", sortOrder: 1, ordinals: [[5, 50]] }, // 书全都不进列表 → 页面 404
    { slug: "fantasy", sortOrder: 2, ordinals: [[70, 114], [10, 40]] }, // 进列表 45 本（3 页）+ 不进列表 31 本
    { slug: "romance", sortOrder: 3, ordinals: [[30, 30], [200, 200]] }, // 一本不进列表、一本进列表
  ];

  it("omits a category none of whose books are list-visible, lists the rest, and trims ?page=N to the page's own page count", async () => {
    process.env.SITE_URL = SITE;
    const { db } = makeDb({ rows, categories });

    // 页面事实：adventure 是 404（列表里一本都没有），fantasy 只有 3 页（进列表的 45 本，不含不进列表的 31 本）。
    expect(await getPublicCategoryPage(db, "en", "adventure", 1)).toBeNull();
    expect((await getPublicCategoryPage(db, "en", "fantasy", 3))?.novels).toHaveLength(5);
    expect(await getPublicCategoryPage(db, "en", "fantasy", 4)).toBeNull();

    const files = await createSitemapFamilyBuilder(db)({ type: "mainpage", locale: "en" });
    expect(categoryLocs(files.flatMap((file) => file.entries))).toEqual([
      `${SITE}/category/fantasy`,
      `${SITE}/category/fantasy?page=2`,
      `${SITE}/category/fantasy?page=3`,
      `${SITE}/category/romance`,
    ]);
  });

  it("no truncation: a category with 4,801 list-visible books gets all 241 pages (the old 240-book window is gone)", async () => {
    process.env.SITE_URL = SITE;
    const many = Array.from({ length: 4_801 }, (_, index) => bookRow("en", index + 1));
    const { db } = makeDb({ rows: many, categories: [{ slug: "huge", sortOrder: 1, ordinals: [[1, 4_801]] }] });
    const files = await createSitemapFamilyBuilder(db)({ type: "mainpage", locale: "en" });
    const locs = categoryLocs(files.flatMap((file) => file.entries));
    expect(locs).toHaveLength(241);
    expect(locs[0]).toBe(`${SITE}/category/huge`);
    expect(locs.at(-1)).toBe(`${SITE}/category/huge?page=241`);
    expect((await getPublicCategoryPage(db, "en", "huge", 241))?.novels).toHaveLength(1);
    expect(await getPublicCategoryPage(db, "en", "huge", 242)).toBeNull();
  });

  it("every category URL the sitemap lists is a non-null getPublicCategoryPage result, and the last listed page is the page's last page", async () => {
    process.env.SITE_URL = SITE;
    const { db } = makeDb({ rows, categories });
    const files = await createSitemapFamilyBuilder(db)({ type: "mainpage", locale: "en" });
    const locs = categoryLocs(files.flatMap((file) => file.entries));
    expect(locs.length).toBeGreaterThan(0);
    for (const loc of locs) {
      const match = /\/category\/([^?]+)(?:\?page=(\d+))?$/.exec(loc)!;
      expect(await getPublicCategoryPage(db, "en", match[1]!, match[2] ? Number(match[2]) : 1), loc).not.toBeNull();
    }
    // 站点地图的页数就是页面自己的总页数：`listPublicCategoryPageCounts` 与 `getPublicCategoryPage` 同一段筛选。
    const counts = await listPublicCategoryPageCounts(db, "en");
    expect([...counts.keys()].sort()).toEqual(["fantasy", "romance"]);
    for (const [slug, totalPages] of counts) {
      expect((await getPublicCategoryPage(db, "en", slug, 1))?.totalPages).toBe(totalPages);
      expect(await getPublicCategoryPage(db, "en", slug, totalPages + 1)).toBeNull();
    }
  });

  it("reads the count matrix exactly once per locale, however many categories there are; non-mainpage families never touch it", async () => {
    process.env.SITE_URL = SITE;
    const manyCategories: Category[] = Array.from({ length: 12 }, (_, index) => ({
      slug: `cat-${index + 1}`, sortOrder: index + 1, ordinals: [[250 + index, 250 + index]] as [number, number][],
    }));
    const { db, stats } = makeDb({ rows, categories: manyCategories });
    const builder = createSitemapFamilyBuilder(db);
    const files = await builder({ type: "mainpage", locale: "en" });
    expect(categoryLocs(files.flatMap((file) => file.entries))).toHaveLength(12);
    expect(stats.matrixQueries).toBe(1);
    expect(stats.pageIdQueries).toBe(0); // 站点地图不查任何页面的编号
    await builder({ type: "novelpage", locale: "en" });
    await builder({ type: "blogpage", locale: "en" });
    expect(stats.matrixQueries).toBe(1);
  });

  it("a locale whose books are all list-visible keeps every category and its full page count", async () => {
    process.env.SITE_URL = SITE;
    const koRows = Array.from({ length: 30 }, (_, index) => bookRow("ko", index + 1));
    const { db } = makeDb({ rows: koRows, categories: [{ slug: "xuanhuan", sortOrder: 1, ordinals: [[1, 25]] }, { slug: "yanqing", sortOrder: 2, ordinals: [[26, 30]] }] });
    const files = await createSitemapFamilyBuilder(db)({ type: "mainpage", locale: "ko" });
    expect(files.flatMap((file) => file.entries).map((entry) => entry.loc)).toEqual([
      `${SITE}/ko`,
      `${SITE}/ko/category/xuanhuan`, `${SITE}/ko/category/xuanhuan?page=2`,
      `${SITE}/ko/category/yanqing`,
    ]);
  });
});
