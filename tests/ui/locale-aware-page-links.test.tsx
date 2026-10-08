import "./setup-cleanup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import type { NovelCardView } from "@/features/public-ui/types";
import { pagedNovels, pagedPosts } from "../fixtures/paged-results";

/**
 * WO-2 (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §8.1): proves the
 * actual href-prefixing WIRING in every touched `src/app/_pages/*` file —
 * not just the underlying `localePrefix` primitive (already covered by
 * `tests/ui/locale-prefix.test.ts`) — by calling each shared page body
 * directly with both `"en"` (must stay byte-identical to before this pass)
 * and a genuinely non-default `SiteLocale` (proving the prefix is really
 * threaded through).
 *
 * No mock on `@/lib/locale/messages`: WO-3 shipped a real, complete Spanish
 * catalog (`src/lib/locale/messages/es.ts`) and `loadMessages`/`getPublicT`
 * deep-merge onto `en` rather than throwing on an incomplete catalog, so
 * `"es"` renders its own real strings end to end here. Each `es` case below
 * queries by the actual Spanish accessible name (e.g. "Ver todo",
 * "Siguiente", "Volver al inicio") instead of the English one — that
 * doubles as a live check that WO-3's catalog is actually wired up, not
 * just that the href prefix changed. The `en` assertions are untouched and
 * stay byte-identical to before this pass.
 */

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

vi.mock("@/app/_lib/public-load", () => ({
  loadChrome: vi.fn(),
  loadActiveLocales: vi.fn(),
  loadHomeNovels: vi.fn(),
  loadHomeCarousel: vi.fn(),
  loadPublicCategories: vi.fn(),
  loadBrowsePage: vi.fn(),
  loadCategoryPage: vi.fn(),
  loadArticleAccess: vi.fn(),
  loadNovelDetail: vi.fn(),
  loadChapterView: vi.fn(),
  loadHreflangSiblings: vi.fn(),
  loadBlogList: vi.fn(),
  loadBlogAccess: vi.fn(),
  loadBlogDetail: vi.fn(),
}));

const publicLoad = await import("@/app/_lib/public-load");
const loadChrome = vi.mocked(publicLoad.loadChrome);
const loadHomeNovels = vi.mocked(publicLoad.loadHomeNovels);
const loadHomeCarousel = vi.mocked(publicLoad.loadHomeCarousel);
const loadPublicCategories = vi.mocked(publicLoad.loadPublicCategories);
const loadBrowsePage = vi.mocked(publicLoad.loadBrowsePage);
const loadCategoryPage = vi.mocked(publicLoad.loadCategoryPage);
const loadArticleAccess = vi.mocked(publicLoad.loadArticleAccess);
const loadHreflangSiblings = vi.mocked(publicLoad.loadHreflangSiblings);
const loadBlogList = vi.mocked(publicLoad.loadBlogList);
const loadBlogAccess = vi.mocked(publicLoad.loadBlogAccess);


const { HomeBody } = await import("@/app/_pages/home");
const { BrowseBody } = await import("@/app/_pages/browse");
const { CategoryBody } = await import("@/app/_pages/category");
const { NovelNotFoundBody } = await import("@/app/_pages/novel-not-found");
const { NovelBody } = await import("@/app/_pages/novel-detail");
const { ChapterBody } = await import("@/app/_pages/chapter");
const { BlogListBody } = await import("@/app/_pages/blog-list");
const { BlogDetailBody } = await import("@/app/_pages/blog-detail");

const SETTINGS = {
  siteName: "cps-novel",
  siteDescription: "Overseas novels.",
  homeMetaTitle: "cps-novel",
  homeMetaDescription: "Read overseas novels.",
  defaultOgImage: "https://example.test/og.png",
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
  updatedAt: new Date("2026-08-18T00:00:00Z"),
};

const CHROME = {
  brandHref: "/",
  navItems: [{ label: "Home", href: "/", current: true }],
  footerNote: undefined,
};

function card(id: string): NovelCardView {
  return {
    id,
    title: `Novel ${id}`,
    coverUrl: "/cover.jpg",
    tags: [],
    href: `/novel/n${id}-pabc123`,
  };
}

beforeEach(() => {
  process.env.SITE_URL = "https://example.test";
  process.env.FEATURE_ARTICLE_BLOG = "true";
  loadChrome.mockResolvedValue({ settings: SETTINGS, chrome: CHROME });
  // PN-09：首页 / 书库 / 博客列表的元数据按活跃语种判断"空语种"，`HomeBody` 等也会构造它——夹具必须给出活跃语种。
  vi.mocked(publicLoad.loadActiveLocales).mockResolvedValue(["en", "es"] as never);
  loadHomeNovels.mockResolvedValue([card("1")]);
  loadHomeCarousel.mockResolvedValue([]);
  loadPublicCategories.mockResolvedValue([]);
  loadBrowsePage.mockImplementation(async (_locale, page) => pagedNovels(Array.from({ length: 21 }, (_, i) => card(String(i))), page));
  loadArticleAccess.mockReset();
  loadHreflangSiblings.mockReset();
  loadHreflangSiblings.mockResolvedValue([]);
  loadBlogList.mockReset();
  loadBlogAccess.mockReset();
  loadCategoryPage.mockReset();
});

afterEach(() => {
  delete process.env.SITE_URL;
  delete process.env.FEATURE_ARTICLE_BLOG;
});

describe.each([
  { locale: "en" as const, prefix: "", name: "View all" },
  { locale: "es" as const, prefix: "/es", name: "Ver todo" },
])("home.tsx · HomeBody — browseAllHref ($locale)", ({ locale, prefix, name }) => {
  it(`"${name}" links to ${prefix || ""}/browse`, async () => {
    const tree = await HomeBody({ locale });
    render(tree);
    const link = screen.getByRole("link", { name });
    expect(link.getAttribute("href")).toBe(`${prefix}/browse`);
  });
});

describe.each([
  { locale: "en" as const, prefix: "", name: "Next" },
  { locale: "es" as const, prefix: "/es", name: "Siguiente" },
])("browse.tsx · BrowseBody — Pagination basePath ($locale)", ({ locale, prefix, name }) => {
  it(`paginator's "${name}" link starts with ${prefix || ""}/browse`, async () => {
    const tree = await BrowseBody({ locale, searchParams: Promise.resolve({ page: "1" }) });
    render(tree);
    const next = screen.getByRole("link", { name });
    expect(next.getAttribute("href")).toBe(`${prefix}/browse?page=2`);
  });
});

describe.each([
  { locale: "en" as const, prefix: "", name: "Next" },
  { locale: "es" as const, prefix: "/es", name: "Siguiente" },
])("category.tsx · CategoryBody — Pagination basePath ($locale)", ({ locale, prefix, name }) => {
  it(`paginator's "${name}" link starts with ${prefix || ""}/category/fantasy`, async () => {
    loadCategoryPage.mockResolvedValue({
      novels: Array.from({ length: 20 }, (_, i) => card(`c${i}`)),
      page: 1,
      totalPages: 2,
      totalCount: 40,
      category: {
        id: "cat-1",
        slug: "fantasy",
        name: "Fantasy",
        description: "Fantasy novels.",
        sortOrder: 1,
        updatedAt: new Date("2026-08-01T00:00:00Z"),
      },
    });
    const tree = await CategoryBody({
      locale,
      params: Promise.resolve({ slug: "fantasy" }),
      searchParams: Promise.resolve({ page: "1" }),
    });
    render(tree);
    const next = screen.getByRole("link", { name });
    expect(next.getAttribute("href")).toBe(`${prefix}/category/fantasy?page=2`);
  });
});

describe.each([
  { locale: "en" as const, prefix: "", name: "Back to home" },
  { locale: "es" as const, prefix: "/es", name: "Volver al inicio" },
])("novel-not-found.tsx · NovelNotFoundBody — homeHref ($locale)", ({ locale, prefix, name }) => {
  // 2026-09-30：`NovelNotFoundBody` 现在是 async（404 页要加载带站名的 chrome），
  // 所以先 await 再渲染；链接文案与 href 的断言一字未改。
  it(`"${name}" links to ${prefix || "/"}`, async () => {
    render(await NovelNotFoundBody({ locale }));
    const link = screen.getByRole("link", { name });
    expect(link.getAttribute("href")).toBe(prefix ? prefix : "/");
  });
});

describe.each([
  { locale: "en" as const, prefix: "", name: "Back to home" },
  { locale: "es" as const, prefix: "/es", name: "Volver al inicio" },
])("novel-detail.tsx · NovelBody unavailable branch — homeHref ($locale)", ({ locale, prefix, name }) => {
  it(`"${name}" links to ${prefix || "/"}`, async () => {
    loadArticleAccess.mockResolvedValue({ kind: "unavailable", title: "A Novel" });
    const tree = await NovelBody({ locale, params: Promise.resolve({ slugParam: "a-novel-pabc123" }) });
    render(tree);
    const link = screen.getByRole("link", { name });
    expect(link.getAttribute("href")).toBe(prefix ? prefix : "/");
  });
});

describe.each([
  { locale: "en" as const, prefix: "", name: "Back to home" },
  { locale: "es" as const, prefix: "/es", name: "Volver al inicio" },
])("chapter.tsx · ChapterBody unavailable branch — homeHref ($locale)", ({ locale, prefix, name }) => {
  it(`"${name}" links to ${prefix || "/"}`, async () => {
    loadArticleAccess.mockResolvedValue({ kind: "unavailable", title: "A Novel" });
    const tree = await ChapterBody({
      locale,
      params: Promise.resolve({ slugParam: "a-novel-pabc123", chapterNumber: "1" }),
    });
    render(tree);
    const link = screen.getByRole("link", { name });
    expect(link.getAttribute("href")).toBe(prefix ? prefix : "/");
  });
});

describe.each([
  { locale: "en" as const, prefix: "", name: "Next" },
  { locale: "es" as const, prefix: "/es", name: "Siguiente" },
])("blog-list.tsx · BlogListBody — Pagination basePath ($locale)", ({ locale, prefix, name }) => {
  it(`paginator's "${name}" link starts with ${prefix || ""}/blog`, async () => {
    loadBlogList.mockImplementation(async (_locale, page) => pagedPosts(
      Array.from({ length: 21 }, (_, i) => ({
        id: `p${i}`,
        title: `Post ${i}`,
        slug: `post-${i}`,
        summary: undefined,
        publishedAt: new Date("2026-08-01T00:00:00Z"),
        href: `/blog/post-${i}`,
      })),
    page));
    const tree = await BlogListBody({ locale, searchParams: Promise.resolve({ page: "1" }) });
    render(tree);
    const next = screen.getByRole("link", { name });
    expect(next.getAttribute("href")).toBe(`${prefix}/blog?page=2`);
  });
});

describe.each([
  { locale: "en" as const, prefix: "", name: "Back to home" },
  { locale: "es" as const, prefix: "/es", name: "Volver al inicio" },
])("blog-detail.tsx · BlogDetailBody unavailable branch — homeHref ($locale)", ({ locale, prefix, name }) => {
  it(`"${name}" links to ${prefix || "/"}`, async () => {
    loadBlogAccess.mockResolvedValue({ kind: "unavailable", title: "A Post" });
    const tree = await BlogDetailBody({ locale, params: Promise.resolve({ slug: "a-post" }) });
    render(tree);
    const link = screen.getByRole("link", { name });
    expect(link.getAttribute("href")).toBe(prefix ? prefix : "/");
  });
});
