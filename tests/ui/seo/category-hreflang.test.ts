import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SITE_LOCALES } from "@/lib/locale/locale-canonical";
import { buildHreflangAlternates } from "@/lib/seo/seo-utils";
import { buildCategorySeoMeta } from "@/lib/seo/seo-templates/category";

/**
 * 2026-09-30 分类页 hreflang（开发单第 8 条）：只列出该分类在该语种**确实有公开
 * 内容**（页面返回 200）的语种，`x-default` 规则不变（优先 en，没有 en 就回落到
 * 当前页面）。
 *
 * 此前分类页对 15 个已登记语种盲枚举（`buildHreflangAlternates` 的默认集），
 * 而海阅的空分类是 404——生产实测 `/ko/category/female-audience` 的 hreflang 里
 * 有 `en=/category/female-audience`（404）和另外 13 个空语种，x-default 也指向
 * 那个 404。
 */

const ORIGIN = "https://novel.example";

// --- 元数据层：用 mock 的页面查询，验证 hreflang 只含真有内容的语种 ---------------
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
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
const { listCategoryPublicLocales } = await import("@/lib/site/category-locales");
const { buildCategoryMetadata } = await import("@/app/_pages/category");

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

function categoryPage(locale: string) {
  return {
    novels: [],
    page: 1,
    totalPages: 1,
    totalCount: 1,
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

/** 假页面查询：只有 `withContent` 里的语种返回页面，其它语种返回 null（= 404）。 */
function categoryHasContentIn(withContent: readonly string[]) {
  getPublicCategoryPage.mockImplementation(async (_db, locale) =>
    withContent.includes(locale) ? categoryPage(locale) : null,
  );
}

beforeEach(() => {
  process.env.SITE_URL = ORIGIN;
  loadChrome.mockReset();
  loadChrome.mockResolvedValue({ settings: SETTINGS, chrome: { brandHref: "/", navItems: [] } });
  loadActiveLocales.mockReset();
  getPublicCategoryPage.mockReset();
});

afterEach(() => {
  delete process.env.SITE_URL;
});

describe("buildHreflangAlternates / buildCategorySeoMeta — 只枚举传入的语种集", () => {
  it("传入 locales 时只列这些语种 + 当前语种；x-default 优先 en，没有 en 回落当前页", () => {
    const withEn = buildHreflangAlternates("/category/romance", "ko", ["en", "ko"]);
    expect(withEn).toEqual({
      en: `${ORIGIN}/category/romance`,
      ko: `${ORIGIN}/ko/category/romance`,
      "x-default": `${ORIGIN}/category/romance`,
    });

    const withoutEn = buildHreflangAlternates("/category/romance", "ko", ["ko", "es"]);
    expect(withoutEn).toEqual({
      ko: `${ORIGIN}/ko/category/romance`,
      es: `${ORIGIN}/es/category/romance`,
      "x-default": `${ORIGIN}/ko/category/romance`,
    });
  });

  it("当前语种即使没被列进 locales 也恒在（自引用）", () => {
    const languages = buildHreflangAlternates("/category/romance", "ko", ["en"]);
    expect(Object.keys(languages).sort()).toEqual(["en", "ko", "x-default"]);
  });

  it("不传 locales 时仍是完整的 SITE_LOCALES 枚举——首页、/browse 这类每个语种都存在的页面行为不变", () => {
    const languages = buildHreflangAlternates("/browse", "en");
    expect(Object.keys(languages)).toEqual([...SITE_LOCALES, "x-default"]);
  });

  it("buildCategorySeoMeta 把 hreflangLocales 落到 alternates.languages", () => {
    const seo = buildCategorySeoMeta(
      { name: "Romance", slug: "romance", siteName: "Novel", defaultOgImage: "/og.jpg", hreflangLocales: ["ko"] },
      1,
      "ko",
    );
    expect(Object.keys(seo.alternates.languages).sort()).toEqual(["ko", "x-default"]);
    expect(seo.alternates.languages["x-default"]).toBe(`${ORIGIN}/ko/category/romance`);
  });
});

describe("listCategoryPublicLocales — 页面返回 200 的唯一定义是 getPublicCategoryPage(…, 1)", () => {
  it("只保留页面查询非空的语种，并保持传入顺序；按第 1 页判定", async () => {
    categoryHasContentIn(["es", "ru"]);
    const found = await listCategoryPublicLocales({} as never, "romance", ["en", "es", "ko", "ru"]);
    expect(found).toEqual(["es", "ru"]);
    expect(getPublicCategoryPage.mock.calls.map((call) => [call[1], call[2], call[3]])).toEqual([
      ["en", "romance", 1],
      ["es", "romance", 1],
      ["ko", "romance", 1],
      ["ru", "romance", 1],
    ]);
  });

  it("没有候选语种就一次查询都不发", async () => {
    await expect(listCategoryPublicLocales({} as never, "romance", [])).resolves.toEqual([]);
    expect(getPublicCategoryPage).not.toHaveBeenCalled();
  });
});

describe("buildCategoryMetadata — hreflang 不再盲枚举 15 个语种", () => {
  const params = Promise.resolve({ slug: "romance" });
  const noQuery = Promise.resolve({});

  it("ko 页：en 下这个分类没有内容（页面 404）→ hreflang 里没有 en；x-default 回落到当前 ko 页；没内容的语种全不出现", async () => {
    loadActiveLocales.mockResolvedValue(["en", "ko", "es"]);
    categoryHasContentIn(["ko", "es"]); // en 是 404

    const metadata = await buildCategoryMetadata("ko", params, noQuery);
    const languages = metadata.alternates?.languages as Record<string, string>;

    expect(languages).toEqual({
      es: `${ORIGIN}/es/category/romance`,
      ko: `${ORIGIN}/ko/category/romance`,
      "x-default": `${ORIGIN}/ko/category/romance`,
    });
    expect(languages).not.toHaveProperty("en");
    for (const locale of ["fr", "de", "ru", "ja", "cs"]) expect(languages).not.toHaveProperty(locale);
  });

  it("en 也有内容时：en 与 ko 互相列出，x-default 是 en", async () => {
    loadActiveLocales.mockResolvedValue(["en", "ko"]);
    categoryHasContentIn(["en", "ko"]);

    const metadata = await buildCategoryMetadata("ko", params, noQuery);
    expect(metadata.alternates?.languages).toEqual({
      en: `${ORIGIN}/category/romance`,
      ko: `${ORIGIN}/ko/category/romance`,
      "x-default": `${ORIGIN}/category/romance`,
    });
  });

  it("不查当前语种自己（页面已经渲染出来了，它必然存在），也不查动态层之外的语种", async () => {
    loadActiveLocales.mockResolvedValue(["en", "ko"]);
    categoryHasContentIn(["en", "ko"]);

    await buildCategoryMetadata("ko", params, noQuery);

    const queried = getPublicCategoryPage.mock.calls.map((call) => call[1]);
    // 1 次是页面自己的 load（ko），1 次是候选里的 en；没有第二次 ko，也没有 fr/ru/… 这些没内容的语种。
    expect(queried.sort()).toEqual(["en", "ko"]);
  });

  it("页面本身 404（分类在当前语种没内容）→ 走 notFound 元数据，不去算 hreflang", async () => {
    loadActiveLocales.mockResolvedValue(["en", "ko"]);
    categoryHasContentIn([]);

    const metadata = await buildCategoryMetadata("ko", params, noQuery);
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(getPublicCategoryPage).toHaveBeenCalledTimes(1);
  });
});

/**
 * 同一轮里顺带发现并修的第三处：category / collection（/browse、/blog 列表）模板的
 * canonical 用的是不带语种前缀的 `buildCanonical`，`/ko/category/x` 的 canonical 因此是
 * 裸的 `/category/x`——空分类是 404，所以这常常是个 404 地址，还与页面自己的 hreflang
 * 自引用条目（`/ko/category/x`）互相矛盾。CPS 的 category 模板用的是
 * `buildLocaleCanonical(locale, path)`（`v8.5.1:src/lib/seo-templates/category.ts`）。
 */
describe("category / collection canonical carry the page's own locale prefix", () => {
  it("category：ko 的 canonical 是 /ko/category/x（含 ?page=2），en 保持无前缀，且与 hreflang 自引用一致", () => {
    const ko = buildCategorySeoMeta(
      { name: "Romance", slug: "romance", siteName: "Novel", defaultOgImage: "/og.jpg", hreflangLocales: ["ko"] },
      1,
      "ko",
    );
    expect(ko.canonical).toBe(`${ORIGIN}/ko/category/romance`);
    expect(ko.alternates.canonical).toBe(`${ORIGIN}/ko/category/romance`);
    expect(ko.alternates.languages.ko).toBe(ko.canonical);
    expect(ko.openGraph.url).toBe(ko.canonical);

    const koPage2 = buildCategorySeoMeta(
      { name: "Romance", slug: "romance", siteName: "Novel", defaultOgImage: "/og.jpg", hreflangLocales: ["ko"] },
      2,
      "ko",
    );
    expect(koPage2.canonical).toBe(`${ORIGIN}/ko/category/romance?page=2`);

    const en = buildCategorySeoMeta(
      { name: "Romance", slug: "romance", siteName: "Novel", defaultOgImage: "/og.jpg", hreflangLocales: ["en"] },
      1,
      "en",
    );
    expect(en.canonical).toBe(`${ORIGIN}/category/romance`);
  });

  it("collection（/browse、/blog 列表）：ko 的 canonical 带 /ko 前缀，第 2 页保留 query，en 无前缀", async () => {
    const { buildCollectionSeoMeta } = await import("@/lib/seo/seo-templates/collection");
    const data = {
      title: "All works",
      description: "Works.",
      canonicalPath: "/browse",
      items: [],
      siteName: "Novel",
      defaultOgImage: "/og.jpg",
    };
    expect(buildCollectionSeoMeta(data, 1, "ko").canonical).toBe(`${ORIGIN}/ko/browse`);
    expect(buildCollectionSeoMeta(data, 2, "ko").canonical).toBe(`${ORIGIN}/ko/browse?page=2`);
    expect(buildCollectionSeoMeta({ ...data, canonicalPath: "/browse?category=romance" }, 2, "ko").canonical).toBe(
      `${ORIGIN}/ko/browse?category=romance&page=2`,
    );
    expect(buildCollectionSeoMeta(data, 1, "en").canonical).toBe(`${ORIGIN}/browse`);
  });
});
