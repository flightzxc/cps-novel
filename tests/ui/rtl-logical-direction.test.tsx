import "./setup-cleanup";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ChapterScreen } from "@/features/public-ui/chapter/ChapterScreen";
import { ChapterListBody } from "@/features/public-ui/novel/ChapterListBody";
import {
  MOCK_CHAPTER,
  MOCK_FEATURED_LIST,
  MOCK_NOVEL_CARDS,
} from "@/features/public-ui/fixtures/mock-content";
import { HomeScreen } from "@/features/public-ui/home/HomeScreen";
import { LocaleSwitcher } from "@/features/public-ui/layout/LocaleSwitcher";
import { SiteShell } from "@/features/public-ui/layout/SiteShell";
import { renderWithMessages } from "./render-with-messages";

/**
 * v0.5.11 · 从右到左（RTL）排版与层级收尾（承接 v0.5.10 的 PN-02 / PN-03）。
 *
 * PN-02 让 `<html dir>` 在切换语言后同步，从菜单进入阿拉伯语时整页会真的变成从右到左，
 * 此前一直潜伏的「物理方向」类名因此暴露：下拉面板向左伸出视口、阅读设置面板挂在标题
 * 下面而不是按钮下面、跳过链接停在错误一侧……
 *
 * 这里做的是**类名契约**，做法同 `reader-settings-panel-layer.test.tsx`：jsdom 没有
 * 布局，证明不了「面板在不在视口里」，真正的几何证据在浏览器验收
 * （`getBoundingClientRect`，dir=rtl / ltr 各取一次）。类名契约钉死的是造成问题的那几个
 * 类：逻辑类名必须在，物理类名必须不在。任何一条被改回去，这里先红。
 *
 * 为什么「物理类名不在」要单独断言：`end-0` 与 `right-0` 同时写上时，两者都是有效
 * 声明，谁赢取决于生成 CSS 里的顺序——只断言「逻辑类名存在」放过不了这种叠写。
 *
 * 逻辑类名在从左到右时与对应的物理类名**计算值相同**（`end-0` ≡ `right: 0`、
 * `text-start` ≡ `text-align: left`），所以从左到右语种的渲染结果不变；
 * 浏览器验收里 LTR 坐标与改前逐像素一致。
 */

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/browse",
  useRouter: () => ({ push: routerPush }),
}));

/** 与 `featured-hero.test.tsx` 同款：jsdom 没有 matchMedia，Hero 用它判断是否停自动播放。 */
function mockMatchMedia() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    })),
  );
}

beforeEach(() => {
  routerPush.mockClear();
  mockMatchMedia();
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

/**
 * 物理方向类：带不带变体前缀（`md:` / `focus:` / `rtl:`）、带不带负号都算。
 * 覆盖 inset 族（left-/right-）、外/内边距（ml-/mr-/pl-/pr-）、文字对齐、单侧边框与
 * 单侧圆角。故意不含 `inset-x-*`、`text-center`、`rounded-t-*`：它们不分左右。
 */
const PHYSICAL_DIRECTION =
  /^(?:[a-z0-9[\]&>:_-]+:)*-?(?:(?:left|right|ml|mr|pl|pr)-|text-(?:left|right)$|border-[lr](?:-|$)|rounded-(?:l|r|tl|tr|bl|br)(?:-|$))/;

function physicalDirectionTokens(element: Element): string[] {
  return Array.from(element.classList).filter((token) => PHYSICAL_DIRECTION.test(token));
}

/** 取元素 class 里形如 `z-50` 的层级数值（只认无前缀的那一个）；没有则返回 null。 */
function zIndexOf(element: Element): number | null {
  for (const token of Array.from(element.classList)) {
    const match = /^z-(\d+)$/.exec(token);
    if (match) {
      return Number(match[1]);
    }
  }
  return null;
}

/**
 * 会建立层叠上下文的类（保守列法）。菜单与面板的 z-index 只有在**同处一个层叠上下文**时
 * 才可比；若某个祖先把其中一个「关」进了自己的上下文，z-60 / z-50 的大小就不再说明
 * 谁在上面。
 */
const STACKING_CONTEXT_TOKEN =
  /^(?:z-\d+|isolate|fixed|sticky|transform(?:-gpu)?|filter|blur(?:-.+)?|backdrop-.+|will-change-.+|mix-blend-.+|opacity-(?!100$)\d+|-?(?:scale|rotate|translate|skew)(?:-.+)?|\[?(?:mask|clip-path|perspective|contain)[^\s]*)$/;

function stackingContextTokensAbove(element: Element): string[] {
  const hits: string[] = [];
  for (let node = element.parentElement; node; node = node.parentElement) {
    for (const token of Array.from(node.classList)) {
      if (STACKING_CONTEXT_TOKEN.test(token)) {
        hits.push(`${node.tagName.toLowerCase()}.${token}`);
      }
    }
  }
  return hits;
}

function renderSwitcher() {
  renderWithMessages(<LocaleSwitcher activeLocales={["en", "es"]} />);
  fireEvent.click(screen.getByRole("button", { name: "Language" }));
  return screen.getByRole("menu");
}

describe("1 · 首页 Hero 起始侧压黑按 dir 镜像", () => {
  function renderScrim() {
    const { container } = render(
      <HomeScreen
        locale="en"
        featuredList={MOCK_FEATURED_LIST.map((novel) => ({
          novel,
          detailHref: "/dev-preview/novel",
          startReadingHref: "/dev-preview/chapter",
        }))}
        novels={MOCK_NOVEL_CARDS}
      />,
    );
    const scrim = container.querySelector('[data-hero-layer="scrim-x"]');
    expect(scrim).toBeTruthy();
    return scrim as HTMLElement;
  }

  it("scrim-x 图层带 rtl:-scale-x-100，且仍然引用同一个渐变 token", () => {
    const scrim = renderScrim();

    expect(scrim.classList.contains("rtl:-scale-x-100")).toBe(true);
    expect(scrim.classList.contains("bg-[image:var(--novel-hero-scrim-x)]")).toBe(true);
  });

  it("镜像只在 rtl 下生效：图层上没有任何无前缀的 scale / rotate / translate 类（从左到右不变）", () => {
    const scrim = renderScrim();

    const unconditionalTransforms = Array.from(scrim.classList).filter((token) =>
      /^-?(?:scale|rotate|translate|skew)(?:-|$)/.test(token),
    );
    expect(unconditionalTransforms).toEqual([]);
  });

  it("渐变 token 仍是物理 `to right` 且只有一份——镜像靠变体，不靠第二套色标（否则会被翻两次）", () => {
    const css = readFileSync(resolve(__dirname, "../../src/styles/globals.css"), "utf8");

    expect(css).toMatch(/--novel-hero-scrim-x:\s*linear-gradient\(\s*to right,/);
    expect(css).not.toMatch(/--novel-hero-scrim-x-[a-z]+\s*:/);
    // 没有按 dir 重新定义这个 token 的选择器块
    expect(css).not.toMatch(/\[dir=["']?rtl["']?\][^{]*\{[^}]*--novel-hero-scrim-x/);
    expect(css).not.toMatch(/:dir\(rtl\)[^{]*\{[^}]*--novel-hero-scrim-x/);
  });
});

describe("2 · 语言切换器下拉面板与提示条贴末端、条目起始对齐", () => {
  it("下拉面板用 end-0，不含任何物理方向类", () => {
    const menu = renderSwitcher();

    expect(menu.classList.contains("end-0")).toBe(true);
    expect(menu.classList.contains("right-0")).toBe(false);
    expect(menu.classList.contains("left-0")).toBe(false);
    expect(physicalDirectionTokens(menu)).toEqual([]);
  });

  it("菜单条目用 text-start，不含 text-left", () => {
    const menu = renderSwitcher();

    const items = menu.querySelectorAll('[role="menuitem"]');
    expect(items.length).toBeGreaterThan(0);
    for (const item of Array.from(items)) {
      expect(item.classList.contains("text-start")).toBe(true);
      expect(item.classList.contains("text-left")).toBe(false);
      expect(physicalDirectionTokens(item)).toEqual([]);
    }
  });

  it("切换后的提示条同样用 end-0，且与下拉面板同层级（页头弹层一个层级）", () => {
    window.sessionStorage.setItem(
      "novel:locale-switch-toast",
      JSON.stringify({ message: "toast", expiresAt: Date.now() + 60_000 }),
    );
    renderWithMessages(<LocaleSwitcher activeLocales={["en", "es"]} />);
    const toast = screen.getByRole("status");

    expect(toast.classList.contains("end-0")).toBe(true);
    expect(physicalDirectionTokens(toast)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Language" }));
    const menu = screen.getByRole("menu");
    expect(zIndexOf(toast)).not.toBeNull();
    expect(zIndexOf(toast)).toBe(zIndexOf(menu));
  });
});

describe("3 · 章节列表锁定条目按钮起始对齐", () => {
  it("锁定条目是 <button>，用 text-start 而不是 text-left", () => {
    render(
      <ChapterListBody
        locale="en"
        chapters={[{ number: 1, title: "One", href: "/dev-preview/novel/1" }]}
        lockedStartNumber={2}
        lockedCount={3}
        totalChapterCount={4}
        readOnUpstreamHref="/go/abc123"
      />,
    );

    const locked = screen.getAllByTestId("locked-chapter-item");
    expect(locked).toHaveLength(3);
    for (const button of locked) {
      expect(button.tagName).toBe("BUTTON");
      expect(button.classList.contains("text-start")).toBe(true);
      expect(button.classList.contains("text-left")).toBe(false);
      expect(physicalDirectionTokens(button)).toEqual([]);
    }
  });
});

describe("4 · 阅读设置面板桌面形态贴按钮末端", () => {
  function renderPanel() {
    render(<ChapterScreen locale="en" chapter={MOCK_CHAPTER} />);
    fireEvent.click(screen.getByTestId("reader-settings-toggle"));
    return screen.getByTestId("reader-settings-panel");
  }

  it("桌面定位用 md:end-0，不含 md:right-0 / md:left-0", () => {
    const panel = renderPanel();

    expect(panel.classList.contains("md:end-0")).toBe(true);
    expect(panel.classList.contains("md:right-0")).toBe(false);
    expect(panel.classList.contains("md:left-0")).toBe(false);
  });

  it("面板根节点上没有任何物理方向类（移动端铺满用的 inset-x-0 不分左右，不在此列）", () => {
    const panel = renderPanel();

    expect(panel.classList.contains("inset-x-0")).toBe(true);
    expect(physicalDirectionTokens(panel)).toEqual([]);
  });
});

describe("5 · 跳过导航链接聚焦时贴起始侧", () => {
  it("focus:start-4，不含 focus:left-4", () => {
    const { container } = render(
      <SiteShell locale="en">
        <p>正文</p>
      </SiteShell>,
    );
    const skip = container.querySelector('a[href="#main"]');
    expect(skip).toBeTruthy();

    expect(skip!.classList.contains("focus:start-4")).toBe(true);
    expect(skip!.classList.contains("focus:left-4")).toBe(false);
    expect(physicalDirectionTokens(skip!)).toEqual([]);
  });
});

describe("6 · 层级：页头语言菜单 > 阅读设置面板 > 续读条", () => {
  function renderBothOpen() {
    render(
      <ChapterScreen
        locale="en"
        chrome={{ activeLocales: ["en", "es"] }}
        chapter={MOCK_CHAPTER}
      />,
    );
    // 与真实操作同序：先开设置面板，再点页头的语言入口
    fireEvent.click(screen.getByTestId("reader-settings-toggle"));
    fireEvent.click(screen.getByRole("button", { name: "Language" }));
    return {
      menu: screen.getByRole("menu"),
      panel: screen.getByTestId("reader-settings-panel"),
      bar: screen.getByTestId("sticky-cta"),
    };
  }

  it("夹具：三者同时在场，互不嵌套（否则下面的层级比较没有意义）", () => {
    const { menu, panel, bar } = renderBothOpen();

    expect(MOCK_CHAPTER.readOnUpstreamHref).toBeTruthy();
    expect(panel.contains(menu)).toBe(false);
    expect(menu.contains(panel)).toBe(false);
    expect(bar.contains(menu)).toBe(false);
    expect(bar.contains(panel)).toBe(false);
  });

  it("菜单层级严格高于面板，面板严格高于续读条", () => {
    const { menu, panel, bar } = renderBothOpen();

    const menuZ = zIndexOf(menu);
    const panelZ = zIndexOf(panel);
    const barZ = zIndexOf(bar);
    expect(menuZ, "菜单必须声明 z-* 层级").not.toBeNull();
    expect(panelZ, "面板必须声明 z-* 层级").not.toBeNull();
    expect(barZ, "续读条必须声明 z-* 层级").not.toBeNull();

    // 同层时 DOM 靠后者在上，而页头在 DOM 里先于面板——所以必须是严格大于，
    // 不能靠「同为 z-50 碰巧」。
    expect(menuZ as number).toBeGreaterThan(panelZ as number);
    expect(panelZ as number).toBeGreaterThan(barZ as number);
    // PN-03 的两个绝对值本单不改（`reader-settings-panel-layer.test.tsx` 另有钉死）。
    expect(panelZ).toBe(50);
    expect(barZ).toBe(40);
  });

  it("菜单与面板的祖先链上没有建立层叠上下文的类——两个 z-index 在同一个上下文里可比", () => {
    const { menu, panel } = renderBothOpen();

    expect(stackingContextTokensAbove(menu)).toEqual([]);
    expect(stackingContextTokensAbove(panel)).toEqual([]);
  });

  it("菜单在 DOM 里先于面板：这正是同层时面板会盖住菜单的原因（前提钉死，防止顺序变了而层级契约没跟上）", () => {
    const { menu, panel } = renderBothOpen();

    expect(menu.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
