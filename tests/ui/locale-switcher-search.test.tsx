import "./setup-cleanup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { loadMessages } from "@/lib/locale/messages";
import { MessagesProvider } from "@/lib/locale/messages/MessagesProvider";

/**
 * PN-15：搜索页的语种切换——直接切到目标语种的 `/search`，**只带 `q`、去掉 `page`**。
 * 其它页面的计划与 href 完全不变（网址冻结：下面"其它页面不变"一组钉住）。
 */
const routerPush = vi.fn();
let mockPathname = "/";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: routerPush }),
}));

const {
  LocaleSwitcher,
  buildDirectLocaleSwitchHref,
  buildLocaleSwitchHref,
  localeSwitchSearch,
  planLocaleSwitch,
} = await import("@/features/public-ui/layout/LocaleSwitcher");

function renderSwitcher(locale: SiteLocale, activeLocales: readonly SiteLocale[]) {
  return render(
    <MessagesProvider locale={locale} messages={loadMessages(locale)}>
      <LocaleSwitcher activeLocales={activeLocales} />
    </MessagesProvider>,
  );
}

function clickLocale(nativeName: string) {
  fireEvent.click(screen.getByRole("button", { name: /Language|言語/ }));
  const item = within(screen.getByRole("menu")).getByRole("menuitem", { name: nativeName });
  fireEvent.click(item);
  return item;
}

beforeEach(() => {
  routerPush.mockReset();
  mockPathname = "/";
  window.history.pushState({}, "", "/");
});

afterEach(() => {
  window.sessionStorage.clear();
  document.cookie = "NEXT_LOCALE=; Max-Age=0; Path=/";
  window.history.pushState({}, "", "/");
});

describe("planLocaleSwitch：搜索页是直接切换", () => {
  it.each(["/search", "/ja/search", "/pt-BR/search", "/zh-Hant/search", "/search/"])("%s → direct", (pathname) => {
    expect(planLocaleSwitch(pathname)).toEqual({ kind: "direct" });
    expect(planLocaleSwitch(pathname, "?q=alpha&page=2")).toEqual({ kind: "direct" });
  });

  it.each(["/search/foo", "/ja/search/foo", "/searchx", "/ja/searchx", "/search-results", "/novel/search"])(
    "%s 不是搜索页：不被新规则吞掉",
    (pathname) => {
      expect(planLocaleSwitch(pathname).kind).not.toBe("direct");
    },
  );
});

describe("其它页面的计划与 href 完全不变（网址冻结）", () => {
  const PLANS: Array<[string, string | undefined, unknown]> = [
    ["/", undefined, { kind: "direct" }],
    ["/ko", undefined, { kind: "direct" }],
    ["/browse", undefined, { kind: "direct" }],
    ["/ko/browse", "?page=2", { kind: "direct" }],
    ["/browse", "?category=romance", { kind: "fallback" }],
    ["/blog", undefined, { kind: "direct" }],
    ["/ko/blog", undefined, { kind: "direct" }],
    ["/novel/lantern-pabc12345", undefined, { kind: "novel", slugParam: "lantern-pabc12345" }],
    ["/novel/lantern-pabc12345/chapter/3", undefined, { kind: "fallback" }],
    ["/category/romance", undefined, { kind: "fallback" }],
    ["/blog/some-post", undefined, { kind: "fallback" }],
    ["/no-such-page", undefined, { kind: "fallback" }],
    ["/novel", undefined, { kind: "fallback" }],
  ];
  it.each(PLANS)("planLocaleSwitch(%s, %s)", (pathname, search, expected) => {
    expect(planLocaleSwitch(pathname, search)).toEqual(expected);
  });

  it("非搜索页：要带的 query string 原样不动（含 page 与其它参数）", () => {
    expect(localeSwitchSearch("/browse", "?page=2")).toBe("?page=2");
    expect(localeSwitchSearch("/ko/browse", "?category=romance&page=2&x=1")).toBe("?category=romance&page=2&x=1");
    expect(localeSwitchSearch("/blog", "?page=3")).toBe("?page=3");
    expect(localeSwitchSearch("/novel/x-p1", "?q=alpha&page=2")).toBe("?q=alpha&page=2");
    expect(localeSwitchSearch("/", "")).toBe("");
    expect(localeSwitchSearch("/browse", undefined)).toBe("");
  });

  it("非搜索页：直接切换的 href 与 buildLocaleSwitchHref 逐字一致", () => {
    for (const [pathname, target, search] of [
      ["/browse", "ja", "?page=2"],
      ["/ko/browse", "en", "?page=2"],
      ["/blog", "de", undefined],
      ["/", "fr", undefined],
      ["/ja", "en", ""],
    ] as const) {
      expect(buildDirectLocaleSwitchHref(pathname, target, search)).toBe(buildLocaleSwitchHref(pathname, target, search));
    }
    expect(buildDirectLocaleSwitchHref("/browse", "ja", "?page=2")).toBe("/ja/browse?page=2");
    expect(buildDirectLocaleSwitchHref("/ko/browse", "en", "?page=2")).toBe("/browse?page=2");
  });
});

describe("搜索页：只带 q，去掉 page", () => {
  it("localeSwitchSearch", () => {
    expect(localeSwitchSearch("/search", "?q=alpha&page=3")).toBe("?q=alpha");
    expect(localeSwitchSearch("/ja/search", "?page=3&q=alpha")).toBe("?q=alpha");
    expect(localeSwitchSearch("/search", "?q=Alpha+King&utm_source=x")).toBe("?q=Alpha+King");
    expect(localeSwitchSearch("/search", "?q=a&q=b")).toBe("?q=a");
    expect(localeSwitchSearch("/search", "?page=3")).toBe("");
    expect(localeSwitchSearch("/search", "?q=")).toBe("");
    expect(localeSwitchSearch("/search", "")).toBe("");
    expect(localeSwitchSearch("/search", undefined)).toBe("");
    expect(localeSwitchSearch("/search", "?q=%E6%84%9B")).toBe("?q=%E6%84%9B");
  });

  it("目标语种的 /search，带 q 不带 page", () => {
    expect(buildDirectLocaleSwitchHref("/search", "ja", "?q=alpha&page=3")).toBe("/ja/search?q=alpha");
    expect(buildDirectLocaleSwitchHref("/ja/search", "en", "?q=alpha&page=3")).toBe("/search?q=alpha");
    expect(buildDirectLocaleSwitchHref("/pt-BR/search", "zh-Hant", "?q=%E6%84%9B")).toBe("/zh-Hant/search?q=%E6%84%9B");
    expect(buildDirectLocaleSwitchHref("/search", "ja", "?page=3")).toBe("/ja/search");
    expect(buildDirectLocaleSwitchHref("/search", "fr", undefined)).toBe("/fr/search");
  });

  it("搜索词里出现 localhost / 127.0.0.1 / :3000 不会触发同源守卫把读者送回首页", () => {
    expect(buildDirectLocaleSwitchHref("/search", "ja", "?q=localhost+tutorial")).toBe("/ja/search?q=localhost+tutorial");
    expect(buildDirectLocaleSwitchHref("/search", "ja", "?q=127.0.0.1")).toBe("/ja/search?q=127.0.0.1");
    // 其它页面的守卫行为不变：路径含这些字样仍然折叠成首页。
    expect(buildLocaleSwitchHref("/browse", "ja", "?x=localhost")).toBe("/");
  });

  it("q 里的特殊字符被编码，不可能构成协议头或 //", () => {
    const href = buildDirectLocaleSwitchHref("/search", "ja", `?q=${encodeURIComponent("javascript:alert(1)//x")}`);
    expect(href.startsWith("/ja/search?q=")).toBe(true);
    expect(href).not.toContain("//");
    expect(href).not.toContain("javascript:");
  });
});

describe("组件：在搜索页点击切换语种", () => {
  it("/search?q=alpha&page=3 → 点日本語 → router.push('/ja/search?q=alpha')（page 去掉）", () => {
    mockPathname = "/search";
    window.history.pushState({}, "", "/search?q=alpha&page=3");
    renderSwitcher("en", ["en", "ja"]);
    clickLocale("日本語");
    expect(routerPush).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith("/ja/search?q=alpha");
  });

  it("/ja/search?q=Alpha+King → 点 English → '/search?q=Alpha+King'", () => {
    mockPathname = "/ja/search";
    window.history.pushState({}, "", "/ja/search?q=Alpha+King&page=2");
    renderSwitcher("ja", ["en", "ja"]);
    clickLocale("English");
    expect(routerPush).toHaveBeenCalledWith("/search?q=Alpha+King");
  });

  it("没有 q（只有 page 或什么都没有）：交给链接自己的 href（目标语种的裸 /search），不 router.push", () => {
    mockPathname = "/search";
    window.history.pushState({}, "", "/search?page=3");
    renderSwitcher("en", ["en", "ja"]);
    // React 的处理器先于 document 上的监听器运行，所以这里在 document 冒泡阶段拦下 jsdom 的默认导航，
    // 又不会让组件看到 defaultPrevented。
    const stopNavigation = (event: Event) => event.preventDefault();
    document.addEventListener("click", stopNavigation);
    const item = clickLocale("日本語");
    document.removeEventListener("click", stopNavigation);
    expect(routerPush).not.toHaveBeenCalled();
    expect(item.getAttribute("href")).toBe("/ja/search");
  });

  it("菜单里每个条目的静态 href 是目标语种的 /search（水合安全，不读 window.location）", () => {
    mockPathname = "/ja/search";
    renderSwitcher("ja", ["en", "ja", "de"]);
    fireEvent.click(screen.getByRole("button", { name: /言語|Language/ }));
    const hrefByName = Object.fromEntries(
      within(screen.getByRole("menu")).getAllByRole("menuitem").map((item) => [item.textContent, item.getAttribute("href")]),
    );
    expect(hrefByName).toEqual({ English: "/search", Deutsch: "/de/search", "日本語": "/ja/search" });
  });

  it("其它页面（/browse?page=2）的点击行为不变：整段 query 原样带上", () => {
    mockPathname = "/browse";
    window.history.pushState({}, "", "/browse?page=2");
    renderSwitcher("en", ["en", "ja"]);
    clickLocale("日本語");
    expect(routerPush).toHaveBeenCalledWith("/ja/browse?page=2");
  });
});
