import "./setup-cleanup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";

import { books, makeFakeDb } from "../fixtures/in-memory-public-db";

/**
 * 分类页 / 浏览页标题下的作品数 = 这个列表**分页能翻到的总本数**（运营 2026-10-08 反馈：
 * 英语 /category/female-audience?page=2 显示 "20 works"，最后一页显示 "9 works"——那是当前页本数；
 * Owner 拍板口径 = 可浏览总数）。
 *
 * 口径与分页、站点地图、404 判定同源：数据库分页（B-38 v0.5.13）里的 `totalCount`——`getPublicCategoryPage` /
 * `getPublicBrowsePage` 返回的真实总数（`public-list.ts` 的 `count(*)`），没有任何上限。本文件把页面用的加载器
 * （`loadCategoryPage` / `loadBrowsePage`）接到**真实**的查询函数上，数据库换成内存 db
 * （`tests/fixtures/in-memory-public-db.ts`：按 SQL 结构分派），所以页面数字、`listPublicCategoryPageCounts`（站点地图）、
 * 分页总页数跑的是同一份真代码。不得在调用方另写一份计数。
 */

const NOT_FOUND = Symbol("next-not-found");

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw NOT_FOUND;
  },
}));

vi.mock("@/app/_lib/public-load", () => ({
  loadChrome: vi.fn(),
  loadActiveLocales: vi.fn(),
  loadBrowsePage: vi.fn(),
  loadCategoryPage: vi.fn(),
}));
// 分类页元数据才会碰 prisma（hreflang）；这里只渲染页面本体。
vi.mock("@/app/_lib/public-deps", () => ({ prisma: {} }));

const publicLoad = await import("@/app/_lib/public-load");
const loadChrome = vi.mocked(publicLoad.loadChrome);
const loadActiveLocales = vi.mocked(publicLoad.loadActiveLocales);
const loadBrowsePage = vi.mocked(publicLoad.loadBrowsePage);
const loadCategoryPage = vi.mocked(publicLoad.loadCategoryPage);
const queries = await import("@/lib/site/queries");
const { BROWSE_PAGE_SIZE, getPublicBrowsePage } = queries;
const { getPublicCategoryPage, listPublicCategoryPageCounts } = await import("@/lib/site/category-queries");
const { CategoryBody } = await import("@/app/_pages/category");
const { BrowseBody } = await import("@/app/_pages/browse");

const SETTINGS = {
  siteName: "PulseNovel",
  siteDescription: "Overseas novels.",
  homeMetaTitle: "",
  homeMetaDescription: "",
  defaultOgImage: "https://example.test/og-default.png",
  googleSearchConsoleVerification: "",
  footerCopyrightText: "",
  footerDisclaimerText: "",
  friendLinks: [],
  indexNowHost: "",
  indexNowKey: "",
  indexNowKeyLocation: "",
  ga4MeasurementId: null,
  yandexVerification: "",
  yandexMetricaId: null,
  updatedAt: new Date("2026-10-08T00:00:00Z"),
};
const CHROME = { brandHref: "/", navItems: [], footerNote: "© test" };

/**
 * 一个语种的内存书库：female-audience 有 `inCategory` 本，另有 `others` 本别的分类（证明数字是分类总数，不是语种总数）。
 * 页面的加载器接到真实的查询函数上。
 */
function useCatalog(inCategory: number, options: { locale?: SiteLocale; others?: number } = {}) {
  const locale = options.locale ?? "en";
  const others = options.others ?? 7;
  const fake = makeFakeDb(books(inCategory + others, locale), [
    { slug: "female-audience", sortOrder: 1, ordinals: [[1, inCategory]] },
    { slug: "fantasy", sortOrder: 2, ordinals: [[inCategory + 1, inCategory + others]] },
  ]);
  loadCategoryPage.mockImplementation(async (loaderLocale, slug, page) => getPublicCategoryPage(fake.db, loaderLocale, slug, page));
  loadBrowsePage.mockImplementation(async (loaderLocale, page) => getPublicBrowsePage(fake.db, loaderLocale, page));
  return fake;
}

/** 标题区最后一行（作品数那一行）。说明文字段落在这些用例里不存在，所以它就是唯一的 <p>。 */
function workCountText(container: HTMLElement): string {
  const paragraphs = container.querySelectorAll("main header p");
  return paragraphs[paragraphs.length - 1]!.textContent!;
}

function cardCount(container: HTMLElement): number {
  return container.querySelectorAll('[data-testid="book-card"]').length;
}

async function renderCategory(locale: SiteLocale, page: number) {
  const tree = await CategoryBody({
    locale,
    params: Promise.resolve({ slug: "female-audience" }),
    searchParams: Promise.resolve(page === 1 ? {} : { page: String(page) }),
  });
  return render(tree).container;
}

async function renderBrowse(locale: SiteLocale, page: number, category?: string) {
  const searchParams: { page?: string; category?: string } = {};
  if (page !== 1) searchParams.page = String(page);
  if (category) searchParams.category = category;
  const tree = await BrowseBody({ locale, searchParams: Promise.resolve(searchParams) });
  return render(tree).container;
}

beforeEach(() => {
  process.env.SITE_URL = "https://example.test";
  loadChrome.mockResolvedValue({ settings: SETTINGS, chrome: CHROME });
  loadActiveLocales.mockResolvedValue(["en", "ru", "pl"] as never);
});

afterEach(() => {
  delete process.env.SITE_URL;
  vi.clearAllMocks();
});

describe("分类页：每一页都显示这个分类分页能翻到的总本数", () => {
  it("分类有 25 本（页大小 20）：第 1 页、第 2 页 H1 下都是 '25 works'，第 2 页实际只渲染 5 张卡片", async () => {
    expect(BROWSE_PAGE_SIZE).toBe(20);
    useCatalog(25);

    const first = await renderCategory("en", 1);
    expect(workCountText(first)).toBe("25 works");
    expect(cardCount(first)).toBe(20);

    const second = await renderCategory("en", 2);
    expect(workCountText(second)).toBe("25 works"); // 旧行为是 "5 works"（当前页本数）
    expect(cardCount(second)).toBe(5);
  });

  it("分类总数不是语种总数：语种里还有别的分类 7 本，数字仍是 25", async () => {
    useCatalog(25);
    const first = await renderCategory("en", 1);
    expect(workCountText(first)).not.toBe("32 works");
    expect(workCountText(first)).toBe("25 works");
  });

  it("只有 1 本：'1 work'（单数形式）", async () => {
    useCatalog(1);
    const only = await renderCategory("en", 1);
    expect(workCountText(only)).toBe("1 work");
    expect(cardCount(only)).toBe(1);
  });

  it("超出总页数仍是 404（与数字同一份列表）：25 本时第 3 页 notFound", async () => {
    useCatalog(25);
    await expect(renderCategory("en", 3)).rejects.toBe(NOT_FOUND);
  });

  /**
   * 数字、分页总页数、站点地图给出的页数三者同口径：
   *   页面显示 N works  →  ceil(N / 页大小) === getPublicCategoryPage 的 totalPages
   *                         === listPublicCategoryPageCounts 对该 slug 给出的页数。
   * 边界取 20 / 21 / 40 / 41，防止"整除"与"进一页"的口径漂移。
   */
  it.each([
    [1, 1],
    [20, 1],
    [21, 2],
    [25, 2],
    [40, 2],
    [41, 3],
  ])("%i 本：页面数字 = %i 页对应的总数，与分页总页数、站点地图页数一致", async (total, pages) => {
    const { db } = useCatalog(total);

    const lastPage = await renderCategory("en", pages);
    const shown = Number(workCountText(lastPage).match(/\d+/)![0]);
    expect(shown).toBe(total);

    const paged = await getPublicCategoryPage(db, "en", "female-audience", pages);
    expect(paged?.totalCount).toBe(shown);
    expect(paged?.totalPages).toBe(Math.ceil(shown / BROWSE_PAGE_SIZE));
    expect(paged?.totalPages).toBe(pages);

    const sitemapPages = (await listPublicCategoryPageCounts(db, "en")).get("female-audience");
    expect(sitemapPages).toBe(Math.ceil(shown / BROWSE_PAGE_SIZE));
    expect(sitemapPages).toBe(paged?.totalPages);
  });

  it.each([
    ["ru", 21],
    ["ru", 22],
    ["ru", 25],
    ["pl", 22],
    ["pl", 25],
  ] as const)("%s：%i 本时第 1、2 页都用该语种的 plural 形式显示总数（不是当前页本数）", async (locale, total) => {
    useCatalog(total, { locale });
    const t = getPublicT(locale);
    const expected = t("collection.workCount", { count: total });

    const first = await renderCategory(locale, 1);
    expect(workCountText(first)).toBe(expected);

    const second = await renderCategory(locale, 2);
    expect(workCountText(second)).toBe(expected);
    // 第 2 页只有 total - 20 张卡片；旧行为会显示这个数的文案。
    expect(cardCount(second)).toBe(total - BROWSE_PAGE_SIZE);
    expect(workCountText(second)).not.toBe(t("collection.workCount", { count: total - BROWSE_PAGE_SIZE }));
  });
});

describe("/browse：同一个屏幕，同一口径", () => {
  it("无分类：25 本时第 1、2 页都是 '25 works'，第 2 页渲染 5 张卡片", async () => {
    useCatalog(25, { others: 0 });

    const first = await renderBrowse("en", 1);
    expect(workCountText(first)).toBe("25 works");
    expect(cardCount(first)).toBe(20);

    const second = await renderBrowse("en", 2);
    expect(workCountText(second)).toBe("25 works");
    expect(cardCount(second)).toBe(5);
  });

  it("无分类、只有 1 本：'1 work'", async () => {
    useCatalog(1, { others: 0 });
    expect(workCountText(await renderBrowse("en", 1))).toBe("1 work");
  });

  it("?category=：走分类同一份列表，25 本时第 1、2 页都是 '25 works'", async () => {
    useCatalog(25);

    const first = await renderBrowse("en", 1, "female-audience");
    expect(workCountText(first)).toBe("25 works");
    expect(cardCount(first)).toBe(20);

    const second = await renderBrowse("en", 2, "female-audience");
    expect(workCountText(second)).toBe("25 works");
    expect(cardCount(second)).toBe(5);
  });

  it("非英语（ru 21 本）：无分类的第 2 页也用 ru 的 plural 形式显示总数", async () => {
    useCatalog(21, { locale: "ru", others: 0 });
    const t = getPublicT("ru");
    const second = await renderBrowse("ru", 2);
    expect(workCountText(second)).toBe(t("collection.workCount", { count: 21 }));
    expect(cardCount(second)).toBe(1);
    expect(workCountText(second)).not.toBe(t("collection.workCount", { count: 1 }));
  });
});
