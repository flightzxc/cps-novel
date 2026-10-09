import "./setup-cleanup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { SITE_LOCALE_NATIVE_NAMES, SITE_LOCALES } from "@/lib/locale/locale-canonical";
import { getPublicT, loadMessages } from "@/lib/locale/messages";
import { MessagesProvider } from "@/lib/locale/messages/MessagesProvider";

/**
 * PN-15 第二批 · 公开网址冻结守卫（`docs/governance/AI_WORKFLOW.md`「公开网址冻结」）。
 *
 * 页头改版（搜索入口 + 手机端方案 A）只允许**换位置**：语种切换从页头右侧的胶囊挪进手机菜单，
 * 每个语种菜单项的 href、切换计划（直接切 / 查兄弟页 / 回退提示）、点击后的跳转必须**逐字不变**。
 *
 * 本文件先于任何页头改动写成，并在改动之前的代码上跑绿（基线）；改动之后它必须仍然绿，
 * 而且手机菜单里的语种列表要与胶囊下拉**逐项相同**（见文件末尾 `describe.each` 的 surface 列表）。
 *
 * 下面所有期望值都是**写死的字面量**，不从被测代码里推导：
 * - `PFX`：15 个语种各自的路径前缀（en 无前缀）；
 * - `KINDS`：10 类页面 × 期望的切换计划 / 渲染期 href / 点击后的跳转 / 提示键。
 * 命名刻意避开 LOCALE / LANGUAGE 字样，以免被 `locale-canonical.test.ts` 的「第二张语种映射表」扫描误判。
 */

const routerPush = vi.fn();
let mockPathname = "/";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: routerPush }),
}));

const { LocaleSwitcher, planLocaleSwitch } = await import("@/features/public-ui/layout/LocaleSwitcher");

/** 菜单条目的期望顺序 = 登记顺序（写死，同时钉住 SITE_LOCALES 本身没被动过）。 */
const ORDER: readonly SiteLocale[] = [
  "en",
  "es",
  "pt-BR",
  "id",
  "vi",
  "th",
  "ja",
  "ko",
  "zh-Hant",
  "ar",
  "fr",
  "de",
  "pl",
  "cs",
  "ru",
];

/** 各语种的路径前缀。字面量，不调用 `localePrefix`。 */
const PFX: Readonly<Record<SiteLocale, string>> = {
  en: "",
  es: "/es",
  "pt-BR": "/pt-BR",
  id: "/id",
  vi: "/vi",
  th: "/th",
  ja: "/ja",
  ko: "/ko",
  "zh-Hant": "/zh-Hant",
  ar: "/ar",
  fr: "/fr",
  de: "/de",
  pl: "/pl",
  cs: "/cs",
  ru: "/ru",
};

const homeOf = (target: SiteLocale) => PFX[target] || "/";

type PlanKind = { kind: "direct" } | { kind: "novel"; slugParam: string } | { kind: "fallback" };

interface Kind {
  name: string;
  /** 当前语种前缀之后的路径；首页是空串。 */
  suffix: string;
  /** `window.location.search`（点击时才读取），无则空串。 */
  search: string;
  plan: PlanKind;
  /** 菜单里指向 `target` 的条目在**渲染期**的 href（只由 pathname 决定，不含 query）。 */
  href: (target: SiteLocale) => string;
  /** 点击 `target` 条目后期望的 `router.push` 参数；`null` = 不 push（交给链接自己的 href）。 */
  push: (target: SiteLocale) => string | null;
  /** 回退提示用哪个键；`null` = 不弹提示。 */
  toast: "fallbackToast" | "fallbackToastPage" | null;
}

const KINDS: readonly Kind[] = [
  {
    name: "首页",
    suffix: "",
    search: "",
    plan: { kind: "direct" },
    href: homeOf,
    push: () => null,
    toast: null,
  },
  {
    name: "/browse",
    suffix: "/browse",
    search: "",
    plan: { kind: "direct" },
    href: (t) => `${PFX[t]}/browse`,
    push: () => null,
    toast: null,
  },
  {
    name: "/browse?page=2（分页参数照 CPS 原样带上）",
    suffix: "/browse",
    search: "?page=2",
    plan: { kind: "direct" },
    href: (t) => `${PFX[t]}/browse`,
    push: (t) => `${PFX[t]}/browse?page=2`,
    toast: null,
  },
  {
    name: "/browse?category=romance（分类页在目标语种可能 404 → 保底）",
    suffix: "/browse",
    search: "?category=romance",
    plan: { kind: "fallback" },
    href: (t) => `${PFX[t]}/browse`,
    push: (t) => `${homeOf(t)}?category=romance`,
    toast: "fallbackToastPage",
  },
  {
    name: "/category/romance",
    suffix: "/category/romance",
    search: "",
    plan: { kind: "fallback" },
    href: homeOf,
    push: homeOf,
    toast: "fallbackToastPage",
  },
  {
    name: "小说详情页（先查兄弟页；这里按「没有」走保底）",
    suffix: "/novel/lantern-pabc12345",
    search: "",
    plan: { kind: "novel", slugParam: "lantern-pabc12345" },
    href: homeOf,
    push: homeOf,
    toast: "fallbackToast",
  },
  {
    name: "章节页",
    suffix: "/novel/lantern-pabc12345/chapter/3",
    search: "",
    plan: { kind: "fallback" },
    href: homeOf,
    push: homeOf,
    toast: "fallbackToast",
  },
  {
    name: "博客列表 /blog",
    suffix: "/blog",
    search: "",
    plan: { kind: "direct" },
    href: (t) => `${PFX[t]}/blog`,
    push: () => null,
    toast: null,
  },
  {
    name: "博客详情",
    suffix: "/blog/winter-reads",
    search: "",
    plan: { kind: "fallback" },
    href: homeOf,
    push: homeOf,
    toast: "fallbackToastPage",
  },
  {
    name: "404（任意未登记路径）",
    suffix: "/no-such-page",
    search: "",
    plan: { kind: "fallback" },
    href: homeOf,
    push: homeOf,
    toast: "fallbackToastPage",
  },
  {
    name: "/search?q=x&page=2（只带 q，去掉 page）",
    suffix: "/search",
    search: "?q=x&page=2",
    plan: { kind: "direct" },
    href: (t) => `${PFX[t]}/search`,
    push: (t) => `${PFX[t]}/search?q=x`,
    toast: null,
  },
];

/** 当前语种 `current` 看到的该类页面的 pathname。 */
function pathOf(current: SiteLocale, kind: Kind): string {
  return kind.suffix === "" ? PFX[current] || "/" : `${PFX[current]}${kind.suffix}`;
}

// ---------------------------------------------------------------------------
// surface：同一份语种菜单在不同位置的呈现。基线（页头改版之前）只有 `pill`。
// ---------------------------------------------------------------------------

interface Surface {
  name: string;
  /** 渲染并返回「打开语种菜单」的函数；返回的是 `role="menu"` 节点。 */
  mount: (current: SiteLocale) => { openMenu: () => HTMLElement };
}

function withMessages(current: SiteLocale, ui: React.ReactElement) {
  return render(
    <MessagesProvider locale={current} messages={loadMessages(current)}>
      {ui}
    </MessagesProvider>,
  );
}

/** 语种菜单触发器：带 `aria-haspopup="menu"` 的按钮（胶囊与手机菜单里的语种行共用这一约定）。 */
function menuTrigger(): HTMLElement {
  const triggers = Array.from(document.querySelectorAll<HTMLElement>('button[aria-haspopup="menu"]'));
  expect(triggers).toHaveLength(1);
  return triggers[0]!;
}

const SURFACES: readonly Surface[] = [
  {
    name: "胶囊下拉（LocaleSwitcher 默认形态）",
    mount: (current) => {
      withMessages(current, <LocaleSwitcher activeLocales={ORDER} />);
      return {
        openMenu: () => {
          fireEvent.click(menuTrigger());
          return screen.getByRole("menu");
        },
      };
    },
  },
];

// ---------------------------------------------------------------------------

let clickPrevented: boolean | null = null;
const observeClick = (event: Event) => {
  clickPrevented = event.defaultPrevented;
  // jsdom 不实现导航，真跳会打出无关的 Not implemented 噪音。React 的处理器先于 document 上的监听器运行，
  // 所以上面记下的是组件自己有没有接管点击。
  event.preventDefault();
};

beforeEach(() => {
  routerPush.mockReset();
  mockPathname = "/";
  clickPrevented = null;
  window.history.pushState({}, "", "/");
  document.addEventListener("click", observeClick);
});

afterEach(() => {
  document.removeEventListener("click", observeClick);
  window.sessionStorage.clear();
  document.cookie = "NEXT_LOCALE=; Max-Age=0; Path=/";
  window.history.pushState({}, "", "/");
  vi.unstubAllGlobals();
});

function setLocation(pathname: string, search: string) {
  mockPathname = pathname;
  window.history.pushState({}, "", `${pathname}${search}`);
}

function menuItems(menu: HTMLElement): HTMLElement[] {
  return within(menu).getAllByRole("menuitem");
}

describe("基线锚点：登记顺序与前缀表", () => {
  it("SITE_LOCALES 的顺序与写死的 ORDER 一致", () => {
    expect([...SITE_LOCALES]).toEqual([...ORDER]);
  });

  it("切换计划（planLocaleSwitch）：每类页面、每个当前语种前缀都与写死的期望一致", () => {
    for (const current of ORDER) {
      for (const kind of KINDS) {
        expect(planLocaleSwitch(pathOf(current, kind), kind.search), `${current} ${kind.name}`).toEqual(kind.plan);
      }
    }
  });
});

describe.each(SURFACES)("语种菜单 · $name", (surface) => {
  describe("15 个当前语种 × 11 类页面：菜单每一项的文字 / href / 当前态逐字不变", () => {
    for (const current of ORDER) {
      it.each(KINDS.map((kind) => [kind.name, kind] as const))(`${current} · %s`, (_name, kind) => {
        setLocation(pathOf(current, kind), "");
        const { openMenu } = surface.mount(current);
        const items = menuItems(openMenu());

        expect(items.map((item) => item.getAttribute("href"))).toEqual(ORDER.map((target) => kind.href(target)));
        expect(items.map((item) => item.textContent)).toEqual(ORDER.map((target) => SITE_LOCALE_NATIVE_NAMES[target]));
        expect(items.map((item) => item.getAttribute("aria-current"))).toEqual(
          ORDER.map((target) => (target === current ? "true" : null)),
        );
      });
    }
  });

  describe("点击后的跳转 / 提示键 / cookie 逐字不变（当前语种 en、ar、pt-BR × 全部目标语种）", () => {
    for (const current of ["en", "ar", "pt-BR"] as const) {
      it.each(KINDS.map((kind) => [kind.name, kind] as const))(`${current} · %s`, async (_name, kind) => {
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => ({ ok: true, json: async () => ({ hasMatch: false }) })),
        );
        const { openMenu } = surface.mount(current);
        const translate = getPublicT(current);

        for (const target of ORDER) {
          if (target === current) continue;

          // 每个目标重置一次环境：路径、query、历史点击记录
          setLocation(pathOf(current, kind), kind.search);
          routerPush.mockReset();
          window.sessionStorage.clear();
          document.cookie = "NEXT_LOCALE=; Max-Age=0; Path=/";
          clickPrevented = null;

          const menu = openMenu();
          const item = menuItems(menu).find((candidate) => candidate.textContent === SITE_LOCALE_NATIVE_NAMES[target]);
          expect(item, `${current} → ${target}`).toBeTruthy();
          fireEvent.click(item!);

          const expectedPush = kind.push(target);
          if (kind.plan.kind === "novel") {
            // 详情页：先查兄弟页，这里接口答「没有」→ 弹提示 + 回目标语种首页
            await waitFor(() => expect(routerPush).toHaveBeenCalledTimes(1));
          }
          if (expectedPush === null) {
            expect(routerPush, `${current} → ${target}`).not.toHaveBeenCalled();
            // 直接切换且没有 query：组件不接管，交给链接自己的 href
            expect(clickPrevented, `${current} → ${target}`).toBe(false);
          } else {
            expect(routerPush, `${current} → ${target}`).toHaveBeenCalledTimes(1);
            expect(routerPush, `${current} → ${target}`).toHaveBeenCalledWith(expectedPush);
          }

          expect(document.cookie, `${current} → ${target}`).toContain(`NEXT_LOCALE=${target}`);

          const stashed = window.sessionStorage.getItem("novel:locale-switch-toast");
          if (kind.toast === null) {
            expect(stashed, `${current} → ${target}`).toBeNull();
          } else {
            const message = translate(`localeSwitcher.${kind.toast}`, { locale: SITE_LOCALE_NATIVE_NAMES[target] });
            expect(JSON.parse(stashed ?? "null")?.message, `${current} → ${target}`).toBe(message);
          }
        }
      });
    }

    it("小说详情页 · 接口答「有对应版本」→ 直接去兄弟页，不弹提示", async () => {
      const detail = KINDS.find((kind) => kind.plan.kind === "novel")!;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: true, json: async () => ({ hasMatch: true, path: "/ja/novel/other-pdef456" }) })),
      );
      setLocation(pathOf("en", detail), "");
      const { openMenu } = surface.mount("en");
      const menu = openMenu();
      const item = menuItems(menu).find((candidate) => candidate.textContent === SITE_LOCALE_NATIVE_NAMES.ko)!;
      fireEvent.click(item);

      await waitFor(() => expect(routerPush).toHaveBeenCalledTimes(1));
      expect(routerPush).toHaveBeenCalledWith("/ko/novel/other-pdef456");
      expect(window.sessionStorage.getItem("novel:locale-switch-toast")).toBeNull();
    });

    it("点击当前语种什么都不做（不 push、不写 cookie）", () => {
      setLocation("/browse", "");
      const { openMenu } = surface.mount("en");
      const menu = openMenu();
      const item = menuItems(menu).find((candidate) => candidate.textContent === SITE_LOCALE_NATIVE_NAMES.en)!;
      fireEvent.click(item);
      expect(routerPush).not.toHaveBeenCalled();
      expect(clickPrevented).toBe(true);
      expect(document.cookie).not.toContain("NEXT_LOCALE=en");
    });
  });
});
