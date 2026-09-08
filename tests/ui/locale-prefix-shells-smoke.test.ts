import "./setup-cleanup";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NovelCardView, NovelDetailView } from "@/features/public-ui/types";

/**
 * WO-1 (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §6.6 item 2): "语种
 * 前缀树可达性冒烟" — for each of the 8 new `src/app/[locale]/...` thin
 * shells, prove they delegate to the exact same shared body in
 * `src/app/_pages/*` that the bare-path shells already use, and that the
 * body is genuinely parameterized by `locale` rather than still reading a
 * module-level constant.
 *
 * `[locale]/layout.tsx`'s guard 404s every locale today (`getRoutableLocale`
 * — see `[locale]/_guard.ts`), `en` included by the D-8 structural rule, so
 * there is no way to drive this through the actual router or even through
 * the locale-prefixed shell files' own exported functions (they all call
 * `requireRoutableLocale`, which throws `notFound()` for every input right
 * now). Per the work order: "因为守卫仍然 404，这些测试是直接调页面函数，
 * 不走路由器" — so this file calls the `src/app/_pages/*` functions
 * directly (bypassing the guard entirely, exactly as a hypothetical
 * `[locale]/...` shell would once a second locale is actually admitted) and
 * compares the result against calling the real bare-path shell
 * (`src/app/page.tsx` etc.), both driven by the same locale
 * (`PUBLIC_SITE_LOCALE` — the only locale with a complete, non-throwing
 * message catalog today; WO-1 does not add translations, so this cannot
 * exercise a second locale's text yet). Structural (deep-equal) parity
 * between the two call paths is exactly the guarantee this smoke test is
 * for: both trees are provably the same shared body, not two forks that
 * happened to look the same on day one.
 */

vi.mock("@/lib/site/category-queries", () => ({
  getPublicCategoryPage: vi.fn(),
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

const categoryQueries = await import("@/lib/site/category-queries");
const getPublicCategoryPage = vi.mocked(categoryQueries.getPublicCategoryPage);

const publicLoad = await import("@/app/_lib/public-load");
const loadChrome = vi.mocked(publicLoad.loadChrome);
const loadHomeNovels = vi.mocked(publicLoad.loadHomeNovels);
const loadHomeCarousel = vi.mocked(publicLoad.loadHomeCarousel);
const loadPublicCategories = vi.mocked(publicLoad.loadPublicCategories);
const loadBrowseNovels = vi.mocked(publicLoad.loadBrowseNovels);
const loadArticleAccess = vi.mocked(publicLoad.loadArticleAccess);
const loadNovelDetail = vi.mocked(publicLoad.loadNovelDetail);
const loadChapterView = vi.mocked(publicLoad.loadChapterView);
const loadHreflangSiblings = vi.mocked(publicLoad.loadHreflangSiblings);
const loadBlogList = vi.mocked(publicLoad.loadBlogList);
const loadBlogAccess = vi.mocked(publicLoad.loadBlogAccess);
const loadBlogDetail = vi.mocked(publicLoad.loadBlogDetail);

const SETTINGS = {
  siteName: "cps-novel",
  siteDescription: "Overseas novels.",
  homeMetaTitle: "cps-novel",
  homeMetaDescription: "Read overseas novels.",
  defaultOgImage: "https://example.test/og.png",
  googleSearchConsoleVerification: "",
  footerCopyrightText: "© test",
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
  navItems: [
    { label: "Home", href: "/", current: true },
    { label: "All works", href: "/browse" },
  ],
  footerNote: "© test",
};

const CARD: NovelCardView = {
  id: "biz-1",
  title: "The Lantern Keeper's Daughter",
  coverUrl: "/covers/lantern.jpg",
  tags: [],
  href: "/novel/lantern-keepers-daughter-pabc123",
};

const DETAIL: NovelDetailView = {
  id: "biz-1",
  title: "The Lantern Keeper's Daughter",
  coverUrl: "/covers/lantern.jpg",
  description: "A coastal town keeps one lantern burning.",
  locale: { code: "en", label: "English" },
  totalChapterCount: 12,
  tags: [],
  previewChapters: [{ number: 1, title: "The Harbour", href: "/novel/lantern-keepers-daughter-pabc123/chapter/1" }],
};

const BLOG_POST = {
  id: "blog-1",
  title: "A blog post",
  slug: "a-blog-post",
  summary: "A short summary",
  publishedAt: new Date("2026-08-05T12:30:00.000Z"),
  href: "/blog/a-blog-post",
};

const BLOG_DETAIL = {
  ...BLOG_POST,
  body: "<p>Body</p>",
  updatedAt: new Date("2026-08-06T00:00:00.000Z"),
};

const ORIGIN = "https://example.test";

beforeEach(() => {
  process.env.SITE_URL = ORIGIN;
  process.env.FEATURE_ARTICLE_BLOG = "true";
  loadChrome.mockReset();
  loadChrome.mockResolvedValue({ settings: SETTINGS, chrome: CHROME });
  loadHomeNovels.mockReset();
  loadHomeNovels.mockResolvedValue([CARD]);
  loadHomeCarousel.mockReset();
  loadHomeCarousel.mockResolvedValue([]);
  loadPublicCategories.mockReset();
  loadPublicCategories.mockResolvedValue([]);
  loadBrowseNovels.mockReset();
  loadBrowseNovels.mockResolvedValue([CARD]);
  loadArticleAccess.mockReset();
  loadNovelDetail.mockReset();
  loadChapterView.mockReset();
  loadHreflangSiblings.mockReset();
  loadHreflangSiblings.mockResolvedValue([]);
  loadBlogList.mockReset();
  loadBlogList.mockResolvedValue([BLOG_POST]);
  loadBlogAccess.mockReset();
  loadBlogDetail.mockReset();
  getPublicCategoryPage.mockReset();
});

afterEach(() => {
  delete process.env.SITE_URL;
  delete process.env.FEATURE_ARTICLE_BLOG;
});

describe("home: src/app/page.tsx and src/app/_pages/home.tsx agree", () => {
  it("generateMetadata / buildHomeMetadata produce the same metadata", async () => {
    const shell = await import("@/app/page");
    const pages = await import("@/app/_pages/home");
    const fromShell = await shell.generateMetadata();
    const fromBody = await pages.buildHomeMetadata("en");
    expect(fromBody).toEqual(fromShell);
  });

  it("default() / HomeBody() produce the same tree", async () => {
    const shell = await import("@/app/page");
    const pages = await import("@/app/_pages/home");
    const fromShell = await shell.default();
    const fromBody = await pages.HomeBody({ locale: "en" });
    expect(fromBody).toEqual(fromShell);
  });
});

describe("browse: src/app/browse/page.tsx and src/app/_pages/browse.tsx agree", () => {
  const searchParams = Promise.resolve({});

  it("generateMetadata / buildBrowseMetadata produce the same metadata", async () => {
    const shell = await import("@/app/browse/page");
    const pages = await import("@/app/_pages/browse");
    const fromShell = await shell.generateMetadata({ searchParams });
    const fromBody = await pages.buildBrowseMetadata("en", searchParams);
    expect(fromBody).toEqual(fromShell);
  });

  it("default() / BrowseBody() produce the same tree", async () => {
    const shell = await import("@/app/browse/page");
    const pages = await import("@/app/_pages/browse");
    const fromShell = await shell.default({ searchParams });
    const fromBody = await pages.BrowseBody({ locale: "en", searchParams });
    expect(fromBody).toEqual(fromShell);
  });
});

describe("category: src/app/category/[slug]/page.tsx and src/app/_pages/category.tsx agree", () => {
  const params = Promise.resolve({ slug: "romance" });
  const searchParams = Promise.resolve({});

  beforeEach(() => {
    getPublicCategoryPage.mockResolvedValue({
      novels: [CARD],
      page: 1,
      totalPages: 1,
      totalCount: 1,
      category: {
        id: "tag-1",
        slug: "romance",
        name: "Romance",
        description: "Romance novels.",
        sortOrder: 1,
        updatedAt: new Date("2026-08-01T00:00:00Z"),
      },
    });
  });

  it("generateMetadata / buildCategoryMetadata produce the same metadata", async () => {
    const shell = await import("@/app/category/[slug]/page");
    const pages = await import("@/app/_pages/category");
    const fromShell = await shell.generateMetadata({ params, searchParams });
    const fromBody = await pages.buildCategoryMetadata("en", params, searchParams);
    expect(fromBody).toEqual(fromShell);
  });

  it("default() / CategoryBody() produce the same tree", async () => {
    const shell = await import("@/app/category/[slug]/page");
    const pages = await import("@/app/_pages/category");
    const fromShell = await shell.default({ params, searchParams });
    const fromBody = await pages.CategoryBody({ locale: "en", params, searchParams });
    expect(fromBody).toEqual(fromShell);
  });
});

describe("novel detail: src/app/novel/[slugParam]/page.tsx and src/app/_pages/novel-detail.tsx agree", () => {
  const params = Promise.resolve({ slugParam: "lantern-keepers-daughter-pabc123" });

  beforeEach(() => {
    loadArticleAccess.mockResolvedValue({
      kind: "published",
      articleId: "article-1",
      novelId: "novel-1",
      slugPart: "lantern-keepers-daughter",
      shortId: "abc123",
      title: DETAIL.title,
    });
    loadNovelDetail.mockResolvedValue(DETAIL);
  });

  it("generateMetadata / buildNovelMetadata produce the same metadata", async () => {
    const shell = await import("@/app/novel/[slugParam]/page");
    const pages = await import("@/app/_pages/novel-detail");
    const fromShell = await shell.generateMetadata({ params });
    const fromBody = await pages.buildNovelMetadata("en", params);
    expect(fromBody).toEqual(fromShell);
  });

  it("default() / NovelBody() produce the same tree", async () => {
    const shell = await import("@/app/novel/[slugParam]/page");
    const pages = await import("@/app/_pages/novel-detail");
    const fromShell = await shell.default({ params });
    const fromBody = await pages.NovelBody({ locale: "en", params });
    expect(fromBody).toEqual(fromShell);
  });
});

describe("novel not-found: src/app/novel/[slugParam]/not-found.tsx and src/app/_pages/novel-not-found.tsx agree", () => {
  it("default() / NovelNotFoundBody() produce the same tree, and metadata is re-exported verbatim", async () => {
    const shell = await import("@/app/novel/[slugParam]/not-found");
    const pages = await import("@/app/_pages/novel-not-found");
    expect(shell.metadata).toEqual(pages.notFoundMetadata);
    const fromShell = shell.default();
    const fromBody = pages.NovelNotFoundBody({ locale: "en" });
    expect(fromBody).toEqual(fromShell);
  });
});

describe("chapter: src/app/novel/[slugParam]/chapter/[chapterNumber]/page.tsx and src/app/_pages/chapter.tsx agree", () => {
  const params = Promise.resolve({ slugParam: "lantern-keepers-daughter-pabc123", chapterNumber: "1" });

  beforeEach(() => {
    loadArticleAccess.mockResolvedValue({
      kind: "published",
      articleId: "article-1",
      novelId: "novel-1",
      slugPart: "lantern-keepers-daughter",
      shortId: "abc123",
      title: DETAIL.title,
    });
    loadChapterView.mockResolvedValue({
      number: 1,
      title: "The Harbour",
      paragraphs: ["First paragraph."],
      novel: { id: "biz-1", title: DETAIL.title, href: CARD.href, coverUrl: DETAIL.coverUrl },
      previewPosition: { index: 1, total: 1 },
    });
  });

  it("generateMetadata / buildChapterMetadata produce the same metadata", async () => {
    const shell = await import("@/app/novel/[slugParam]/chapter/[chapterNumber]/page");
    const pages = await import("@/app/_pages/chapter");
    const fromShell = await shell.generateMetadata({ params });
    const fromBody = await pages.buildChapterMetadata("en", params);
    expect(fromBody).toEqual(fromShell);
  });

  it("default() / ChapterBody() produce the same tree", async () => {
    const shell = await import("@/app/novel/[slugParam]/chapter/[chapterNumber]/page");
    const pages = await import("@/app/_pages/chapter");
    const fromShell = await shell.default({ params });
    const fromBody = await pages.ChapterBody({ locale: "en", params });
    expect(fromBody).toEqual(fromShell);
  });
});

describe("chapter layout: bare and [locale] trees are byte-identical copies", () => {
  it("both export the same PublicChapterLayout behavior", async () => {
    const bare = await import("@/app/novel/[slugParam]/chapter/layout");
    const prefixed = await import("@/app/[locale]/novel/[slugParam]/chapter/layout");
    const bareTree = bare.default({ children: "CHILDREN" as never }) as {
      props: { children: readonly { type: unknown }[] };
    };
    const prefixedTree = prefixed.default({ children: "CHILDREN" as never }) as {
      props: { children: readonly { type: unknown }[] };
    };
    expect(prefixedTree.props.children.map((c) => c.type)).toEqual(bareTree.props.children.map((c) => c.type));
  });
});

describe("blog list: src/app/blog/page.tsx and src/app/_pages/blog-list.tsx agree", () => {
  const searchParams = Promise.resolve({});

  it("generateMetadata / buildBlogListMetadata produce the same metadata", async () => {
    const shell = await import("@/app/blog/page");
    const pages = await import("@/app/_pages/blog-list");
    const fromShell = await shell.generateMetadata({ searchParams });
    const fromBody = await pages.buildBlogListMetadata("en", searchParams);
    expect(fromBody).toEqual(fromShell);
  });

  it("default() / BlogListBody() produce the same tree", async () => {
    const shell = await import("@/app/blog/page");
    const pages = await import("@/app/_pages/blog-list");
    const fromShell = await shell.default({ searchParams });
    const fromBody = await pages.BlogListBody({ locale: "en", searchParams });
    expect(fromBody).toEqual(fromShell);
  });
});

describe("blog detail: src/app/blog/[slug]/page.tsx and src/app/_pages/blog-detail.tsx agree", () => {
  const params = Promise.resolve({ slug: "a-blog-post" });

  beforeEach(() => {
    loadBlogAccess.mockResolvedValue({ kind: "published", articleId: "blog-article-1", title: BLOG_DETAIL.title });
    loadBlogDetail.mockResolvedValue(BLOG_DETAIL);
  });

  it("generateMetadata / buildBlogDetailMetadata produce the same metadata", async () => {
    const shell = await import("@/app/blog/[slug]/page");
    const pages = await import("@/app/_pages/blog-detail");
    const fromShell = await shell.generateMetadata({ params });
    const fromBody = await pages.buildBlogDetailMetadata("en", params);
    expect(fromBody).toEqual(fromShell);
  });

  it("default() / BlogDetailBody() produce the same tree", async () => {
    const shell = await import("@/app/blog/[slug]/page");
    const pages = await import("@/app/_pages/blog-detail");
    const fromShell = await shell.default({ params });
    const fromBody = await pages.BlogDetailBody({ locale: "en", params });
    expect(fromBody).toEqual(fromShell);
  });
});
