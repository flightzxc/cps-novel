import "./setup-cleanup";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NovelCardView, NovelDetailView } from "@/features/public-ui/types";
import { UnavailableScreen } from "@/features/public-ui/status/UnavailableScreen";
import { BlogUnavailableScreen } from "@/features/public-ui/blog/BlogUnavailableScreen";

/**
 * WO-1 (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §6.6 item 2): "语种
 * 前缀树可达性冒烟" — for each of the 8 new `src/app/[locale]/...` thin
 * shells, prove they delegate to the exact same shared body in
 * `src/app/_pages/*` that the bare-path shells already use, and that the
 * body is genuinely parameterized by `locale` rather than still reading a
 * module-level constant.
 *
 * Review fix (M1, 2026-09-09): the previous version of this file NEVER
 * imported any `src/app/[locale]/...` file. It called `src/app/_pages/*`
 * directly on "both sides" of every comparison (once as `pages.HomeBody({
 * locale: "en" })`, once via `shell.default()` where `shell` was the
 * BARE-path `src/app/page.tsx`, which itself just calls
 * `HomeBody({ locale: PUBLIC_SITE_LOCALE })` — and `PUBLIC_SITE_LOCALE ===
 * "en"`). Both sides called the identical function with the identical
 * argument — a tautology that could not fail short of `toEqual` itself
 * being broken, and it could never have caught a bug in any
 * `src/app/[locale]/...` shell file because none of those files were ever
 * imported.
 *
 * This version instead:
 *
 * 1. Mocks `@/app/[locale]/_guard` — wrapping, not replacing, the real
 *    implementation (see `guardActual` / `bypassGuard` / `restoreRealGuard`
 *    below) — so `requireRoutableLocale`/`getRoutableLocale` can be pointed
 *    at either a "locale is routable" stub (`"en"`, for the parity tests
 *    below) or the real, always-404 gate (for the "guard unmocked" block at
 *    the end), without ever calling `vi.resetModules()`. A `resetModules()`
 *    re-evaluation would silently disconnect the shared
 *    `src/app/_lib/public-load` / `@/lib/site/category-queries` mocks below
 *    from the `vi.fn()` instances the `_pages/*` bodies actually import.
 * 2. For every one of the 8 shells, actually `import()`s the real
 *    `src/app/[locale]/...` file and drives its exported
 *    `generateMetadata`/`default` — not `src/app/_pages/*` a second time —
 *    and deep-equals the result against the real bare-path shell
 *    (`src/app/page.tsx` etc.) called with the same mocked inputs. Because
 *    both shells delegate to the SAME singleton `_pages/*` module instance
 *    (no `resetModules()` ever runs), a bug in a `[locale]/...` shell's own
 *    wiring — wrong body import, dropped/reordered argument, wrong param
 *    key — breaks only the prefixed side and is caught here.
 * 3. Adds independent, non-self-referential assertions (exact
 *    title/description/robots/canonical values) alongside the bare-vs-
 *    prefixed comparison, especially for `/browse`'s category branch (see
 *    "browse: bare-path and [locale]-prefixed shells agree" below). A bug
 *    INSIDE the shared `_pages/*` body (e.g. `buildBrowseMetadata`'s
 *    category-vs-site description `||` precedence, or its title ternary)
 *    affects both shells identically, so bare-vs-prefixed equality alone
 *    can never catch it — only a pinned, independently-known-correct value
 *    can. This is the check this file's load-bearing verification exercises
 *    (temporarily flip `src/app/_pages/browse.tsx`'s title ternary or `||`
 *    precedence and re-run this file: it goes red).
 * 4. Adds a final "guard unmocked" block asserting that every gated
 *    `[locale]/...` shell (all but the not-found shell, which never calls
 *    the guard — see its own describe block) still 404s under the REAL
 *    `_guard.ts` — i.e. that this test's guard bypass is opt-in scaffolding
 *    for the parity checks above, not a change to production behavior.
 */

const NOT_FOUND = Symbol("next-not-found");

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw NOT_FOUND;
  },
}));

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

// Wraps (does not replace) the real guard: the default `vi.fn()` behavior is
// the ACTUAL `requireRoutableLocale`/`getRoutableLocale` implementation, so
// a test that never touches these mocks still exercises real gate logic.
// `bypassGuard()`/`restoreRealGuard()` below flip the implementation per
// test group.
vi.mock("@/app/[locale]/_guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/[locale]/_guard")>();
  return {
    requireRoutableLocale: vi.fn(actual.requireRoutableLocale),
    getRoutableLocale: vi.fn(actual.getRoutableLocale),
  };
});

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

const guard = await import("@/app/[locale]/_guard");
const requireRoutableLocale = vi.mocked(guard.requireRoutableLocale);
const getRoutableLocale = vi.mocked(guard.getRoutableLocale);

// The TRUE, unmocked guard — bypasses the `vi.mock` above entirely (see
// Vitest's `importActual`). Used only to restore real gate behavior for the
// "guard unmocked" block; every other test in this file runs with the guard
// bypassed via `bypassGuard()`.
const guardActual = await vi.importActual<typeof import("@/app/[locale]/_guard")>("@/app/[locale]/_guard");

function bypassGuard(): void {
  requireRoutableLocale.mockReturnValue("en");
  getRoutableLocale.mockReturnValue("en");
}

function restoreRealGuard(): void {
  requireRoutableLocale.mockImplementation(guardActual.requireRoutableLocale);
  getRoutableLocale.mockImplementation(guardActual.getRoutableLocale);
}

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

// Deliberately distinct from SETTINGS.siteDescription ("Overseas novels.")
// — see "browse: bare-path and [locale]-prefixed shells agree" below, whose
// category-branch test relies on this being distinguishable to pin down the
// `||` precedence in `buildBrowseMetadata`.
const CATEGORY = {
  id: "tag-1",
  slug: "fantasy",
  name: "Fantasy",
  description: "Distinguishing category description.",
  sortOrder: 1,
  updatedAt: new Date("2026-08-01T00:00:00Z"),
};

const CATEGORY_PAGE = {
  novels: [CARD],
  page: 1,
  totalPages: 1,
  totalCount: 1,
  category: CATEGORY,
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
  bypassGuard();
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

describe("home: bare-path and [locale]-prefixed shells agree", () => {
  it("generateMetadata agrees and matches known-correct values (index/follow, home canonical)", async () => {
    const bare = await import("@/app/page");
    const prefixed = await import("@/app/[locale]/page");

    const fromBare = await bare.generateMetadata();
    const fromPrefixed = await prefixed.generateMetadata({ params: Promise.resolve({ locale: "en" }) });
    expect(fromPrefixed).toEqual(fromBare);
    expect(fromBare.robots).toEqual({ index: true, follow: true });
    expect(fromBare.alternates).toEqual(expect.objectContaining({ canonical: `${ORIGIN}/` }));
  });

  it("default() renders the same tree on both shells", async () => {
    const bare = await import("@/app/page");
    const prefixed = await import("@/app/[locale]/page");

    const fromBare = await bare.default();
    const fromPrefixed = await prefixed.default({ params: Promise.resolve({ locale: "en" }) });
    expect(fromPrefixed).toEqual(fromBare);
  });
});

describe("browse: bare-path and [locale]-prefixed shells agree", () => {
  it("default (non-category) listing: generateMetadata/default agree, title matches the WO-1 §6.4 byte-identical substitution", async () => {
    const bare = await import("@/app/browse/page");
    const prefixed = await import("@/app/[locale]/browse/page");
    const searchParams = Promise.resolve({});

    const fromBareMeta = await bare.generateMetadata({ searchParams });
    const fromPrefixedMeta = await prefixed.generateMetadata({ params: Promise.resolve({ locale: "en" }), searchParams });
    expect(fromPrefixedMeta).toEqual(fromBareMeta);
    expect(fromBareMeta.title).toBe("All works");
    expect(fromBareMeta.description).toBe(SETTINGS.siteDescription);

    const fromBareTree = await bare.default({ searchParams });
    const fromPrefixedTree = await prefixed.default({ params: Promise.resolve({ locale: "en" }), searchParams });
    expect(fromPrefixedTree).toEqual(fromBareTree);
  });

  it("category branch: generateMetadata/default agree, and the category's own description takes precedence over the site description — this is the check this file's load-bearing verification exercises: flip buildBrowseMetadata's title ternary or `||` precedence and this assertion (not the bare-vs-prefixed one above it) goes red, because both shells share the same _pages/browse.tsx body and would still agree with each other even if that body were wrong", async () => {
    getPublicCategoryPage.mockResolvedValue(CATEGORY_PAGE);
    const bare = await import("@/app/browse/page");
    const prefixed = await import("@/app/[locale]/browse/page");
    const searchParams = Promise.resolve({ category: "fantasy" });

    const fromBareMeta = await bare.generateMetadata({ searchParams });
    const fromPrefixedMeta = await prefixed.generateMetadata({ params: Promise.resolve({ locale: "en" }), searchParams });
    expect(fromPrefixedMeta).toEqual(fromBareMeta);
    expect(fromBareMeta.title).toBe("Fantasy novels");
    expect(fromBareMeta.description).toBe(CATEGORY.description);
    expect(fromBareMeta.description).not.toBe(SETTINGS.siteDescription);

    const fromBareTree = await bare.default({ searchParams });
    const fromPrefixedTree = await prefixed.default({ params: Promise.resolve({ locale: "en" }), searchParams });
    expect(fromPrefixedTree).toEqual(fromBareTree);
  });

  it("404s for page=2 with zero novels on both shells (C-29 review low fix)", async () => {
    loadBrowseNovels.mockResolvedValue([]);
    const bare = await import("@/app/browse/page");
    const prefixed = await import("@/app/[locale]/browse/page");
    const searchParams = Promise.resolve({ page: "2" });

    await expect(bare.default({ searchParams })).rejects.toBe(NOT_FOUND);
    await expect(prefixed.default({ params: Promise.resolve({ locale: "en" }), searchParams })).rejects.toBe(NOT_FOUND);
  });
});

describe("category: bare-path and [locale]-prefixed shells agree", () => {
  beforeEach(() => {
    getPublicCategoryPage.mockResolvedValue(CATEGORY_PAGE);
  });

  it("generateMetadata/default agree, title is the bare category name (no ' novels' suffix)", async () => {
    const bare = await import("@/app/category/[slug]/page");
    const prefixed = await import("@/app/[locale]/category/[slug]/page");
    const params = Promise.resolve({ slug: "fantasy" });
    const prefixedParams = Promise.resolve({ locale: "en", slug: "fantasy" });
    const searchParams = Promise.resolve({});

    const fromBareMeta = await bare.generateMetadata({ params, searchParams });
    const fromPrefixedMeta = await prefixed.generateMetadata({ params: prefixedParams, searchParams });
    expect(fromPrefixedMeta).toEqual(fromBareMeta);
    expect(fromBareMeta.title).toBe("Fantasy");

    const fromBareTree = await bare.default({ params, searchParams });
    const fromPrefixedTree = await prefixed.default({ params: prefixedParams, searchParams });
    expect(fromPrefixedTree).toEqual(fromBareTree);
  });

  it("404s when the category does not exist, on both shells", async () => {
    getPublicCategoryPage.mockResolvedValue(null);
    const bare = await import("@/app/category/[slug]/page");
    const prefixed = await import("@/app/[locale]/category/[slug]/page");
    const params = Promise.resolve({ slug: "missing" });
    const prefixedParams = Promise.resolve({ locale: "en", slug: "missing" });
    const searchParams = Promise.resolve({});

    await expect(bare.default({ params, searchParams })).rejects.toBe(NOT_FOUND);
    await expect(prefixed.default({ params: prefixedParams, searchParams })).rejects.toBe(NOT_FOUND);
  });
});

describe("novel detail: bare-path and [locale]-prefixed shells agree", () => {
  const NOVEL_PARAMS = { slugParam: "lantern-keepers-daughter-pabc123" };

  it("published: generateMetadata/default agree, self-canonical, hreflang from the real Prisma novelId", async () => {
    loadArticleAccess.mockResolvedValue({
      kind: "published",
      articleId: "article-1",
      novelId: "novel-1",
      slugPart: "lantern-keepers-daughter",
      shortId: "abc123",
      title: DETAIL.title,
    });
    loadNovelDetail.mockResolvedValue(DETAIL);
    loadHreflangSiblings.mockResolvedValue([
      { locale: "fr", slug: "la-fille-du-gardien-du-phare", publicPageShortId: "def456" },
    ]);

    const bare = await import("@/app/novel/[slugParam]/page");
    const prefixed = await import("@/app/[locale]/novel/[slugParam]/page");
    const params = Promise.resolve(NOVEL_PARAMS);
    const prefixedParams = Promise.resolve({ locale: "en", ...NOVEL_PARAMS });

    const fromBareMeta = await bare.generateMetadata({ params });
    const fromPrefixedMeta = await prefixed.generateMetadata({ params: prefixedParams });
    expect(fromPrefixedMeta).toEqual(fromBareMeta);
    expect(fromBareMeta.robots).toEqual({ index: true, follow: true });
    expect(fromBareMeta.alternates?.languages).toEqual({
      en: `${ORIGIN}/novel/lantern-keepers-daughter-pabc123`,
      fr: `${ORIGIN}/fr/novel/la-fille-du-gardien-du-phare-pdef456`,
      "x-default": `${ORIGIN}/novel/lantern-keepers-daughter-pabc123`,
    });

    const fromBareTree = await bare.default({ params });
    const fromPrefixedTree = await prefixed.default({ params: prefixedParams });
    expect(fromPrefixedTree).toEqual(fromBareTree);
  });

  it("unavailable: renders UnavailableScreen (not 404) on both shells, noindex metadata", async () => {
    loadArticleAccess.mockResolvedValue({ kind: "unavailable", title: DETAIL.title });

    const bare = await import("@/app/novel/[slugParam]/page");
    const prefixed = await import("@/app/[locale]/novel/[slugParam]/page");
    const params = Promise.resolve(NOVEL_PARAMS);
    const prefixedParams = Promise.resolve({ locale: "en", ...NOVEL_PARAMS });

    const fromBareTree = await bare.default({ params });
    const fromPrefixedTree = await prefixed.default({ params: prefixedParams });
    expect(fromPrefixedTree).toEqual(fromBareTree);
    expect(fromBareTree.type).toBe(UnavailableScreen);

    const fromBareMeta = await bare.generateMetadata({ params });
    const fromPrefixedMeta = await prefixed.generateMetadata({ params: prefixedParams });
    expect(fromPrefixedMeta).toEqual(fromBareMeta);
    expect(fromBareMeta.robots).toEqual({ index: false, follow: false });
  });

  it("takedown / not_found: notFound() on both shells", async () => {
    const bare = await import("@/app/novel/[slugParam]/page");
    const prefixed = await import("@/app/[locale]/novel/[slugParam]/page");
    const params = Promise.resolve(NOVEL_PARAMS);
    const prefixedParams = Promise.resolve({ locale: "en", ...NOVEL_PARAMS });

    loadArticleAccess.mockResolvedValue({ kind: "takedown", title: DETAIL.title });
    await expect(bare.default({ params })).rejects.toBe(NOT_FOUND);
    await expect(prefixed.default({ params: prefixedParams })).rejects.toBe(NOT_FOUND);

    loadArticleAccess.mockResolvedValue({ kind: "not_found" });
    await expect(bare.default({ params })).rejects.toBe(NOT_FOUND);
    await expect(prefixed.default({ params: prefixedParams })).rejects.toBe(NOT_FOUND);
  });
});

describe("novel not-found: bare-path and [locale]-prefixed shells agree", () => {
  it("both pin PUBLIC_SITE_LOCALE (Next's zero-prop not-found.tsx constraint), metadata re-exported verbatim", async () => {
    const bare = await import("@/app/novel/[slugParam]/not-found");
    const prefixed = await import("@/app/[locale]/novel/[slugParam]/not-found");
    const pages = await import("@/app/_pages/novel-not-found");

    expect(bare.metadata).toEqual(pages.notFoundMetadata);
    expect(prefixed.metadata).toEqual(pages.notFoundMetadata);

    const fromBare = bare.default();
    const fromPrefixed = prefixed.default();
    expect(fromPrefixed).toEqual(fromBare);
  });
});

describe("chapter: bare-path and [locale]-prefixed shells agree", () => {
  const CHAPTER_PARAMS = { slugParam: "lantern-keepers-daughter-pabc123", chapterNumber: "1" };

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

  it("generateMetadata/default agree, self-canonicalizing the chapter URL", async () => {
    const bare = await import("@/app/novel/[slugParam]/chapter/[chapterNumber]/page");
    const prefixed = await import("@/app/[locale]/novel/[slugParam]/chapter/[chapterNumber]/page");
    const params = Promise.resolve(CHAPTER_PARAMS);
    const prefixedParams = Promise.resolve({ locale: "en", ...CHAPTER_PARAMS });

    const fromBareMeta = await bare.generateMetadata({ params });
    const fromPrefixedMeta = await prefixed.generateMetadata({ params: prefixedParams });
    expect(fromPrefixedMeta).toEqual(fromBareMeta);
    expect(fromBareMeta.alternates).toEqual(
      expect.objectContaining({ canonical: `${ORIGIN}/novel/lantern-keepers-daughter-pabc123/chapter/1` }),
    );

    const fromBareTree = await bare.default({ params });
    const fromPrefixedTree = await prefixed.default({ params: prefixedParams });
    expect(fromPrefixedTree).toEqual(fromBareTree);
  });

  it("404s non-canonical chapter numbers on both shells", async () => {
    const bare = await import("@/app/novel/[slugParam]/chapter/[chapterNumber]/page");
    const prefixed = await import("@/app/[locale]/novel/[slugParam]/chapter/[chapterNumber]/page");
    const params = Promise.resolve({ ...CHAPTER_PARAMS, chapterNumber: "01" });
    const prefixedParams = Promise.resolve({ locale: "en", ...CHAPTER_PARAMS, chapterNumber: "01" });

    await expect(bare.default({ params })).rejects.toBe(NOT_FOUND);
    await expect(prefixed.default({ params: prefixedParams })).rejects.toBe(NOT_FOUND);
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

describe("blog list: bare-path and [locale]-prefixed shells agree", () => {
  it("generateMetadata/default agree when the flag is on", async () => {
    const bare = await import("@/app/blog/page");
    const prefixed = await import("@/app/[locale]/blog/page");
    const searchParams = Promise.resolve({});

    const fromBareMeta = await bare.generateMetadata({ searchParams });
    const fromPrefixedMeta = await prefixed.generateMetadata({ params: Promise.resolve({ locale: "en" }), searchParams });
    expect(fromPrefixedMeta).toEqual(fromBareMeta);
    expect(fromBareMeta.robots).toEqual({ index: true, follow: true });
    expect(fromBareMeta.title).toBe("Blog");

    const fromBareTree = await bare.default({ searchParams });
    const fromPrefixedTree = await prefixed.default({ params: Promise.resolve({ locale: "en" }), searchParams });
    expect(fromPrefixedTree).toEqual(fromBareTree);
  });

  it("FEATURE_ARTICLE_BLOG off: notFound() on both shells without ever calling loadBlogList, generateMetadata noindexes", async () => {
    delete process.env.FEATURE_ARTICLE_BLOG;
    const bare = await import("@/app/blog/page");
    const prefixed = await import("@/app/[locale]/blog/page");
    const searchParams = Promise.resolve({});

    await expect(bare.default({ searchParams })).rejects.toBe(NOT_FOUND);
    await expect(prefixed.default({ params: Promise.resolve({ locale: "en" }), searchParams })).rejects.toBe(NOT_FOUND);
    expect(loadBlogList).not.toHaveBeenCalled();

    const fromBareMeta = await bare.generateMetadata({ searchParams });
    const fromPrefixedMeta = await prefixed.generateMetadata({ params: Promise.resolve({ locale: "en" }), searchParams });
    expect(fromPrefixedMeta).toEqual(fromBareMeta);
    expect(fromBareMeta.robots).toEqual({ index: false, follow: false });
  });

  it("404s for page=2 with zero posts on both shells", async () => {
    loadBlogList.mockResolvedValue([]);
    const bare = await import("@/app/blog/page");
    const prefixed = await import("@/app/[locale]/blog/page");
    const searchParams = Promise.resolve({ page: "2" });

    await expect(bare.default({ searchParams })).rejects.toBe(NOT_FOUND);
    await expect(prefixed.default({ params: Promise.resolve({ locale: "en" }), searchParams })).rejects.toBe(NOT_FOUND);
  });
});

describe("blog detail: bare-path and [locale]-prefixed shells agree", () => {
  const BLOG_PARAMS = { slug: "a-blog-post" };

  it("published: generateMetadata/default agree", async () => {
    loadBlogAccess.mockResolvedValue({ kind: "published", articleId: "blog-article-1", title: BLOG_DETAIL.title });
    loadBlogDetail.mockResolvedValue(BLOG_DETAIL);

    const bare = await import("@/app/blog/[slug]/page");
    const prefixed = await import("@/app/[locale]/blog/[slug]/page");
    const params = Promise.resolve(BLOG_PARAMS);
    const prefixedParams = Promise.resolve({ locale: "en", ...BLOG_PARAMS });

    const fromBareMeta = await bare.generateMetadata({ params });
    const fromPrefixedMeta = await prefixed.generateMetadata({ params: prefixedParams });
    expect(fromPrefixedMeta).toEqual(fromBareMeta);
    expect(fromBareMeta.robots).toEqual({ index: true, follow: true });
    expect(fromBareMeta.alternates?.canonical).toBe(`${ORIGIN}/blog/a-blog-post`);

    const fromBareTree = await bare.default({ params });
    const fromPrefixedTree = await prefixed.default({ params: prefixedParams });
    expect(fromPrefixedTree).toEqual(fromBareTree);
  });

  it("not_found / takedown: notFound() on both shells", async () => {
    const bare = await import("@/app/blog/[slug]/page");
    const prefixed = await import("@/app/[locale]/blog/[slug]/page");
    const params = Promise.resolve(BLOG_PARAMS);
    const prefixedParams = Promise.resolve({ locale: "en", ...BLOG_PARAMS });

    loadBlogAccess.mockResolvedValue({ kind: "not_found" });
    await expect(bare.default({ params })).rejects.toBe(NOT_FOUND);
    await expect(prefixed.default({ params: prefixedParams })).rejects.toBe(NOT_FOUND);

    loadBlogAccess.mockResolvedValue({ kind: "takedown", title: BLOG_DETAIL.title });
    await expect(bare.default({ params })).rejects.toBe(NOT_FOUND);
    await expect(prefixed.default({ params: prefixedParams })).rejects.toBe(NOT_FOUND);
  });

  it("unavailable: renders BlogUnavailableScreen (not 404) on both shells", async () => {
    loadBlogAccess.mockResolvedValue({ kind: "unavailable", title: BLOG_DETAIL.title });
    const bare = await import("@/app/blog/[slug]/page");
    const prefixed = await import("@/app/[locale]/blog/[slug]/page");
    const params = Promise.resolve(BLOG_PARAMS);
    const prefixedParams = Promise.resolve({ locale: "en", ...BLOG_PARAMS });

    const fromBareTree = await bare.default({ params });
    const fromPrefixedTree = await prefixed.default({ params: prefixedParams });
    expect(fromPrefixedTree).toEqual(fromBareTree);
    expect(fromBareTree.type).toBe(BlogUnavailableScreen);
  });
});

describe("[locale]/... shells 404 with the guard UNMOCKED — the one routability decision still lives in _guard.ts, not in any leaf page", () => {
  beforeEach(() => {
    restoreRealGuard();
  });

  // "en": rejected by the D-8 structural rule (default locale stays at the
  // bare path — see _guard.ts's doc comment). "fr": registered in
  // SITE_LOCALES but not (yet) on PUBLISHABLE_LOCALES — rejected by the
  // separate D-7 publish-whitelist gate. Both are real, independent
  // rejection paths through the same real, unmocked getRoutableLocale.
  const locales = ["en", "fr"] as const;

  it.each(locales)("home shell 404s for rawLocale=%s", async (rawLocale) => {
    const prefixed = await import("@/app/[locale]/page");
    const params = Promise.resolve({ locale: rawLocale });
    await expect(prefixed.generateMetadata({ params })).rejects.toBe(NOT_FOUND);
    await expect(prefixed.default({ params })).rejects.toBe(NOT_FOUND);
  });

  it.each(locales)("browse shell 404s for rawLocale=%s", async (rawLocale) => {
    const prefixed = await import("@/app/[locale]/browse/page");
    const params = Promise.resolve({ locale: rawLocale });
    const searchParams = Promise.resolve({});
    await expect(prefixed.generateMetadata({ params, searchParams })).rejects.toBe(NOT_FOUND);
    await expect(prefixed.default({ params, searchParams })).rejects.toBe(NOT_FOUND);
  });

  it.each(locales)("category shell 404s for rawLocale=%s", async (rawLocale) => {
    const prefixed = await import("@/app/[locale]/category/[slug]/page");
    const params = Promise.resolve({ locale: rawLocale, slug: "fantasy" });
    const searchParams = Promise.resolve({});
    await expect(prefixed.generateMetadata({ params, searchParams })).rejects.toBe(NOT_FOUND);
    await expect(prefixed.default({ params, searchParams })).rejects.toBe(NOT_FOUND);
  });

  it.each(locales)("novel detail shell 404s for rawLocale=%s", async (rawLocale) => {
    const prefixed = await import("@/app/[locale]/novel/[slugParam]/page");
    const params = Promise.resolve({ locale: rawLocale, slugParam: "lantern-keepers-daughter-pabc123" });
    await expect(prefixed.generateMetadata({ params })).rejects.toBe(NOT_FOUND);
    await expect(prefixed.default({ params })).rejects.toBe(NOT_FOUND);
  });

  it.each(locales)("chapter shell 404s for rawLocale=%s", async (rawLocale) => {
    const prefixed = await import("@/app/[locale]/novel/[slugParam]/chapter/[chapterNumber]/page");
    const params = Promise.resolve({
      locale: rawLocale,
      slugParam: "lantern-keepers-daughter-pabc123",
      chapterNumber: "1",
    });
    await expect(prefixed.generateMetadata({ params })).rejects.toBe(NOT_FOUND);
    await expect(prefixed.default({ params })).rejects.toBe(NOT_FOUND);
  });

  it.each(locales)("blog list shell 404s for rawLocale=%s", async (rawLocale) => {
    const prefixed = await import("@/app/[locale]/blog/page");
    const params = Promise.resolve({ locale: rawLocale });
    const searchParams = Promise.resolve({});
    await expect(prefixed.generateMetadata({ params, searchParams })).rejects.toBe(NOT_FOUND);
    await expect(prefixed.default({ params, searchParams })).rejects.toBe(NOT_FOUND);
  });

  it.each(locales)("blog detail shell 404s for rawLocale=%s", async (rawLocale) => {
    const prefixed = await import("@/app/[locale]/blog/[slug]/page");
    const params = Promise.resolve({ locale: rawLocale, slug: "a-blog-post" });
    await expect(prefixed.generateMetadata({ params })).rejects.toBe(NOT_FOUND);
    await expect(prefixed.default({ params })).rejects.toBe(NOT_FOUND);
  });

  // The not-found shell (src/app/[locale]/novel/[slugParam]/not-found.tsx)
  // is deliberately excluded here — it never calls requireRoutableLocale
  // (see its own describe block above and its doc comment: Next renders
  // not-found.tsx with zero props, so it cannot read the route's locale).
});
