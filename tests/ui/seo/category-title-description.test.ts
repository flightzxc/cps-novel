import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPublicT } from "@/lib/locale/messages";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

/**
 * TKD 对齐 CPS（Owner 2026-09-30，照 CPS v8.5.1 `seo-templates/category.ts:29-31`）第三块：
 *
 *  - 分类页标题 = 分类名 + （第 2 页起）本地化翻页后缀，不加 "novels"，不含品牌名
 *    （品牌后缀由根布局模板加，见 `real-metadata-merge.test.ts`）；
 *  - 分类页描述 = 分类自己的描述 || 一句固定的本地化兜底文案（推翻此前"绝不合成描述"）；
 *  - og:title / twitter:title 与 <title> 同（带翻页后缀、不带品牌）；
 *  - CollectionPage JSON-LD 的 name 仍是纯分类名（不带翻页后缀）；description 与 meta 同源
 *    （分类自己的描述 || 兜底句，照 CPS `category.ts:31`，复核 A2）。
 *    alternates/hreflang 不在本测试范围（另一条线在改）。
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
}));

vi.mock("@/lib/site/category-queries", () => ({
  getPublicCategoryPage: vi.fn(),
}));

const publicLoad = await import("@/app/_lib/public-load");
const loadChrome = vi.mocked(publicLoad.loadChrome);
const loadActiveLocales = vi.mocked(publicLoad.loadActiveLocales);
const categoryQueries = await import("@/lib/site/category-queries");
const getPublicCategoryPage = vi.mocked(categoryQueries.getPublicCategoryPage);
const { buildCategoryMetadata } = await import("@/app/_pages/category");
const { generateSeoMeta } = await import("@/lib/seo/seo-meta-generator");

const CHROME = { brandHref: "/", navItems: [], footerNote: "© test" };
const SETTINGS = {
  siteName: "PulseNovel",
  siteDescription: "ADMIN-SITE-DESCRIPTION",
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
  updatedAt: new Date("2026-09-30T00:00:00Z"),
};
const CARD = { id: "biz-1", title: "A Book", coverUrl: "/c.jpg", tags: [], href: "/novel/a-book-pabc123" };

function categoryPage(page: number, description: string | null) {
  return {
    novels: [CARD],
    page,
    totalPages: 3,
    totalCount: 45,
    category: {
      id: "cat-1",
      slug: "romance",
      name: "Romance",
      description,
      sortOrder: 0,
      updatedAt: new Date("2026-09-10T00:00:00Z"),
    },
  };
}

function titleOf(metadata: { title?: unknown }): string {
  if (typeof metadata.title !== "string") throw new Error(`expected a plain string title, got ${JSON.stringify(metadata.title)}`);
  return metadata.title;
}

beforeEach(() => {
  process.env.SITE_URL = "https://example.test";
  loadChrome.mockResolvedValue({ settings: SETTINGS, chrome: CHROME });
  loadActiveLocales.mockResolvedValue(["en", "ja"] as never);
});

afterEach(() => {
  delete process.env.SITE_URL;
  vi.clearAllMocks();
});

describe("分类页标题：分类名 + 第 2 页起的翻页后缀", () => {
  it("第 1 页就是分类名本身（不加 novels、不含品牌名），og/twitter 同", async () => {
    getPublicCategoryPage.mockResolvedValue(categoryPage(1, null));
    const metadata = await buildCategoryMetadata(PUBLIC_SITE_LOCALE, Promise.resolve({ slug: "romance" }), Promise.resolve({}));
    expect(titleOf(metadata)).toBe("Romance");
    expect(metadata.openGraph?.title).toBe("Romance");
    expect((metadata.twitter as { title?: string }).title).toBe("Romance");
  });

  it("第 2 页起是 '分类名 - Page N'（en），og:title/twitter:title 同带后缀、都不带品牌名", async () => {
    getPublicCategoryPage.mockResolvedValue(categoryPage(2, null));
    const metadata = await buildCategoryMetadata(PUBLIC_SITE_LOCALE, Promise.resolve({ slug: "romance" }), Promise.resolve({ page: "2" }));
    expect(titleOf(metadata)).toBe("Romance - Page 2");
    expect(metadata.openGraph?.title).toBe("Romance - Page 2");
    expect((metadata.twitter as { title?: string }).title).toBe("Romance - Page 2");
    expect(JSON.stringify(metadata)).not.toContain("PulseNovel |");
    expect(titleOf(metadata)).not.toContain("PulseNovel");
  });

  it("翻页后缀按语种本地化（ja/fr/ru），不是写死的英文", async () => {
    getPublicCategoryPage.mockResolvedValue(categoryPage(3, null));
    for (const locale of ["ja", "fr", "ru", "ar"] as const) {
      const metadata = await buildCategoryMetadata(locale, Promise.resolve({ slug: "romance" }), Promise.resolve({ page: "3" }));
      expect(titleOf(metadata), locale).toBe(`Romance${getPublicT(locale)("meta.pageSuffix", { page: 3 })}`);
    }
    const ja = await buildCategoryMetadata("ja", Promise.resolve({ slug: "romance" }), Promise.resolve({ page: "3" }));
    expect(titleOf(ja)).toBe("Romance - 3ページ");
  });
});

describe("分类页描述：分类自己的描述 || 固定的本地化兜底句", () => {
  it("分类有自己的描述：用它（不被后台站点描述或兜底句覆盖）", async () => {
    getPublicCategoryPage.mockResolvedValue(categoryPage(1, "Own Romance description."));
    const metadata = await buildCategoryMetadata(PUBLIC_SITE_LOCALE, Promise.resolve({ slug: "romance" }), Promise.resolve({}));
    expect(metadata.description).toBe("Own Romance description.");
    expect(metadata.openGraph?.description).toBe("Own Romance description.");
  });

  it("分类没有描述：用本地化兜底句（en 为 'Discover {name} novels on PulseNovel.'），og/twitter 同", async () => {
    getPublicCategoryPage.mockResolvedValue(categoryPage(1, null));
    const metadata = await buildCategoryMetadata(PUBLIC_SITE_LOCALE, Promise.resolve({ slug: "romance" }), Promise.resolve({}));
    expect(metadata.description).toBe("Discover Romance novels on PulseNovel.");
    expect(metadata.openGraph?.description).toBe("Discover Romance novels on PulseNovel.");
    expect((metadata.twitter as { description?: string }).description).toBe("Discover Romance novels on PulseNovel.");
    // 分类页从不读后台站点描述（那是首页/浏览页/博客列表的事）。
    expect(metadata.description).not.toContain("ADMIN");
  });

  it("分类没有描述：14 个非英语语种都走各自的兜底句（不出现英文句子）", async () => {
    getPublicCategoryPage.mockResolvedValue(categoryPage(1, null));
    for (const locale of ["es", "pt-BR", "id", "vi", "th", "ja", "ko", "zh-Hant", "ar", "fr", "de", "pl", "cs", "ru"] as const) {
      const metadata = await buildCategoryMetadata(locale, Promise.resolve({ slug: "romance" }), Promise.resolve({}));
      expect(metadata.description, locale).toBe(getPublicT(locale)("meta.categoryDescriptionFallback", { name: "Romance" }));
      expect(metadata.description, locale).not.toBe("Discover Romance novels on PulseNovel.");
      expect(metadata.description, locale).toContain("Romance");
    }
  });
});

describe("CollectionPage JSON-LD（category 模板）", () => {
  const base = {
    name: "Romance",
    slug: "romance",
    siteName: "PulseNovel",
    defaultOgImage: "https://example.test/og.png",
    // 对方（语种切换会话）新增的必填字段：hreflang 只列有内容的语种；本用例不关心 alternates。
    hreflangLocales: ["en"],
  };
  const parse = (seo: { other?: { "application/ld+json": string } }) =>
    JSON.parse(seo.other!["application/ld+json"]) as Array<Record<string, unknown>>;

  it("name 永远是纯分类名（不带翻页后缀）；分类没有描述时 description 用兜底句，与 meta/og/twitter 同一个值", () => {
    const seo = generateSeoMeta({
      entity: "category",
      locale: "en",
      pageNumber: 2,
      data: { ...base, description: null, descriptionFallback: "Discover Romance novels on PulseNovel.", pageSuffix: " - Page 2" },
    });
    const [collection] = parse(seo);
    expect(collection).toMatchObject({ "@type": "CollectionPage", name: "Romance", description: "Discover Romance novels on PulseNovel." });
    expect(collection!.description).toBe(seo.description);
    expect(collection!.description).toBe(seo.openGraph.description);
    expect(collection!.description).toBe(seo.twitter.description);
    expect(seo.title).toBe("Romance - Page 2");
  });

  it("分类有描述时 JSON-LD 带该描述（兜底句不覆盖它）", () => {
    const seo = generateSeoMeta({
      entity: "category",
      locale: "en",
      data: { ...base, description: "Own description.", descriptionFallback: "fallback" },
    });
    expect(parse(seo)[0]).toMatchObject({ description: "Own description." });
    expect(seo.description).toBe("Own description.");
  });

  it("页面层：分类无描述时 JSON-LD description 是本语种兜底句（en/ja）", async () => {
    getPublicCategoryPage.mockResolvedValue(categoryPage(1, null));
    const { CategoryBody } = await import("@/app/_pages/category");
    for (const locale of ["en", "ja"] as const) {
      const tree = await CategoryBody({ locale, params: Promise.resolve({ slug: "romance" }), searchParams: Promise.resolve({}) });
      const children = (tree as unknown as { props: { children: unknown[] } }).props.children;
      const node = children.find((child) => typeof child === "object" && child !== null && typeof (child as { props?: { json?: unknown } }).props?.json === "string") as { props: { json: string } };
      const [collection] = JSON.parse(node.props.json) as Array<Record<string, unknown>>;
      expect(collection!.description, locale).toBe(getPublicT(locale)("meta.categoryDescriptionFallback", { name: "Romance" }));
    }
  });

  it("不传兜底句/后缀时保持旧行为（描述为空串、JSON-LD 无 description、标题是纯分类名）", () => {
    const seo = generateSeoMeta({ entity: "category", locale: "en", data: { ...base, description: null } });
    expect(seo.title).toBe("Romance");
    expect(seo.description).toBe("");
    expect("description" in parse(seo)[0]!).toBe(false);
  });
});
