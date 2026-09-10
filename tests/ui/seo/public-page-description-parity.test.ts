import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPublicT } from "@/lib/locale/messages";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

/**
 * 公开页 `<meta name="description">` CPS parity gate
 * (施工报告_公开页description与句数门禁_2026-09-10.md 任务 1).
 *
 * 起因：首页 `https://novel.test/` 实测 `<head>` 没有
 * `<meta name="description">`。根因是 `src/app/_pages/home.tsx` 的
 * `settings.homeMetaDescription || settings.siteDescription` 两级链在两个
 * SiteSetting 字段都为空（当前生产状态）时落到 `""`；Next 的
 * `Meta()`（`node_modules/next/dist/lib/metadata/generate/meta.js`）对
 * `content === ""` 直接跳过渲染整个 `<meta>` 标签，而不仅仅是
 * `null`/`undefined` 才跳过——即使根布局 `src/app/layout.tsx` 设了非空
 * `description`，子路由段显式返回的 `description: ""` 也会在
 * `resolve-metadata.js` 的逐字段合并（`metadata[key] ?? null`）里整段覆盖
 * 掉父级的值，而不是被跳过继承。
 *
 * CPS v8.5.1 对照（`src/app/[locale]/(site)/layout.tsx` 与
 * `src/lib/seo-templates/category.ts`）：CPS 的每一层"列表/首页"description
 * 链都以一个消息目录字符串收尾（`t("homeDescriptionFallback")` /
 * `i18n.descriptionFallback(name)`），保证永不为空。本文件按页逐一断言：
 * description 非空、与 openGraph.description 一致、不超过 CPS
 * `truncateDescription` 的 155 上限（`src/lib/seo/seo-templates/_shared.ts`
 * 第 43 行，直接照抄 CPS 同名函数的默认值）。
 *
 * 反向自检：把 `src/app/_pages/home.tsx` 的第三级 `t("meta.siteDescription")`
 * 拿掉，"home: 落到消息目录兜底" 这条用例会红（description 变回 ""）。
 */

const NOT_FOUND = Symbol("next-not-found");

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw NOT_FOUND;
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
const loadNovelDetail = vi.mocked(publicLoad.loadNovelDetail);
const loadChapterView = vi.mocked(publicLoad.loadChapterView);
const loadHreflangSiblings = vi.mocked(publicLoad.loadHreflangSiblings);
const loadBlogList = vi.mocked(publicLoad.loadBlogList);
const loadBlogAccess = vi.mocked(publicLoad.loadBlogAccess);
const loadBlogDetail = vi.mocked(publicLoad.loadBlogDetail);

const categoryQueries = await import("@/lib/site/category-queries");
const getPublicCategoryPage = vi.mocked(categoryQueries.getPublicCategoryPage);

const { buildHomeMetadata } = await import("@/app/_pages/home");
const { buildBrowseMetadata } = await import("@/app/_pages/browse");
const { buildCategoryMetadata } = await import("@/app/_pages/category");
const { buildBlogListMetadata } = await import("@/app/_pages/blog-list");
const { buildBlogDetailMetadata } = await import("@/app/_pages/blog-detail");
const { buildNovelMetadata } = await import("@/app/_pages/novel-detail");
const { buildChapterMetadata } = await import("@/app/_pages/chapter");
const { notFoundMetadata } = await import("@/app/_pages/novel-not-found");
const rootNotFound = await import("@/app/not-found");

const ORIGIN = "https://example.test";
/** CPS `_shared.ts#truncateDescription` default `maxLen` — ported verbatim
 * into `src/lib/seo/seo-templates/_shared.ts:43`, same 155 value. */
const MAX_DESCRIPTION_LENGTH = 155;

const t = getPublicT(PUBLIC_SITE_LOCALE);

const CHROME = { brandHref: "/", navItems: [], footerNote: "© test" };

/** Both DB-side description fields empty — the actual production state
 * that exposed the missing-`<meta name="description">` bug on `/`. A
 * non-empty `defaultOgImage` is kept so failures here are never about
 * `resolveOgImage`'s unrelated "OG image is required" guard. */
const SETTINGS_NO_DESCRIPTION = {
  siteName: "cps-novel",
  siteDescription: "",
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
  updatedAt: new Date("2026-09-10T00:00:00Z"),
};

const CARD_WITH_COVER = {
  id: "biz-1",
  title: "The Lantern Keeper's Daughter",
  coverUrl: "/covers/lantern.jpg",
  tags: [],
  href: "/novel/lantern-keepers-daughter-pabc123",
};

function assertNonEmptyConsistentDescription(metadata: Record<string, any>, label: string) {
  expect(metadata.description, `${label}: description must not be empty`).toBeTruthy();
  expect(typeof metadata.description, `${label}: description must be a string`).toBe("string");
  expect(
    metadata.description.length,
    `${label}: description must not exceed CPS's ${MAX_DESCRIPTION_LENGTH}-char truncateDescription bound`,
  ).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
  expect(
    metadata.openGraph?.description,
    `${label}: openGraph.description must match description`,
  ).toBe(metadata.description);
}

beforeEach(() => {
  process.env.SITE_URL = ORIGIN;
});

afterEach(() => {
  delete process.env.SITE_URL;
  delete process.env.FEATURE_ARTICLE_BLOG;
  vi.clearAllMocks();
});

describe("public page <meta name=description>: non-empty, matches og:description, within CPS's 155-char bound", () => {
  it("home: falls back to the message catalog when both SiteSetting description fields are empty", async () => {
    loadChrome.mockResolvedValue({ settings: SETTINGS_NO_DESCRIPTION, chrome: CHROME });
    loadHomeNovels.mockResolvedValue([CARD_WITH_COVER]);
    loadHomeCarousel.mockResolvedValue([]);
    loadPublicCategories.mockResolvedValue([]);

    const metadata = await buildHomeMetadata(PUBLIC_SITE_LOCALE);
    assertNonEmptyConsistentDescription(metadata as Record<string, any>, "home");
    expect(metadata.description).toBe(t("meta.siteDescription"));
  });

  it("browse (all works, no category filter): falls back to the message catalog when settings.siteDescription is empty", async () => {
    loadChrome.mockResolvedValue({ settings: SETTINGS_NO_DESCRIPTION, chrome: CHROME });
    loadBrowseNovels.mockResolvedValue([CARD_WITH_COVER]);

    const metadata = await buildBrowseMetadata(PUBLIC_SITE_LOCALE, Promise.resolve({}));
    assertNonEmptyConsistentDescription(metadata as Record<string, any>, "browse");
    expect(metadata.description).toBe(t("collection.browseSeoDescription"));
  });

  it("blog list: falls back to the message catalog when settings.siteDescription is empty", async () => {
    process.env.FEATURE_ARTICLE_BLOG = "true";
    loadChrome.mockResolvedValue({ settings: SETTINGS_NO_DESCRIPTION, chrome: CHROME });
    loadBlogList.mockResolvedValue([
      {
        id: "blog-1",
        title: "A blog post",
        slug: "a-blog-post",
        summary: "A short summary",
        publishedAt: new Date("2026-08-05T12:30:00.000Z"),
        href: "/blog/a-blog-post",
      },
    ]);

    const metadata = await buildBlogListMetadata(PUBLIC_SITE_LOCALE, Promise.resolve({}));
    assertNonEmptyConsistentDescription(metadata as Record<string, any>, "blog list");
    expect(metadata.description).toBe(t("blog.listDescription"));
  });

  it("category: keeps its existing non-empty synthesized fallback when the category's own description is empty (pre-existing, not touched by this pass)", async () => {
    loadChrome.mockResolvedValue({ settings: SETTINGS_NO_DESCRIPTION, chrome: CHROME });
    getPublicCategoryPage.mockResolvedValue({
      novels: [CARD_WITH_COVER],
      page: 1,
      totalPages: 1,
      totalCount: 1,
      category: {
        id: "cat-1",
        slug: "fantasy",
        name: "Fantasy",
        description: "",
        sortOrder: 0,
        updatedAt: new Date("2026-09-10T00:00:00Z"),
      },
    });

    const metadata = await buildCategoryMetadata(
      PUBLIC_SITE_LOCALE,
      Promise.resolve({ slug: "fantasy" }),
      Promise.resolve({}),
    );
    assertNonEmptyConsistentDescription(metadata as Record<string, any>, "category");
  });

  it("novel detail: description is the truncated Novel/Article synopsis and matches og:description", async () => {
    loadChrome.mockResolvedValue({ settings: SETTINGS_NO_DESCRIPTION, chrome: CHROME });
    loadArticleAccess.mockResolvedValue({
      kind: "published",
      articleId: "article-1",
      novelId: "novel-1",
      slugPart: "lantern-keepers-daughter",
      shortId: "abc123",
      title: "The Lantern Keeper's Daughter",
    });
    loadNovelDetail.mockResolvedValue({
      id: "biz-1",
      title: "The Lantern Keeper's Daughter",
      coverUrl: "/covers/lantern.jpg",
      description:
        "A coastal town keeps one lantern burning long after the harbor went dark, and nobody in the village will explain why to a stranger asking after dusk.",
      locale: { code: "en", label: "English" },
      totalChapterCount: 12,
      tags: [],
      previewChapters: [],
    });
    loadHreflangSiblings.mockResolvedValue([]);

    const metadata = await buildNovelMetadata(
      PUBLIC_SITE_LOCALE,
      Promise.resolve({ slugParam: "lantern-keepers-daughter-pabc123" }),
    );
    assertNonEmptyConsistentDescription(metadata as Record<string, any>, "novel detail");
  });

  it("chapter: description falls back to the chapter's first paragraph and matches og:description", async () => {
    loadChrome.mockResolvedValue({ settings: SETTINGS_NO_DESCRIPTION, chrome: CHROME });
    loadArticleAccess.mockResolvedValue({
      kind: "published",
      articleId: "article-1",
      novelId: "novel-1",
      slugPart: "lantern-keepers-daughter",
      shortId: "abc123",
      title: "The Lantern Keeper's Daughter",
    });
    loadChapterView.mockResolvedValue({
      number: 1,
      title: "The Harbour",
      paragraphs: ["The tide came in early that year, and with it, the first of the strange letters."],
      novel: {
        id: "biz-1",
        title: "The Lantern Keeper's Daughter",
        href: "/novel/lantern-keepers-daughter-pabc123",
        coverUrl: "/covers/lantern.jpg",
      },
      previewPosition: { index: 1, total: 3 },
    });
    loadHreflangSiblings.mockResolvedValue([]);

    const metadata = await buildChapterMetadata(
      PUBLIC_SITE_LOCALE,
      Promise.resolve({ slugParam: "lantern-keepers-daughter-pabc123", chapterNumber: "1" }),
    );
    assertNonEmptyConsistentDescription(metadata as Record<string, any>, "chapter");
  });

  it("blog detail: description falls back through metaDescription/summary and matches og:description", async () => {
    loadChrome.mockResolvedValue({ settings: SETTINGS_NO_DESCRIPTION, chrome: CHROME });
    loadBlogAccess.mockResolvedValue({ kind: "published", articleId: "blog-1", title: "A blog post" });
    loadBlogDetail.mockResolvedValue({
      id: "blog-1",
      title: "A blog post",
      slug: "a-blog-post",
      summary: "A short summary of the post that stands in for metaDescription when it is unset.",
      publishedAt: new Date("2026-08-05T12:30:00.000Z"),
      href: "/blog/a-blog-post",
      coverUrl: "/covers/blog.jpg",
      body: "<p>Body</p>",
      updatedAt: new Date("2026-08-06T00:00:00.000Z"),
    });

    const metadata = await buildBlogDetailMetadata(PUBLIC_SITE_LOCALE, Promise.resolve({ slug: "a-blog-post" }));
    assertNonEmptyConsistentDescription(metadata as Record<string, any>, "blog detail");
  });

  it("not-found shells never set an empty-string description that would defeat the root layout's inherited default", () => {
    // Neither file should carry a `description` key at all — that is what
    // lets `src/app/layout.tsx`'s non-empty `t("meta.siteDescription")`
    // flow through unopposed (an explicit `description: ""` here would
    // override it, exactly like the home-page bug this file guards against).
    expect("description" in notFoundMetadata).toBe(false);
    expect("description" in rootNotFound.metadata).toBe(false);
  });
});
