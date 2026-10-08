import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getPublicChapterView,
  getPublicNovelDetail,
  listHomeNovels,
  listPublicCategories,
  loadPublicChrome,
} from "@/lib/site/queries";
import { invalidateSiteSettingCache } from "@/server/site-settings/service";
import { clearPublicCategoryCountsCacheForTest } from "@/lib/site/public-list";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

import { classifyPublicListQuery } from "../../fixtures/in-memory-public-db";

/**
 * N-9 (施工规格 / 交接提示词): a regression gate on how many DB round-trips
 * one page render costs, plus one capability this file adds and locks in.
 *
 * Finding (Lane B): `src/app/page.tsx` (home) called `@/app/_lib/public-load`'s
 * `loadChrome("home")` (settings + a full `listPublicCategories` query, for
 * the footer) *and*, separately, that module's own `loadPublicCategories
 * (locale)` (the same underlying query again, for `HomeScreen`'s own
 * `categories` prop) — two independent `listPublicCategories` round-trips
 * per home-page render for data that is identical both times (same locale,
 * same published-article snapshot). `loadPublicChrome` (`@/lib/site/queries`)
 * gained an optional third `categories` parameter so a caller who already has
 * the list can pass it in instead of triggering a second query.
 *
 * Fixed (Lane D): `@/app/_lib/public-load`'s `loadChrome` now forwards an
 * optional second argument down to `loadPublicChrome`'s `categories`
 * parameter (a signature change, not a new export — see that function's doc
 * comment for why: `tests/ui/public-routes.test.tsx`'s fixed `vi.mock`
 * factory only knows the existing export names). `src/app/page.tsx`'s
 * `generateMetadata` and default export both now call
 * `loadPublicCategories(locale)` once and hand the result to `loadChrome
 * ("home", categories)`, so the redundant second `listPublicCategories`
 * round-trip is gone.
 *
 * So this file does two things:
 *  1. Pins the *fixed* production call pattern's query count (N-9 originally
 *     as a ceiling: was ≤ 7 pre-fix, ≤ 5 after; B-38 re-pins it as the exact
 *     statement list, see the update below) so a regression still fails CI.
 *  2. Proves the `loadPublicChrome(..., categories)` capability itself works
 *     in isolation (no second query when `categories` is supplied).
 *
 * `getSiteSetting`'s own 30s process-local TTL cache
 * (`server/site-settings/service.ts`) means a *warm* cache serves every
 * `siteSetting` read for free; this file always calls
 * `invalidateSiteSettingCache()` first, i.e. it measures the conservative
 * *cold*-cache cost of one render, not the steady-state cost across
 * back-to-back requests within the same 30s window (which is strictly
 * lower).
 *
 * Home-carousel (`src/lib/site/home-carousel-service.ts`,
 * `getHomeCarouselItems`) is a separate lane's surface with its own test
 * coverage — deliberately excluded from this budget rather than
 * approximated.
 *
 * B-38 (v0.5.13) update — the numbers below are re-pinned for the database-paginated list:
 * `listPublicArticles` (the "load the newest 240 rows" query that the footer and the home grid
 * both ran) is gone. The footer categories now come from the per-locale-per-category count
 * matrix (`@/lib/site/public-list`: one counts statement + one visible-totals statement, cached
 * in-process for 60 seconds) plus a fresh read of the category names; the home grid is
 * ids (LIMIT 20) -> hydrate by id -> card tags read from `novel_effective_tag`. Every number is
 * now EXACT (not a ceiling) and given for both a cold matrix cache (first request after a
 * restart / every 60s) and a warm one (the steady state).
 */

type ArticleCardRow = {
  id: string;
  title: string;
  slug: string;
  locale: string;
  publicPageShortId: string;
  publishedAt: Date;
  summary: string | null;
  novel: { id: string; businessId: string; title: string; description: string; coverUrl: string | null; locale: string; totalChapterCount: number };
  promoLink: { status: string; webUrl: string | null; appUrl: string | null; publicRedirectCode?: string };
};

const NOVEL_ID = "11111111-1111-1111-1111-111111111111";

const ARTICLE_ROW: ArticleCardRow = {
  id: "article-1",
  title: "Some Novel",
  slug: "some-novel",
  locale: "en",
  publicPageShortId: "AbCdEf12",
  publishedAt: new Date("2026-09-01T00:00:00.000Z"),
  summary: "A summary",
  novel: {
    id: NOVEL_ID,
    businessId: "biz-1",
    title: "Some Novel",
    description: "A description",
    coverUrl: "https://example.test/cover.jpg",
    locale: "en",
    totalChapterCount: 10,
  },
  promoLink: { status: "fetched", webUrl: "https://example.test/read", appUrl: null, publicRedirectCode: "redirectcode123" },
};

const SITE_SETTING_ROW = {
  siteName: "cps-novel",
  siteDescription: "desc",
  homeMetaTitle: "home title",
  homeMetaDescription: "home desc",
  defaultOgImage: "https://example.test/og.jpg",
  googleSearchConsoleVerification: "",
  footerCopyrightText: "",
  footerDisclaimerText: "",
  friendLinks: [],
  indexNowHost: "",
  indexNowKey: "",
  indexNowKeyLocation: "",
  ga4MeasurementId: null,
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
};

const TAG_ROW = {
  novel_id: NOVEL_ID,
  id: "22222222-2222-4222-8222-222222222222",
  slug: "fantasy",
  requested_display_name: "Fantasy",
  en_display_name: null,
  zh_display_name: null,
  sort_order: 1,
  updated_at: new Date("2026-09-01T00:00:00.000Z"),
};

/**
 * Counts every DB round-trip by operation key. Returns the same fixture
 * row(s) regardless of the `where` clause content — this file measures
 * *call volume*, not filter correctness (that is `tests/backend/public/**`'s
 * and `tests/integration/site/**`'s job). Raw statements are told apart by
 * their structure (`classifyPublicListQuery`), the same way the in-memory
 * public db does.
 */
class CountingFakeDb {
  readonly calls: string[] = [];

  private record(key: string) {
    this.calls.push(key);
  }

  asPrismaClient(): PrismaClient {
    return {
      article: {
        findFirst: async () => {
          this.record("article.findFirst");
          return structuredClone(ARTICLE_ROW);
        },
        findMany: async () => {
          this.record("article.findMany (hydrate cards by id)");
          return [structuredClone(ARTICLE_ROW)];
        },
      },
      novelChapter: {
        findFirst: async () => {
          this.record("novelChapter.findFirst");
          return {
            canonicalChapterNumber: 1,
            title: "Chapter One",
            content: { body: "Paragraph one.\n\nParagraph two." },
          };
        },
        findMany: async () => {
          this.record("novelChapter.findMany");
          return [{ canonicalChapterNumber: 1, title: "Chapter One" }];
        },
      },
      siteSetting: {
        findUnique: async () => {
          this.record("siteSetting.findUnique");
          return structuredClone(SITE_SETTING_ROW);
        },
      },
      $queryRaw: async (query: { text: string }) => {
        const kind = classifyPublicListQuery(query);
        this.record(`$queryRaw (${kind})`);
        switch (kind) {
          case "matrix": return [{ locale: "en", canonical_tag_id: TAG_ROW.id, slug: TAG_ROW.slug, n: 1 }];
          case "totals": return [{ locale: "en", n: 1 }];
          case "category-names": return [TAG_ROW];
          case "page-ids": return [{ id: ARTICLE_ROW.id }];
          case "page-count": return [{ total: 1 }];
          case "taxonomy": return [TAG_ROW];
          default: return [];
        }
      },
    } as unknown as PrismaClient;
  }

  countOf(key: string): number {
    return this.calls.filter((call) => call === key).length;
  }

  /** 每个 key 的次数，按 key 排序，便于整体断言。 */
  histogram(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const call of [...this.calls].sort()) result[call] = (result[call] ?? 0) + 1;
    return result;
  }
}

beforeEach(() => {
  invalidateSiteSettingCache();
  clearPublicCategoryCountsCacheForTest();
});

afterEach(() => vi.unstubAllEnvs());

/**
 * The exact statements of each render. "cold" = matrix cache empty (first request after a restart, then once
 * per 60 s); "warm" = matrix cache hit (the steady state: the counts + visible-totals statements disappear,
 * the category-name read stays because names are never cached).
 */
const MATRIX = { "$queryRaw (matrix)": 1, "$queryRaw (totals)": 1 } as const;
const NAMES = { "$queryRaw (category-names)": 1 } as const;
const SETTINGS = { "siteSetting.findUnique": 1 } as const;
const HOME_GRID = {
  "$queryRaw (page-ids)": 1, // ids, LIMIT 20 — no total
  "article.findMany (hydrate cards by id)": 1,
  "$queryRaw (taxonomy)": 1, // card tags, read from the projection table
} as const;
const DETAIL = { "article.findFirst": 1, "novelChapter.findMany": 1, "$queryRaw (taxonomy)": 1 } as const;
const CHAPTER = { "article.findFirst": 1, "novelChapter.findMany": 1, "novelChapter.findFirst": 1, "$queryRaw (taxonomy)": 1 } as const;
const sumOf = (...parts: Array<Record<string, number>>) => {
  const total: Record<string, number> = {};
  for (const part of parts) for (const [key, value] of Object.entries(part)) total[key] = (total[key] ?? 0) + value;
  return Object.fromEntries(Object.entries(total).sort(([a], [b]) => a.localeCompare(b)));
};

describe.each(["false", "true"])("公开侧一次渲染的查询数（auto=%s）", (flag) => {
  beforeEach(() => vi.stubEnv("FEATURE_NOVEL_TAG_AUTO", flag));
  it("首页（N-9 已接线，lane D）：categories 只算一次（页脚 + 作品格共用），冷 7 条 / 暖 5 条", async () => {
    const db = new CountingFakeDb();
    const client = db.asPrismaClient();

    // Mirrors `src/app/page.tsx` as it calls `@/app/_lib/public-load`: `loadPublicCategories(locale)` once, whose
    // result is handed to `loadChrome(locale, "home", categories)` (here simulated directly against `queries.ts` as
    // `loadPublicChrome(client, PUBLIC_SITE_LOCALE, "home", categories)`) instead of `loadChrome(locale, "home")`
    // re-querying categories internally. `generateMetadata` and the page body both do this same pair of calls in
    // production, but `React.cache()` request-scoping dedupes them to exactly the one round-trip modelled here.
    const categories = await listPublicCategories(client, PUBLIC_SITE_LOCALE);
    await loadPublicChrome(client, PUBLIC_SITE_LOCALE, "home", categories);
    await listHomeNovels(client, PUBLIC_SITE_LOCALE);

    expect(db.histogram()).toEqual(sumOf(SETTINGS, MATRIX, NAMES, HOME_GRID));
    expect(db.calls).toHaveLength(7);
    // 列表窗口的"先取一批再切片"没有了：首页作品格不数总数，也没有 page-count。
    expect(db.countOf("$queryRaw (page-count)")).toBe(0);

    // 暖缓存（同一进程里 60 秒内的下一个请求）：矩阵的两条语句消失。
    invalidateSiteSettingCache();
    const warm = new CountingFakeDb();
    const warmClient = warm.asPrismaClient();
    const warmCategories = await listPublicCategories(warmClient, PUBLIC_SITE_LOCALE);
    await loadPublicChrome(warmClient, PUBLIC_SITE_LOCALE, "home", warmCategories);
    await listHomeNovels(warmClient, PUBLIC_SITE_LOCALE);
    expect(warm.histogram()).toEqual(sumOf(SETTINGS, NAMES, HOME_GRID));
    expect(warm.calls).toHaveLength(5);
  });

  it("loadPublicChrome(..., categories) 能力：预先算好的 categories 不触发第二次查询（该能力已由 lane D 接入 src/app/page.tsx，本用例单独验证能力本身）", async () => {
    const db = new CountingFakeDb();
    const client = db.asPrismaClient();
    const categories = await listPublicCategories(client, PUBLIC_SITE_LOCALE);
    expect(db.histogram()).toEqual(sumOf(MATRIX, NAMES));

    await loadPublicChrome(client, PUBLIC_SITE_LOCALE, "home", categories);
    // `loadPublicChrome` must not have queried categories again — only the site setting was added.
    expect(db.histogram()).toEqual(sumOf(SETTINGS, MATRIX, NAMES));
  });

  it("详情页：getPublicNovelDetail + loadPublicChrome（无预取 categories）冷 7 条 / 暖 5 条", async () => {
    const db = new CountingFakeDb();
    const client = db.asPrismaClient();

    await getPublicNovelDetail(client, "article-1");
    await loadPublicChrome(client, PUBLIC_SITE_LOCALE); // detail page's footer chrome call — no shared categories to pass in

    expect(db.histogram()).toEqual(sumOf(DETAIL, SETTINGS, MATRIX, NAMES));
    expect(db.calls).toHaveLength(7);

    invalidateSiteSettingCache();
    const warm = new CountingFakeDb();
    const warmClient = warm.asPrismaClient();
    await getPublicNovelDetail(warmClient, "article-1");
    await loadPublicChrome(warmClient, PUBLIC_SITE_LOCALE);
    expect(warm.histogram()).toEqual(sumOf(DETAIL, SETTINGS, NAMES));
    expect(warm.calls).toHaveLength(5);
  });

  it("章节页：getPublicChapterView + loadPublicChrome 冷 8 条 / 暖 6 条", async () => {
    const db = new CountingFakeDb();
    const client = db.asPrismaClient();

    await getPublicChapterView(client, "article-1", 1);
    await loadPublicChrome(client, PUBLIC_SITE_LOCALE);

    expect(db.histogram()).toEqual(sumOf(CHAPTER, SETTINGS, MATRIX, NAMES));
    expect(db.calls).toHaveLength(8);

    invalidateSiteSettingCache();
    const warm = new CountingFakeDb();
    const warmClient = warm.asPrismaClient();
    await getPublicChapterView(warmClient, "article-1", 1);
    await loadPublicChrome(warmClient, PUBLIC_SITE_LOCALE);
    expect(warm.histogram()).toEqual(sumOf(CHAPTER, SETTINGS, NAMES));
    expect(warm.calls).toHaveLength(6);
  });
});
