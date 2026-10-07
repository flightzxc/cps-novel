import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSitemapFamilyBuilder } from "@/lib/seo/sitemap";
import { getPublicCategoryPage, listPublicCategoryPageCounts } from "@/lib/site/category-queries";
import { PUBLIC_LIST_CAP } from "@/lib/site/queries";

/**
 * B-38（2026-10-07）：站点地图的分类网址必须是分类页确实返回 200 的。
 *
 * 分类页只在 `listPublicArticles` 的最新 `PUBLIC_LIST_CAP`（240）本里过滤；站点地图过去按全部公开书目判定，
 * 冷门分类的书全在最新 240 本之外时，站点地图列了、页面 404。这里用一个**真正遵守 `take` / 排序**的内存 db
 * （不是"忽略 take 直接返回所有行"的桩），在默认的 `npm test` 里快速钉住：
 *   - 书全在最新 240 本之外的分类不列；
 *   - 书在最新 240 本之内的分类照列，`?page=N` 只到页面的总页数；
 *   - 站点地图列出的每个网址，用 `getPublicCategoryPage` 查都不为 null（同一个 db、同一套谓词）；
 *   - 每个语种只发一次页面的列表查询。
 * 真实库（真实角色、真实约束）的同款用例在 `tests/integration/tasks/sitemap-category-cap-postgres.test.ts`。
 */

const SITE = "https://novel.example";
const BASE = Date.parse("2026-01-01T00:00:00.000Z");

type Row = ReturnType<typeof bookRow>;

function bookRow(locale: string, ordinal: number) {
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
    novel: {
      id: novelId, businessId: `biz-${locale}-${ordinal}`, title: `Book ${ordinal}`, description: "Desc",
      coverUrl: `/covers/${ordinal}.webp`, locale, totalChapterCount: 3, status: "published", deletedAt: null as Date | null,
    },
    promoLink: { status: "fetched", webUrl: `https://promo.example/${ordinal}`, appUrl: null, deletedAt: null as Date | null },
  };
}

type Category = { slug: string; sortOrder: number; ordinals: readonly [number, number][] };

function tagRows(category: Category, row: Row, ordinal: number) {
  if (!category.ordinals.some(([from, to]) => ordinal >= from && ordinal <= to)) return [];
  return [{
    novel_id: row.novel.id,
    id: `00000000-0000-4000-8000-${String(category.sortOrder).padStart(12, "0")}`,
    slug: category.slug,
    requested_display_name: category.slug,
    en_display_name: category.slug,
    zh_display_name: null,
    sort_order: category.sortOrder,
    updated_at: new Date("2025-01-01T00:00:00.000Z"),
  }];
}

function makeDb(input: { rows: Row[]; categories: readonly Category[] }) {
  const stats = { listQueries: 0 };
  const ordinalByNovel = new Map(input.rows.map((row) => [row.novel.id, Number(row.novel.id.split("-").at(-1))]));
  const findMany = vi.fn(async (args: { take?: number; where: { AND: Array<Record<string, unknown>> } }) => {
    const locale = args.where.AND.find((clause) => "locale" in clause)?.locale;
    const inLocale = input.rows.filter((row) => row.locale === locale);
    if (args.take === PUBLIC_LIST_CAP) {
      // 页面的列表查询：按 publishedAt 降序、id 升序，只取前 take 本。
      stats.listQueries += 1;
      return [...inLocale]
        .sort((a, b) => b.publishedAt.valueOf() - a.publishedAt.valueOf() || a.id.localeCompare(b.id))
        .slice(0, args.take);
    }
    // 站点地图候选：全部公开可见行（按 id）。块大小 500 > 行数，一次读完。
    return [...inLocale].sort((a, b) => a.id.localeCompare(b.id));
  });
  const db = {
    article: { findMany },
    canonicalTag: {
      findFirst: vi.fn(async ({ where }: { where: { slug: string } }) => {
        const category = input.categories.find((candidate) => candidate.slug === where.slug);
        return category
          ? { id: `00000000-0000-4000-8000-${String(category.sortOrder).padStart(12, "0")}`, slug: category.slug,
              status: "active", sortOrder: category.sortOrder, updatedAt: new Date("2025-01-01T00:00:00.000Z"), translations: [] }
          : null;
      }),
    },
    siteSetting: { findUnique: vi.fn().mockResolvedValue({
      siteName: "Fixture", siteDescription: "", homeMetaTitle: "", homeMetaDescription: "", defaultOgImage: "",
      googleSearchConsoleVerification: "", footerCopyrightText: "", footerDisclaimerText: "", friendLinks: [],
      indexNowHost: "", indexNowKey: "", indexNowKeyLocation: "", ga4MeasurementId: null,
      yandexVerification: "", yandexMetricaId: null, updatedAt: new Date("2025-06-01T00:00:00.000Z"),
    }) },
    $queryRaw: vi.fn(async (query: { values?: unknown[] }) => {
      const ids = new Set((query.values ?? []).flat(Infinity) as unknown[]);
      return input.rows
        .filter((row) => ids.has(row.novel.id))
        .flatMap((row) => input.categories.flatMap((category) =>
          tagRows(category, row, ordinalByNovel.get(row.novel.id)!)));
    }),
  };
  return { db: db as unknown as PrismaClient, stats };
}

function categoryLocs(entries: ReadonlyArray<{ loc: string }>) {
  return entries.map((entry) => entry.loc).filter((loc) => loc.includes("/category/"));
}

afterEach(() => {
  delete process.env.SITE_URL;
});

describe("B-38 sitemap category URLs follow the category page's own 240-book window", () => {
  // en：300 本，最新 240 本 = 序号 61..300。
  const rows = Array.from({ length: 300 }, (_, index) => bookRow("en", index + 1));
  const categories: Category[] = [
    { slug: "adventure", sortOrder: 1, ordinals: [[5, 50]] }, // 书全在窗口之外
    { slug: "fantasy", sortOrder: 2, ordinals: [[70, 114], [10, 40]] }, // 窗口之内 45 本（3 页）+ 之外 31 本
    { slug: "romance", sortOrder: 3, ordinals: [[30, 30], [200, 200]] }, // 一内一外
  ];

  it("omits a category whose books are all outside the newest 240, lists the rest, and trims ?page=N to the page's own page count", async () => {
    process.env.SITE_URL = SITE;
    const { db } = makeDb({ rows, categories });

    // 页面事实：adventure 是 404（窗口里一本都没有），fantasy 只有 3 页。
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
    // 站点地图的页数就是页面自己的总页数：`listPublicCategoryPageCounts` 与 `getPublicCategoryPage` 同源。
    const counts = await listPublicCategoryPageCounts(db, "en");
    expect([...counts.keys()].sort()).toEqual(["fantasy", "romance"]);
    for (const [slug, totalPages] of counts) {
      expect((await getPublicCategoryPage(db, "en", slug, 1))?.totalPages).toBe(totalPages);
      expect(await getPublicCategoryPage(db, "en", slug, totalPages + 1)).toBeNull();
    }
  });

  it("calls the page's list query exactly once per locale, however many categories there are", async () => {
    process.env.SITE_URL = SITE;
    const manyCategories: Category[] = Array.from({ length: 12 }, (_, index) => ({
      slug: `cat-${index + 1}`, sortOrder: index + 1, ordinals: [[250 + index, 250 + index]] as [number, number][],
    }));
    const { db, stats } = makeDb({ rows, categories: manyCategories });
    const files = await createSitemapFamilyBuilder(db)({ type: "mainpage", locale: "en" });
    expect(categoryLocs(files.flatMap((file) => file.entries))).toHaveLength(12);
    expect(stats.listQueries).toBe(1);
  });

  it("a locale with at most 240 books keeps every category and its full page count (unchanged behaviour)", async () => {
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
