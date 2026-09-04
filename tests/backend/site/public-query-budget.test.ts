import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import {
  getPublicChapterView,
  getPublicNovelDetail,
  listHomeNovels,
  listPublicCategories,
  loadPublicChrome,
} from "@/lib/site/queries";
import { invalidateSiteSettingCache } from "@/server/site-settings/service";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

/**
 * N-9 (施工规格 / 交接提示词): a regression gate on how many DB round-trips
 * one page render costs, plus one capability this file adds and locks in.
 *
 * Finding: `src/app/page.tsx` (home) calls `@/app/_lib/public-load`'s
 * `loadChrome("home")` (settings + a full `listPublicCategories` query, for
 * the footer) *and*, separately, that module's own `loadPublicCategories
 * (locale)` (the same underlying query again, for `HomeScreen`'s own
 * `categories` prop) — two independent `listPublicCategories` round-trips
 * per home-page render for data that is identical both times (same locale,
 * same published-article snapshot).
 *
 * 🔴 Not fixed in `page.tsx` — attempted, then reverted. `loadPublicChrome`
 * (`@/lib/site/queries`) below gained an optional third `categories`
 * parameter so a caller who already has the list can pass it in instead of
 * triggering a second query (see that function's doc comment). Wiring it
 * into `page.tsx` requires also changing `@/app/_lib/public-load.ts`'s
 * `loadChrome` (either its signature or a new variant) — outside this
 * lane's file boundary. Worse, `page.tsx` calling `queries.ts`/`getSiteSetting`
 * directly (bypassing `public-load.ts`'s React-cache-wrapped exports, which
 * is what an in-boundary-only fix would have to do) breaks
 * `tests/ui/public-routes.test.tsx` (outside this lane too, not to be
 * edited): that suite mocks `@/app/_lib/public-load` but not
 * `@/lib/site/queries` or the real Prisma client, so any direct call throws
 * a `DATABASE_URL` error. Verified by hand, then reverted. This is flagged
 * in the lane report as a follow-up for whoever owns `public-load.ts`.
 *
 * So this file does two things instead of one:
 *  1. Pins the *current, unfixed* production call pattern's query count as a
 *     ceiling — "≤ this many", not "exactly this many" — so a *further*
 *     regression still fails CI even though this specific inefficiency
 *     isn't closed yet.
 *  2. Proves the `loadPublicChrome(..., categories)` capability itself works
 *     (no second query when `categories` is supplied) — a real, tested
 *     building block, ready for whoever wires it into `public-load.ts` +
 *     `page.tsx` together.
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
 * 🔴 Separately: `listPublicArticles` (called by `listHomeNovels`) and
 * `listPublicCategories` independently run the *exact same* `article.findMany`
 * query (same `buildPublicArticleWhere({locale})`, `ARTICLE_CARD_SELECT`,
 * `take`) — a second, older duplication this lane did not touch. Collapsing
 * it behind one cached fetch would need every current caller of either
 * function — including tests outside this lane's file boundary that inject
 * a fake `db: PrismaClient` per call — audited for compatibility first,
 * which is out of this lane's time budget. Also flagged in the lane report.
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

/**
 * Counts every DB round-trip by operation key. Returns the same fixture
 * row(s) regardless of the `where` clause content — this file measures
 * *call volume*, not filter correctness (that is `tests/backend/public/**`'s
 * job).
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
          this.record("article.findMany");
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
      $queryRaw: async () => {
        this.record("$queryRaw (taxonomy)");
        return [];
      },
    } as unknown as PrismaClient;
  }

  countOf(key: string): number {
    return this.calls.filter((call) => call === key).length;
  }
}

beforeEach(() => {
  invalidateSiteSettingCache();
});

describe("公开侧一次渲染的查询数（cold cache）", () => {
  it("首页（当前生产调用形态，未接线修复）：getSiteSetting + listPublicCategories 形态合计 ≤ 7 次新增查询", async () => {
    const db = new CountingFakeDb();
    const client = db.asPrismaClient();

    // Mirrors `src/app/page.tsx` as it actually calls `@/app/_lib/public-load`
    // today: `loadChrome("home")` (settings + its own internal categories
    // query, here simulated as `loadPublicChrome` with no `categories` arg)
    // *and* a separate `loadPublicCategories` call for `HomeScreen`'s prop —
    // the duplication this file's header documents as not yet fixed.
    await loadPublicChrome(client, "home");
    await listPublicCategories(client, PUBLIC_SITE_LOCALE);
    await listHomeNovels(client, PUBLIC_SITE_LOCALE);

    const settingAndCategoryCalls =
      db.countOf("siteSetting.findUnique") + db.countOf("article.findMany") + db.countOf("$queryRaw (taxonomy)");
    expect(settingAndCategoryCalls).toBeLessThanOrEqual(7);
    // Pin the exact shape too, so a regression that trades one call for a
    // different one still fails loudly instead of hiding under the sum.
    expect(db.countOf("siteSetting.findUnique")).toBe(1);
    // loadPublicChrome's internal listPublicCategories + the page's own
    // separate listPublicCategories call + listHomeNovels(->listPublicArticles):
    // three separate `article.findMany` calls for what is, twice over, the
    // exact same query.
    expect(db.countOf("article.findMany")).toBe(3);
    expect(db.countOf("$queryRaw (taxonomy)")).toBe(3);
  });

  it("loadPublicChrome(..., categories) 能力：预先算好的 categories 不触发第二次查询（capability 就绪，尚未接入 page.tsx，见文件头注释）", async () => {
    const db = new CountingFakeDb();
    const client = db.asPrismaClient();
    const categories = await listPublicCategories(client, PUBLIC_SITE_LOCALE);
    expect(db.countOf("article.findMany")).toBe(1);

    await loadPublicChrome(client, "home", categories);
    // `loadPublicChrome` must not have queried categories again.
    expect(db.countOf("article.findMany")).toBe(1);
  });

  it("详情页：getPublicNovelDetail + loadPublicChrome（无预取 categories）的总查询数 ≤ 6", async () => {
    const db = new CountingFakeDb();
    const client = db.asPrismaClient();

    await getPublicNovelDetail(client, "article-1");
    await loadPublicChrome(client); // detail page's footer chrome call — no shared categories to pass in

    expect(db.calls.length).toBeLessThanOrEqual(6);
  });

  it("章节页：getPublicChapterView + loadPublicChrome 的总查询数 ≤ 7", async () => {
    const db = new CountingFakeDb();
    const client = db.asPrismaClient();

    await getPublicChapterView(client, "article-1", 1);
    await loadPublicChrome(client);

    expect(db.calls.length).toBeLessThanOrEqual(7);
  });
});
