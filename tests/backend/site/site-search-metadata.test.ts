/**
 * PN-15 搜索页收录与分享卡片：状态矩阵（Owner 2026-10-09 拍板，照 CPS v8.1.2 / v8.4.0）。
 *
 * 每个状态的 robots / canonical / hreflang 缺席 / og·twitter 都在这里逐个钉住。
 * 移植自 CPS `tests/site-search-metadata.test.ts`，加上海阅的分页（第 2 页起自引用）与 15 语文案。
 */
import { afterAll, describe, expect, it } from "vitest";

import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";
import { buildSearchCanonical, buildSearchPageMetadata, type SearchMetadataResult } from "@/lib/site-search/metadata";
import type { SiteSearchStatus } from "@/lib/site-search/types";

const SITE = "https://pulsenovels.example";
const SETTINGS = {
  siteName: "  PulseNovel  ",
  siteDescription: "Backoffice site description.",
  defaultOgImage: "/brand/og-default.png",
};

// describe 体在收集阶段就会求值（早于 beforeEach），所以 SITE_URL 在模块顶层设置，文件结束时还原。
const previousSiteUrl = process.env.SITE_URL;
process.env.SITE_URL = SITE;
afterAll(() => {
  if (previousSiteUrl === undefined) delete process.env.SITE_URL;
  else process.env.SITE_URL = previousSiteUrl;
});

function result(status: SiteSearchStatus, displayQuery: string, itemCount = 0, page = 1): SearchMetadataResult {
  return { status, displayQuery, itemCount, page };
}

function build(
  locale: SiteLocale,
  resultValue: SearchMetadataResult | null,
  options: { enabled?: boolean; settings?: Partial<typeof SETTINGS> } = {},
) {
  return buildSearchPageMetadata({
    enabled: options.enabled ?? true,
    locale,
    result: resultValue,
    t: getPublicT(locale),
    settings: { ...SETTINGS, ...options.settings },
  });
}

function canonicalOf(metadata: ReturnType<typeof build>): string {
  const value = metadata.alternates?.canonical;
  if (typeof value !== "string") throw new Error("expected a string canonical");
  return value;
}

function expectNoHreflang(metadata: ReturnType<typeof build>) {
  expect(Object.keys(metadata.alternates ?? {})).toEqual(["canonical"]);
  expect(metadata.alternates?.languages).toBeUndefined();
}

type OpenGraphLike = { title?: string; description?: string; url?: string; siteName?: string; locale?: string; type?: string; images?: unknown };
type TwitterLike = { card?: string; title?: string; description?: string; images?: unknown };
const og = (metadata: ReturnType<typeof build>) => metadata.openGraph as OpenGraphLike;
const tw = (metadata: ReturnType<typeof build>) => metadata.twitter as TwitterLike;

describe("ok 且本页有书：index,follow，自引用 canonical，动态标题与描述", () => {
  const metadata = build("en", result("ok", "Alpha King", 20));

  it("robots index,follow", () => {
    expect(metadata.robots).toEqual({ index: true, follow: true });
  });

  it("canonical = 本语种 /search?q=<归一词>（保留大小写，空格为 +），只有 q 一个参数", () => {
    expect(canonicalOf(metadata)).toBe(`${SITE}/search?q=Alpha+King`);
    expect([...new URL(canonicalOf(metadata)).searchParams.keys()]).toEqual(["q"]);
  });

  it("标题不带品牌（品牌由根布局模板加），描述动态", () => {
    expect(metadata.title).toBe("Search results for “Alpha King”");
    expect(metadata.description).toBe("Search results for “Alpha King” on PulseNovel. Discover novels and start reading free chapters.");
  });

  it("openGraph：website、标题/描述同上（不带品牌）、url = canonical、siteName = 品牌名（去空白）、locale、站点默认图", () => {
    expect(og(metadata)).toMatchObject({
      type: "website",
      title: "Search results for “Alpha King”",
      description: metadata.description,
      url: `${SITE}/search?q=Alpha+King`,
      siteName: "PulseNovel",
      locale: "en_US",
    });
    expect(og(metadata).images).toEqual([
      { url: `${SITE}/brand/og-default.png`, width: 1200, height: 630, alt: "Search results for “Alpha King”" },
    ]);
  });

  it("twitter：summary_large_image，标题/描述同上，图 = 站点默认图", () => {
    expect(tw(metadata)).toMatchObject({
      card: "summary_large_image",
      title: "Search results for “Alpha King”",
      description: metadata.description,
      images: [`${SITE}/brand/og-default.png`],
    });
  });

  it("不声明 hreflang", () => {
    expectNoHreflang(metadata);
  });
});

describe("分页：第 2 页起 canonical 自引用（带 page），参数顺序 q → page", () => {
  it("第 1 页不带 page", () => {
    expect(canonicalOf(build("en", result("ok", "alpha", 20, 1)))).toBe(`${SITE}/search?q=alpha`);
  });

  it("第 2、3 页：&page=N", () => {
    expect(canonicalOf(build("en", result("ok", "alpha", 20, 2)))).toBe(`${SITE}/search?q=alpha&page=2`);
    expect(canonicalOf(build("en", result("ok", "alpha", 5, 3)))).toBe(`${SITE}/search?q=alpha&page=3`);
    expect(og(build("en", result("ok", "alpha", 20, 2))).url).toBe(`${SITE}/search?q=alpha&page=2`);
  });

  it("与翻页组件 Pagination 的拼法一致（同一个参数编码器）", async () => {
    const { Pagination } = await import("@/features/public-ui/collection/Pagination");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(
      Pagination({ locale: "en", currentPage: 2, totalPages: 3, basePath: "/search", searchParams: { q: "Alpha King & co" } }) as never,
    );
    const next = /href="([^"]*page=3[^"]*)"/.exec(html)![1]!.replaceAll("&amp;", "&");
    expect(next).toBe("/search?q=Alpha+King+%26+co&page=3");
    expect(buildSearchCanonical("en", "Alpha King & co", 3)).toBe(`${SITE}${next}`);
  });
});

describe("非英语语种：前缀、百分号编码、文案", () => {
  it("日语单个汉字：/ja/search?q=%E6%84%9B，index,follow", () => {
    const metadata = build("ja", result("ok", "愛", 3));
    expect(metadata.robots).toEqual({ index: true, follow: true });
    expect(canonicalOf(metadata)).toBe(`${SITE}/ja/search?q=%E6%84%9B`);
    expect(og(metadata).locale).toBe("ja_JP");
  });

  it("繁体中文、葡语（pt-BR）前缀照 localePrefix 规则", () => {
    expect(canonicalOf(build("zh-Hant", result("ok", "愛", 3)))).toBe(`${SITE}/zh-Hant/search?q=%E6%84%9B`);
    expect(canonicalOf(build("pt-BR", result("ok", "amor", 3)))).toBe(`${SITE}/pt-BR/search?q=amor`);
  });

  it("保留保留字符与无关参数被丢弃：canonical 里只有 q（和 page）", () => {
    const url = new URL(canonicalOf(build("en", result("ok", "Love & 100%?", 1))));
    expect(url.searchParams.get("q")).toBe("Love & 100%?");
    expect([...url.searchParams.keys()]).toEqual(["q"]);
    expect(url.search).not.toMatch(/utm_/);
  });

  it("不同归一词 → 不同 canonical；相同 → 相同；大小写不同是两个网址（照 CPS 接受）", () => {
    const of = (query: string) => canonicalOf(build("en", result("ok", query, 1)));
    expect(of("wife")).not.toBe(of("love"));
    expect(of("wife")).toBe(of("wife"));
    expect(of("Wife")).not.toBe(of("wife"));
  });

  it("动态标题/描述走各语种文案（法语 « {query} » 两侧是 U+00A0）", () => {
    const metadata = build("fr", result("ok", "alpha", 3));
    expect(metadata.title).toBe("Résultats de recherche pour « alpha »");
    expect(String(metadata.description)).toContain("« alpha »");
  });

  it("动态文案按字面透传（& 引号 < > 换行 不在这里转义，转义是渲染层的事）", () => {
    const query = "Rock & \"Roll\" 'x' <b>";
    const metadata = build("en", result("ok", query, 1));
    expect(metadata.title).toBe(`Search results for “${query}”`);
    expect(og(metadata).title).toBe(metadata.title);
    expect(tw(metadata).title).toBe(metadata.title);
  });
});

describe("ok 零结果：noindex,follow，裸 canonical，动态标题（照 CPS v8.4.0）", () => {
  const metadata = build("en", result("ok", "zzzxqvnotfound", 0));

  it("robots noindex,follow", () => {
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });

  it("canonical = 裸 /search，没有 query string", () => {
    expect(canonicalOf(metadata)).toBe(`${SITE}/search`);
    expect(new URL(canonicalOf(metadata)).search).toBe("");
  });

  it("标题 / 描述 / og / twitter 同样是动态的", () => {
    expect(metadata.title).toBe("Search results for “zzzxqvnotfound”");
    expect(String(metadata.description)).toContain("zzzxqvnotfound");
    expect(og(metadata).title).toBe(metadata.title);
    expect(tw(metadata).title).toBe(metadata.title);
    expect(og(metadata).url).toBe(`${SITE}/search`);
  });

  it("不声明 hreflang", () => {
    expectNoHreflang(metadata);
  });

  it("零结果的第 2 页同样 noindex 裸 canonical（页面层本来会 404，这里钉住元数据不会自引用）", () => {
    const second = build("en", result("ok", "zzzxqvnotfound", 0, 2));
    expect(second.robots).toEqual({ index: false, follow: true });
    expect(canonicalOf(second)).toBe(`${SITE}/search`);
  });
});

describe.each(["idle", "too_short", "too_long"] as const)("%s：noindex,follow，裸 canonical，站点级分享卡片", (status) => {
  const metadata = build("en", result(status, "x"));

  it("robots / canonical / hreflang", () => {
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(canonicalOf(metadata)).toBe(`${SITE}/search`);
    expectNoHreflang(metadata);
  });

  it("标题 = 页面标题（search.title，不带品牌）", () => {
    expect(metadata.title).toBe("Search");
  });

  it("og / twitter 是站点级：标题 = 站点名，描述 = 站点描述（默认语种读后台），图 = 站点默认图，不含搜索词", () => {
    expect(og(metadata)).toMatchObject({
      type: "website",
      title: "PulseNovel",
      description: "Backoffice site description.",
      url: `${SITE}/search`,
      siteName: "PulseNovel",
      locale: "en_US",
    });
    expect(og(metadata).images).toEqual([{ url: `${SITE}/brand/og-default.png`, width: 1200, height: 630, alt: "PulseNovel" }]);
    expect(tw(metadata)).toMatchObject({ card: "summary_large_image", title: "PulseNovel", description: "Backoffice site description." });
    expect(JSON.stringify(metadata)).not.toContain("“x”");
  });
});

describe("站点级描述：只有默认语种读后台，其它语种读 meta.siteDescription（同全部作品页）", () => {
  it("非默认语种用文案目录里的站点描述，不用后台那个（后台只有一个值，不分语种）", () => {
    const metadata = build("de", result("idle", ""));
    const expected = getPublicT("de")("meta.siteDescription");
    expect(expected).not.toBe(getPublicT("en")("meta.siteDescription"));
    expect(metadata.description).toBe(expected);
    expect(og(metadata).description).toBe(expected);
    expect(canonicalOf(metadata)).toBe(`${SITE}/de/search`);
  });

  it("默认语种后台站点描述为空时回落到文案", () => {
    const metadata = build("en", result("idle", ""), { settings: { siteDescription: "   " } });
    expect(metadata.description).toBe(getPublicT("en")("meta.siteDescription"));
  });

  it("站点名为空白时品牌回落到代码内置的 PulseNovel", () => {
    const metadata = build("en", result("idle", ""), { settings: { siteName: "   " } });
    expect(og(metadata).siteName).toBe("PulseNovel");
    expect(og(metadata).title).toBe("PulseNovel");
  });
});

describe("unavailable 与开关关闭：noindex,nofollow，裸 canonical，站点级分享卡片", () => {
  it("数据库出错", () => {
    const metadata = build("en", result("unavailable", "wife"));
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(canonicalOf(metadata)).toBe(`${SITE}/search`);
    expect(metadata.title).toBe("Search");
    expect(og(metadata).title).toBe("PulseNovel");
    expectNoHreflang(metadata);
    expect(JSON.stringify(metadata)).not.toContain("wife");
  });

  it("开关关闭（result 为 null）：/ja/search", () => {
    const metadata = build("ja", null, { enabled: false });
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(canonicalOf(metadata)).toBe(`${SITE}/ja/search`);
    expect(new URL(canonicalOf(metadata)).pathname).toBe("/ja/search");
    expect(metadata.title).toBe(getPublicT("ja")("search.title"));
    expectNoHreflang(metadata);
  });

  it("开关关闭时即使传了有结果的 result 也不收录（开关优先）", () => {
    const metadata = build("en", result("ok", "alpha", 20), { enabled: false });
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(canonicalOf(metadata)).toBe(`${SITE}/search`);
    expect(metadata.title).toBe("Search");
  });
});

describe("只有「ok 且本页有书」可以 index（全状态矩阵逐个断言）", () => {
  const cases: Array<[string, SearchMetadataResult | null, boolean, { index: boolean; follow: boolean }]> = [
    ["ok·有书", result("ok", "alpha", 1), true, { index: true, follow: true }],
    ["ok·零结果", result("ok", "alpha", 0), true, { index: false, follow: true }],
    ["idle", result("idle", ""), true, { index: false, follow: true }],
    ["too_short", result("too_short", "a"), true, { index: false, follow: true }],
    ["too_long", result("too_long", "a".repeat(501)), true, { index: false, follow: true }],
    ["unavailable", result("unavailable", "alpha"), true, { index: false, follow: false }],
    ["开关关", null, false, { index: false, follow: false }],
  ];
  it.each(cases)("%s", (_name, resultValue, enabled, robots) => {
    for (const locale of ["en", "ja", "ar"] as const) {
      expect(build(locale, resultValue, { enabled }).robots).toEqual(robots);
    }
  });
});

describe("站点默认分享图缺失（全新的库里是空串）：不抛错，只是没有图", () => {
  it("关闭状态的 404 页不会因为没配分享图变成 500", () => {
    const metadata = build("en", null, { enabled: false, settings: { defaultOgImage: "  " } });
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(og(metadata).images).toBeUndefined();
    expect(tw(metadata).images).toBeUndefined();
  });
});
