import "./setup-cleanup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import type { NovelCardView } from "@/features/public-ui/types";

/**
 * WO-2 (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §8.1): proves the
 * actual href-prefixing WIRING in every touched `src/app/_pages/*` file —
 * not just the underlying `localePrefix` primitive (already covered by
 * `tests/ui/locale-prefix.test.ts`) — by calling each shared page body
 * directly with both `"en"` (must stay byte-identical to before this pass)
 * and a genuinely non-default `SiteLocale` (proving the prefix is really
 * threaded through).
 *
 * 🔴 The `@/lib/locale/messages` mock below is the reason this file can use
 * a non-"en" locale at all today. WO-2 does NOT implement WO-3's
 * deep-merge-to-English fallback — `src/lib/locale/messages/es.ts` (and
 * every other non-"en" catalog) is still an intentionally empty placeholder
 * in this worktree, and the real `loadMessages`/`getPublicT` throw
 * `MissingMessagesError` for any locale but `"en"` (`index.ts`'s own doc
 * comment: "Incomplete catalogs throw — never merge onto en"). That
 * completeness gap is WO-3's job, not this file's concern — this override
 * exists purely to let a `"es"` `SiteLocale` value flow far enough through
 * these page bodies to observe the prop it actually changed (an href
 * string), without needing real Spanish copy to exist yet. For `"en"`
 * itself the override is a no-op passthrough to the real, unmocked
 * `loadMessages("en")`/`getPublicT("en")` — so every `"en"` assertion below
 * is still a faithful regression check, not weakened by this mock.
 */
vi.mock("@/lib/locale/messages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/locale/messages")>();
  return {
    ...actual,
    loadMessages: () => actual.loadMessages("en"),
    getPublicT: () => actual.getPublicT("en"),
  };
});

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

vi.mock("@/app/_lib/public-load", () => ({
  loadChrome: vi.fn(),
  loadHomeNovels: vi.fn(),
  loadHomeCarousel: vi.fn(),
  loadPublicCategories: vi.fn(),
  loadBrowseNovels: vi.fn(),
  loadArticleAccess: vi.fn(),
  loadNovelDetail: vi.fn(),
  loadChapterView: vi.fn(),
  loadHreflangSiblings: vi.fn(),
  loadBlogList: vi.fn(),
  loadBlogAccess: vi.fn(),
  loadBlogDetail: vi.fn(),
}));

vi.mock("@/lib/site/category-queries", () => ({
  getPublicCategoryPage: vi.fn(),
}));

const publicLoad = await import("@/app/_lib/public-load");
const loadChrome = vi.mocked(publicLoad.loadChrome);
const loadHomeNovels = vi.mocked(publicLoad.loadHomeNovels);
const loadHomeCarousel = vi.mocked(publicLoad.loadHomeCarousel);
const loadPublicCategories = vi.mocked(publicLoad.loadPublicCategories);
const loadBrowseNovels = vi.mocked(publicLoad.loadBrowseNovels);
const loadArticleAccess = vi.mocked(publicLoad.loadArticleAccess);
const loadHreflangSiblings = vi.mocked(publicLoad.loadHreflangSiblings);
const loadBlogList = vi.mocked(publicLoad.loadBlogList);
const loadBlogAccess = vi.mocked(publicLoad.loadBlogAccess);

const categoryQueries = await import("@/lib/site/category-queries");
const getPublicCategoryPage = vi.mocked(categoryQueries.getPublicCategoryPage);

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
  loadHomeNovels.mockResolvedValue([card("1")]);
  loadHomeCarousel.mockResolvedValue([]);
  loadPublicCategories.mockResolvedValue([]);
  loadBrowseNovels.mockResolvedValue(Array.from({ length: 21 }, (_, i) => card(String(i))));
  loadArticleAccess.mockReset();
  loadHreflangSiblings.mockReset();
  loadHreflangSiblings.mockResolvedValue([]);
  loadBlogList.mockReset();
  loadBlogAccess.mockReset();
  getPublicCategoryPage.mockReset();
});

afterEach(() => {
  delete process.env.SITE_URL;
  delete process.env.FEATURE_ARTICLE_BLOG;
});

describe.each([
  { locale: "en" as const, prefix: "" },
  { locale: "es" as const, prefix: "/es" },
])("home.tsx · HomeBody — browseAllHref ($locale)", ({ locale, prefix }) => {
  it(`"View all" links to ${prefix || ""}/browse`, async () => {
    const tree = await HomeBody({ locale });
    render(tree);
    const link = screen.getByRole("link", { name: "View all" });
    expect(link.getAttribute("href")).toBe(`${prefix}/browse`);
  });
});

describe.each([
  { locale: "en" as const, prefix: "" },
  { locale: "es" as const, prefix: "/es" },
])("browse.tsx · BrowseBody — Pagination basePath ($locale)", ({ locale, prefix }) => {
  it(`paginator's Next link starts with ${prefix || ""}/browse`, async () => {
    const tree = await BrowseBody({ locale, searchParams: Promise.resolve({ page: "1" }) });
    render(tree);
    const next = screen.getByRole("link", { name: "Next" });
    expect(next.getAttribute("href")).toBe(`${prefix}/browse?page=2`);
  });
});

describe.each([
  { locale: "en" as const, prefix: "" },
  { locale: "es" as const, prefix: "/es" },
])("category.tsx · CategoryBody — Pagination basePath ($locale)", ({ locale, prefix }) => {
  it(`paginator's Next link starts with ${prefix || ""}/category/fantasy`, async () => {
    getPublicCategoryPage.mockResolvedValue({
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
    const next = screen.getByRole("link", { name: "Next" });
    expect(next.getAttribute("href")).toBe(`${prefix}/category/fantasy?page=2`);
  });
});

describe.each([
  { locale: "en" as const, prefix: "" },
  { locale: "es" as const, prefix: "/es" },
])("novel-not-found.tsx · NovelNotFoundBody — homeHref ($locale)", ({ locale, prefix }) => {
  it(`"Back to home" links to ${prefix || "/"}`, () => {
    render(NovelNotFoundBody({ locale }));
    const link = screen.getByRole("link", { name: "Back to home" });
    expect(link.getAttribute("href")).toBe(prefix ? prefix : "/");
  });
});

describe.each([
  { locale: "en" as const, prefix: "" },
  { locale: "es" as const, prefix: "/es" },
])("novel-detail.tsx · NovelBody unavailable branch — homeHref ($locale)", ({ locale, prefix }) => {
  it(`"Back to home" links to ${prefix || "/"}`, async () => {
    loadArticleAccess.mockResolvedValue({ kind: "unavailable", title: "A Novel" });
    const tree = await NovelBody({ locale, params: Promise.resolve({ slugParam: "a-novel-pabc123" }) });
    render(tree);
    const link = screen.getByRole("link", { name: "Back to home" });
    expect(link.getAttribute("href")).toBe(prefix ? prefix : "/");
  });
});

describe.each([
  { locale: "en" as const, prefix: "" },
  { locale: "es" as const, prefix: "/es" },
])("chapter.tsx · ChapterBody unavailable branch — homeHref ($locale)", ({ locale, prefix }) => {
  it(`"Back to home" links to ${prefix || "/"}`, async () => {
    loadArticleAccess.mockResolvedValue({ kind: "unavailable", title: "A Novel" });
    const tree = await ChapterBody({
      locale,
      params: Promise.resolve({ slugParam: "a-novel-pabc123", chapterNumber: "1" }),
    });
    render(tree);
    const link = screen.getByRole("link", { name: "Back to home" });
    expect(link.getAttribute("href")).toBe(prefix ? prefix : "/");
  });
});

describe.each([
  { locale: "en" as const, prefix: "" },
  { locale: "es" as const, prefix: "/es" },
])("blog-list.tsx · BlogListBody — Pagination basePath ($locale)", ({ locale, prefix }) => {
  it(`paginator's Next link starts with ${prefix || ""}/blog`, async () => {
    loadBlogList.mockResolvedValue(
      Array.from({ length: 21 }, (_, i) => ({
        id: `p${i}`,
        title: `Post ${i}`,
        slug: `post-${i}`,
        summary: undefined,
        publishedAt: new Date("2026-08-01T00:00:00Z"),
        href: `/blog/post-${i}`,
      })),
    );
    const tree = await BlogListBody({ locale, searchParams: Promise.resolve({ page: "1" }) });
    render(tree);
    const next = screen.getByRole("link", { name: "Next" });
    expect(next.getAttribute("href")).toBe(`${prefix}/blog?page=2`);
  });
});

describe.each([
  { locale: "en" as const, prefix: "" },
  { locale: "es" as const, prefix: "/es" },
])("blog-detail.tsx · BlogDetailBody unavailable branch — homeHref ($locale)", ({ locale, prefix }) => {
  it(`"Back to home" links to ${prefix || "/"}`, async () => {
    loadBlogAccess.mockResolvedValue({ kind: "unavailable", title: "A Post" });
    const tree = await BlogDetailBody({ locale, params: Promise.resolve({ slug: "a-post" }) });
    render(tree);
    const link = screen.getByRole("link", { name: "Back to home" });
    expect(link.getAttribute("href")).toBe(prefix ? prefix : "/");
  });
});
