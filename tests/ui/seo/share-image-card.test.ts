import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateSeoMeta } from "@/lib/seo/seo-meta-generator";
import { resolveShareImage } from "@/lib/seo/seo-templates/_shared";

/**
 * 分享图卡片口径（B-37 阶段 0，2026-10-07）。
 *
 * 问题：所有 SEO 模板都把分享图声明成 `1200×630` + `twitter:card = summary_large_image`，
 * 但书封实际是 250×350，宽度低于 X 大图卡片的最小宽度 300。
 *
 * 规则（唯一判定在 `_shared.ts#resolveShareImage`，各模板统一调用）：
 *   - 最终分享图是站点默认图（`public/brand/og-default.png`，1200×630）：
 *     `summary_large_image` + `width: 1200, height: 630`；
 *   - 最终分享图是书封：`summary`，og:image **不声明** width/height。
 * 适用：novel、chapter，以及会拿「列表第一本书封」兜底的 home、collection（browse）、category。
 * blog 不动：博客封面是运营上传的，尺寸未知，不在本单范围。
 */

const ORIGIN = "https://example.test";
const DEFAULT_IMAGE = `${ORIGIN}/brand/og-default.png`;
const COVER_PATH = "/covers/lantern.jpg";
const COVER_ABS = `${ORIGIN}${COVER_PATH}`;

type OgImage = { url: string; alt: string; width?: number; height?: number };

function expectLarge(
  seo: { openGraph: { images: OgImage[] }; twitter: { card: string; images: string[] } },
  url: string,
) {
  expect(seo.twitter.card).toBe("summary_large_image");
  expect(seo.twitter.images).toEqual([url]);
  expect(seo.openGraph.images).toHaveLength(1);
  expect(seo.openGraph.images[0]).toMatchObject({ url, width: 1200, height: 630 });
}

function expectSmall(
  seo: { openGraph: { images: OgImage[] }; twitter: { card: string; images: string[] } },
  url: string,
) {
  expect(seo.twitter.card).toBe("summary");
  expect(seo.twitter.images).toEqual([url]);
  expect(seo.openGraph.images).toHaveLength(1);
  const image = seo.openGraph.images[0];
  expect(image.url).toBe(url);
  // 不声明 width/height：键根本不存在，而不是值为 undefined/0
  expect(image).not.toHaveProperty("width");
  expect(image).not.toHaveProperty("height");
}

beforeEach(() => {
  process.env.SITE_URL = ORIGIN;
});

afterEach(() => {
  delete process.env.SITE_URL;
});

describe("resolveShareImage（共享判定）", () => {
  it("有书封 → 书封 + summary，og:image 不声明 width/height", () => {
    const share = resolveShareImage({ coverUrl: COVER_PATH, defaultOgImage: DEFAULT_IMAGE, alt: "Lantern" });

    expect(share.kind).toBe("cover");
    expect(share.url).toBe(COVER_ABS);
    expect(share.twitterCard).toBe("summary");
    expect(share.openGraphImages).toEqual([{ url: COVER_ABS, alt: "Lantern" }]);
  });

  it("没有书封 → 站点默认图 + summary_large_image + 1200×630", () => {
    const share = resolveShareImage({ coverUrl: null, defaultOgImage: DEFAULT_IMAGE, alt: "Site" });

    expect(share.kind).toBe("site-default");
    expect(share.url).toBe(DEFAULT_IMAGE);
    expect(share.twitterCard).toBe("summary_large_image");
    expect(share.openGraphImages).toEqual([{ url: DEFAULT_IMAGE, width: 1200, height: 630, alt: "Site" }]);
  });

  it("空字符串的书封按没有处理，落到站点默认图", () => {
    const share = resolveShareImage({ coverUrl: "", defaultOgImage: DEFAULT_IMAGE, alt: "x" });
    expect(share.kind).toBe("site-default");
  });

  it("prefer=default：两者都有时站点默认图胜出（首页/列表/分类的既有取值顺序）", () => {
    const share = resolveShareImage({
      coverUrl: COVER_PATH,
      defaultOgImage: DEFAULT_IMAGE,
      prefer: "default",
      alt: "x",
    });
    expect(share.kind).toBe("site-default");
    expect(share.url).toBe(DEFAULT_IMAGE);
    expect(share.twitterCard).toBe("summary_large_image");
  });

  it("prefer=default：站点默认图缺失时才拿书封兜底，且按书封口径给小图卡片", () => {
    const share = resolveShareImage({ coverUrl: COVER_PATH, defaultOgImage: "", prefer: "default", alt: "x" });
    expect(share.kind).toBe("cover");
    expect(share.twitterCard).toBe("summary");
    expect(share.openGraphImages[0]).not.toHaveProperty("width");
  });

  it("两者都缺失 fail closed，与 resolveOgImage 同一个报错", () => {
    expect(() => resolveShareImage({ alt: "x" })).toThrow("OG image is required");
    expect(() => resolveShareImage({ coverUrl: "", defaultOgImage: null, prefer: "default", alt: "x" })).toThrow(
      "OG image is required",
    );
  });
});

describe("各模板统一走共享判定", () => {
  const novelData = (extra: { coverUrl?: string | null; defaultOgImage?: string | null }) => ({
    title: "The Lantern Keeper's Daughter",
    description: "A coastal town keeps one lantern burning.",
    canonicalPath: "/novel/lantern-pabc123",
    siteName: "PulseNovel",
    hreflangAlternates: { "x-default": `${ORIGIN}/novel/lantern-pabc123` },
    ...extra,
  });

  it("novel：有书封 → summary 且无 width/height；无书封 → 默认图大卡片", () => {
    expectSmall(
      generateSeoMeta({ entity: "novel", data: novelData({ coverUrl: COVER_PATH, defaultOgImage: DEFAULT_IMAGE }) }),
      COVER_ABS,
    );
    expectLarge(
      generateSeoMeta({ entity: "novel", data: novelData({ coverUrl: null, defaultOgImage: DEFAULT_IMAGE }) }),
      DEFAULT_IMAGE,
    );
  });

  it("novel：JSON-LD 的 Book.image 仍是同一张图（卡片口径变化不影响结构化数据）", () => {
    const seo = generateSeoMeta({
      entity: "novel",
      data: novelData({ coverUrl: COVER_PATH, defaultOgImage: DEFAULT_IMAGE }),
    });
    const [book] = JSON.parse(seo.other!["application/ld+json"]) as Array<{ image: string }>;
    expect(book.image).toBe(COVER_ABS);
  });

  const chapterData = (extra: { coverUrl?: string | null; defaultOgImage?: string | null }) => ({
    title: "The Harbour · The Lantern Keeper's Daughter",
    description: "The tide came in early that year.",
    canonicalPath: "/novel/lantern-pabc123/chapter/1",
    novelTitle: "The Lantern Keeper's Daughter",
    novelCanonicalPath: "/novel/lantern-pabc123",
    siteName: "PulseNovel",
    hreflangAlternates: { "x-default": `${ORIGIN}/novel/lantern-pabc123/chapter/1` },
    ...extra,
  });

  it("chapter：有书封 → summary 且无 width/height；无书封 → 默认图大卡片", () => {
    expectSmall(
      generateSeoMeta({ entity: "chapter", data: chapterData({ coverUrl: COVER_PATH, defaultOgImage: DEFAULT_IMAGE }) }),
      COVER_ABS,
    );
    expectLarge(
      generateSeoMeta({ entity: "chapter", data: chapterData({ defaultOgImage: DEFAULT_IMAGE }) }),
      DEFAULT_IMAGE,
    );
  });

  it("home：有站点默认图 → 默认图大卡片（即便同时有第一本书封）；默认图缺失才用书封兜底 → summary", () => {
    const base = { siteName: "PulseNovel", description: "Read novels." };
    expectLarge(
      generateSeoMeta({
        entity: "home",
        data: { ...base, defaultOgImage: DEFAULT_IMAGE, fallbackCoverUrl: COVER_PATH },
      }),
      DEFAULT_IMAGE,
    );
    expectSmall(
      generateSeoMeta({ entity: "home", data: { ...base, defaultOgImage: "", fallbackCoverUrl: COVER_PATH } }),
      COVER_ABS,
    );
  });

  it("collection（/browse、/blog 列表）：同 home", () => {
    const base = {
      title: "All works",
      description: "Browse.",
      canonicalPath: "/browse",
      items: [],
      siteName: "PulseNovel",
    };
    expectLarge(
      generateSeoMeta({
        entity: "collection",
        data: { ...base, defaultOgImage: DEFAULT_IMAGE, fallbackCoverUrl: COVER_PATH },
      }),
      DEFAULT_IMAGE,
    );
    expectSmall(
      generateSeoMeta({ entity: "collection", data: { ...base, defaultOgImage: null, fallbackCoverUrl: COVER_PATH } }),
      COVER_ABS,
    );
    // 没有任何书封兜底（例如博客列表）：始终是默认图大卡片
    expectLarge(
      generateSeoMeta({ entity: "collection", data: { ...base, defaultOgImage: DEFAULT_IMAGE } }),
      DEFAULT_IMAGE,
    );
  });

  it("category：同 home", () => {
    const base = { name: "Romance", slug: "romance", siteName: "PulseNovel", hreflangLocales: ["en"] };
    expectLarge(
      generateSeoMeta({
        entity: "category",
        data: { ...base, defaultOgImage: DEFAULT_IMAGE, fallbackCoverUrl: COVER_PATH },
      }),
      DEFAULT_IMAGE,
    );
    expectSmall(
      generateSeoMeta({ entity: "category", data: { ...base, defaultOgImage: "", fallbackCoverUrl: COVER_PATH } }),
      COVER_ABS,
    );
  });

  it("blog 不动：博客封面尺寸未知，仍是旧口径（summary_large_image + 1200×630）", () => {
    const seo = generateSeoMeta({
      entity: "blog",
      data: {
        title: "A post",
        description: "Body.",
        canonicalPath: "/blog/a-post",
        coverUrl: "/uploads/blog-cover.jpg",
        defaultOgImage: DEFAULT_IMAGE,
        siteName: "PulseNovel",
      },
    });
    expectLarge(seo, `${ORIGIN}/uploads/blog-cover.jpg`);
  });
});

/**
 * 页面层：首页 / 浏览页 / 分类页此前把「站点默认图 || 列表第一本书封」合并成一个
 * `defaultOgImage` 再交给模板，模板无从判断最终选中的是哪一种。现在两个值分开传。
 * 这几条用例走真实的页面元数据函数，钉住「分开传」——合并回去的话，兜底书封会被当成
 * 站点默认图，谎报 1200×630。
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
const categoryQueries = await import("@/lib/site/category-queries");
const getPublicCategoryPage = vi.mocked(categoryQueries.getPublicCategoryPage);
const { buildHomeMetadata } = await import("@/app/_pages/home");
const { buildBrowseMetadata } = await import("@/app/_pages/browse");
const { buildCategoryMetadata } = await import("@/app/_pages/category");

const CHROME = { brandHref: "/", navItems: [], footerNote: "© test" };
const settings = (defaultOgImage: string) => ({
  siteName: "PulseNovel",
  siteDescription: "Site description.",
  homeMetaTitle: "PulseNovel",
  homeMetaDescription: "Home description.",
  defaultOgImage,
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
  updatedAt: new Date("2026-10-07T00:00:00Z"),
});
const CARD = { id: "biz-1", title: "A Book", coverUrl: COVER_PATH, tags: [], href: "/novel/a-book-pabc123" };

function openGraphImages(metadata: { openGraph?: unknown }) {
  return (metadata.openGraph as { images: OgImage[] }).images;
}
function twitterCard(metadata: { twitter?: unknown }) {
  return (metadata.twitter as { card: string }).card;
}

describe("页面层：站点默认图与「第一本书封」兜底分开传给模板", () => {
  beforeEach(() => {
    loadActiveLocales.mockResolvedValue(["en"] as never);
    loadPublicCategories.mockResolvedValue([]);
    loadHomeNovels.mockResolvedValue([CARD]);
    loadBrowseNovels.mockResolvedValue([CARD]);
    getPublicCategoryPage.mockResolvedValue({
      novels: [CARD],
      page: 1,
      totalPages: 1,
      totalCount: 1,
      category: { id: "c1", slug: "romance", name: "Romance", description: null, sortOrder: 0, updatedAt: new Date("2026-10-07T00:00:00Z") },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("首页：配置了站点默认图 → 默认图大卡片，不被第一本书封抢走", async () => {
    loadChrome.mockResolvedValue({ settings: settings(DEFAULT_IMAGE), chrome: CHROME });
    const metadata = await buildHomeMetadata("en");

    expect(twitterCard(metadata)).toBe("summary_large_image");
    expect(openGraphImages(metadata)[0]).toMatchObject({ url: DEFAULT_IMAGE, width: 1200, height: 630 });
  });

  it("首页：站点默认图缺失 → 第一本书封兜底，小图卡片且不声明尺寸", async () => {
    loadChrome.mockResolvedValue({ settings: settings(""), chrome: CHROME });
    const metadata = await buildHomeMetadata("en");

    expect(twitterCard(metadata)).toBe("summary");
    expect(openGraphImages(metadata)[0]).toEqual({ url: COVER_ABS, alt: "PulseNovel" });
  });

  it("浏览页：配置了站点默认图 → 默认图大卡片；缺失 → 第一本书封 + 小图卡片", async () => {
    loadChrome.mockResolvedValue({ settings: settings(DEFAULT_IMAGE), chrome: CHROME });
    const withDefault = await buildBrowseMetadata("en", Promise.resolve({}));
    expect(twitterCard(withDefault)).toBe("summary_large_image");
    expect(openGraphImages(withDefault)[0]).toMatchObject({ url: DEFAULT_IMAGE, width: 1200, height: 630 });

    loadChrome.mockResolvedValue({ settings: settings(""), chrome: CHROME });
    const withoutDefault = await buildBrowseMetadata("en", Promise.resolve({}));
    expect(twitterCard(withoutDefault)).toBe("summary");
    expect(openGraphImages(withoutDefault)[0]).not.toHaveProperty("width");
    expect(openGraphImages(withoutDefault)[0].url).toBe(COVER_ABS);
  });

  it("分类页：配置了站点默认图 → 默认图大卡片；缺失 → 第一本书封 + 小图卡片", async () => {
    loadChrome.mockResolvedValue({ settings: settings(DEFAULT_IMAGE), chrome: CHROME });
    const withDefault = await buildCategoryMetadata("en", Promise.resolve({ slug: "romance" }), Promise.resolve({}));
    expect(twitterCard(withDefault)).toBe("summary_large_image");
    expect(openGraphImages(withDefault)[0]).toMatchObject({ url: DEFAULT_IMAGE, width: 1200, height: 630 });

    loadChrome.mockResolvedValue({ settings: settings(""), chrome: CHROME });
    const withoutDefault = await buildCategoryMetadata("en", Promise.resolve({ slug: "romance" }), Promise.resolve({}));
    expect(twitterCard(withoutDefault)).toBe("summary");
    expect(openGraphImages(withoutDefault)[0]).not.toHaveProperty("width");
    expect(openGraphImages(withoutDefault)[0].url).toBe(COVER_ABS);
  });
});
