import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SITE_LOCALES } from "@/lib/locale/locale-canonical";
import { buildHreflangAlternates } from "@/lib/seo/seo-utils";
import { buildCategorySeoMeta } from "@/lib/seo/seo-templates/category";
import { clearPublicCategoryCountsCacheForTest } from "@/lib/site/public-list";

import { classifyPublicListQuery } from "../../fixtures/in-memory-public-db";

/**
 * 2026-09-30 分类页 hreflang（开发单第 8 条）：只列出该分类在该语种**确实有公开
 * 内容**（页面返回 200）的语种，`x-default` 规则不变（优先 en，没有 en 就回落到
 * 当前页面）。
 *
 * 此前分类页对 15 个已登记语种盲枚举（`buildHreflangAlternates` 的默认集），
 * 而海阅的空分类是 404——生产实测 `/ko/category/female-audience` 的 hreflang 里
 * 有 `en=/category/female-audience`（404）和另外 13 个空语种，x-default 也指向
 * 那个 404。
 *
 * B-38（v0.5.13）：判定改读每语种每分类本数矩阵（一次查询，不再逐语种调页面查询——那是第 1 页要额外查十几个
 * 语种的 400 毫秒），"该分类在某语种有书 ⟺ 页面返回 200"由真实库用例
 * `tests/integration/site/consistency-invariants-postgres.test.ts` 逐语种证明；这里用一个按 SQL 结构分派的
 * 假库验证元数据层怎样使用它。
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
  loadCategoryPage: vi.fn(),
}));
// 假库：`$queryRaw` 只答每语种每分类本数矩阵（`categoryHasContentIn` 决定哪些语种里 romance 有书）。
const fakeDb = vi.hoisted(() => ({ matrixLocales: [] as string[], statements: [] as string[], $queryRaw: null as unknown }));
vi.mock("@/app/_lib/public-deps", () => ({ prisma: fakeDb }));

const publicLoad = await import("@/app/_lib/public-load");
const loadChrome = vi.mocked(publicLoad.loadChrome);
const loadActiveLocales = vi.mocked(publicLoad.loadActiveLocales);
const loadCategoryPage = vi.mocked(publicLoad.loadCategoryPage);
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

/**
 * `withContent` 里的语种：romance 在那里有列表可见的书——页面本身（加载器）返回页面，矩阵里也有它；
 * 其它语种页面是 null（= 404），矩阵里没有。
 */
function categoryHasContentIn(withContent: readonly string[]) {
  fakeDb.matrixLocales = [...withContent];
  loadCategoryPage.mockImplementation(async (locale) => (withContent.includes(locale) ? categoryPage(locale) : null));
}

beforeEach(() => {
  process.env.SITE_URL = ORIGIN;
  loadChrome.mockReset();
  loadChrome.mockResolvedValue({ settings: SETTINGS, chrome: { brandHref: "/", navItems: [] } });
  loadActiveLocales.mockReset();
  loadCategoryPage.mockReset();
  clearPublicCategoryCountsCacheForTest();
  fakeDb.matrixLocales = [];
  fakeDb.statements = [];
  fakeDb.$queryRaw = async (query: { text: string }) => {
    const kind = classifyPublicListQuery(query);
    fakeDb.statements.push(kind);
    if (kind === "matrix") {
      return fakeDb.matrixLocales.map((locale) => ({ locale, canonical_tag_id: "cat-1", slug: "romance", n: 1 }));
    }
    return [];
  };
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

describe("listCategoryPublicLocales — 读每语种每分类本数矩阵：该分类本数 > 0 的语种 ∩ 候选", () => {
  it("只保留矩阵里有这个分类的语种，并保持传入顺序；一次矩阵读取，不逐语种探测、不调页面查询", async () => {
    categoryHasContentIn(["es", "ru", "pl"]);
    const found = await listCategoryPublicLocales(fakeDb as never, "romance", ["en", "es", "ko", "ru"]);
    expect(found).toEqual(["es", "ru"]);
    expect(fakeDb.statements.filter((kind) => kind === "matrix")).toHaveLength(1);
    expect(loadCategoryPage).not.toHaveBeenCalled();
  });

  it("slug 规范化与页面入口一致（大小写 / 首尾空白）；矩阵里没有的分类 → 空", async () => {
    categoryHasContentIn(["es"]);
    expect(await listCategoryPublicLocales(fakeDb as never, "  Romance ", ["en", "es"])).toEqual(["es"]);
    expect(await listCategoryPublicLocales(fakeDb as never, "unknown", ["en", "es"])).toEqual([]);
  });

  it("没有候选语种就一次查询都不发", async () => {
    await expect(listCategoryPublicLocales(fakeDb as never, "romance", [])).resolves.toEqual([]);
    expect(fakeDb.statements).toEqual([]);
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

  it("不逐语种探测：页面自己的加载器只调一次（当前语种），hreflang 只读一次矩阵；候选只含动态层活跃语种去掉当前语种", async () => {
    loadActiveLocales.mockResolvedValue(["en", "ko", "fr"]);
    categoryHasContentIn(["en", "ko", "ru"]);

    const metadata = await buildCategoryMetadata("ko", params, noQuery);

    expect(loadCategoryPage).toHaveBeenCalledTimes(1);
    expect(loadCategoryPage.mock.calls[0]).toEqual(["ko", "romance", 1]);
    expect(fakeDb.statements.filter((kind) => kind === "matrix")).toHaveLength(1);
    // 矩阵里有 ru，但 ru 不在动态层活跃语种里（候选之外）→ 不列；fr 活跃但矩阵里没有 → 不列。
    expect(Object.keys(metadata.alternates?.languages as Record<string, string>).sort()).toEqual(["en", "ko", "x-default"]);
  });

  it("页面本身 404（分类在当前语种没内容）→ 走 notFound 元数据，不去算 hreflang", async () => {
    loadActiveLocales.mockResolvedValue(["en", "ko"]);
    categoryHasContentIn([]);

    const metadata = await buildCategoryMetadata("ko", params, noQuery);
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(loadCategoryPage).toHaveBeenCalledTimes(1);
    expect(fakeDb.statements).toEqual([]);
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
      activeLocales: ["en", "ko"],
    };
    expect(buildCollectionSeoMeta(data, 1, "ko").canonical).toBe(`${ORIGIN}/ko/browse`);
    expect(buildCollectionSeoMeta(data, 2, "ko").canonical).toBe(`${ORIGIN}/ko/browse?page=2`);
    expect(buildCollectionSeoMeta({ ...data, canonicalPath: "/browse?category=romance" }, 2, "ko").canonical).toBe(
      `${ORIGIN}/ko/browse?category=romance&page=2`,
    );
    expect(buildCollectionSeoMeta(data, 1, "en").canonical).toBe(`${ORIGIN}/browse`);
  });
});
