import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toNextMetadata } from "@/app/_lib/seo-metadata";
import { generateSeoMeta } from "@/lib/seo/seo-meta-generator";
import { paginatedRobots } from "@/lib/seo/seo-templates/_shared";
import { buildCategorySeoMeta, type CategorySeoData } from "@/lib/seo/seo-templates/category";
import { buildCollectionSeoMeta, type CollectionSeoData } from "@/lib/seo/seo-templates/collection";
import { SITE_LOCALES } from "@/lib/locale/locale-canonical";
import { shouldNoIndex } from "@/lib/seo/seo-utils";

/**
 * PN-01 剩余部分 + PN-08（2026-10-07，Owner 确认"分页页允许收录，对齐 CPS"）：
 * 分类页、书库页（/browse）、博客列表页（/blog）的第 2 页起——
 *
 *   1. 不再输出 noindex（与第 1 页一样默认可收录），canonical 仍是自身（带 `?page=N`）；
 *   2. 不输出任何跨语种 hreflang（含 x-default）——此前各语种都指向第 1 页；
 *   3. 分类页生成元数据时不再逐语种探测"该分类在其它语种是否有内容"；
 *   4. 第 1 页的全部元数据与改前（BASE `639605c`）逐字相同。
 *
 * 出处：CPS 生产 tag v8.7.2 `src/lib/seo-templates/_shared.ts:43-47` 的 `paginatedRobots`
 * 恒返回 `undefined`（CPS 提交 `ca29608`、`197bb69`），CPS 分类模板 `category.ts:93`
 * 用它填 `robots`；`seo-utils.ts:140` 的 `shouldNoIndex` 在 CPS 里已无调用方。
 * hreflang 第 2 页起为空是**有意偏离** CPS（CPS 第 2 页的 hreflang 仍指向第 1 页）。
 */

const ORIGIN = "https://novel.example";

// ── 模块 mock（只用于 buildCategoryMetadata / buildBrowseMetadata / buildBlogListMetadata）──
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@/app/_lib/public-load", () => ({
  loadChrome: vi.fn(),
  loadActiveLocales: vi.fn(),
  loadBrowseNovels: vi.fn(),
  loadBlogList: vi.fn(),
}));
vi.mock("@/lib/site/category-queries", () => ({
  getPublicCategoryPage: vi.fn(),
}));
vi.mock("@/lib/site/category-locales", () => ({
  listCategoryPublicLocales: vi.fn(),
}));

const publicLoad = await import("@/app/_lib/public-load");
const loadChrome = vi.mocked(publicLoad.loadChrome);
const loadActiveLocales = vi.mocked(publicLoad.loadActiveLocales);
const loadBrowseNovels = vi.mocked(publicLoad.loadBrowseNovels);
const loadBlogList = vi.mocked(publicLoad.loadBlogList);
const categoryQueries = await import("@/lib/site/category-queries");
const getPublicCategoryPage = vi.mocked(categoryQueries.getPublicCategoryPage);
const categoryLocales = await import("@/lib/site/category-locales");
const listCategoryPublicLocales = vi.mocked(categoryLocales.listCategoryPublicLocales);
const { buildCategoryMetadata } = await import("@/app/_pages/category");
const { buildBrowseMetadata } = await import("@/app/_pages/browse");
const { buildBlogListMetadata } = await import("@/app/_pages/blog-list");

const SETTINGS = {
  siteName: "PulseNovel",
  siteDescription: "",
  homeMetaTitle: "",
  homeMetaDescription: "",
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
  updatedAt: new Date("2026-09-30T00:00:00Z"),
};

beforeEach(() => {
  process.env.SITE_URL = ORIGIN;
  process.env.FEATURE_ARTICLE_BLOG = "true";
  loadChrome.mockReset();
  loadChrome.mockResolvedValue({ settings: SETTINGS, chrome: { brandHref: "/", navItems: [] } });
  loadActiveLocales.mockReset();
  loadActiveLocales.mockResolvedValue(["en", "ko", "es", "ja"] as never);
  getPublicCategoryPage.mockReset();
  listCategoryPublicLocales.mockReset();
  loadBrowseNovels.mockReset();
  loadBlogList.mockReset();
});

afterEach(() => {
  delete process.env.SITE_URL;
  delete process.env.FEATURE_ARTICLE_BLOG;
});

// ── 夹具：与改前快照（BASE 实测输出）使用同一组输入 ────────────────────────────────────
function categoryInput(locale: string, page: number): CategorySeoData {
  return {
    name: "Romance",
    slug: "romance",
    description: "Romance novels.",
    descriptionFallback: "Discover Romance novels on PulseNovel.",
    pageSuffix: page >= 2 ? ` - Page ${page}` : undefined,
    siteName: "PulseNovel",
    defaultOgImage: "/og.png",
    fallbackCoverUrl: "/c.jpg",
    hreflangLocales: ["en", "ko", "es", locale],
  };
}

function collectionInput(canonicalPath: string, page: number): CollectionSeoData {
  return {
    title: page >= 2 ? `All works - Page ${page}` : "All works",
    description: "Published novels.",
    canonicalPath,
    items: [{ name: "Lantern", url: "/novel/lantern-pabc" }],
    siteName: "PulseNovel",
    defaultOgImage: "/og.png",
    fallbackCoverUrl: "/c.jpg",
    // PN-09：列表模板的 hreflang 现在只列活跃语种。金样来自 BASE（盲目枚举全部 15 个登记语种），
    // 所以这里让 15 个语种都"有书"——这正是"非空语种、全部语种活跃"时输出必须与改前逐字一致的证明；
    // 空语种/部分活跃的行为见 `tests/ui/seo/empty-locale-hidden.test.ts`。
    activeLocales: SITE_LOCALES,
  };
}

function categoryPage(locale: string, page: number) {
  return {
    novels: [{ id: "n1", title: "A Book", coverUrl: "/c.jpg", tags: [], href: "/novel/a-pabc" }],
    page,
    totalPages: 5,
    totalCount: 100,
    category: {
      id: "cat-1",
      slug: "romance",
      name: `Romance (${locale})`,
      description: null,
      sortOrder: 1,
      updatedAt: new Date("2026-09-30T00:00:00Z"),
    },
  };
}

const NOVEL = { id: "n1", title: "A Book", coverUrl: "/c.jpg", tags: [], href: "/novel/a-pabc" };
const POST = {
  id: "p1",
  title: "A post",
  slug: "a-post",
  summary: "s",
  publishedAt: new Date("2026-08-05T12:30:00.000Z"),
  href: "/blog/a-post",
};

// ── 改前（BASE 639605c）第 1 页的实测输出，逐字固化 ─────────────────────────────────────
// 生成方式：在 BASE 上用上面的夹具调用各模板 / buildCategoryMetadata，JSON 序列化后原样贴入
// （`robots: undefined` 显式保留，配合 toStrictEqual 连"键是否存在"一起比）。
const GOLDEN_CATEGORY_EN = {
  "title": "Romance",
  "description": "Romance novels.",
  "canonical": "https://novel.example/category/romance",
  "openGraph": {
    "type": "website",
    "title": "Romance",
    "description": "Romance novels.",
    "url": "https://novel.example/category/romance",
    "siteName": "PulseNovel",
    "locale": "en_US",
    "images": [
      {
        "url": "https://novel.example/og.png",
        "width": 1200,
        "height": 630,
        "alt": "Romance"
      }
    ]
  },
  "twitter": {
    "card": "summary_large_image",
    "title": "Romance",
    "description": "Romance novels.",
    "images": [
      "https://novel.example/og.png"
    ]
  },
  "alternates": {
    "canonical": "https://novel.example/category/romance",
    "languages": {
      "en": "https://novel.example/category/romance",
      "ko": "https://novel.example/ko/category/romance",
      "es": "https://novel.example/es/category/romance",
      "x-default": "https://novel.example/category/romance"
    }
  },
  "robots": undefined,
  "other": {
    "application/ld+json": "[{\"@context\":\"https://schema.org\",\"@type\":\"CollectionPage\",\"name\":\"Romance\",\"url\":\"https://novel.example/category/romance\",\"description\":\"Romance novels.\"},{\"@context\":\"https://schema.org\",\"@type\":\"BreadcrumbList\",\"itemListElement\":[{\"@type\":\"ListItem\",\"position\":1,\"name\":\"Home\",\"item\":\"https://novel.example/\"},{\"@type\":\"ListItem\",\"position\":2,\"name\":\"Romance\",\"item\":\"https://novel.example/category/romance\"}]}]"
  }
};

const GOLDEN_CATEGORY_KO = {
  "title": "Romance",
  "description": "Romance novels.",
  "canonical": "https://novel.example/ko/category/romance",
  "openGraph": {
    "type": "website",
    "title": "Romance",
    "description": "Romance novels.",
    "url": "https://novel.example/ko/category/romance",
    "siteName": "PulseNovel",
    "locale": "ko_KR",
    "images": [
      {
        "url": "https://novel.example/og.png",
        "width": 1200,
        "height": 630,
        "alt": "Romance"
      }
    ]
  },
  "twitter": {
    "card": "summary_large_image",
    "title": "Romance",
    "description": "Romance novels.",
    "images": [
      "https://novel.example/og.png"
    ]
  },
  "alternates": {
    "canonical": "https://novel.example/ko/category/romance",
    "languages": {
      "en": "https://novel.example/category/romance",
      "ko": "https://novel.example/ko/category/romance",
      "es": "https://novel.example/es/category/romance",
      "x-default": "https://novel.example/category/romance"
    }
  },
  "robots": undefined,
  "other": {
    "application/ld+json": "[{\"@context\":\"https://schema.org\",\"@type\":\"CollectionPage\",\"name\":\"Romance\",\"url\":\"https://novel.example/ko/category/romance\",\"description\":\"Romance novels.\"},{\"@context\":\"https://schema.org\",\"@type\":\"BreadcrumbList\",\"itemListElement\":[{\"@type\":\"ListItem\",\"position\":1,\"name\":\"홈\",\"item\":\"https://novel.example/ko\"},{\"@type\":\"ListItem\",\"position\":2,\"name\":\"Romance\",\"item\":\"https://novel.example/ko/category/romance\"}]}]"
  }
};

const GOLDEN_BROWSE_EN = {
  "title": "All works",
  "description": "Published novels.",
  "canonical": "https://novel.example/browse",
  "openGraph": {
    "type": "website",
    "title": "All works",
    "description": "Published novels.",
    "url": "https://novel.example/browse",
    "siteName": "PulseNovel",
    "locale": "en_US",
    "images": [
      {
        "url": "https://novel.example/og.png",
        "width": 1200,
        "height": 630,
        "alt": "All works"
      }
    ]
  },
  "twitter": {
    "card": "summary_large_image",
    "title": "All works",
    "description": "Published novels.",
    "images": [
      "https://novel.example/og.png"
    ]
  },
  "alternates": {
    "canonical": "https://novel.example/browse",
    "languages": {
      "en": "https://novel.example/browse",
      "es": "https://novel.example/es/browse",
      "pt-BR": "https://novel.example/pt-BR/browse",
      "id": "https://novel.example/id/browse",
      "vi": "https://novel.example/vi/browse",
      "th": "https://novel.example/th/browse",
      "ja": "https://novel.example/ja/browse",
      "ko": "https://novel.example/ko/browse",
      "zh-Hant": "https://novel.example/zh-Hant/browse",
      "ar": "https://novel.example/ar/browse",
      "fr": "https://novel.example/fr/browse",
      "de": "https://novel.example/de/browse",
      "pl": "https://novel.example/pl/browse",
      "cs": "https://novel.example/cs/browse",
      "ru": "https://novel.example/ru/browse",
      "x-default": "https://novel.example/browse"
    }
  },
  "robots": undefined,
  "other": {
    "application/ld+json": "[{\"@context\":\"https://schema.org\",\"@type\":\"ItemList\",\"name\":\"All works\",\"numberOfItems\":1,\"itemListElement\":[{\"@type\":\"ListItem\",\"position\":1,\"url\":\"https://novel.example/novel/lantern-pabc\",\"name\":\"Lantern\"}]},{\"@context\":\"https://schema.org\",\"@type\":\"BreadcrumbList\",\"itemListElement\":[{\"@type\":\"ListItem\",\"position\":1,\"name\":\"Home\",\"item\":\"https://novel.example/\"},{\"@type\":\"ListItem\",\"position\":2,\"name\":\"All works\",\"item\":\"https://novel.example/browse\"}]}]"
  }
};

const GOLDEN_BROWSE_KO = {
  "title": "All works",
  "description": "Published novels.",
  "canonical": "https://novel.example/ko/browse",
  "openGraph": {
    "type": "website",
    "title": "All works",
    "description": "Published novels.",
    "url": "https://novel.example/ko/browse",
    "siteName": "PulseNovel",
    "locale": "ko_KR",
    "images": [
      {
        "url": "https://novel.example/og.png",
        "width": 1200,
        "height": 630,
        "alt": "All works"
      }
    ]
  },
  "twitter": {
    "card": "summary_large_image",
    "title": "All works",
    "description": "Published novels.",
    "images": [
      "https://novel.example/og.png"
    ]
  },
  "alternates": {
    "canonical": "https://novel.example/ko/browse",
    "languages": {
      "en": "https://novel.example/browse",
      "es": "https://novel.example/es/browse",
      "pt-BR": "https://novel.example/pt-BR/browse",
      "id": "https://novel.example/id/browse",
      "vi": "https://novel.example/vi/browse",
      "th": "https://novel.example/th/browse",
      "ja": "https://novel.example/ja/browse",
      "ko": "https://novel.example/ko/browse",
      "zh-Hant": "https://novel.example/zh-Hant/browse",
      "ar": "https://novel.example/ar/browse",
      "fr": "https://novel.example/fr/browse",
      "de": "https://novel.example/de/browse",
      "pl": "https://novel.example/pl/browse",
      "cs": "https://novel.example/cs/browse",
      "ru": "https://novel.example/ru/browse",
      "x-default": "https://novel.example/browse"
    }
  },
  "robots": undefined,
  "other": {
    "application/ld+json": "[{\"@context\":\"https://schema.org\",\"@type\":\"ItemList\",\"name\":\"All works\",\"numberOfItems\":1,\"itemListElement\":[{\"@type\":\"ListItem\",\"position\":1,\"url\":\"https://novel.example/novel/lantern-pabc\",\"name\":\"Lantern\"}]},{\"@context\":\"https://schema.org\",\"@type\":\"BreadcrumbList\",\"itemListElement\":[{\"@type\":\"ListItem\",\"position\":1,\"name\":\"홈\",\"item\":\"https://novel.example/ko\"},{\"@type\":\"ListItem\",\"position\":2,\"name\":\"All works\",\"item\":\"https://novel.example/ko/browse\"}]}]"
  }
};

const GOLDEN_BROWSE_CATEGORY_KO = {
  "title": "All works",
  "description": "Published novels.",
  "canonical": "https://novel.example/ko/browse?category=romance",
  "openGraph": {
    "type": "website",
    "title": "All works",
    "description": "Published novels.",
    "url": "https://novel.example/ko/browse?category=romance",
    "siteName": "PulseNovel",
    "locale": "ko_KR",
    "images": [
      {
        "url": "https://novel.example/og.png",
        "width": 1200,
        "height": 630,
        "alt": "All works"
      }
    ]
  },
  "twitter": {
    "card": "summary_large_image",
    "title": "All works",
    "description": "Published novels.",
    "images": [
      "https://novel.example/og.png"
    ]
  },
  "alternates": {
    "canonical": "https://novel.example/ko/browse?category=romance",
    "languages": {
      "en": "https://novel.example/browse?category=romance",
      "es": "https://novel.example/es/browse?category=romance",
      "pt-BR": "https://novel.example/pt-BR/browse?category=romance",
      "id": "https://novel.example/id/browse?category=romance",
      "vi": "https://novel.example/vi/browse?category=romance",
      "th": "https://novel.example/th/browse?category=romance",
      "ja": "https://novel.example/ja/browse?category=romance",
      "ko": "https://novel.example/ko/browse?category=romance",
      "zh-Hant": "https://novel.example/zh-Hant/browse?category=romance",
      "ar": "https://novel.example/ar/browse?category=romance",
      "fr": "https://novel.example/fr/browse?category=romance",
      "de": "https://novel.example/de/browse?category=romance",
      "pl": "https://novel.example/pl/browse?category=romance",
      "cs": "https://novel.example/cs/browse?category=romance",
      "ru": "https://novel.example/ru/browse?category=romance",
      "x-default": "https://novel.example/browse?category=romance"
    }
  },
  "robots": undefined,
  "other": {
    "application/ld+json": "[{\"@context\":\"https://schema.org\",\"@type\":\"ItemList\",\"name\":\"All works\",\"numberOfItems\":1,\"itemListElement\":[{\"@type\":\"ListItem\",\"position\":1,\"url\":\"https://novel.example/novel/lantern-pabc\",\"name\":\"Lantern\"}]},{\"@context\":\"https://schema.org\",\"@type\":\"BreadcrumbList\",\"itemListElement\":[{\"@type\":\"ListItem\",\"position\":1,\"name\":\"홈\",\"item\":\"https://novel.example/ko\"},{\"@type\":\"ListItem\",\"position\":2,\"name\":\"All works\",\"item\":\"https://novel.example/ko/browse?category=romance\"}]}]"
  }
};

const GOLDEN_BLOG_EN = {
  "title": "All works",
  "description": "Published novels.",
  "canonical": "https://novel.example/blog",
  "openGraph": {
    "type": "website",
    "title": "All works",
    "description": "Published novels.",
    "url": "https://novel.example/blog",
    "siteName": "PulseNovel",
    "locale": "en_US",
    "images": [
      {
        "url": "https://novel.example/og.png",
        "width": 1200,
        "height": 630,
        "alt": "All works"
      }
    ]
  },
  "twitter": {
    "card": "summary_large_image",
    "title": "All works",
    "description": "Published novels.",
    "images": [
      "https://novel.example/og.png"
    ]
  },
  "alternates": {
    "canonical": "https://novel.example/blog",
    "languages": {
      "en": "https://novel.example/blog",
      "es": "https://novel.example/es/blog",
      "pt-BR": "https://novel.example/pt-BR/blog",
      "id": "https://novel.example/id/blog",
      "vi": "https://novel.example/vi/blog",
      "th": "https://novel.example/th/blog",
      "ja": "https://novel.example/ja/blog",
      "ko": "https://novel.example/ko/blog",
      "zh-Hant": "https://novel.example/zh-Hant/blog",
      "ar": "https://novel.example/ar/blog",
      "fr": "https://novel.example/fr/blog",
      "de": "https://novel.example/de/blog",
      "pl": "https://novel.example/pl/blog",
      "cs": "https://novel.example/cs/blog",
      "ru": "https://novel.example/ru/blog",
      "x-default": "https://novel.example/blog"
    }
  },
  "robots": undefined,
  "other": {
    "application/ld+json": "[{\"@context\":\"https://schema.org\",\"@type\":\"ItemList\",\"name\":\"All works\",\"numberOfItems\":1,\"itemListElement\":[{\"@type\":\"ListItem\",\"position\":1,\"url\":\"https://novel.example/novel/lantern-pabc\",\"name\":\"Lantern\"}]},{\"@context\":\"https://schema.org\",\"@type\":\"BreadcrumbList\",\"itemListElement\":[{\"@type\":\"ListItem\",\"position\":1,\"name\":\"Home\",\"item\":\"https://novel.example/\"},{\"@type\":\"ListItem\",\"position\":2,\"name\":\"All works\",\"item\":\"https://novel.example/blog\"}]}]"
  }
};

// 2026-10-08（运营反馈、Owner 确认，有意偏离 CPS）：页面层把分类名换成标题形式
// `collection.categoryHeading`（ko 为 "{name} 소설"），所以 title / og:title / twitter:title /
// 分享图 alt 四处从 "Romance (ko)" 变为 "Romance (ko) 소설"；描述兜底句仍用纯分类名，其余字段
// （canonical / hreflang / robots / 描述）与改前逐字相同。
const GOLDEN_CATEGORY_METADATA_KO = {
  "title": "Romance (ko) 소설",
  "description": "PulseNovel에서 Romance (ko) 소설을 만나보세요.",
  "alternates": {
    "canonical": "https://novel.example/ko/category/romance",
    "languages": {
      "en": "https://novel.example/category/romance",
      "es": "https://novel.example/es/category/romance",
      "ko": "https://novel.example/ko/category/romance",
      "x-default": "https://novel.example/category/romance"
    }
  },
  "openGraph": {
    "type": "website",
    "title": "Romance (ko) 소설",
    "description": "PulseNovel에서 Romance (ko) 소설을 만나보세요.",
    "url": "https://novel.example/ko/category/romance",
    "siteName": "PulseNovel",
    "locale": "ko_KR",
    "images": [
      {
        "url": "https://example.test/og.png",
        "width": 1200,
        "height": 630,
        "alt": "Romance (ko) 소설"
      }
    ]
  },
  "twitter": {
    "card": "summary_large_image",
    "title": "Romance (ko) 소설",
    "description": "PulseNovel에서 Romance (ko) 소설을 만나보세요.",
    "images": [
      "https://example.test/og.png"
    ]
  },
  "robots": {
    "index": true,
    "follow": true
  }
};

describe("paginatedRobots — 与 CPS v8.7.2 一致：恒返回 undefined", () => {
  it("任何页码都返回 undefined（CPS tests/seo-meta-generator.test.ts:133-137 同款断言）", () => {
    expect(paginatedRobots()).toBeUndefined();
    expect(paginatedRobots(1)).toBeUndefined();
    expect(paginatedRobots(2)).toBeUndefined();
    expect(paginatedRobots(10)).toBeUndefined();
  });

  it("shouldNoIndex 仍是原函数（CPS 里也保留着定义），只是模板不再调用：见下方第 2 页 robots 断言", () => {
    expect(shouldNoIndex(1)).toBe(false);
    expect(shouldNoIndex(2)).toBe(true);
  });
});

describe("目标 4：第 1 页与改前逐字相同（BASE 实测输出，toStrictEqual）", () => {
  it("分类模板：en / ko", () => {
    expect(buildCategorySeoMeta(categoryInput("en", 1), 1, "en")).toStrictEqual(GOLDEN_CATEGORY_EN);
    expect(buildCategorySeoMeta(categoryInput("ko", 1), 1, "ko")).toStrictEqual(GOLDEN_CATEGORY_KO);
  });

  it("列表模板：/browse（en、ko）、/browse?category=（ko）、/blog（en）", () => {
    expect(buildCollectionSeoMeta(collectionInput("/browse", 1), 1, "en")).toStrictEqual(GOLDEN_BROWSE_EN);
    expect(buildCollectionSeoMeta(collectionInput("/browse", 1), 1, "ko")).toStrictEqual(GOLDEN_BROWSE_KO);
    expect(buildCollectionSeoMeta(collectionInput("/browse?category=romance", 1), 1, "ko")).toStrictEqual(
      GOLDEN_BROWSE_CATEGORY_KO,
    );
    expect(buildCollectionSeoMeta(collectionInput("/blog", 1), 1, "en")).toStrictEqual(GOLDEN_BLOG_EN);
  });

  it("第 1 页仍然带完整 hreflang（含 x-default），robots 键存在且为 undefined", () => {
    const category = buildCategorySeoMeta(categoryInput("ko", 1), 1, "ko");
    expect(Object.keys(category.alternates.languages).sort()).toEqual(["en", "es", "ko", "x-default"]);
    expect(Object.hasOwn(category, "robots")).toBe(true);
    expect(category.robots).toBeUndefined();

    const collection = buildCollectionSeoMeta(collectionInput("/browse", 1), 1, "ko");
    expect(Object.keys(collection.alternates.languages)).toHaveLength(16); // 15 语种 + x-default
    expect(collection.alternates.languages["x-default"]).toBe(`${ORIGIN}/browse`);
    expect(collection.robots).toBeUndefined();
  });

  it("buildCategoryMetadata 第 1 页：hreflang 来自逐语种探测（照常调用一次），输出与改前相同（仅标题四处换成标题形式）", async () => {
    getPublicCategoryPage.mockResolvedValue(categoryPage("ko", 1));
    listCategoryPublicLocales.mockResolvedValue(["en", "es"]);

    const metadata = await buildCategoryMetadata("ko", Promise.resolve({ slug: "romance" }), Promise.resolve({}));

    expect(metadata).toStrictEqual(GOLDEN_CATEGORY_METADATA_KO);
    expect(listCategoryPublicLocales).toHaveBeenCalledTimes(1);
    expect(listCategoryPublicLocales.mock.calls[0]![1]).toBe("romance");
    expect(listCategoryPublicLocales.mock.calls[0]![2]).toEqual(["en", "es", "ja"]); // 活跃语种去掉当前语种
  });
});

describe("目标 1 + 2：模板第 2、3 页——可收录、canonical 自身、无 hreflang", () => {
  for (const page of [2, 3]) {
    it(`分类模板 第 ${page} 页（en、ko）`, () => {
      for (const locale of ["en", "ko"] as const) {
        const seo = buildCategorySeoMeta(categoryInput(locale, page), page, locale);
        const prefix = locale === "en" ? "" : `/${locale}`;
        expect(seo.robots).toBeUndefined();
        expect(seo.canonical).toBe(`${ORIGIN}${prefix}/category/romance?page=${page}`);
        expect(seo.alternates.canonical).toBe(seo.canonical);
        expect(seo.openGraph.url).toBe(seo.canonical);
        expect(seo.alternates.languages).toEqual({});
        expect(Object.keys(seo.alternates.languages)).toHaveLength(0); // 含 x-default 也没有
        // 标题与描述不动：仍带翻页后缀。
        expect(seo.title).toBe(`Romance - Page ${page}`);
        expect(seo.description).toBe("Romance novels.");
      }
    });

    it(`列表模板 第 ${page} 页：/browse、/browse?category=、/blog（en、ko）`, () => {
      const cases = [
        ["/browse", `/browse?page=${page}`],
        ["/browse?category=romance", `/browse?category=romance&page=${page}`],
        ["/blog", `/blog?page=${page}`],
      ] as const;
      for (const locale of ["en", "ko"] as const) {
        const prefix = locale === "en" ? "" : `/${locale}`;
        for (const [canonicalPath, expectedPath] of cases) {
          const seo = buildCollectionSeoMeta(collectionInput(canonicalPath, page), page, locale);
          expect(seo.robots, `${canonicalPath} ${locale}`).toBeUndefined();
          expect(seo.canonical, `${canonicalPath} ${locale}`).toBe(`${ORIGIN}${prefix}${expectedPath}`);
          expect(seo.alternates.canonical).toBe(seo.canonical);
          expect(seo.alternates.languages, `${canonicalPath} ${locale}`).toEqual({});
          expect(seo.title).toBe(`All works - Page ${page}`);
        }
      }
    });
  }

  it("经 generateSeoMeta 分发后同样成立（collection 与 category 两个入口）", () => {
    const category = generateSeoMeta({ entity: "category", locale: "ko", pageNumber: 2, data: categoryInput("ko", 2) });
    expect(category.robots).toBeUndefined();
    expect(category.alternates.languages).toEqual({});
    const collection = generateSeoMeta({ entity: "collection", locale: "ko", pageNumber: 2, data: collectionInput("/blog", 2) });
    expect(collection.robots).toBeUndefined();
    expect(collection.alternates.languages).toEqual({});
  });

  it("经 toNextMetadata 后：第 2 页 robots 是 { index: true, follow: true }，alternates 无 languages 条目；第 1 页 robots 同值", () => {
    const category2 = toNextMetadata(buildCategorySeoMeta(categoryInput("en", 2), 2, "en"));
    expect(category2.robots).toEqual({ index: true, follow: true });
    expect(category2.alternates?.languages).toEqual({});
    expect(category2.alternates?.canonical).toBe(`${ORIGIN}/category/romance?page=2`);

    const collection2 = toNextMetadata(buildCollectionSeoMeta(collectionInput("/browse", 2), 2, "en"));
    expect(collection2.robots).toEqual({ index: true, follow: true });
    expect(collection2.alternates?.languages).toEqual({});

    const collection1 = toNextMetadata(buildCollectionSeoMeta(collectionInput("/browse", 1), 1, "en"));
    expect(collection1.robots).toEqual({ index: true, follow: true });
    expect(Object.keys(collection1.alternates?.languages ?? {}).length).toBeGreaterThan(0);
  });
});

describe("目标 1 + 2：页面层元数据——书库页、博客列表页第 2 页", () => {
  it("/browse?page=2：可收录、canonical 自身、无 hreflang；/browse 第 1 页 hreflang 不变", async () => {
    loadBrowseNovels.mockResolvedValue(Array.from({ length: 21 }, (_, index) => ({ ...NOVEL, id: `n-${index}` })));

    const page2 = await buildBrowseMetadata("en", Promise.resolve({ page: "2" }));
    expect(page2.robots).toEqual({ index: true, follow: true });
    expect(page2.alternates?.canonical).toBe(`${ORIGIN}/browse?page=2`);
    expect(page2.alternates?.languages).toEqual({});

    // PN-09：第 1 页 hreflang 只列活跃语种；15 个语种全部活跃时与改前（盲目枚举 15 个）逐字一致。
    loadActiveLocales.mockResolvedValue([...SITE_LOCALES] as never);
    const page1 = await buildBrowseMetadata("en", Promise.resolve({}));
    expect(page1.robots).toEqual({ index: true, follow: true });
    expect(Object.keys(page1.alternates?.languages ?? {})).toHaveLength(16);
    expect((page1.alternates?.languages as Record<string, string>)["x-default"]).toBe(`${ORIGIN}/browse`);
  });

  it("/blog?page=2：可收录、canonical 自身、无 hreflang；/blog 第 1 页 hreflang 不变", async () => {
    loadBlogList.mockResolvedValue(Array.from({ length: 21 }, (_, index) => ({ ...POST, id: `p-${index}`, slug: `a-${index}` })));

    const page2 = await buildBlogListMetadata("ko", Promise.resolve({ page: "2" }));
    expect(page2.robots).toEqual({ index: true, follow: true });
    expect(page2.alternates?.canonical).toBe(`${ORIGIN}/ko/blog?page=2`);
    expect(page2.alternates?.languages).toEqual({});

    // PN-09：同上，15 个语种全部活跃时与改前一致。
    loadActiveLocales.mockResolvedValue([...SITE_LOCALES] as never);
    const page1 = await buildBlogListMetadata("ko", Promise.resolve({}));
    expect(Object.keys(page1.alternates?.languages ?? {})).toHaveLength(16);
  });
});

describe("目标 3：分类页第 2 页起不再逐语种探测", () => {
  const params = Promise.resolve({ slug: "romance" });

  it("第 2 页：listCategoryPublicLocales 调用 0 次；页面自己的查询只有 1 次；robots 可收录、canonical 自身、无 hreflang", async () => {
    getPublicCategoryPage.mockResolvedValue(categoryPage("ko", 2));
    listCategoryPublicLocales.mockResolvedValue(["en", "es"]);

    const metadata = await buildCategoryMetadata("ko", params, Promise.resolve({ page: "2" }));

    expect(listCategoryPublicLocales).not.toHaveBeenCalled();
    expect(getPublicCategoryPage).toHaveBeenCalledTimes(1);
    expect(metadata.robots).toEqual({ index: true, follow: true });
    expect(metadata.alternates?.canonical).toBe(`${ORIGIN}/ko/category/romance?page=2`);
    expect(metadata.alternates?.languages).toEqual({});
  });

  it("第 3 页同样 0 次探测", async () => {
    getPublicCategoryPage.mockResolvedValue(categoryPage("en", 3));
    listCategoryPublicLocales.mockResolvedValue(["ko"]);

    const metadata = await buildCategoryMetadata("en", params, Promise.resolve({ page: "3" }));

    expect(listCategoryPublicLocales).not.toHaveBeenCalled();
    expect(metadata.alternates?.languages).toEqual({});
    expect(metadata.alternates?.canonical).toBe(`${ORIGIN}/category/romance?page=3`);
  });

  it("第 1 页照常探测一次（对照：短路只作用于第 2 页起）", async () => {
    getPublicCategoryPage.mockResolvedValue(categoryPage("en", 1));
    listCategoryPublicLocales.mockResolvedValue(["ko"]);

    const metadata = await buildCategoryMetadata("en", params, Promise.resolve({}));

    expect(listCategoryPublicLocales).toHaveBeenCalledTimes(1);
    expect(Object.keys(metadata.alternates?.languages ?? {}).sort()).toEqual(["en", "ko", "x-default"]);
  });
});
