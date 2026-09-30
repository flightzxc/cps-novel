import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPublicT } from "@/lib/locale/messages";

/**
 * TKD 对齐 CPS（Owner 2026-09-30）第二、三块：
 *
 *  - 后台"首页标题/首页描述/站点描述"只有一个值（不分语种），只有默认语种（英文）读它，
 *    其余 14 语走各自的文案——CPS `(site)/page.tsx` 的 `useSettingsMetadata = locale === "en"`；
 *  - 分类页/浏览页/博客列表从第 2 页起标题加本地化的翻页后缀（`meta.pageSuffix`），
 *    第 1 页不加。
 *
 * 只验元数据构建函数的返回值（title/description/og）；后缀有没有被布局模板正确套上，
 * 只有 Next 合并元数据时才看得出来，见 `real-metadata-merge.test.ts`。
 *
 * 反向自检：把 `home.tsx`/`browse.tsx`/`blog-list.tsx` 里的 `useSettingsMetadata`
 * 判断去掉（恒读后台值），"ja 不读后台值"几条用例会红。
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
  loadHomeNovels: vi.fn(),
  loadHomeCarousel: vi.fn(),
  loadPublicCategories: vi.fn(),
  loadBrowseNovels: vi.fn(),
  loadBlogList: vi.fn(),
}));

vi.mock("@/lib/site/category-queries", () => ({
  getPublicCategoryPage: vi.fn(),
}));

const publicLoad = await import("@/app/_lib/public-load");
const loadChrome = vi.mocked(publicLoad.loadChrome);
const loadHomeNovels = vi.mocked(publicLoad.loadHomeNovels);
const loadPublicCategories = vi.mocked(publicLoad.loadPublicCategories);
const loadBrowseNovels = vi.mocked(publicLoad.loadBrowseNovels);
const loadBlogList = vi.mocked(publicLoad.loadBlogList);
const categoryQueries = await import("@/lib/site/category-queries");
const getPublicCategoryPage = vi.mocked(categoryQueries.getPublicCategoryPage);

const { buildHomeMetadata, HomeBody } = await import("@/app/_pages/home");
const { buildBrowseMetadata } = await import("@/app/_pages/browse");
const { buildBlogListMetadata } = await import("@/app/_pages/blog-list");

const ORIGIN = "https://example.test";
const CHROME = { brandHref: "/", navItems: [], footerNote: "© test" };

/** 运营在后台填了三个单值——这正是"15 语首页都显示同一句英文"的触发条件。 */
const SETTINGS_FILLED = {
  siteName: "PulseNovel",
  siteDescription: "ADMIN-SITE-DESCRIPTION",
  homeMetaTitle: "ADMIN-HOME-TITLE",
  homeMetaDescription: "ADMIN-HOME-DESCRIPTION",
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
};
const SETTINGS_EMPTY = {
  ...SETTINGS_FILLED,
  siteDescription: "",
  homeMetaTitle: "",
  homeMetaDescription: "",
};

const CARD = {
  id: "biz-1",
  title: "The Lantern Keeper's Daughter",
  coverUrl: "/covers/lantern.jpg",
  tags: [],
  href: "/novel/lantern-keepers-daughter-pabc123",
};

function titleOf(metadata: { title?: unknown }): string {
  const title = metadata.title;
  if (typeof title === "string") return title;
  if (typeof title === "object" && title !== null && "absolute" in title) return String((title as { absolute: string }).absolute);
  throw new Error(`unexpected title shape: ${JSON.stringify(title)}`);
}

beforeEach(() => {
  process.env.SITE_URL = ORIGIN;
  process.env.FEATURE_ARTICLE_BLOG = "true";
  mockActiveLocales();
  loadPublicCategories.mockResolvedValue([]);
  loadHomeNovels.mockResolvedValue([CARD]);
});

afterEach(() => {
  delete process.env.SITE_URL;
  delete process.env.FEATURE_ARTICLE_BLOG;
  vi.clearAllMocks();
});

function mockActiveLocales() {
  vi.mocked(publicLoad.loadActiveLocales).mockResolvedValue(["en", "ja"] as never);
}

describe("首页：只有默认语种读后台单值", () => {
  it("en：后台首页标题/描述有值就用它们（能不发版改）", async () => {
    loadChrome.mockResolvedValue({ settings: SETTINGS_FILLED, chrome: CHROME });
    const metadata = await buildHomeMetadata("en");
    expect(titleOf(metadata)).toBe("ADMIN-HOME-TITLE");
    expect(metadata.description).toBe("ADMIN-HOME-DESCRIPTION");
    expect(metadata.openGraph?.title).toBe("ADMIN-HOME-TITLE");
  });

  it("en：首页描述为空时依次读站点描述", async () => {
    loadChrome.mockResolvedValue({ settings: { ...SETTINGS_FILLED, homeMetaDescription: "" }, chrome: CHROME });
    const metadata = await buildHomeMetadata("en");
    expect(metadata.description).toBe("ADMIN-SITE-DESCRIPTION");
  });

  it("en：后台三个值都为空时读文案，标题是品牌+兜底句（不再退回站点名）", async () => {
    loadChrome.mockResolvedValue({ settings: SETTINGS_EMPTY, chrome: CHROME });
    const metadata = await buildHomeMetadata("en");
    const t = getPublicT("en");
    expect(titleOf(metadata)).toBe(t("meta.homeTitleFallback"));
    expect(titleOf(metadata)).toBe("PulseNovel - Discover Novels and Read Free Books");
    expect(metadata.description).toBe(t("meta.siteDescription"));
  });

  it("ja：不读后台值——即使运营填了，标题/描述/og 都走 ja 文案", async () => {
    loadChrome.mockResolvedValue({ settings: SETTINGS_FILLED, chrome: CHROME });
    const metadata = await buildHomeMetadata("ja");
    const t = getPublicT("ja");
    expect(titleOf(metadata)).toBe(t("meta.homeTitleFallback"));
    expect(titleOf(metadata)).not.toContain("ADMIN");
    expect(metadata.description).toBe(t("meta.siteDescription"));
    expect(metadata.description).not.toContain("ADMIN");
    expect(metadata.openGraph?.title).toBe(t("meta.homeTitleFallback"));
    expect(metadata.openGraph?.description).toBe(t("meta.siteDescription"));
  });

  it("14 个非英语语种都不读后台值", async () => {
    loadChrome.mockResolvedValue({ settings: SETTINGS_FILLED, chrome: CHROME });
    for (const locale of ["es", "pt-BR", "id", "vi", "th", "ja", "ko", "zh-Hant", "ar", "fr", "de", "pl", "cs", "ru"] as const) {
      const metadata = await buildHomeMetadata(locale);
      const t = getPublicT(locale);
      expect(titleOf(metadata), locale).toBe(t("meta.homeTitleFallback"));
      expect(metadata.description, locale).toBe(t("meta.siteDescription"));
    }
  });
});

describe("首页 WebSite JSON-LD 与 meta 同一套取值（复核 A3）", () => {
  /** HomeBody 只返回元素树；取第一个 JSON-LD script 的内容。 */
  async function websiteJsonLd(locale: "en" | "ja") {
    const tree = await HomeBody({ locale });
    const children = (tree as unknown as { props: { children: unknown[] } }).props.children;
    const node = children.find((child) => typeof child === "object" && child !== null && typeof (child as { props?: { json?: unknown } }).props?.json === "string") as { props: { json: string } };
    return JSON.parse(node.props.json) as { "@type": string; name: string; description: string };
  }

  it("/ja：JSON-LD description 是 ja 文案，与 <meta description> 一致，不读后台值（此前是英文后台值）", async () => {
    loadChrome.mockResolvedValue({ settings: SETTINGS_FILLED, chrome: CHROME });
    const meta = await buildHomeMetadata("ja");
    const ld = await websiteJsonLd("ja");
    const t = getPublicT("ja");
    expect(ld["@type"]).toBe("WebSite");
    expect(ld.description).toBe(t("meta.siteDescription"));
    expect(ld.description).toBe(meta.description);
    expect(ld.description).not.toContain("ADMIN");
  });

  it("en：JSON-LD description 与 meta 一样读后台值；后台为空时同样退回文案", async () => {
    loadChrome.mockResolvedValue({ settings: SETTINGS_FILLED, chrome: CHROME });
    expect((await websiteJsonLd("en")).description).toBe("ADMIN-HOME-DESCRIPTION");
    expect((await websiteJsonLd("en")).description).toBe((await buildHomeMetadata("en")).description);
    loadChrome.mockResolvedValue({ settings: SETTINGS_EMPTY, chrome: CHROME });
    expect((await websiteJsonLd("en")).description).toBe(getPublicT("en")("meta.siteDescription"));
  });
});

describe("浏览页/博客列表：描述只有默认语种读后台站点描述", () => {
  it("browse：en 读站点描述，ja 走文案", async () => {
    loadChrome.mockResolvedValue({ settings: SETTINGS_FILLED, chrome: CHROME });
    loadBrowseNovels.mockResolvedValue([CARD]);
    const en = await buildBrowseMetadata("en", Promise.resolve({}));
    expect(en.description).toBe("ADMIN-SITE-DESCRIPTION");
    const ja = await buildBrowseMetadata("ja", Promise.resolve({}));
    expect(ja.description).toBe(getPublicT("ja")("collection.browseSeoDescription"));
    expect(ja.description).not.toContain("ADMIN");
  });

  it("browse ?category=：分类自身的描述优先；没有时同样 en 读站点描述、ja 走文案", async () => {
    loadChrome.mockResolvedValue({ settings: SETTINGS_FILLED, chrome: CHROME });
    getPublicCategoryPage.mockResolvedValue({
      novels: [CARD],
      page: 1,
      totalPages: 1,
      totalCount: 1,
      category: { id: "c1", slug: "fantasy", name: "Fantasy", description: null, sortOrder: 0, updatedAt: new Date("2026-09-10T00:00:00Z") },
    });
    const en = await buildBrowseMetadata("en", Promise.resolve({ category: "fantasy" }));
    expect(en.description).toBe("ADMIN-SITE-DESCRIPTION");
    const ja = await buildBrowseMetadata("ja", Promise.resolve({ category: "fantasy" }));
    expect(ja.description).toBe(getPublicT("ja")("collection.browseSeoDescription"));

    getPublicCategoryPage.mockResolvedValue({
      novels: [CARD],
      page: 1,
      totalPages: 1,
      totalCount: 1,
      category: { id: "c1", slug: "fantasy", name: "Fantasy", description: "OWN-CATEGORY-DESCRIPTION", sortOrder: 0, updatedAt: new Date("2026-09-10T00:00:00Z") },
    });
    const own = await buildBrowseMetadata("ja", Promise.resolve({ category: "fantasy" }));
    expect(own.description).toBe("OWN-CATEGORY-DESCRIPTION");
  });

  it("blog list：en 读站点描述，ja 走文案", async () => {
    loadChrome.mockResolvedValue({ settings: SETTINGS_FILLED, chrome: CHROME });
    loadBlogList.mockResolvedValue([
      { id: "b1", title: "Post", slug: "post", summary: "s", publishedAt: new Date("2026-08-05T12:30:00.000Z"), href: "/blog/post" },
    ]);
    const en = await buildBlogListMetadata("en", Promise.resolve({}));
    expect(en.description).toBe("ADMIN-SITE-DESCRIPTION");
    const ja = await buildBlogListMetadata("ja", Promise.resolve({}));
    expect(ja.description).toBe(getPublicT("ja")("blog.listDescription"));
    expect(ja.description).not.toContain("ADMIN");
  });
});

describe("翻页后缀：浏览页/博客列表第 2 页起加，第 1 页不加，走文案", () => {
  const manyCards = Array.from({ length: 45 }, (_, i) => ({ ...CARD, id: `biz-${i}`, title: `Novel ${i}`, href: `/novel/n-${i}` }));
  const manyPosts = Array.from({ length: 45 }, (_, i) => ({
    id: `b${i}`,
    title: `Post ${i}`,
    slug: `post-${i}`,
    summary: "s",
    publishedAt: new Date("2026-08-05T12:30:00.000Z"),
    href: `/blog/post-${i}`,
  }));

  it("browse：第 1 页无后缀，第 2 页 ' - Page 2'（en）/ ' - 2ページ'（ja），og:title 同带、都不带品牌名", async () => {
    loadChrome.mockResolvedValue({ settings: SETTINGS_EMPTY, chrome: CHROME });
    loadBrowseNovels.mockResolvedValue(manyCards);
    const page1 = await buildBrowseMetadata("en", Promise.resolve({}));
    expect(titleOf(page1)).toBe("All works");
    const page2 = await buildBrowseMetadata("en", Promise.resolve({ page: "2" }));
    expect(titleOf(page2)).toBe("All works - Page 2");
    expect(page2.openGraph?.title).toBe("All works - Page 2");
    expect(titleOf(page2)).not.toContain("PulseNovel");

    const ja2 = await buildBrowseMetadata("ja", Promise.resolve({ page: "2" }));
    const tJa = getPublicT("ja");
    expect(titleOf(ja2)).toBe(`${tJa("collection.allWorksTitle")}${tJa("meta.pageSuffix", { page: 2 })}`);
    expect(titleOf(ja2)).toContain("2");
  });

  it("blog list：第 1 页 'Blog'，第 2 页 'Blog - Page 2'；ja 用译文与本地化后缀", async () => {
    loadChrome.mockResolvedValue({ settings: SETTINGS_EMPTY, chrome: CHROME });
    loadBlogList.mockResolvedValue(manyPosts);
    const page1 = await buildBlogListMetadata("en", Promise.resolve({}));
    expect(titleOf(page1)).toBe("Blog");
    const page2 = await buildBlogListMetadata("en", Promise.resolve({ page: "2" }));
    expect(titleOf(page2)).toBe("Blog - Page 2");
    expect(page2.openGraph?.title).toBe("Blog - Page 2");

    const ja2 = await buildBlogListMetadata("ja", Promise.resolve({ page: "2" }));
    const tJa = getPublicT("ja");
    expect(titleOf(ja2)).toBe(`${tJa("blog.listTitle")}${tJa("meta.pageSuffix", { page: 2 })}`);
    expect(tJa("blog.listTitle")).not.toBe("Blog");
  });
});
