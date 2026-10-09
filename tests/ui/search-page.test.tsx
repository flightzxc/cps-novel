import "./setup-cleanup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

import type { NovelCardView } from "@/features/public-ui/types";
import { SITE_LOCALES, type SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";
import type { SiteSearchResponse } from "@/lib/site-search/types";

/**
 * PN-15 站内搜索页：各状态的文案、表单形状（零 JS、GET、不写 action）、开关关闭 404、页码规则、转义。
 * 页面用的加载器（`loadChrome` / `loadSearchPage`）被 mock，查询与 SQL 由别的用例证明。
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
vi.mock("@/app/_lib/search-load", () => ({
  loadSearchPage: vi.fn(),
}));

const publicLoad = await import("@/app/_lib/public-load");
const searchLoad = await import("@/app/_lib/search-load");
const loadChrome = vi.mocked(publicLoad.loadChrome);
const loadActiveLocales = vi.mocked(publicLoad.loadActiveLocales);
const loadSearchPage = vi.mocked(searchLoad.loadSearchPage);
const { SearchBody, buildSearchMetadata } = await import("@/app/_pages/search");

const BASE_SETTINGS = {
  siteName: "PulseNovel",
  siteDescription: "Overseas novels.",
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
  updatedAt: new Date("2026-10-09T00:00:00Z"),
};
const CHROME = { brandHref: "/", navItems: [], footerNote: "© test" };

function chromeWith(enabled: boolean | undefined) {
  const settings = enabled === undefined ? BASE_SETTINGS : { ...BASE_SETTINGS, siteSearchEnabled: enabled };
  return { settings: settings as never, chrome: CHROME } as never;
}

function cards(count: number, offset = 0): NovelCardView[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `book-${offset + index}`,
    title: `Alpha book ${offset + index}`,
    tags: [],
    href: `/novel/alpha-book-${offset + index}-p${offset + index}`,
  }));
}

function response(partial: Partial<SiteSearchResponse> & Pick<SiteSearchResponse, "status">): SiteSearchResponse {
  return {
    displayQuery: "",
    items: [],
    totalCount: 0,
    page: 1,
    totalPages: 1,
    pageSize: 20,
    ...partial,
  };
}

async function renderPage(locale: SiteLocale, searchParams: Record<string, string | string[]> = {}) {
  const tree = await SearchBody({ locale, searchParams: Promise.resolve(searchParams) });
  return render(tree).container;
}

async function expectNotFound(locale: SiteLocale, searchParams: Record<string, string | string[]>) {
  await expect(SearchBody({ locale, searchParams: Promise.resolve(searchParams) })).rejects.toBe(NOT_FOUND);
}

const status = (container: HTMLElement) => container.querySelector('p[role="status"]')!;

beforeEach(() => {
  process.env.SITE_URL = "https://example.test";
  loadChrome.mockResolvedValue(chromeWith(true));
  loadActiveLocales.mockResolvedValue(["en", "ja"] as never);
  loadSearchPage.mockResolvedValue(response({ status: "idle" }));
});

afterEach(() => {
  delete process.env.SITE_URL;
  vi.clearAllMocks();
});

describe("后台开关", () => {
  it("关闭（false）：页面 404、元数据 noindex,nofollow，且不碰搜索加载器", async () => {
    loadChrome.mockResolvedValue(chromeWith(false));
    await expectNotFound("en", { q: "alpha" });
    const metadata = await buildSearchMetadata("en", Promise.resolve({ q: "alpha" }));
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.alternates).toEqual({ canonical: "https://example.test/search" });
    expect(loadSearchPage).not.toHaveBeenCalled();
  });

  it("站点设置里还没有这个字段（后台开关分支未合入）：恒按关", async () => {
    loadChrome.mockResolvedValue(chromeWith(undefined));
    await expectNotFound("ja", {});
    const metadata = await buildSearchMetadata("ja", Promise.resolve({}));
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.alternates).toEqual({ canonical: "https://example.test/ja/search" });
    expect(loadSearchPage).not.toHaveBeenCalled();
  });

  it("打开（true）：渲染", async () => {
    const container = await renderPage("en");
    expect(container.querySelector("h1")!.textContent).toBe("Search");
  });
});

describe("搜索表单：零 JS、GET、不写 action", () => {
  it("<form role=search method=get>，没有 action；输入框与按钮的属性", async () => {
    loadSearchPage.mockResolvedValue(response({ status: "too_short", displayQuery: "a" }));
    const container = await renderPage("en", { q: "a" });
    const form = container.querySelector("form")!;
    expect(form.getAttribute("role")).toBe("search");
    expect(form.getAttribute("method")).toBe("get");
    expect(form.hasAttribute("action")).toBe(false);

    const input = form.querySelector("input")!;
    expect(input.getAttribute("type")).toBe("search");
    expect(input.getAttribute("name")).toBe("q");
    expect(input.getAttribute("maxlength")).toBe("500");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.getAttribute("enterkeyhint")).toBe("search");
    expect(input.getAttribute("placeholder")).toBe("Search by book title…");
    expect((input as HTMLInputElement).value).toBe("a");

    const label = form.querySelector(`label[for="${input.id}"]`)!;
    expect(label.textContent).toBe("Search novels by title");
    expect(label.className).toContain("sr-only");

    const button = form.querySelector("button")!;
    expect(button.getAttribute("type")).toBe("submit");
    expect(button.textContent).toBe("Search");
    expect(button.className).toContain("bg-novel-accent");
    expect(button.className).toContain("text-novel-on-accent");
    expect(button.className).toContain("h-11");
    expect(input.className).toContain("h-11");
    expect(form.querySelectorAll("input")).toHaveLength(1); // 只有 q，没有隐藏的 page
  });

  it("源码里没有客户端指令 / 事件处理 / dangerouslySetInnerHTML", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    for (const file of ["SearchForm.tsx", "SearchScreen.tsx"]) {
      const source = readFileSync(path.resolve(import.meta.dirname, "../../src/features/public-ui/search", file), "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code).not.toContain("use client");
      expect(code).not.toMatch(/dangerouslySetInnerHTML|onSubmit|onChange|useState|useEffect/);
    }
  });
});

describe("各状态文案", () => {
  it("idle：提示输入书名；没有结果区、没有翻页条", async () => {
    const container = await renderPage("en");
    expect(status(container).textContent).toBe("Enter a book title to start searching.");
    expect(container.querySelector('[data-testid="book-grid"]')).toBeNull();
    expect(container.querySelector('[data-testid="pagination"]')).toBeNull();
  });

  it("too_short：至少 2 个字，输入框回填归一后的词", async () => {
    loadSearchPage.mockResolvedValue(response({ status: "too_short", displayQuery: "a" }));
    const container = await renderPage("en", { q: "  a " });
    expect(status(container).textContent).toBe("Enter at least 2 characters to search.");
    expect((container.querySelector("input") as HTMLInputElement).value).toBe("a");
  });

  it("too_long：不超过 500 个字", async () => {
    loadSearchPage.mockResolvedValue(response({ status: "too_long", displayQuery: "a".repeat(501) }));
    const container = await renderPage("en", { q: "a".repeat(501) });
    expect(status(container).textContent).toBe("Enter no more than 500 characters.");
  });

  it("unavailable：暂时不可用，页面不报错", async () => {
    loadSearchPage.mockResolvedValue(response({ status: "unavailable", displayQuery: "alpha" }));
    const container = await renderPage("en", { q: "alpha" });
    expect(status(container).textContent).toBe("Search is temporarily unavailable. Please try again later.");
    expect(container.querySelector('[data-testid="book-grid"]')).toBeNull();
  });

  it("ok 有结果：Results for \"query\" + 作品数 + 网格", async () => {
    loadSearchPage.mockResolvedValue(response({ status: "ok", displayQuery: "alpha", items: cards(20), totalCount: 45, totalPages: 3 }));
    const container = await renderPage("en", { q: "alpha" });
    expect(status(container).textContent).toBe('Results for "alpha"45 works');
    expect(container.querySelectorAll('[data-testid="book-card"]')).toHaveLength(20);
    expect(container.querySelector("h1")!.textContent).toBe("Search");
  });

  it("ok 只有 1 本：作品数用 '1 work'", async () => {
    loadSearchPage.mockResolvedValue(response({ status: "ok", displayQuery: "alpha", items: cards(1), totalCount: 1 }));
    const container = await renderPage("en", { q: "alpha" });
    expect(status(container).textContent).toBe('Results for "alpha"1 work');
  });

  it("ok 零结果：No results found，下一行整句 emptyHint 是指向本语种 /browse 的链接", async () => {
    loadSearchPage.mockResolvedValue(response({ status: "ok", displayQuery: "zzz" }));
    const en = await renderPage("en", { q: "zzz" });
    expect(status(en).textContent).toBe('No results found for "zzz".');
    const link = en.querySelector("main header a")!;
    expect(link.textContent).toBe("Try browsing all works instead.");
    expect(link.getAttribute("href")).toBe("/browse");
    expect(en.querySelector('[data-testid="book-grid"]')).toBeNull();
    expect(en.querySelector('[data-testid="pagination"]')).toBeNull();
  });

  it("零结果的链接带语种前缀", async () => {
    loadSearchPage.mockResolvedValue(response({ status: "ok", displayQuery: "zzz" }));
    const container = await renderPage("ja", { q: "zzz" });
    expect(container.querySelector("main header a")!.getAttribute("href")).toBe("/ja/browse");
    expect(container.querySelector("main header a")!.textContent).toBe(getPublicT("ja")("search.emptyHint"));
  });

  it("有结果时没有 emptyHint 链接", async () => {
    loadSearchPage.mockResolvedValue(response({ status: "ok", displayQuery: "alpha", items: cards(3), totalCount: 3 }));
    const container = await renderPage("en", { q: "alpha" });
    expect(container.querySelector("main header a")).toBeNull();
  });
});

describe("翻页条：basePath、q、第 2 页起 page、不预取", () => {
  it("第 1 页：下一页 /search?q=alpha&page=2；没有上一页链接", async () => {
    loadSearchPage.mockResolvedValue(response({ status: "ok", displayQuery: "alpha", items: cards(20), totalCount: 45, totalPages: 3, page: 1 }));
    const container = await renderPage("en", { q: "alpha" });
    const nav = container.querySelector('[data-testid="pagination"]')!;
    const hrefs = [...nav.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/search?q=alpha&page=2"]);
  });

  it("第 2 页：上一页回到不带 page 的 /search?q=alpha；下一页 page=3；非英语带前缀；q 里的空格是 +", async () => {
    loadSearchPage.mockResolvedValue(response({ status: "ok", displayQuery: "Alpha King", items: cards(20, 20), totalCount: 45, totalPages: 3, page: 2 }));
    const container = await renderPage("ja", { q: "Alpha King", page: "2" });
    const hrefs = [...container.querySelectorAll('[data-testid="pagination"] a')].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/ja/search?q=Alpha+King", "/ja/search?q=Alpha+King&page=3"]);
    expect(loadSearchPage).toHaveBeenCalledWith("ja", "Alpha King", 2);
  });

  it("只有 1 页：不渲染翻页条", async () => {
    loadSearchPage.mockResolvedValue(response({ status: "ok", displayQuery: "alpha", items: cards(5), totalCount: 5, totalPages: 1 }));
    const container = await renderPage("en", { q: "alpha" });
    expect(container.querySelector('[data-testid="pagination"]')).toBeNull();
  });
});

describe("q 与 page 参数", () => {
  it("q 重复时取第一个", async () => {
    await renderPage("en", { q: ["first", "second"] });
    expect(loadSearchPage).toHaveBeenCalledWith("en", "first", 1);
  });

  it("没有 q 时原始查询是空串", async () => {
    await renderPage("en", {});
    expect(loadSearchPage).toHaveBeenCalledWith("en", "", 1);
  });

  it("page 空 = 第 1 页", async () => {
    await renderPage("en", { q: "alpha", page: "" });
    expect(loadSearchPage).toHaveBeenCalledWith("en", "alpha", 1);
  });

  it.each(["abc", "0", "-1", "01", "1.5", " 2", "2 ", "1e2", "٣"])("非法页码 %j → 404", async (page) => {
    await expectNotFound("en", { q: "alpha", page });
    expect(loadSearchPage).not.toHaveBeenCalled();
  });

  it("其它参数一律忽略", async () => {
    await renderPage("en", { q: "alpha", utm_source: "x", category: "romance" } as never);
    expect(loadSearchPage).toHaveBeenCalledWith("en", "alpha", 1);
  });
});

describe("页码越界 → 404", () => {
  it("ok 且 page > totalPages", async () => {
    loadSearchPage.mockResolvedValue(response({ status: "ok", displayQuery: "alpha", items: [], totalCount: 45, totalPages: 3, page: 4 }));
    await expectNotFound("en", { q: "alpha", page: "4" });
  });

  it("ok 且 page = totalPages 正常渲染", async () => {
    loadSearchPage.mockResolvedValue(response({ status: "ok", displayQuery: "alpha", items: cards(5, 40), totalCount: 45, totalPages: 3, page: 3 }));
    const container = await renderPage("en", { q: "alpha", page: "3" });
    expect(container.querySelectorAll('[data-testid="book-card"]')).toHaveLength(5);
  });

  it("没有结果时只有第 1 页合法：零结果的第 2 页 404", async () => {
    loadSearchPage.mockResolvedValue(response({ status: "ok", displayQuery: "zzz", totalCount: 0, totalPages: 1, page: 2 }));
    await expectNotFound("en", { q: "zzz", page: "2" });
  });

  it("没输入 / 太短 / 太长的状态没有页：page=2 → 404", async () => {
    for (const statusValue of ["idle", "too_short", "too_long"] as const) {
      loadSearchPage.mockResolvedValue(response({ status: statusValue, page: 2 }));
      await expectNotFound("en", { q: "a", page: "2" });
    }
  });

  it("数据库出错时不知道总页数，不判页码：渲染'暂不可用'提示", async () => {
    loadSearchPage.mockResolvedValue(response({ status: "unavailable", displayQuery: "alpha", page: 2 }));
    const container = await renderPage("en", { q: "alpha", page: "2" });
    expect(status(container).textContent).toBe("Search is temporarily unavailable. Please try again later.");
  });

  it("超大页码（服务层按第 1 页兜底、返回 totalPages）也用读者请求的页码判 404", async () => {
    loadSearchPage.mockResolvedValue(response({ status: "ok", displayQuery: "alpha", items: [], totalCount: 45, totalPages: 3, page: 1 }));
    await expectNotFound("en", { q: "alpha", page: "9".repeat(400) });
  });
});

describe("搜索词按文本输出，不转义成 HTML", () => {
  const nasty = '<script>alert("x")</script> & <img src=x onerror=alert(1)>';

  it("状态文案、输入框回填都是文本；DOM 里没有注入的元素", async () => {
    loadSearchPage.mockResolvedValue(response({ status: "ok", displayQuery: nasty }));
    const container = await renderPage("en", { q: nasty });
    expect(status(container).textContent).toBe(`No results found for "${nasty}".`);
    expect((container.querySelector("input") as HTMLInputElement).value).toBe(nasty);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img[onerror]")).toBeNull();
    // 状态行里只有我们自己渲染的 <span>，没有被注入的元素（innerHTML 里 `<` 在属性值中本来就不转义，不能拿它断言）。
    expect([...status(container).querySelectorAll("*")].map((node) => node.tagName)).toEqual(["SPAN"]);
    expect(container.querySelector("main header")!.innerHTML).toContain("&lt;script&gt;");
  });
});

describe("15 个语种都能渲染各状态（文案来自各自目录）", () => {
  it.each(SITE_LOCALES)("%s", async (locale) => {
    const t = getPublicT(locale);
    loadSearchPage.mockResolvedValue(response({ status: "ok", displayQuery: "alpha", items: cards(2), totalCount: 2 }));
    const container = await renderPage(locale, { q: "alpha" });
    expect(container.querySelector("h1")!.textContent).toBe(t("search.title"));
    expect(status(container).textContent).toBe(`${t("search.resultsHeading", { query: "alpha" })}${t("collection.workCount", { count: 2 })}`);
    expect(container.querySelector("form button")!.textContent).toBe(t("search.submit"));
    expect(container.querySelector("form input")!.getAttribute("placeholder")).toBe(t("search.inputPlaceholder"));
    expect(container.querySelector("form label")!.textContent).toBe(t("search.inputLabel"));

    loadSearchPage.mockResolvedValue(response({ status: "idle" }));
    expect(status((await renderPage(locale)).ownerDocument.body)).toBeTruthy();
  });
});

describe("请求内去重：元数据与正文用同样的实参调用同一个加载器", () => {
  it("同一个 (语种, 原始 q, 页码)", async () => {
    loadSearchPage.mockResolvedValue(response({ status: "ok", displayQuery: "alpha", items: cards(2), totalCount: 2 }));
    await buildSearchMetadata("en", Promise.resolve({ q: "alpha", page: "1" }));
    await renderPage("en", { q: "alpha", page: "1" });
    expect(loadSearchPage.mock.calls).toEqual([
      ["en", "alpha", 1],
      ["en", "alpha", 1],
    ]);
  });

  it("createSearchPageLoader：memoize 包一层，按 (语种, q, 页码) 三个原始值调用底层搜索", async () => {
    const { createSearchPageLoader } = await vi.importActual<typeof import("@/app/_lib/search-load")>("@/app/_lib/search-load");
    const memo = new Map<string, Promise<SiteSearchResponse>>();
    const memoize = vi.fn(<A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R => {
      const key = JSON.stringify(args);
      if (!memo.has(key)) memo.set(key, fn(...args) as never);
      return memo.get(key) as R;
    });
    const search = vi.fn(async () => response({ status: "ok", displayQuery: "alpha" }));
    const loader = createSearchPageLoader(memoize as never, search);
    const [a, b] = await Promise.all([loader("en", "alpha", 2), loader("en", "alpha", 2)]);
    expect(a).toBe(b);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith({ locale: "en", query: "alpha", page: 2 });
    expect(memoize).toHaveBeenCalledTimes(1);
  });
});

describe("元数据（页面层接线）", () => {
  it("有结果：index,follow + 自引用 canonical；非法页码：Not found + noindex,nofollow", async () => {
    loadSearchPage.mockResolvedValue(response({ status: "ok", displayQuery: "alpha", items: cards(2), totalCount: 2 }));
    const ok = await buildSearchMetadata("en", Promise.resolve({ q: "alpha" }));
    expect(ok.robots).toEqual({ index: true, follow: true });
    expect(ok.alternates).toEqual({ canonical: "https://example.test/search?q=alpha" });

    const bad = await buildSearchMetadata("en", Promise.resolve({ q: "alpha", page: "x" }));
    expect(bad.title).toBe("Not found");
    expect(bad.robots).toEqual({ index: false, follow: false });
  });

  it("各状态的页面层元数据（接线）：零结果 noindex,follow + 裸 canonical；没输入 / 太短 / 太长 noindex,follow；出错 noindex,nofollow", async () => {
    const cases: Array<[Partial<SiteSearchResponse> & Pick<SiteSearchResponse, "status">, { index: boolean; follow: boolean }]> = [
      [{ status: "ok", displayQuery: "zzz" }, { index: false, follow: true }],
      [{ status: "idle" }, { index: false, follow: true }],
      [{ status: "too_short", displayQuery: "a" }, { index: false, follow: true }],
      [{ status: "too_long", displayQuery: "a".repeat(501) }, { index: false, follow: true }],
      [{ status: "unavailable", displayQuery: "alpha" }, { index: false, follow: false }],
    ];
    for (const [partial, robots] of cases) {
      loadSearchPage.mockResolvedValue(response(partial));
      const metadata = await buildSearchMetadata("en", Promise.resolve({ q: partial.displayQuery ?? "" }));
      expect(metadata.robots, partial.status).toEqual(robots);
      expect(metadata.alternates, partial.status).toEqual({ canonical: "https://example.test/search" });
    }
  });

  it("有结果的第 2 页：canonical 自引用带 page", async () => {
    loadSearchPage.mockResolvedValue(response({ status: "ok", displayQuery: "alpha", items: cards(20, 20), totalCount: 45, totalPages: 3, page: 2 }));
    const metadata = await buildSearchMetadata("ja", Promise.resolve({ q: "alpha", page: "2" }));
    expect(metadata.robots).toEqual({ index: true, follow: true });
    expect(metadata.alternates).toEqual({ canonical: "https://example.test/ja/search?q=alpha&page=2" });
  });

  it("越界页的元数据同样是 Not found", async () => {
    loadSearchPage.mockResolvedValue(response({ status: "ok", displayQuery: "alpha", items: [], totalCount: 45, totalPages: 3, page: 4 }));
    const metadata = await buildSearchMetadata("en", Promise.resolve({ q: "alpha", page: "4" }));
    expect(metadata.title).toBe("Not found");
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
