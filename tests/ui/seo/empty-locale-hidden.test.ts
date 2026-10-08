import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SITE_LOCALES, type SiteLocale } from "@/lib/locale/locale-canonical";
import { isEmptyLocale } from "@/lib/locale/empty-locale";
import { buildHreflangAlternates } from "@/lib/seo/seo-utils";
import { buildHomeSeoMeta } from "@/lib/seo/seo-templates/home";
import { buildCollectionSeoMeta } from "@/lib/seo/seo-templates/collection";

import { resolveRouteMetadata, type ResolvedMetadata } from "./_helpers/next-metadata-merge";

/**
 * PN-09（Owner 2026-10-08：没有书时连入口也隐藏）——公开页元数据一侧。
 *
 * "空语种" = 不在动态层活跃语种集合（`loadActiveLocales()` ← `getActiveLocales()`）里的语种，
 * 唯一判定是 `isEmptyLocale`。本文件钉三件事：
 *
 *  1. 空语种下所有会返回 200 的入口页——首页、书库 `/browse`、博客列表 `/blog`——输出
 *     `noindex, follow`，且不声明任何 hreflang（含自指与 x-default）；canonical 仍是自身；
 *  2. 非空语种这三个页面的 robots 与改前一致（不覆盖，最终落成 `index, follow`），hreflang
 *     只列活跃语种，**不含任何空语种**；全部 15 个语种都活跃时，输出与改前（盲目枚举 15 个）逐字一致；
 *  3. 语种一旦有了书（活跃集合里出现它），同一个页面自动回到可收录——没有任何人工开关；
 *  4. 不删路由：空语种的这三个页面照常构建元数据与页面体，不走 `notFound()`
 *     （404 元数据是 `follow: false`、标题 "Not found"，与空语种的 `follow: true` 可区分）。
 *
 * 另有一组走 Next 16.1.6 自己的 `accumulateMetadata`（见 `_helpers/next-metadata-merge.ts`）合并
 * 磁盘上真实的 layout/page 元数据，断言浏览器最终会看到的 robots——根布局本身带
 * `noindex, nofollow`，页面级覆盖是否真的压过它，只有合并后才看得出来。
 *
 * 反向自检（见施工报告）：
 *  ① 菜单不过滤空语种 → `tests/ui/locale-switcher-empty-locale.test.tsx` 红（另一个文件）；
 *  ② 去掉 `emptyLocaleRobots` 里的 noindex → 本文件"空语种 noindex"各条红；
 *  ③ 页面层的"空语种"判定改用常量/另一份集合（例如恒 `["en"]`、恒 `SITE_LOCALES`）→
 *     "非空语种可收录"或"空语种 noindex"至少一条红。
 */

const NOT_FOUND = Symbol("next-not-found");

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw NOT_FOUND;
  },
}));

vi.mock("next/headers", () => ({
  headers: async () => ({ get: () => null }),
}));

vi.mock("@/app/_lib/public-deps", () => ({ prisma: {} }));

const state = vi.hoisted(() => ({
  settings: null as unknown as Record<string, unknown>,
}));

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
  loadBlogList: vi.fn(),
}));

vi.mock("@/lib/site/category-queries", () => ({
  getPublicCategoryPage: vi.fn(),
}));

const publicLoad = await import("@/app/_lib/public-load");
const loadChrome = vi.mocked(publicLoad.loadChrome);
const loadActiveLocales = vi.mocked(publicLoad.loadActiveLocales);
const loadHomeNovels = vi.mocked(publicLoad.loadHomeNovels);
const loadHomeCarousel = vi.mocked(publicLoad.loadHomeCarousel);
const loadPublicCategories = vi.mocked(publicLoad.loadPublicCategories);
const loadBrowseNovels = vi.mocked(publicLoad.loadBrowseNovels);
const loadBlogList = vi.mocked(publicLoad.loadBlogList);

const { buildHomeMetadata, HomeBody } = await import("@/app/_pages/home");
const { buildBrowseMetadata, BrowseBody } = await import("@/app/_pages/browse");
const { buildBlogListMetadata, BlogListBody } = await import("@/app/_pages/blog-list");

const ORIGIN = "https://example.test";
const CHROME = { brandHref: "/", navItems: [], footerNote: "© test" };
const SETTINGS = {
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
  yandexVerification: "",
  yandexMetricaId: null,
  updatedAt: new Date("2026-09-30T00:00:00Z"),
};

/** 混合场景：en/ru/ko 有书，其余 12 个登记语种（含 cs）都是空语种。 */
const ACTIVE_MIXED: SiteLocale[] = ["en", "ko", "ru"];
const NOINDEX_FOLLOW = { index: false, follow: true };
const INDEX_FOLLOW = { index: true, follow: true };

beforeEach(() => {
  process.env.SITE_URL = ORIGIN;
  process.env.FEATURE_ARTICLE_BLOG = "true";
  state.settings = SETTINGS;
  loadChrome.mockResolvedValue({ settings: SETTINGS, chrome: CHROME } as never);
  loadActiveLocales.mockResolvedValue(ACTIVE_MIXED as never);
  loadPublicCategories.mockResolvedValue([]);
  loadHomeNovels.mockResolvedValue([]);
  loadHomeCarousel.mockResolvedValue([]);
  loadBrowseNovels.mockResolvedValue([]);
  loadBlogList.mockResolvedValue([]);
});

afterEach(() => {
  delete process.env.SITE_URL;
  delete process.env.FEATURE_ARTICLE_BLOG;
  vi.clearAllMocks();
});

type Built = { robots?: unknown; alternates?: { canonical?: unknown; languages?: unknown } | null };
type PageCase = {
  name: string;
  path: string;
  build: (locale: SiteLocale) => Promise<Built>;
};

const PAGES: PageCase[] = [
  { name: "首页", path: "", build: (locale) => buildHomeMetadata(locale) },
  { name: "书库 /browse", path: "/browse", build: (locale) => buildBrowseMetadata(locale, Promise.resolve({})) },
  { name: "博客列表 /blog", path: "/blog", build: (locale) => buildBlogListMetadata(locale, Promise.resolve({})) },
];

function canonicalOf(locale: SiteLocale, path: string): string {
  // 首页（path = ""）：en 是站点根 `…/`，其余语种是 `…/<locale>`（与 `buildLocaleCanonical` 一致）。
  if (path === "") return locale === "en" ? `${ORIGIN}/` : `${ORIGIN}/${locale}`;
  return `${ORIGIN}${locale === "en" ? "" : `/${locale}`}${path}`;
}

function hreflangKeys(built: Built): string[] {
  return Object.keys((built.alternates?.languages ?? {}) as Record<string, string>).sort();
}

describe("isEmptyLocale：空语种的唯一判定", () => {
  it("不在活跃集合里 = 空；在集合里 = 非空", () => {
    expect(isEmptyLocale("cs", ACTIVE_MIXED)).toBe(true);
    expect(isEmptyLocale("de", ACTIVE_MIXED)).toBe(true);
    expect(isEmptyLocale("ru", ACTIVE_MIXED)).toBe(false);
    expect(isEmptyLocale("ko", ACTIVE_MIXED)).toBe(false);
  });

  it("默认语种 en 永远不算空（即便集合里没有它）", () => {
    expect(isEmptyLocale("en", [])).toBe(false);
    expect(isEmptyLocale("en", ["ru"])).toBe(false);
  });

  it("15 个登记语种里，混合场景下恰好 12 个是空语种", () => {
    const empties = SITE_LOCALES.filter((locale) => isEmptyLocale(locale, ACTIVE_MIXED));
    expect(empties).toHaveLength(SITE_LOCALES.length - ACTIVE_MIXED.length);
    expect(empties).toContain("cs");
    for (const active of ACTIVE_MIXED) expect(empties).not.toContain(active);
  });
});

describe.each(PAGES)("$name：空语种 noindex，非空语种照旧", ({ path, build }) => {
  it("cs（空语种）：robots = noindex,follow；不声明任何 hreflang；canonical 仍是自身", async () => {
    const built = await build("cs");
    expect(built.robots).toEqual(NOINDEX_FOLLOW);
    expect(built.alternates?.languages).toEqual({});
    expect(built.alternates?.canonical).toBe(canonicalOf("cs", path));
    // 页面确实向活跃语种集合要了答案（而不是自己另查/写死）。
    expect(loadActiveLocales).toHaveBeenCalled();
  });

  it("de（另一个空语种）同样 noindex,follow；12 个空语种逐个验", async () => {
    for (const locale of SITE_LOCALES.filter((candidate) => isEmptyLocale(candidate, ACTIVE_MIXED))) {
      const built = await build(locale);
      expect(built.robots, locale).toEqual(NOINDEX_FOLLOW);
      expect(built.alternates?.languages, locale).toEqual({});
    }
  });

  it("ru（非空语种）：robots 最终是 index,follow；hreflang 只列活跃语种，不含任何空语种", async () => {
    const built = await build("ru");
    expect(built.robots).toEqual(INDEX_FOLLOW);
    expect(hreflangKeys(built)).toEqual(["en", "ko", "ru", "x-default"].sort());
    for (const locale of SITE_LOCALES.filter((candidate) => isEmptyLocale(candidate, ACTIVE_MIXED))) {
      expect(hreflangKeys(built), locale).not.toContain(locale);
    }
    expect((built.alternates?.languages as Record<string, string>)["x-default"]).toBe(canonicalOf("en", path));
  });

  it("en：永远可收录；hreflang 同样只列活跃语种", async () => {
    const built = await build("en");
    expect(built.robots).toEqual(INDEX_FOLLOW);
    expect(hreflangKeys(built)).toEqual(["en", "ko", "ru", "x-default"].sort());
  });

  it("语种有了书：活跃集合出现 cs 之后同一个页面自动回到可收录，且进入自己和别人的 hreflang（无需人工操作）", async () => {
    loadActiveLocales.mockResolvedValue(["en", "ko", "ru", "cs"] as never);
    const cs = await build("cs");
    expect(cs.robots).toEqual(INDEX_FOLLOW);
    expect(hreflangKeys(cs)).toEqual(["cs", "en", "ko", "ru", "x-default"].sort());
    expect((cs.alternates?.languages as Record<string, string>).cs).toBe(canonicalOf("cs", path));
    const ru = await build("ru");
    expect(hreflangKeys(ru)).toContain("cs");
  });

  it("不删路由：空语种页面照常构建元数据，不走 notFound（404 元数据是 follow:false + 'Not found'，这里不是）", async () => {
    const built = (await build("cs")) as Built & { title?: unknown };
    expect(built.robots).not.toEqual({ index: false, follow: false });
    expect(JSON.stringify(built.title ?? "")).not.toContain("Not found");
  });
});

describe("空语种的页面体照常渲染（路由保持 200，不 404、不跳转）", () => {
  it("HomeBody('cs') / BrowseBody('cs') / BlogListBody('cs') 都不抛 notFound，返回可渲染的元素树", async () => {
    await expect(HomeBody({ locale: "cs" })).resolves.toBeTruthy();
    await expect(BrowseBody({ locale: "cs", searchParams: Promise.resolve({}) })).resolves.toBeTruthy();
    await expect(BlogListBody({ locale: "cs", searchParams: Promise.resolve({}) })).resolves.toBeTruthy();
  });

  it("但空语种的第 2 页、带分类的书库本来就是 404，这一点不变（只有第 1 页入口是 200）", async () => {
    await expect(BrowseBody({ locale: "cs", searchParams: Promise.resolve({ page: "2" }) })).rejects.toBe(NOT_FOUND);
    await expect(BlogListBody({ locale: "cs", searchParams: Promise.resolve({ page: "2" }) })).rejects.toBe(NOT_FOUND);
  });
});

describe("非空语种：与改前逐字一致（模板层，参照老函数 buildHreflangAlternates）", () => {
  const homeData = { siteName: "PulseNovel", description: "d", defaultOgImage: "/og.png" };
  const collectionData = {
    title: "All works",
    description: "d",
    canonicalPath: "/browse",
    items: [],
    siteName: "PulseNovel",
    defaultOgImage: "/og.png",
  };

  it("15 个语种都活跃时：首页 hreflang 与旧的全量枚举逐字相同，robots 不覆盖", () => {
    for (const locale of SITE_LOCALES) {
      const meta = buildHomeSeoMeta({ ...homeData, activeLocales: SITE_LOCALES }, locale);
      expect(meta.alternates.languages, locale).toStrictEqual(buildHreflangAlternates("/", locale));
      expect(meta.robots, locale).toBeUndefined();
    }
  });

  it("15 个语种都活跃时：列表页第 1 页 hreflang 与旧的全量枚举逐字相同，robots 不覆盖", () => {
    for (const locale of SITE_LOCALES) {
      const meta = buildCollectionSeoMeta({ ...collectionData, activeLocales: SITE_LOCALES }, 1, locale);
      expect(meta.alternates.languages, locale).toStrictEqual(buildHreflangAlternates("/browse", locale));
      expect(meta.robots, locale).toBeUndefined();
    }
  });

  it("部分语种活跃时：键集合恰好 = 活跃语种 + 当前语种 + x-default", () => {
    const meta = buildHomeSeoMeta({ ...homeData, activeLocales: ["en", "ru"] }, "ru");
    expect(Object.keys(meta.alternates.languages).sort()).toEqual(["en", "ru", "x-default"]);
  });

  it("空语种 + 第 2 页：仍是 noindex、无 hreflang（第 2 页不会比第 1 页更可收录）", () => {
    const meta = buildCollectionSeoMeta({ ...collectionData, activeLocales: ["en"] }, 2, "cs");
    expect(meta.robots).toEqual(NOINDEX_FOLLOW);
    expect(meta.alternates.languages).toEqual({});
  });
});

describe("走 Next 真实元数据合并：浏览器最终看到的 robots", () => {
  async function resolveRoute(pathname: string, routeDir: string, locale?: string): Promise<ResolvedMetadata> {
    return resolveRouteMetadata({ pathname, routeDir, params: locale ? { locale } : undefined });
  }

  /** Next 把 robots 解析成 `{ basic: "noindex, follow", googleBot: ... }`；这里只看 basic 的字符串。 */
  function basicRobots(resolved: ResolvedMetadata): string {
    return String((resolved.robots as { basic?: string } | null)?.basic ?? "");
  }

  it("/cs、/cs/browse、/cs/blog：最终 robots = noindex, follow（压过根布局的 noindex,nofollow 且保留 follow）", async () => {
    for (const [pathname, routeDir] of [
      ["/cs", "[locale]"],
      ["/cs/browse", "[locale]/browse"],
      ["/cs/blog", "[locale]/blog"],
    ] as const) {
      const resolved = await resolveRoute(pathname, routeDir, "cs");
      expect(basicRobots(resolved), pathname).toBe("noindex, follow");
    }
  });

  it("/ru、/ru/browse、/ru/blog 与英文 /、/browse、/blog：最终 robots = index, follow", async () => {
    for (const [pathname, routeDir, locale] of [
      ["/ru", "[locale]", "ru"],
      ["/ru/browse", "[locale]/browse", "ru"],
      ["/ru/blog", "[locale]/blog", "ru"],
      ["/", "", undefined],
      ["/browse", "browse", undefined],
      ["/blog", "blog", undefined],
    ] as const) {
      const resolved = await resolveRoute(pathname, routeDir, locale);
      expect(basicRobots(resolved), pathname).toBe("index, follow");
    }
  });

  it("cs 有了书之后，/cs 的最终 robots 回到 index, follow", async () => {
    loadActiveLocales.mockResolvedValue(["en", "cs"] as never);
    const resolved = await resolveRoute("/cs", "[locale]", "cs");
    expect(basicRobots(resolved)).toBe("index, follow");
  });
});
