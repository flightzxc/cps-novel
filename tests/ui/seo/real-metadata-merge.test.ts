import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPublicT } from "@/lib/locale/messages";
import { toChapterView } from "@/lib/site/mappers";
import { SITE_LOCALES } from "@/lib/locale/locale-canonical";

import { resolveNotFoundMetadata, resolveRouteMetadata, type ResolvedMetadata } from "./_helpers/next-metadata-merge";

/**
 * 真实合并验证（TKD 对齐 CPS，Owner 2026-09-30，施工工单第七节"必须真实渲染验证"）。
 *
 * 品牌后缀 `%s | 站点名` 挂在根布局，某个页面有没有被套上，只有 Next 合并元数据时才看得出来
 * ——只测各页 `buildXxxMetadata()` 的返回值证明不了任何事。这里把**磁盘上真实的**
 * layout/page 元数据导出（按 app 目录树逐级收集）交给 **Next 16.1.6 自己的**
 * `accumulateMetadata` 合并，断言最终 `<title>`（`title.absolute`）、og:title、twitter:title。
 * 助手与选择理由见 `_helpers/next-metadata-merge.ts`。
 *
 * 覆盖（施工工单第二节验收表逐行）：英文首页 `/`、`/ja` 首页、小说详情、章节、分类第 1/2 页、
 * 浏览、博客列表与详情、404 元数据、后台/登录/开发预览；并断言 og:title/twitter:title 不带后缀。
 *
 * 数据层（public-load/category-queries/站点设置）用 mock 喂固定数据，被测的是"元数据导出 +
 * Next 合并"这一层，不是数据库查询。
 *
 * 404 有两条路径，必须分开验：页面 `generateMetadata` 自己返回的 "Not found"（页面没抛 notFound 时才用）
 * 与 Next 的 not-found 约定（`notFound()` 抛出后的真 404 响应用 not-found 文件自己的元数据，页面
 * `generateMetadata` 的标题不会出现在 404 响应里）。后者是真实渲染验证（`next build` + `next start`，
 * 一次性 PostgreSQL）发现的：not-found 文件原先只有 robots、没有标题，真 404 的 `<title>` 落到根布局
 * `title.default`（站点名），与验收表"Not found | 站点名"不符，已在 not-found 文件补标题。
 *
 * 反向自检（本轮三处变异，均须让本文件对应用例变红，见施工报告）：
 *  1. 去掉 `_pages/home.tsx` 首页的 `title.absolute`——"/ja 首页不带后缀"等用例红；
 *  2. 去掉 `novel-detail.tsx`/`blog-detail.tsx` 的 `normalizeMetadataTitle` 调用——"已带 | 站点名
 *     的 SEO 标题只出现一次后缀"红；
 *  3. 去掉 `home.tsx` 的 `useSettingsMetadata`（非英语不读后台值）判断——"/ja 首页读文案不读后台值"红。
 */

const NOT_FOUND = Symbol("next-not-found");

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw NOT_FOUND;
  },
}));

const state = vi.hoisted(() => ({
  settings: null as unknown as Record<string, unknown>,
}));

const headerState = vi.hoisted(() => ({ locale: null as string | null }));
// `[locale]` 段的 not-found 壳按请求头（`x-novel-locale`）取语种，与 `src/app/layout.tsx` 同一机制。
vi.mock("next/headers", () => ({
  headers: async () => ({ get: () => headerState.locale }),
}));

vi.mock("@/app/_lib/public-deps", () => ({ prisma: {} }));
vi.mock("@/server/site-settings/service", () => ({
  getSiteSetting: vi.fn(async () => state.settings),
}));

vi.mock("@/app/_lib/public-load", () => ({
  loadChrome: vi.fn(),
  loadActiveLocales: vi.fn(),
  loadHomeNovels: vi.fn(),
  loadHomeCarousel: vi.fn(),
  loadPublicCategories: vi.fn(),
  loadBrowseNovels: vi.fn(),
  loadArticleAccess: vi.fn(),
  loadNovelDetail: vi.fn(),
  loadChapterView: vi.fn(),
  loadHreflangSiblings: vi.fn(),
  loadRelatedAndNewReleases: vi.fn(),
  loadBlogList: vi.fn(),
  loadBlogAccess: vi.fn(),
  loadBlogDetail: vi.fn(),
}));

vi.mock("@/lib/site/category-queries", () => ({
  getPublicCategoryPage: vi.fn(),
}));

const publicLoad = await import("@/app/_lib/public-load");
const loadChrome = vi.mocked(publicLoad.loadChrome);
const loadActiveLocales = vi.mocked(publicLoad.loadActiveLocales);
const loadHomeNovels = vi.mocked(publicLoad.loadHomeNovels);
const loadPublicCategories = vi.mocked(publicLoad.loadPublicCategories);
const loadBrowseNovels = vi.mocked(publicLoad.loadBrowseNovels);
const loadArticleAccess = vi.mocked(publicLoad.loadArticleAccess);
const loadNovelDetail = vi.mocked(publicLoad.loadNovelDetail);
const loadChapterView = vi.mocked(publicLoad.loadChapterView);
const loadHreflangSiblings = vi.mocked(publicLoad.loadHreflangSiblings);
const loadRelatedAndNewReleases = vi.mocked(publicLoad.loadRelatedAndNewReleases);
const loadBlogList = vi.mocked(publicLoad.loadBlogList);
const loadBlogAccess = vi.mocked(publicLoad.loadBlogAccess);
const loadBlogDetail = vi.mocked(publicLoad.loadBlogDetail);
const categoryQueries = await import("@/lib/site/category-queries");
const getPublicCategoryPage = vi.mocked(categoryQueries.getPublicCategoryPage);

const rootNotFound = await import("@/app/not-found");
const novelNotFound = await import("@/app/novel/[slugParam]/not-found");
const localeNovelNotFound = await import("@/app/[locale]/novel/[slugParam]/not-found");

const ORIGIN = "https://example.test";
const CHROME = { brandHref: "/", navItems: [], footerNote: "© test" };

function makeSettings(overrides: Record<string, unknown> = {}) {
  return {
    siteName: "PulseNovel",
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
    updatedAt: new Date("2026-09-30T00:00:00Z"),
    ...overrides,
  };
}

/** 每条路由解析后的 (route -> 最终 <title>) 记录；`TKD_PRINT_TITLES=1` 时打印成表，供施工报告对照验收表。 */
const titleLog: Array<{ route: string; title: string; ogTitle: string | null }> = [];

async function resolve(route: string, request: Parameters<typeof resolveRouteMetadata>[0]): Promise<ResolvedMetadata> {
  const resolved = await resolveRouteMetadata({ pathname: route, ...request });
  titleLog.push({ route, title: resolved.title.absolute, ogTitle: resolved.openGraph?.title.absolute ?? null });
  return resolved;
}

/** 站点名为 PulseNovel 时，任一公开页的最终 og:title / twitter:title 都不能带品牌后缀（品牌走 og:site_name）。 */
function expectSocialTitlesWithoutSuffix(resolved: ResolvedMetadata, expectedSocialTitle: string) {
  expect(resolved.openGraph?.title.absolute).toBe(expectedSocialTitle);
  expect(resolved.twitter?.title.absolute).toBe(expectedSocialTitle);
  // 根布局没有 openGraph/twitter 标题模板——模板只作用于 <title>。
  expect(resolved.openGraph?.title.template ?? null).toBeNull();
  expect(resolved.twitter?.title.template ?? null).toBeNull();
}

const CARD = { id: "biz-1", title: "Lost Kingdom", coverUrl: "/covers/lost.jpg", tags: [], href: "/novel/lost-kingdom-pabc123" };
const MANY_CARDS = Array.from({ length: 45 }, (_, i) => ({ ...CARD, id: `biz-${i}`, title: `Novel ${i}`, href: `/novel/n-${i}` }));
const MANY_POSTS = Array.from({ length: 45 }, (_, i) => ({
  id: `b${i}`,
  title: `Post ${i}`,
  slug: `post-${i}`,
  summary: "s",
  publishedAt: new Date("2026-08-05T12:30:00.000Z"),
  href: `/blog/post-${i}`,
}));

const PUBLISHED_ACCESS = {
  kind: "published" as const,
  articleId: "article-1",
  novelId: "novel-1",
  slugPart: "lost-kingdom",
  shortId: "abc123",
  title: "Lost Kingdom",
};

function novelDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: "biz-1",
    title: "Lost Kingdom",
    coverUrl: "/covers/lost.jpg",
    description: "A kingdom lost beyond the sea, and the one who searches for its gate.",
    locale: { code: "en", label: "English" },
    totalChapterCount: 12,
    tags: [],
    previewChapters: [],
    ...overrides,
  };
}

beforeEach(() => {
  process.env.SITE_URL = ORIGIN;
  process.env.FEATURE_ARTICLE_BLOG = "true";
  state.settings = makeSettings();
  loadChrome.mockImplementation(async () => ({ settings: state.settings, chrome: CHROME }) as never);
  loadActiveLocales.mockResolvedValue(["en", "ja"] as never);
  loadHomeNovels.mockResolvedValue([CARD]);
  loadPublicCategories.mockResolvedValue([]);
  loadHreflangSiblings.mockResolvedValue([]);
});

afterEach(() => {
  delete process.env.SITE_URL;
  delete process.env.FEATURE_ARTICLE_BLOG;
  vi.clearAllMocks();
});

describe("首页：不加后缀，15 语一致（title.absolute）", () => {
  it("英文首页 /：后台没填 -> 文案兜底 'PulseNovel - Discover Novels and Read Free Books'，不带 '| PulseNovel'", async () => {
    const resolved = await resolve("/", { routeDir: "" });
    expect(resolved.title.absolute).toBe("PulseNovel - Discover Novels and Read Free Books");
    expectSocialTitlesWithoutSuffix(resolved, "PulseNovel - Discover Novels and Read Free Books");
  });

  it("英文首页 /：后台首页标题有值就用它，同样不加后缀", async () => {
    state.settings = makeSettings({ homeMetaTitle: "ADMIN-HOME-TITLE", homeMetaDescription: "ADMIN-HOME-DESCRIPTION" });
    const resolved = await resolve("/", { routeDir: "" });
    expect(resolved.title.absolute).toBe("ADMIN-HOME-TITLE");
    expect(resolved.description).toBe("ADMIN-HOME-DESCRIPTION");
    expectSocialTitlesWithoutSuffix(resolved, "ADMIN-HOME-TITLE");
  });

  it("/ja 首页：读 ja 文案、不读后台值，并且不带 '| PulseNovel'（隔了一层 [locale] 布局，不写 absolute 就会被套上后缀）", async () => {
    state.settings = makeSettings({ homeMetaTitle: "ADMIN-HOME-TITLE", homeMetaDescription: "ADMIN-HOME-DESCRIPTION" });
    const t = getPublicT("ja");
    const resolved = await resolve("/ja", { routeDir: "[locale]", params: { locale: "ja" } });
    expect(resolved.title.absolute).toBe(t("meta.homeTitleFallback"));
    expect(resolved.title.absolute).not.toContain("| PulseNovel");
    expect(resolved.title.absolute).not.toContain("ADMIN");
    expect(resolved.description).toBe(t("meta.siteDescription"));
    expectSocialTitlesWithoutSuffix(resolved, t("meta.homeTitleFallback"));
  });

  it("14 个非英语语种的首页都是各自文案、都不带后缀", async () => {
    state.settings = makeSettings({ homeMetaTitle: "ADMIN-HOME-TITLE" });
    for (const locale of SITE_LOCALES.filter((l) => l !== "en")) {
      const resolved = await resolve(`/${locale}`, { routeDir: "[locale]", params: { locale } });
      expect(resolved.title.absolute, locale).toBe(getPublicT(locale)("meta.homeTitleFallback"));
      expect(resolved.title.absolute, locale).not.toMatch(/\| PulseNovel$/);
    }
  });
});

describe("小说详情：SEO 标题 + 布局后缀；已带后缀的先去重", () => {
  beforeEach(() => {
    loadArticleAccess.mockResolvedValue(PUBLISHED_ACCESS);
  });

  it("新模板生效后：'Lost Kingdom Novel - Read Free Chapters Online | PulseNovel'，og:title 不带后缀", async () => {
    loadNovelDetail.mockResolvedValue(novelDetail({ seoTitle: "Lost Kingdom Novel - Read Free Chapters Online" }) as never);
    const resolved = await resolve("/novel/lost-kingdom-pabc123", { routeDir: "novel/[slugParam]", params: { slugParam: "lost-kingdom-pabc123" } });
    expect(resolved.title.absolute).toBe("Lost Kingdom Novel - Read Free Chapters Online | PulseNovel");
    expectSocialTitlesWithoutSuffix(resolved, "Lost Kingdom Novel - Read Free Chapters Online");
  });

  it("老文章（回写前，SEO 标题就是书名）：'Lost Kingdom | PulseNovel'", async () => {
    loadNovelDetail.mockResolvedValue(novelDetail({ seoTitle: "Lost Kingdom" }) as never);
    const resolved = await resolve("/novel/lost-kingdom-pabc123", { routeDir: "novel/[slugParam]", params: { slugParam: "lost-kingdom-pabc123" } });
    expect(resolved.title.absolute).toBe("Lost Kingdom | PulseNovel");
  });

  it("没有 SEO 标题时退回书名：'Lost Kingdom | PulseNovel'", async () => {
    loadNovelDetail.mockResolvedValue(novelDetail() as never);
    const resolved = await resolve("/novel/lost-kingdom-pabc123", { routeDir: "novel/[slugParam]", params: { slugParam: "lost-kingdom-pabc123" } });
    expect(resolved.title.absolute).toBe("Lost Kingdom | PulseNovel");
  });

  it("运营填的 SEO 标题自带 '| PulseNovel'：去重后只出现一次后缀（反向自检：去掉 normalizeMetadataTitle 调用会变成双后缀）", async () => {
    loadNovelDetail.mockResolvedValue(novelDetail({ seoTitle: "Lost Kingdom | PulseNovel" }) as never);
    const resolved = await resolve("/novel/lost-kingdom-pabc123", { routeDir: "novel/[slugParam]", params: { slugParam: "lost-kingdom-pabc123" } });
    expect(resolved.title.absolute).toBe("Lost Kingdom | PulseNovel");
    expect(resolved.title.absolute.match(/PulseNovel/g)).toHaveLength(1);
    expectSocialTitlesWithoutSuffix(resolved, "Lost Kingdom");

    loadNovelDetail.mockResolvedValue(novelDetail({ seoTitle: "Lost Kingdom | PulseNovel | PulseNovel" }) as never);
    const twice = await resolve("/novel/lost-kingdom-pabc123", { routeDir: "novel/[slugParam]", params: { slugParam: "lost-kingdom-pabc123" } });
    expect(twice.title.absolute).toBe("Lost Kingdom | PulseNovel");
  });

  it("去重与布局共用同一个站点名：后台站点名是 'CPS Novel'（列 DEFAULT）时后缀与去重都用它", async () => {
    state.settings = makeSettings({ siteName: "CPS Novel" });
    loadNovelDetail.mockResolvedValue(novelDetail({ seoTitle: "Lost Kingdom | CPS Novel" }) as never);
    const resolved = await resolve("/novel/lost-kingdom-pabc123", { routeDir: "novel/[slugParam]", params: { slugParam: "lost-kingdom-pabc123" } });
    expect(resolved.title.absolute).toBe("Lost Kingdom | CPS Novel");
  });

  it("站点名为空（去空白后）时布局与去重都退回 'PulseNovel'", async () => {
    state.settings = makeSettings({ siteName: "   " });
    loadNovelDetail.mockResolvedValue(novelDetail({ seoTitle: "Lost Kingdom | PulseNovel" }) as never);
    const resolved = await resolve("/novel/lost-kingdom-pabc123", { routeDir: "novel/[slugParam]", params: { slugParam: "lost-kingdom-pabc123" } });
    expect(resolved.title.absolute).toBe("Lost Kingdom | PulseNovel");
  });

  it("/ja/novel/...：同样套后缀（隔了 [locale] 布局，模板本来就该套）", async () => {
    loadNovelDetail.mockResolvedValue(novelDetail({ seoTitle: "失われた王国 小説 - 無料の章をオンラインで読む" }) as never);
    const resolved = await resolve("/ja/novel/x", { routeDir: "[locale]/novel/[slugParam]", params: { locale: "ja", slugParam: "x" } });
    expect(resolved.title.absolute).toBe("失われた王国 小説 - 無料の章をオンラインで読む | PulseNovel");
    expectSocialTitlesWithoutSuffix(resolved, "失われた王国 小説 - 無料の章をオンラインで読む");
  });
});

describe("小说详情/章节页 JSON-LD：书名干净，不带营销句式的 SEO 标题（复核 A1，对应 CPS 剧集详情页）", () => {
  /** 取页面 Body 输出里第一个 JSON-LD script 的内容（Body 只返回元素树，不渲染子组件）。 */
  function firstJsonLd(tree: unknown): Array<Record<string, unknown>> {
    const children = (tree as { props: { children: unknown[] } }).props.children;
    const node = children.find(
      (child) => typeof child === "object" && child !== null && "props" in child && typeof (child as { props: { json?: unknown } }).props.json === "string",
    ) as { props: { json: string } } | undefined;
    if (!node) throw new Error("no JSON-LD element in the page body");
    return JSON.parse(node.props.json) as Array<Record<string, unknown>>;
  }

  beforeEach(() => {
    loadArticleAccess.mockResolvedValue(PUBLISHED_ACCESS);
    loadRelatedAndNewReleases.mockResolvedValue({ related: [], newReleases: [] } as never);
  });

  it("新模板生效（seoTitle = 'X Novel - Read Free Chapters Online'）：<title>/og:title 用 SEO 标题，Book.name 与面包屑第 2 级仍是 'Lost Kingdom'", async () => {
    const seoTitle = "Lost Kingdom Novel - Read Free Chapters Online";
    loadNovelDetail.mockResolvedValue(novelDetail({ seoTitle }) as never);
    const merged = await resolve("/novel/lost-kingdom-pabc123", { routeDir: "novel/[slugParam]", params: { slugParam: "lost-kingdom-pabc123" } });
    expect(merged.title.absolute).toBe(`${seoTitle} | PulseNovel`);
    expectSocialTitlesWithoutSuffix(merged, seoTitle);

    const { NovelBody } = await import("@/app/_pages/novel-detail");
    const jsonLd = firstJsonLd(await NovelBody({ locale: "en", params: Promise.resolve({ slugParam: "lost-kingdom-pabc123" }) }));
    const [book, breadcrumb] = jsonLd as [Record<string, unknown>, { itemListElement: Array<{ position: number; name: string }> }];
    expect(book).toMatchObject({ "@type": "Book", name: "Lost Kingdom" });
    expect(breadcrumb.itemListElement.find((item) => item.position === 2)!.name).toBe("Lost Kingdom");
    expect(JSON.stringify(jsonLd)).not.toContain("Read Free Chapters Online");
  });

  it("SEO 标题自带站点后缀的老数据：JSON-LD 同样是干净书名（不带 '| PulseNovel'）", async () => {
    loadNovelDetail.mockResolvedValue(novelDetail({ seoTitle: "Lost Kingdom | PulseNovel" }) as never);
    const { NovelBody } = await import("@/app/_pages/novel-detail");
    const [book] = firstJsonLd(await NovelBody({ locale: "en", params: Promise.resolve({ slugParam: "x" }) }));
    expect(book).toMatchObject({ name: "Lost Kingdom" });
  });

  it("章节页面包屑第 2 级拿到的是干净书名（chapter.novel.title = 文章标题，不是 SEO 标题）", async () => {
    const article = {
      id: "article-1",
      title: "Lost Kingdom",
      slug: "lost-kingdom",
      locale: "en",
      publicPageShortId: "abc123",
      publishedAt: new Date("2026-01-01T00:00:00Z"),
      summary: "s",
      body: "b",
      // 文章自己的 SEO 标题是营销句式——章节页的书名来源不能是它。
      seoMetadata: { metaTitle: "Lost Kingdom Novel - Read Free Chapters Online" },
      novel: { id: "n1", businessId: "biz-1", title: "Lost Kingdom", description: "d", coverUrl: null, locale: "en", totalChapterCount: 12 },
    };
    loadChapterView.mockResolvedValue(
      toChapterView(article, { canonicalChapterNumber: 3, title: "Chapter 3: The Gate", body: "The gate opened." }, [{ canonicalChapterNumber: 3, title: null }]) as never,
    );
    const { ChapterBody } = await import("@/app/_pages/chapter");
    const jsonLd = firstJsonLd(await ChapterBody({ locale: "en", params: Promise.resolve({ slugParam: "lost-kingdom-pabc123", chapterNumber: "3" }) }));
    const breadcrumb = jsonLd.find((entry) => entry["@type"] === "BreadcrumbList") as { itemListElement: Array<{ position: number; name: string }> };
    expect(breadcrumb.itemListElement.find((item) => item.position === 2)!.name).toBe("Lost Kingdom");
    expect(JSON.stringify(jsonLd)).not.toContain("Read Free Chapters Online");
  });
});

describe("章节页：'章节名 · 书名 | 站点名'，没有章节名时按语种本地化", () => {
  const article = {
    id: "article-1",
    title: "Lost Kingdom",
    slug: "lost-kingdom",
    locale: "en",
    publicPageShortId: "abc123",
    publishedAt: new Date("2026-01-01T00:00:00Z"),
    summary: "s",
    body: "b",
    seoMetadata: {},
    novel: { id: "n1", businessId: "biz-1", title: "Lost Kingdom", description: "d", coverUrl: null, locale: "en", totalChapterCount: 12 },
  };
  const previews = [{ canonicalChapterNumber: 3, title: null }];

  beforeEach(() => {
    loadArticleAccess.mockResolvedValue(PUBLISHED_ACCESS);
  });

  it("'Chapter 3: The Gate · Lost Kingdom | PulseNovel'，og:title 不带后缀", async () => {
    loadChapterView.mockResolvedValue(
      toChapterView(article, { canonicalChapterNumber: 3, title: "Chapter 3: The Gate", body: "The gate opened.\n\nSecond." }, previews) as never,
    );
    const resolved = await resolve("/novel/lost-kingdom-pabc123/chapter/3", {
      routeDir: "novel/[slugParam]/chapter/[chapterNumber]",
      params: { slugParam: "lost-kingdom-pabc123", chapterNumber: "3" },
    });
    expect(resolved.title.absolute).toBe("Chapter 3: The Gate · Lost Kingdom | PulseNovel");
    expectSocialTitlesWithoutSuffix(resolved, "Chapter 3: The Gate · Lost Kingdom");
  });

  it("没有章节名（en）：'Chapter 3 · Lost Kingdom | PulseNovel'", async () => {
    loadChapterView.mockResolvedValue(toChapterView(article, { canonicalChapterNumber: 3, title: null, body: "The gate opened." }, previews) as never);
    const resolved = await resolve("/novel/lost-kingdom-pabc123/chapter/3", {
      routeDir: "novel/[slugParam]/chapter/[chapterNumber]",
      params: { slugParam: "lost-kingdom-pabc123", chapterNumber: "3" },
    });
    expect(resolved.title.absolute).toBe("Chapter 3 · Lost Kingdom | PulseNovel");
  });

  it("没有章节名（ja）：走 ja 文案 '第3章 · … | PulseNovel'，不再是英文 Chapter 3", async () => {
    const jaArticle = { ...article, locale: "ja", novel: { ...article.novel, locale: "ja" } };
    loadChapterView.mockResolvedValue(toChapterView(jaArticle, { canonicalChapterNumber: 3, title: null, body: "門が開いた。" }, previews) as never);
    const resolved = await resolve("/ja/novel/x/chapter/3", {
      routeDir: "[locale]/novel/[slugParam]/chapter/[chapterNumber]",
      params: { locale: "ja", slugParam: "x", chapterNumber: "3" },
    });
    expect(resolved.title.absolute).toBe("第3章 · Lost Kingdom | PulseNovel");
    expect(resolved.title.absolute).not.toContain("Chapter");
  });
});

describe("分类页：分类名 | 站点名；第 2 页起加翻页后缀", () => {
  function categoryPage(page: number) {
    return {
      novels: [CARD],
      page,
      totalPages: 3,
      totalCount: 45,
      category: { id: "cat-1", slug: "romance", name: "Romance", description: null, sortOrder: 0, updatedAt: new Date("2026-09-10T00:00:00Z") },
    };
  }

  it("第 1 页 'Romance | PulseNovel'；第 2 页 'Romance - Page 2 | PulseNovel'；og:title 不带品牌", async () => {
    getPublicCategoryPage.mockResolvedValue(categoryPage(1));
    const first = await resolve("/category/romance", { routeDir: "category/[slug]", params: { slug: "romance" } });
    expect(first.title.absolute).toBe("Romance | PulseNovel");
    expectSocialTitlesWithoutSuffix(first, "Romance");

    getPublicCategoryPage.mockResolvedValue(categoryPage(2));
    const second = await resolve("/category/romance?page=2", { routeDir: "category/[slug]", params: { slug: "romance" }, searchParams: { page: "2" } });
    expect(second.title.absolute).toBe("Romance - Page 2 | PulseNovel");
    expectSocialTitlesWithoutSuffix(second, "Romance - Page 2");
    expect(second.description).toBe("Discover Romance novels on PulseNovel.");
  });

  it("/ja/category/...：翻页后缀是 ja 的 ' - 2ページ'", async () => {
    getPublicCategoryPage.mockResolvedValue(categoryPage(2));
    const second = await resolve("/ja/category/romance?page=2", {
      routeDir: "[locale]/category/[slug]",
      params: { locale: "ja", slug: "romance" },
      searchParams: { page: "2" },
    });
    expect(second.title.absolute).toBe("Romance - 2ページ | PulseNovel");
  });
});

describe("浏览页 / 博客列表 / 博客详情", () => {
  it("浏览页：'All works | PulseNovel'，第 2 页 'All works - Page 2 | PulseNovel'", async () => {
    loadBrowseNovels.mockResolvedValue(MANY_CARDS);
    const first = await resolve("/browse", { routeDir: "browse" });
    expect(first.title.absolute).toBe("All works | PulseNovel");
    expectSocialTitlesWithoutSuffix(first, "All works");
    const second = await resolve("/browse?page=2", { routeDir: "browse", searchParams: { page: "2" } });
    expect(second.title.absolute).toBe("All works - Page 2 | PulseNovel");
    expectSocialTitlesWithoutSuffix(second, "All works - Page 2");
  });

  it("博客列表：'Blog | PulseNovel'，第 2 页 'Blog - Page 2 | PulseNovel'；ja 是译文加 ja 后缀", async () => {
    loadBlogList.mockResolvedValue(MANY_POSTS);
    const first = await resolve("/blog", { routeDir: "blog" });
    expect(first.title.absolute).toBe("Blog | PulseNovel");
    const second = await resolve("/blog?page=2", { routeDir: "blog", searchParams: { page: "2" } });
    expect(second.title.absolute).toBe("Blog - Page 2 | PulseNovel");
    expectSocialTitlesWithoutSuffix(second, "Blog - Page 2");
    const ja = await resolve("/ja/blog?page=2", { routeDir: "[locale]/blog", params: { locale: "ja" }, searchParams: { page: "2" } });
    expect(ja.title.absolute).toBe("ブログ - 2ページ | PulseNovel");
  });

  function post(overrides: Record<string, unknown> = {}) {
    return {
      id: "blog-1",
      title: "A blog post",
      slug: "a-blog-post",
      summary: "A short summary of the post.",
      publishedAt: new Date("2026-08-05T12:30:00.000Z"),
      href: "/blog/a-blog-post",
      coverUrl: "/covers/blog.jpg",
      body: "<p>Body</p>",
      updatedAt: new Date("2026-08-06T00:00:00.000Z"),
      ...overrides,
    };
  }

  it("博客详情：'SEO 标题 | PulseNovel'；SEO 标题自带 '| PulseNovel' 时只出现一次（反向自检：去掉 normalizeMetadataTitle 会变双后缀）", async () => {
    loadBlogAccess.mockResolvedValue({ kind: "published", articleId: "blog-1", title: "A blog post" } as never);
    loadBlogDetail.mockResolvedValue(post({ metaTitle: "How to read novels online" }) as never);
    const plain = await resolve("/blog/a-blog-post", { routeDir: "blog/[slug]", params: { slug: "a-blog-post" } });
    expect(plain.title.absolute).toBe("How to read novels online | PulseNovel");
    expectSocialTitlesWithoutSuffix(plain, "How to read novels online");

    loadBlogDetail.mockResolvedValue(post({ metaTitle: "How to read novels online | PulseNovel" }) as never);
    const dup = await resolve("/blog/a-blog-post", { routeDir: "blog/[slug]", params: { slug: "a-blog-post" } });
    expect(dup.title.absolute).toBe("How to read novels online | PulseNovel");
    expect(dup.title.absolute.match(/PulseNovel/g)).toHaveLength(1);

    loadBlogDetail.mockResolvedValue(post({ metaTitle: undefined }) as never);
    const fallback = await resolve("/blog/a-blog-post", { routeDir: "blog/[slug]", params: { slug: "a-blog-post" } });
    expect(fallback.title.absolute).toBe("A blog post | PulseNovel");
  });
});

describe("404 / 下架 / 不可用（页面元数据仍为 noindex）", () => {
  it("小说页不存在：'Not found | PulseNovel'，noindex", async () => {
    loadArticleAccess.mockResolvedValue({ kind: "not_found" } as never);
    const resolved = await resolve("/novel/nope", { routeDir: "novel/[slugParam]", params: { slugParam: "nope" } });
    expect(resolved.title.absolute).toBe("Not found | PulseNovel");
    expect(resolved.robots).toEqual({ basic: "noindex, nofollow", googleBot: null });
  });

  it("章节不存在：'Chapter not found | PulseNovel'，noindex", async () => {
    loadArticleAccess.mockResolvedValue({ kind: "not_found" } as never);
    const resolved = await resolve("/novel/nope/chapter/1", {
      routeDir: "novel/[slugParam]/chapter/[chapterNumber]",
      params: { slugParam: "nope", chapterNumber: "1" },
    });
    expect(resolved.title.absolute).toBe("Chapter not found | PulseNovel");
  });

  it("下架 / 不可用：元数据标题是作品标题（现状，未改）+ 布局后缀，noindex", async () => {
    loadArticleAccess.mockResolvedValue({ kind: "unavailable", articleId: "a", novelId: "n", title: "Lost Kingdom" } as never);
    const unavailable = await resolve("/novel/x", { routeDir: "novel/[slugParam]", params: { slugParam: "x" } });
    expect(unavailable.title.absolute).toBe("Lost Kingdom | PulseNovel");
    expect(unavailable.robots).toEqual({ basic: "noindex, nofollow", googleBot: null });
    loadArticleAccess.mockResolvedValue({ kind: "takedown", articleId: "a", novelId: "n", title: "Lost Kingdom" } as never);
    const takedown = await resolve("/novel/x", { routeDir: "novel/[slugParam]", params: { slugParam: "x" } });
    expect(takedown.title.absolute).toBe("Lost Kingdom | PulseNovel");
  });

  it("博客不存在：'Not found | PulseNovel'", async () => {
    loadBlogAccess.mockResolvedValue({ kind: "not_found" } as never);
    const resolved = await resolve("/blog/nope", { routeDir: "blog/[slug]", params: { slug: "nope" } });
    expect(resolved.title.absolute).toBe("Not found | PulseNovel");
  });

  it("Next 的 not-found 约定（真 404 响应用的是 not-found 文件自己的元数据，页面 generateMetadata 的标题不会出现在 404 响应里）：'Not found | PulseNovel'，noindex", async () => {
    for (const [name, mod, routeDir] of [
      ["根 404（未匹配路由、浏览/分类/博客等的 notFound()）", rootNotFound, ""],
      ["小说段 404（不带语种前缀）", novelNotFound, "novel/[slugParam]"],
    ] as const) {
      const resolved = await resolveNotFoundMetadata({ routeDir, notFoundModule: mod });
      expect(resolved.title.absolute, name).toBe("Not found | PulseNovel");
      expect(resolved.robots, name).toEqual({ basic: "noindex, nofollow", googleBot: null });
      // 不带 description 键——不覆盖根布局继承的描述。
      expect(resolved.description, name).toBe(getPublicT("en")("meta.siteDescription"));
    }
  });

  it("[locale] 段的 404 壳按请求语种：/ja/... 的 404 标题是 ja 的 'Not found'，后缀仍是站点名；没有语种头时回退英文", async () => {
    headerState.locale = "ja";
    const ja = await resolveNotFoundMetadata({ routeDir: "[locale]/novel/[slugParam]", notFoundModule: localeNovelNotFound, params: { locale: "ja", slugParam: "x" } });
    expect(ja.title.absolute).toBe(`${getPublicT("ja")("meta.notFound")} | PulseNovel`);
    expect(ja.title.absolute).toBe("見つかりません | PulseNovel");
    expect(ja.robots).toEqual({ basic: "noindex, nofollow", googleBot: null });
    headerState.locale = null;
    const fallback = await resolveNotFoundMetadata({ routeDir: "[locale]/novel/[slugParam]", notFoundModule: localeNovelNotFound, params: { locale: "ja", slugParam: "x" } });
    expect(fallback.title.absolute).toBe("Not found | PulseNovel");
  });
});

describe("后台 / 登录 / 开发预览：保持原样，不套品牌后缀", () => {
  it("后台页与登录页仍是 '海外阅读后台'（后台布局写成 title.absolute，不被根布局模板套一次）", async () => {
    const admin = await resolve("/tasks", { routeDir: "(admin)/tasks" });
    expect(admin.title.absolute).toBe("海外阅读后台");
    const login = await resolve("/login", { routeDir: "(admin-auth)/login" });
    expect(login.title.absolute).toBe("海外阅读后台");
    const twoFactor = await resolve("/two-factor/challenge", { routeDir: "(admin-auth)/two-factor/challenge" });
    expect(twoFactor.title.absolute).toBe("海外阅读后台");
  });

  it("dev-preview 章节页标题原样（章名 · 书名，无后缀）；越界章号 'Chapter not found' 同样无后缀", async () => {
    const ok = await resolve("/dev-preview/chapter/1", { routeDir: "dev-preview/chapter/[chapterNumber]", params: { chapterNumber: "1" } });
    expect(ok.title.absolute).toContain("Chapter 1");
    expect(ok.title.absolute).not.toContain("| PulseNovel");
    const missing = await resolve("/dev-preview/chapter/999", { routeDir: "dev-preview/chapter/[chapterNumber]", params: { chapterNumber: "999" } });
    expect(missing.title.absolute).toBe("Chapter not found");
  });
});

describe("助手自身的可信度（防止'合并'被悄悄换成假的）", () => {
  it("按真实目录树收集，没有 layout 的中间段也占一项 null：英文首页 2 项、/browse 3 项、/ja 首页 3 项、章节页 6 项", async () => {
    const { metadataModulePaths } = await import("./_helpers/next-metadata-merge");
    expect(metadataModulePaths("")).toEqual(["/src/app/layout.tsx", "/src/app/page.tsx"]);
    expect(metadataModulePaths("browse")).toEqual(["/src/app/layout.tsx", null, "/src/app/browse/page.tsx"]);
    expect(metadataModulePaths("[locale]")).toEqual(["/src/app/layout.tsx", "/src/app/[locale]/layout.tsx", "/src/app/[locale]/page.tsx"]);
    expect(metadataModulePaths("novel/[slugParam]/chapter/[chapterNumber]")).toEqual([
      "/src/app/layout.tsx",
      null,
      null,
      "/src/app/novel/[slugParam]/chapter/layout.tsx",
      null,
      "/src/app/novel/[slugParam]/chapter/[chapterNumber]/page.tsx",
    ]);
  });

  it("合并确实在按 Next 的规则跑：同一个页面写成普通字符串标题，英文首页位置（同层）不被套、/browse 位置（隔层）被套", async () => {
    // 首页（与根布局同层）不套模板，浏览页（隔一个空段）套模板——两个都是 Next 合并规则的直接后果，
    // 不是页面函数自己拼的。上面各 describe 的期望值就是从这条规则来的。
    loadBrowseNovels.mockResolvedValue([CARD]);
    const browse = await resolve("/browse", { routeDir: "browse" });
    expect(browse.title.template).toBeNull();
    expect(browse.title.absolute.endsWith(" | PulseNovel")).toBe(true);
    const home = await resolve("/", { routeDir: "" });
    expect(home.title.absolute.endsWith(" | PulseNovel")).toBe(false);
  });
});

afterEach(() => {
  if (process.env.TKD_PRINT_TITLES === "1" && titleLog.length > 0) {
    console.log(titleLog.splice(0).map((row) => `${row.route}\t${row.title}\t[og:title=${row.ogTitle}]`).join("\n"));
  }
});
