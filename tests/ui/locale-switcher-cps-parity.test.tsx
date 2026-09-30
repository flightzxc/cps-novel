import "./setup-cleanup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT, loadMessages } from "@/lib/locale/messages";
import { MessagesProvider } from "@/lib/locale/messages/MessagesProvider";

/**
 * 2026-09-30 语种切换对齐短剧站（开发单：语种切换、404 页面与跨语种链接对齐 CPS）。
 *
 * 这份用例钉的是切换器**点击之后去哪儿**——旧实现只把旧前缀换成新前缀、路径原样
 * 保留，韩语书/章节页切到 en 就是 404（`/novel/{韩语 slug}` 在 en 下不存在）。
 * 新行为（照搬 CPS `switchLocale`，`v8.5.1:src/components/site/locale-switcher.tsx:174-234`）：
 *
 * - 首页 / `/browse` / `/blog`：直接切换；
 * - 书的详情页：先查 `/api/novel-locale-check`，有对应版本直接跳，没有或出错 →
 *   弹提示 + 跳目标语种首页；
 * - 章节页、分类页及其它一切：不查，直接弹提示 + 跳目标语种首页。
 *
 * 与旧 `locale-switcher*.test.tsx` 分开成独立文件：旧文件里的断言（直接切换的
 * 纯函数、菜单语义、`/browse` 上的 query 保留）在新行为下依旧成立，一条没改；
 * 这里只放新增行为。
 */
const routerPush = vi.fn();
let mockPathname = "/";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: routerPush }),
}));

const { LocaleSwitcher, planLocaleSwitch, buildLocaleHomeHref } = await import(
  "@/features/public-ui/layout/LocaleSwitcher"
);

const fetchMock = vi.fn();

function renderSwitcher(locale: SiteLocale, activeLocales: readonly SiteLocale[]) {
  return render(
    <MessagesProvider locale={locale} messages={loadMessages(locale)}>
      <LocaleSwitcher activeLocales={activeLocales} />
    </MessagesProvider>,
  );
}

function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: /Language|언어/ }));
  return screen.getByRole("menu");
}

/** 打开菜单并左键点击某个语种条目（按其本语自称）。 */
function clickLocale(nativeName: string) {
  const item = within(openMenu()).getByRole("menuitem", { name: nativeName });
  fireEvent.click(item);
  return item;
}

function toastText(locale: SiteLocale, target: string): string {
  return getPublicT(locale)("localeSwitcher.fallbackToast", { locale: target });
}

beforeEach(() => {
  routerPush.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  mockPathname = "/";
  window.history.pushState({}, "", "/");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.sessionStorage.clear();
  document.cookie = "NEXT_LOCALE=; Max-Age=0; Path=/";
  window.history.pushState({}, "", "/");
});

describe("planLocaleSwitch — 哪些路径可以直接切换、哪些要查、哪些走保底", () => {
  it.each([
    ["/", undefined],
    ["/ko", undefined],
    ["/browse", undefined],
    ["/ko/browse", undefined],
    ["/browse", "?page=2"],
    ["/browse", "?utm_source=x"],
    ["/blog", undefined],
    ["/ko/blog", undefined],
  ])("%s %s → direct（每个已登记语种都有这个页面）", (pathname, search) => {
    expect(planLocaleSwitch(pathname, search)).toEqual({ kind: "direct" });
  });

  it("书的详情页 → novel，slugParam 已解码", () => {
    expect(planLocaleSwitch("/novel/lantern-pabc12345")).toEqual({ kind: "novel", slugParam: "lantern-pabc12345" });
    expect(planLocaleSwitch("/ko/novel/lantern-pabc12345/")).toEqual({ kind: "novel", slugParam: "lantern-pabc12345" });
    expect(planLocaleSwitch("/ko/novel/%EB%93%B1%EB%8C%80-pabc12345")).toEqual({
      kind: "novel",
      slugParam: "등대-pabc12345",
    });
  });

  it.each([
    "/novel/lantern-pabc12345/chapter/3",
    "/ko/novel/lantern-pabc12345/chapter/3",
    "/category/romance",
    "/ko/category/romance",
    "/blog/some-post",
    "/ko/blog/some-post",
    "/novel",
    "/novel/a/b",
    "/no-such-page",
  ])("%s → fallback（目标语种未必有这个页面，也不去查）", (pathname) => {
    expect(planLocaleSwitch(pathname)).toEqual({ kind: "fallback" });
  });

  it("/browse?category=… → fallback（分类在目标语种没有文章时是 404）", () => {
    expect(planLocaleSwitch("/browse", "?category=romance")).toEqual({ kind: "fallback" });
    expect(planLocaleSwitch("/ko/browse", "?page=2&category=romance")).toEqual({ kind: "fallback" });
  });

  it("buildLocaleHomeHref：en 是 /，其它是 /{locale}，不会出现 /{locale}/", () => {
    expect(buildLocaleHomeHref("en")).toBe("/");
    expect(buildLocaleHomeHref("ko")).toBe("/ko");
    expect(buildLocaleHomeHref("pt-BR")).toBe("/pt-BR");
  });
});

describe("书的详情页切换语种（照搬 CPS switchLocale + /api/novel-locale-check）", () => {
  beforeEach(() => {
    mockPathname = "/ko/novel/deungdae-pabc12345";
  });

  it("目标语种有这本书的公开页 → 直接跳到接口给的路径，不弹提示", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ hasMatch: true, path: "/novel/lantern-pxyz98765" }),
    });
    renderSwitcher("ko", ["en", "ko"]);

    clickLocale("English");

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/novel/lantern-pxyz98765"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/novel-locale-check?slug=deungdae-pabc12345&target=en");
    expect(screen.queryByRole("status")).toBeNull();
    expect(routerPush).toHaveBeenCalledTimes(1);
  });

  it("接口给的是带前缀的路径时不会重复加前缀（目标是非 en 语种）", async () => {
    mockPathname = "/novel/lantern-pxyz98765";
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ hasMatch: true, path: "/ko/novel/deungdae-pabc12345" }),
    });
    renderSwitcher("en", ["en", "ko"]);

    clickLocale("한국어");

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/ko/novel/deungdae-pabc12345"));
  });

  it("目标语种没有这本书 → 弹提示（源语种文案，{locale} 是目标语种自称）+ 跳目标语种首页，不跳 404 路径", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ hasMatch: false }) });
    renderSwitcher("ko", ["en", "ko"]);

    clickLocale("English");

    await waitFor(() => expect(routerPush).toHaveBeenCalledTimes(1));
    expect(routerPush).toHaveBeenCalledWith("/");
    expect(screen.getByRole("status").textContent).toBe(toastText("ko", "English"));
  });

  it("接口出错（网络失败）→ 同样弹提示 + 跳目标语种首页", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    renderSwitcher("ko", ["en", "ko"]);

    clickLocale("English");

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/"));
    expect(screen.getByRole("status").textContent).toBe(toastText("ko", "English"));
  });

  it("接口返回 5xx → 同样弹提示 + 跳目标语种首页（不因为 500 把用户留在原地）", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({ hasMatch: false }) });
    renderSwitcher("ko", ["en", "ko"]);

    clickLocale("English");

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/"));
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("接口 5 秒不返回 → 按出错处理（弹提示 + 回目标首页），不让用户卡死", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    renderSwitcher("ko", ["en", "ko"]);

    clickLocale("English");
    expect(routerPush).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
    });

    expect(routerPush).toHaveBeenCalledWith("/");
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("上一次切换还没落地时，再点不会重复发起查询", async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    fetchMock.mockReturnValue(new Promise((resolve) => (resolveFetch = resolve)));
    renderSwitcher("ko", ["en", "ko", "es"]);

    clickLocale("English");
    clickLocale("Español");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch({ ok: true, json: async () => ({ hasMatch: false }) });
    await waitFor(() => expect(routerPush).toHaveBeenCalledTimes(1));
  });
});

describe("章节页 / 分类页 / 博客文章页 / 其它路径：不查对应关系，直接弹提示 + 跳目标语种首页", () => {
  it.each([
    ["章节页", "/ko/novel/deungdae-pabc12345/chapter/3"],
    ["分类页", "/ko/category/romance"],
    ["博客文章页", "/ko/blog/some-post"],
    ["一个不存在的地址（404 页本身）", "/ko/no-such-page"],
  ])("%s：一次网络请求都不发，弹提示，跳 en 首页", async (_label, pathname) => {
    mockPathname = pathname;
    renderSwitcher("ko", ["en", "ko"]);

    clickLocale("English");

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe(toastText("ko", "English"));
  });

  it("目标是非 en 语种时跳的是 /{locale} 而不是 /{locale}/", async () => {
    mockPathname = "/ko/novel/deungdae-pabc12345/chapter/3";
    renderSwitcher("ko", ["en", "ko", "es"]);

    clickLocale("Español");

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/es"));
    expect(screen.getByRole("status").textContent).toBe(toastText("ko", "Español"));
  });

  it("/browse?category=… 同样走保底", async () => {
    mockPathname = "/ko/browse";
    window.history.pushState({}, "", "/ko/browse?category=romance");
    renderSwitcher("ko", ["en", "ko"]);

    clickLocale("English");

    await waitFor(() => expect(routerPush).toHaveBeenCalled());
    expect(routerPush).toHaveBeenCalledWith("/?category=romance");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("菜单条目的 href 在保底页上是目标语种首页（新标签打开也不会落进 404 路径）", () => {
    mockPathname = "/ko/novel/deungdae-pabc12345/chapter/3";
    renderSwitcher("ko", ["en", "ko", "es"]);

    const menu = openMenu();
    expect(within(menu).getByRole("menuitem", { name: "English" }).getAttribute("href")).toBe("/");
    expect(within(menu).getByRole("menuitem", { name: "Español" }).getAttribute("href")).toBe("/es");
  });

  it("带修饰键的点击交给浏览器：不查询、不弹提示、不写 cookie、不接管跳转", () => {
    mockPathname = "/ko/novel/deungdae-pabc12345/chapter/3";
    renderSwitcher("ko", ["en", "ko"]);

    const item = within(openMenu()).getByRole("menuitem", { name: "English" });
    item.addEventListener("click", (event) => event.preventDefault()); // 抑制 jsdom 的导航噪音
    fireEvent.click(item, { ctrlKey: true });

    expect(routerPush).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.cookie).not.toContain("NEXT_LOCALE");
  });
});

describe("直接切换的页面保持不变（首页 / 浏览页 / 博客列表）", () => {
  it("首页：不查询、不弹提示；条目 href 直接就是目标语种首页，不接管点击", () => {
    mockPathname = "/ko";
    renderSwitcher("ko", ["en", "ko"]);

    const item = clickLocale("English");
    expect(item.getAttribute("href")).toBe("/");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled(); // 没有 query 时交给 <Link> 自己导航
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("浏览页带 query 时点击读当前 query，直接带过去（与旧行为一致）", () => {
    mockPathname = "/ko/browse";
    window.history.pushState({}, "", "/ko/browse?page=2");
    renderSwitcher("ko", ["en", "ko"]);

    clickLocale("English");

    expect(routerPush).toHaveBeenCalledWith("/browse?page=2");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("NEXT_LOCALE cookie（CPS switchLocale 的第一行）", () => {
  it("点击切换时写入目标语种，之后首页 `/` 的根路径协商不会把 en 弹回 /ko", () => {
    mockPathname = "/ko";
    renderSwitcher("ko", ["en", "ko"]);

    clickLocale("English");

    expect(document.cookie).toContain("NEXT_LOCALE=en");
  });

  it("点当前语种什么都不做：不写 cookie、不查询、不跳转（并阻止 <Link> 的默认导航）", () => {
    mockPathname = "/ko/novel/deungdae-pabc12345/chapter/3";
    renderSwitcher("ko", ["en", "ko"]);

    const item = within(openMenu()).getByRole("menuitem", { name: "한국어" });
    const notPrevented = fireEvent.click(item);

    expect(notPrevented).toBe(false); // preventDefault 被调用
    expect(document.cookie).not.toContain("NEXT_LOCALE");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
  });
});

describe("提示跨页面存活（SiteShell 在页面 body 里，router.push 后切换器会重新挂载）", () => {
  it("回首页之后新挂载的切换器读回 sessionStorage 里的提示，继续显示剩余时间，到时消失", async () => {
    vi.useFakeTimers();
    mockPathname = "/ko/novel/deungdae-pabc12345/chapter/3";
    const first = renderSwitcher("ko", ["en", "ko"]);

    clickLocale("English");
    expect(routerPush).toHaveBeenCalledWith("/");
    expect(screen.getByRole("status").textContent).toBe(toastText("ko", "English"));

    // 导航：旧页面卸载，目标语种首页上新挂载一个切换器。
    first.unmount();
    expect(screen.queryByRole("status")).toBeNull();
    mockPathname = "/";
    renderSwitcher("en", ["en", "ko"]);

    // 读回来的仍是点击时按源语种（ko）生成的那句话。
    expect(screen.getByRole("status").textContent).toBe(toastText("ko", "English"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3600);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("过期的提示不会在之后的页面里冒出来", () => {
    window.sessionStorage.setItem(
      "novel:locale-switch-toast",
      JSON.stringify({ message: "stale", expiresAt: Date.now() - 1 }),
    );
    renderSwitcher("en", ["en", "ko"]);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("sessionStorage 里是坏数据也不影响渲染", () => {
    window.sessionStorage.setItem("novel:locale-switch-toast", "{not json");
    renderSwitcher("en", ["en", "ko"]);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Language" })).toBeTruthy();
  });
});

describe("语言菜单里 en 始终显示（CPS active.add(\"en\")）", () => {
  it("韩语页面 + 动态层给的集合里没有 en：菜单里仍有 English", () => {
    mockPathname = "/ko";
    renderSwitcher("ko", ["ko", "ru"]);

    const menu = openMenu();
    expect(within(menu).getByRole("menuitem", { name: "English" }).getAttribute("href")).toBe("/");
  });

  it("当前语种不在动态层集合里（例如访问一个还没有内容的语种页）也仍在菜单里，并标 aria-current", () => {
    mockPathname = "/ko";
    renderSwitcher("ko", ["en", "ru"]);

    const menu = openMenu();
    expect(within(menu).getByRole("menuitem", { name: "한국어" }).getAttribute("aria-current")).toBe("true");
    expect(within(menu).getByRole("menuitem", { name: "English" })).toBeTruthy();
  });

  it("菜单顺序按 SITE_LOCALES 登记顺序，不是传入顺序", () => {
    mockPathname = "/";
    renderSwitcher("en", ["ru", "ko", "en"]);

    const names = within(openMenu()).getAllByRole("menuitem").map((item) => item.textContent);
    expect(names).toEqual(["English", "한국어", "Русский"]);
  });
});
