import "./setup-cleanup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { SiteShell } from "@/features/public-ui/layout/SiteShell";
import { SITE_LOCALE_NATIVE_NAMES, SITE_LOCALES, type SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";
import { chromeFromSiteSetting } from "@/lib/site/chrome";
import { renderWithMessages } from "./render-with-messages";

/**
 * PN-15 第二批 · 页头搜索入口 + 手机页头方案 A。
 *
 * 网址冻结（语种菜单逐项不变）的守卫在 `header-locale-url-freeze.test.tsx`；这里管：
 * 开关、搜索入口三处呈现、手机页头结构（两个等大按钮 / 语种胶囊不出现）、手机菜单面板、
 * 当前页高亮、透明页头、从右到左、Esc、跨页提示条。
 *
 * jsdom 没有布局和媒体查询——「手机上不显示 / 桌面上显示」只能钉**类名契约**（`hidden` + `md:*`），
 * 真正的几何证据在浏览器验收（本机预览页 /dev-preview/header，320 / 390 / 768 / 1440 各取一次）。
 */

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/browse",
  useRouter: () => ({ push: routerPush }),
}));

const { SiteHeader } = await import("@/features/public-ui/layout/SiteHeader");

const NAV = [
  { label: "Home", href: "/", current: false },
  { label: "All works", href: "/browse", current: true },
];

const ACTIVE: readonly SiteLocale[] = ["en", "es", "ja", "ar"];

beforeEach(() => {
  routerPush.mockReset();
});

afterEach(() => {
  window.sessionStorage.clear();
});

/** 页头里「手机专属」的右侧按钮簇：`md:hidden` 且含菜单开关的那个容器。 */
function mobileCluster(): HTMLElement {
  const toggle = document.querySelector<HTMLElement>("button[aria-controls]:not([aria-haspopup])");
  expect(toggle).toBeTruthy();
  return toggle!.parentElement as HTMLElement;
}

function menuToggle(): HTMLElement {
  return screen.getByRole("button", { name: /^(Open|Close) menu$/ });
}

function openPanel(): HTMLElement {
  const toggle = menuToggle();
  if (toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle);
  return document.getElementById(toggle.getAttribute("aria-controls")!) as HTMLElement;
}

describe("开关：searchHref 缺省 = 页头里没有任何搜索入口", () => {
  it("缺省时：没有放大镜按钮、桌面导航没有搜索项、手机菜单面板里也没有", () => {
    const { container } = renderWithMessages(<SiteHeader navItems={NAV} activeLocales={ACTIVE} />);
    const panel = openPanel();

    expect(screen.queryByRole("link", { name: "Search" })).toBeNull();
    expect(container.querySelector('a[href$="/search"]')).toBeNull();
    // 桌面导航只有 navItems 的两项
    const desktopNav = container.querySelector("header nav.hidden") as HTMLElement;
    expect(within(desktopNav).getAllByRole("link").map((link) => link.textContent)).toEqual(["Home", "All works"]);
    // 手机菜单面板：两个导航项 + 语种行，没有搜索
    expect(within(panel).getAllByRole("link").map((link) => link.textContent)).toEqual(["Home", "All works"]);
    // 手机右侧只剩菜单开关
    expect(mobileCluster().children).toHaveLength(1);
  });

  it("有 searchHref 时：手机放大镜、手机菜单搜索行、桌面导航搜索项三处都在，href 正确", () => {
    const { container } = renderWithMessages(
      <SiteHeader navItems={NAV} activeLocales={ACTIVE} searchHref="/search" />,
    );
    const desktopNav = container.querySelector("header nav.hidden") as HTMLElement;
    const cluster = mobileCluster();

    const magnifier = within(cluster).getByRole("link", { name: "Search" });
    expect(magnifier.getAttribute("href")).toBe("/search");
    expect(within(desktopNav).getByRole("link", { name: "Search" }).getAttribute("href")).toBe("/search");

    const panel = openPanel();
    expect(within(panel).getByRole("link", { name: "Search" }).getAttribute("href")).toBe("/search");
  });

  it("非英语：href 带语种前缀，文案是该语种的 search.title", () => {
    const { container } = render(
      <SiteShell locale="fr" chrome={{ navItems: NAV, activeLocales: ACTIVE, searchHref: "/fr/search" }}>
        <p>正文</p>
      </SiteShell>,
    );
    const label = getPublicT("fr")("search.title");
    expect(label).toBe("Recherche");
    const links = container.querySelectorAll<HTMLAnchorElement>('header a[href="/fr/search"]');
    // 手机放大镜（aria-label）+ 桌面导航项（文字）
    expect(links).toHaveLength(2);
    expect(Array.from(links).map((link) => link.getAttribute("aria-label") ?? link.textContent)).toEqual([label, label]);
  });
});

describe("chromeFromSiteSetting：开关与 searchHref", () => {
  const BASE = {
    siteName: "PulseNovel",
    footerCopyrightText: "",
    footerDisclaimerText: "",
    friendLinks: [],
  };
  const settingsWith = (extra: Record<string, unknown>) =>
    ({ ...BASE, ...extra }) as unknown as Parameters<typeof chromeFromSiteSetting>[0];

  it.each([
    ["字段缺失（字段还没合入的分支）", {}],
    ["false", { siteSearchEnabled: false }],
    ["undefined", { siteSearchEnabled: undefined }],
    ["字符串 'true' 不是布尔 true", { siteSearchEnabled: "true" }],
    ["数字 1 不是布尔 true", { siteSearchEnabled: 1 }],
  ])("关：%s → chrome 里连 searchHref / searchCurrent 这两个 key 都不存在", (_name, extra) => {
    const chrome = chromeFromSiteSetting(settingsWith(extra), "en", "browse");
    expect("searchHref" in chrome).toBe(false);
    expect("searchCurrent" in chrome).toBe(false);
  });

  it("开：en 为 /search，其余 14 个语种为 /{语种}/search", () => {
    for (const locale of SITE_LOCALES) {
      const chrome = chromeFromSiteSetting(settingsWith({ siteSearchEnabled: true }), locale);
      expect(chrome.searchHref, locale).toBe(locale === "en" ? "/search" : `/${locale}/search`);
      expect(chrome.searchCurrent, locale).toBe(false);
    }
  });

  it("current='search'：searchCurrent 为 true，navItems 里没有任何一项被高亮", () => {
    const chrome = chromeFromSiteSetting(settingsWith({ siteSearchEnabled: true }), "ja", "search");
    expect(chrome.searchCurrent).toBe(true);
    expect(chrome.navItems?.map((item) => item.current)).toEqual([false, false]);
  });

  it("navItems 的形状与开关无关：恒为 首页 / 全部作品 两项，字段只有 label / href / current", () => {
    for (const enabled of [false, true]) {
      const chrome = chromeFromSiteSetting(settingsWith({ siteSearchEnabled: enabled }), "es", "home");
      expect(chrome.navItems).toEqual([
        { label: "Inicio", href: "/es", current: true },
        { label: "Todas las obras", href: "/es/browse", current: false },
      ]);
      expect(chrome.navItems?.every((item) => Object.keys(item).sort().join() === "current,href,label")).toBe(true);
    }
  });

  it("开关关闭时 chrome 的 key 集合与改动前逐字一致", () => {
    const chrome = chromeFromSiteSetting(settingsWith({}), "en", "home");
    expect(Object.keys(chrome).sort()).toEqual(
      ["activeLocales", "brandHref", "footerLinks", "footerNote", "navItems", "siteName"].sort(),
    );
  });
});

describe("手机页头结构（方案 A）", () => {
  it("右侧是等大的两个 44×44 按钮：放大镜 + 菜单开关，间距 4px，都 shrink-0", () => {
    renderWithMessages(<SiteHeader navItems={NAV} activeLocales={ACTIVE} searchHref="/search" />);
    const cluster = mobileCluster();
    const [magnifier, toggle] = Array.from(cluster.children) as HTMLElement[];

    expect(cluster.children).toHaveLength(2);
    expect(cluster.classList.contains("md:hidden")).toBe(true);
    expect(cluster.classList.contains("gap-1")).toBe(true); // 4px
    expect(magnifier!.tagName).toBe("A");
    expect(toggle!.tagName).toBe("BUTTON");
    for (const element of [magnifier!, toggle!]) {
      expect(element.classList.contains("h-11")).toBe(true); // 44px
      expect(element.classList.contains("w-11")).toBe(true);
      expect(element.classList.contains("shrink-0")).toBe(true);
    }
    // 右内边距补偿：开关保持 -me-2（既有契约，见 rtl-logical-direction.test.tsx）
    expect(toggle!.classList.contains("-me-2")).toBe(true);
  });

  it("没有搜索入口时，菜单开关同样是 44×44 shrink-0", () => {
    renderWithMessages(<SiteHeader navItems={NAV} activeLocales={ACTIVE} />);
    const toggle = menuToggle();
    expect(toggle.classList.contains("h-11")).toBe(true);
    expect(toggle.classList.contains("w-11")).toBe(true);
    expect(toggle.classList.contains("shrink-0")).toBe(true);
  });

  it("手机页头里不渲染语种胶囊：按钮簇里没有语种按钮，胶囊触发按钮是 hidden（md 起才 inline-flex）", () => {
    const { container } = renderWithMessages(
      <SiteHeader navItems={NAV} activeLocales={ACTIVE} searchHref="/search" />,
    );
    const cluster = mobileCluster();
    expect(cluster.querySelector('[aria-haspopup="menu"]')).toBeNull();

    const pill = screen.getByRole("button", { name: "Language" });
    expect(cluster.contains(pill)).toBe(false);
    expect(pill.classList.contains("hidden")).toBe(true);
    expect(pill.classList.contains("md:inline-flex")).toBe(true);
    expect(pill.classList.contains("inline-flex")).toBe(false); // 无前缀的 inline-flex 会在手机上把它显示出来

    // 导航 / 胶囊所在的那一层：手机上 contents（不占 flex 位），md 起 flex
    const wrapper = container.querySelector("header nav.hidden")!.parentElement as HTMLElement;
    expect(wrapper.classList.contains("contents")).toBe(true);
    expect(wrapper.classList.contains("md:flex")).toBe(true);
  });

  it("站标完整保留：站标是页头第一个子元素，没有 hidden / shrink / truncate", () => {
    const { container } = renderWithMessages(
      <SiteHeader navItems={NAV} activeLocales={ACTIVE} searchHref="/search" brandName="PulseNovel" />,
    );
    const brand = container.querySelector("header a:has([data-brand-slot='mark'])") as HTMLElement;
    expect(brand).toBeTruthy();
    expect(brand.parentElement!.firstElementChild).toBe(brand);
    expect(brand.className).not.toMatch(/\bhidden\b|truncate|shrink-0|overflow-hidden/);
    expect(within(brand).getByText("PulseNovel")).toBeTruthy();
  });

  it("放大镜按钮的可访问名称就是 search.title，图标本身 aria-hidden", () => {
    renderWithMessages(<SiteHeader navItems={NAV} activeLocales={ACTIVE} searchHref="/search" />);
    const [magnifier] = Array.from(mobileCluster().children) as HTMLElement[];
    expect(magnifier!.getAttribute("aria-label")).toBe("Search");
    expect(magnifier!.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("手机菜单面板", () => {
  it("展开后依次为 首页 / 全部作品 / 搜索 / 语种行；每一行最小高 52px", () => {
    renderWithMessages(<SiteHeader navItems={NAV} activeLocales={ACTIVE} searchHref="/search" />);
    const panel = openPanel();
    const rows = Array.from(panel.querySelectorAll("ul > li")) as HTMLElement[];

    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByRole("link").textContent).toBe("Home");
    expect(within(rows[1]!).getByRole("link").textContent).toBe("All works");
    expect(within(rows[2]!).getByRole("link").textContent).toBe("Search");
    expect(within(rows[2]!).getByRole("link").querySelector("svg")).toBeTruthy(); // 搜索前面的放大镜小图标

    for (const row of rows) {
      const control = row.querySelector<HTMLElement>("a, button")!;
      expect(control.className, row.textContent ?? "").toContain("min-h-[52px]");
    }
  });

  it("语种行：地球图标 + nav.language 文案，右侧是当前语种本语自称 + 下拉箭头；没有 aria-label 盖掉可见文字", () => {
    renderWithMessages(<SiteHeader navItems={NAV} activeLocales={ACTIVE} searchHref="/search" />);
    const panel = openPanel();
    const trigger = within(panel).getByRole("button", { name: /Language/ });

    expect(trigger.getAttribute("aria-label")).toBeNull();
    expect(trigger.textContent).toBe(`Language${SITE_LOCALE_NATIVE_NAMES.en}`);
    expect(trigger.querySelectorAll("svg")).toHaveLength(2); // 地球 + 箭头
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(within(panel).queryByRole("menu")).toBeNull();

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(within(panel).getByRole("menu")).toBeTruthy();
    expect(within(panel).getAllByRole("menuitem")).toHaveLength(ACTIVE.length);
  });

  it("语种列表就地展开：菜单节点没有 absolute / fixed / z-* 之类的浮层类", () => {
    renderWithMessages(<SiteHeader navItems={NAV} activeLocales={ACTIVE} />);
    const panel = openPanel();
    fireEvent.click(within(panel).getByRole("button", { name: /Language/ }));
    const menu = within(panel).getByRole("menu");

    for (const token of Array.from(menu.classList)) {
      expect(token, `菜单类 ${token}`).not.toMatch(/^(?:absolute|fixed|sticky|z-\d+)$/);
    }
  });

  it("只有一个可选语种时：没有语种行，也没有多余的分隔线（空的 li 被藏掉）", () => {
    renderWithMessages(<SiteHeader navItems={NAV} activeLocales={["en"]} searchHref="/search" />);
    const panel = openPanel();

    expect(panel.querySelector('[aria-haspopup="menu"]')).toBeNull();
    const last = Array.from(panel.querySelectorAll("ul > li")).at(-1) as HTMLElement;
    expect(last.children).toHaveLength(0);
    expect(last.classList.contains("empty:hidden")).toBe(true);
  });

  it("点导航项 / 搜索项：面板收起（沿用既有行为）", () => {
    renderWithMessages(<SiteHeader navItems={NAV} activeLocales={ACTIVE} searchHref="/search" />);
    for (const name of ["All works", "Search"]) {
      const panel = openPanel();
      const link = within(panel).getByRole("link", { name });
      link.addEventListener("click", (event) => event.preventDefault());
      fireEvent.click(link);
      expect(menuToggle().getAttribute("aria-expanded"), name).toBe("false");
    }
  });

  it("点放大镜按钮不影响菜单状态（它是普通链接）", () => {
    renderWithMessages(<SiteHeader navItems={NAV} activeLocales={ACTIVE} searchHref="/search" />);
    const [magnifier] = Array.from(mobileCluster().children) as HTMLElement[];
    magnifier!.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(magnifier!);
    expect(menuToggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("点语种行里的某个语种（会真的切换）：整块面板收起", () => {
    window.history.pushState({}, "", "/browse");
    renderWithMessages(<SiteHeader navItems={NAV} activeLocales={ACTIVE} searchHref="/search" />);
    const panel = openPanel();
    fireEvent.click(within(panel).getByRole("button", { name: /Language/ }));
    const item = within(panel).getByRole("menuitem", { name: SITE_LOCALE_NATIVE_NAMES.es });
    // React 的处理器先于 document 上的监听器运行：在 document 冒泡阶段拦下 jsdom 的默认导航，
    // 又不会让组件看到 defaultPrevented（元素自己的监听器会，所以不能挂在元素上）。
    const stopNavigation = (event: Event) => event.preventDefault();
    document.addEventListener("click", stopNavigation);
    fireEvent.click(item);
    document.removeEventListener("click", stopNavigation);

    expect(menuToggle().getAttribute("aria-expanded")).toBe("false");
    document.cookie = "NEXT_LOCALE=; Max-Age=0; Path=/";
  });

  it("点语种行里的当前语种：只收起语种列表，面板留着", () => {
    renderWithMessages(<SiteHeader navItems={NAV} activeLocales={ACTIVE} searchHref="/search" />);
    const panel = openPanel();
    fireEvent.click(within(panel).getByRole("button", { name: /Language/ }));
    fireEvent.click(within(panel).getByRole("menuitem", { name: SITE_LOCALE_NATIVE_NAMES.en }));

    expect(within(panel).queryByRole("menu")).toBeNull();
    expect(menuToggle().getAttribute("aria-expanded")).toBe("true");
  });
});

describe("当前页高亮（颜色 + 下划线双重编码 + aria-current）", () => {
  it("搜索页：放大镜、桌面导航搜索项、手机菜单搜索行都高亮；首页 / 全部作品不再高亮", () => {
    const { container } = renderWithMessages(
      <SiteHeader
        navItems={NAV.map((item) => ({ ...item, current: false }))}
        activeLocales={ACTIVE}
        searchHref="/search"
        searchCurrent
      />,
    );
    const desktopNav = container.querySelector("header nav.hidden") as HTMLElement;
    const desktop = within(desktopNav).getByRole("link", { name: "Search" });
    const [magnifier] = Array.from(mobileCluster().children) as HTMLElement[];
    const row = within(openPanel()).getByRole("link", { name: "Search" });

    for (const link of [desktop, row]) {
      expect(link.getAttribute("aria-current")).toBe("page");
      expect(link.className).toContain("underline");
      expect(link.className).toContain("text-novel-primary");
    }
    expect(magnifier!.getAttribute("aria-current")).toBe("page");
    expect(magnifier!.className).toContain("text-novel-primary");
    expect(screen.queryAllByRole("link", { current: "page" }).filter((link) => link.textContent === "Home")).toEqual([]);
  });

  it("非搜索页：搜索入口不高亮，也没有 aria-current", () => {
    const { container } = renderWithMessages(
      <SiteHeader navItems={NAV} activeLocales={ACTIVE} searchHref="/search" />,
    );
    const desktopNav = container.querySelector("header nav.hidden") as HTMLElement;
    const desktop = within(desktopNav).getByRole("link", { name: "Search" });
    expect(desktop.getAttribute("aria-current")).toBeNull();
    expect(desktop.className).not.toContain("underline");
    expect(desktop.className).toContain("text-novel-fg-muted");
  });

  it("既有导航项的高亮规则不变（沿用 NavLink）", () => {
    renderWithMessages(<SiteHeader navItems={NAV} activeLocales={ACTIVE} searchHref="/search" />);
    const active = screen.getAllByRole("link", { name: "All works" })[0]!;
    expect(active.getAttribute("aria-current")).toBe("page");
    expect(active.className).toContain("underline");
    expect(active.className).toContain("text-novel-primary");
  });
});

describe("桌面导航：首页 / 全部作品 / 搜索，后接语种胶囊", () => {
  it("导航里搜索项在最后一项，带 16px 放大镜；语种胶囊在导航之后", () => {
    const { container } = renderWithMessages(
      <SiteHeader navItems={NAV} activeLocales={ACTIVE} searchHref="/search" />,
    );
    const desktopNav = container.querySelector("header nav.hidden") as HTMLElement;
    const links = within(desktopNav).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["Home", "All works", "Search"]);
    expect(links[2]!.querySelector("svg")!.getAttribute("width")).toBe("16");
    expect(desktopNav.querySelector("ul")!.classList.contains("gap-7")).toBe(true); // 28px

    const pill = screen.getByRole("button", { name: "Language" });
    expect(desktopNav.compareDocumentPosition(pill) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("首页主视觉上的透明页头", () => {
  it("透明态：放大镜与菜单开关使用同一组颜色类，页头 data-header-transparent=true", () => {
    const { container } = renderWithMessages(
      <SiteHeader navItems={NAV} activeLocales={ACTIVE} searchHref="/search" overlay />,
    );
    expect(container.querySelector("header")!.getAttribute("data-header-transparent")).toBe("true");

    const [magnifier, toggle] = Array.from(mobileCluster().children) as HTMLElement[];
    const colorTokens = (element: HTMLElement) =>
      Array.from(element.classList).filter((token) => /^(?:hover:)?(?:text|bg)-novel-/.test(token)).sort();
    expect(colorTokens(magnifier!)).toEqual(colorTokens(toggle!));
    expect(colorTokens(magnifier!)).toContain("text-novel-fg-muted");
  });
});

describe("从右到左：新增元素只用逻辑属性", () => {
  // 与 rtl-logical-direction.test.tsx 同款的物理方向类识别
  const PHYSICAL =
    /^(?:[a-z0-9[\]&>:_-]+:)*-?(?:(?:left|right|ml|mr|pl|pr)-|text-(?:left|right)$|border-[lr](?:-|$)|rounded-(?:l|r|tl|tr|bl|br)(?:-|$))/;

  it("页头（含展开的手机面板、展开的语种列表、胶囊下拉）里没有任何物理方向类", () => {
    const { container } = renderWithMessages(
      <SiteHeader navItems={NAV} activeLocales={ACTIVE} searchHref="/search" searchCurrent />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Language" })); // 胶囊下拉
    const panel = openPanel();
    fireEvent.click(within(panel).getByRole("button", { name: /Language/ })); // 手机语种列表

    const offenders: string[] = [];
    for (const element of Array.from(container.querySelectorAll("header *"))) {
      for (const token of Array.from(element.classList)) {
        if (PHYSICAL.test(token)) offenders.push(`<${element.tagName.toLowerCase()}> ${token}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("语种行与列表用 text-start / ps-7（起始侧缩进），胶囊用 md:ms-2", () => {
    const { container } = renderWithMessages(<SiteHeader navItems={NAV} activeLocales={ACTIVE} />);
    const panel = openPanel();
    const trigger = within(panel).getByRole("button", { name: /Language/ });
    expect(trigger.classList.contains("text-start")).toBe(true);
    fireEvent.click(trigger);
    expect(within(panel).getByRole("menu").classList.contains("ps-7")).toBe(true);
    for (const item of within(panel).getAllByRole("menuitem")) {
      expect(item.classList.contains("text-start")).toBe(true);
    }
    const pillRoot = container.querySelector("header nav.hidden")!.nextElementSibling as HTMLElement;
    expect(pillRoot.classList.contains("md:ms-2")).toBe(true);
  });

  it("阿拉伯语页头：文案是阿拉伯语的 search.title / 菜单开关名称，href 带 /ar 前缀", () => {
    const { container } = render(
      <SiteShell locale="ar" chrome={{ navItems: NAV, activeLocales: ACTIVE, searchHref: "/ar/search" }}>
        <p>x</p>
      </SiteShell>,
    );
    const t = getPublicT("ar");
    const [magnifier, toggle] = Array.from(
      container.querySelector("button[aria-controls]:not([aria-haspopup])")!.parentElement!.children,
    ) as HTMLElement[];
    expect(magnifier!.getAttribute("href")).toBe("/ar/search");
    expect(magnifier!.getAttribute("aria-label")).toBe(t("search.title"));
    expect(toggle!.getAttribute("aria-label")).toBe(t("nav.openMenu"));
  });
});

describe("键盘", () => {
  it("放大镜与菜单开关都能 Tab 到：是原生 a[href] / button，没有 tabindex=-1", () => {
    renderWithMessages(<SiteHeader navItems={NAV} activeLocales={ACTIVE} searchHref="/search" />);
    const [magnifier, toggle] = Array.from(mobileCluster().children) as HTMLElement[];
    expect(magnifier!.getAttribute("href")).toBe("/search");
    expect(toggle!.getAttribute("type")).toBe("button");
    expect(magnifier!.getAttribute("tabindex")).toBeNull();
    expect(toggle!.getAttribute("tabindex")).toBeNull();
  });

  it("Esc 关闭菜单并把焦点交还开关（既有行为保留）", () => {
    renderWithMessages(<SiteHeader navItems={NAV} activeLocales={ACTIVE} searchHref="/search" />);
    fireEvent.click(menuToggle());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(menuToggle().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(menuToggle());
  });

  it("语种列表展开时，在行内按 Esc：只收起列表、焦点回语种行，面板不关；再按一次才关面板", () => {
    renderWithMessages(<SiteHeader navItems={NAV} activeLocales={ACTIVE} searchHref="/search" />);
    const panel = openPanel();
    const trigger = within(panel).getByRole("button", { name: /Language/ });
    fireEvent.click(trigger);
    const item = within(panel).getAllByRole("menuitem")[1]!;
    item.focus();

    fireEvent.keyDown(item, { key: "Escape" });
    expect(within(panel).queryByRole("menu")).toBeNull();
    expect(menuToggle().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(trigger);

    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(menuToggle().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(menuToggle());
  });
});

describe("跨页提示条（切换语种后新页面上显示）", () => {
  function stash(message: string) {
    window.sessionStorage.setItem(
      "novel:locale-switch-toast",
      JSON.stringify({ message, expiresAt: Date.now() + 60_000 }),
    );
  }

  it("手机菜单收起时提示条也在：由始终挂载的胶囊实例显示，手机上 fixed 贴页头下沿、md 起 absolute", () => {
    stash("Not available in 日本語");
    renderWithMessages(<SiteHeader navItems={NAV} activeLocales={ACTIVE} searchHref="/search" />);

    const toast = screen.getByRole("status");
    expect(toast.textContent).toBe("Not available in 日本語");
    expect(toast.classList.contains("fixed")).toBe(true);
    expect(toast.classList.contains("md:absolute")).toBe(true);
    expect(toast.classList.contains("end-0")).toBe(true); // 逻辑属性，RTL 镜像
    expect(toast.classList.contains("z-60")).toBe(true);
  });

  it("展开手机菜单和语种行后，同一条提示不会再出现第二份", () => {
    stash("Not available in 日本語");
    renderWithMessages(<SiteHeader navItems={NAV} activeLocales={ACTIVE} searchHref="/search" />);
    const panel = openPanel();
    fireEvent.click(within(panel).getByRole("button", { name: /Language/ }));

    expect(screen.getAllByRole("status")).toHaveLength(1);
  });
});
