import "./setup-cleanup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { HomeScreen } from "@/features/public-ui/home/HomeScreen";
import { HERO_AUTOPLAY_MS } from "@/features/public-ui/home/FeaturedHero";
import {
  MOCK_FEATURED_LIST,
  MOCK_FEATURED_LIST_NO_HERO,
  MOCK_NOVEL_CARDS,
} from "@/features/public-ui/fixtures/mock-content";

/**
 * 首页主推位 · 通栏出血 Hero + 轮播。
 *
 * 这一版推翻了 P1-10 初稿的两条决定（不做通栏 banner / 不做轮播），
 * 依据见 docs/p1/P1_10_VISUAL_DIRECTION.md 第五节与文末变更记录。
 */

/** jsdom 没有 matchMedia，Hero 用它判断是否要停自动播放 */
function mockMatchMedia(reducedMotion: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: reducedMotion && query.includes("prefers-reduced-motion"),
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

function entries(list = MOCK_FEATURED_LIST) {
  return list.map((novel) => ({
    novel,
    detailHref: "/dev-preview/novel",
    startReadingHref: "/dev-preview/chapter",
  }));
}

function renderHome(featuredList = entries()) {
  return render(
    <HomeScreen featuredList={featuredList} novels={MOCK_NOVEL_CARDS} />,
  );
}

/** fixture 里带横版物料的本数 */
const HERO_COUNT = MOCK_FEATURED_LIST.filter((n) => n.heroImageUrl).length;

beforeEach(() => mockMatchMedia(false));
afterEach(() => vi.unstubAllGlobals());

describe("主推位形态选择", () => {
  it("有横版物料时渲染通栏 Hero", () => {
    renderHome();
    expect(screen.getByTestId("featured-hero")).toBeTruthy();
  });

  it("只把有横版物料的放进轮播，不拿空底图凑数", () => {
    // fixture 刻意留了一本没有 heroImageUrl
    expect(HERO_COUNT).toBeLessThan(MOCK_FEATURED_LIST.length);

    renderHome();
    expect(
      screen.getByTestId("featured-hero-dots").querySelectorAll('[role="tab"]'),
    ).toHaveLength(HERO_COUNT);
  });

  it("一本都没有横版物料时整体回落到封面编排版", () => {
    const { container } = renderHome(entries(MOCK_FEATURED_LIST_NO_HERO));

    expect(screen.queryByTestId("featured-hero")).toBeNull();
    // 回落版有自己的眉标与主推标题（书名在下方网格里也会出现，所以按 id 定位）
    expect(screen.getByText("本期主推")).toBeTruthy();
    expect(container.querySelector("#featured-title")?.textContent).toBe(
      MOCK_FEATURED_LIST[0].title,
    );
  });

  it("主推列表为空时主推位整块不渲染，首页直接从网格开始", () => {
    renderHome([]);

    expect(screen.queryByTestId("featured-hero")).toBeNull();
    expect(screen.queryByText("本期主推")).toBeNull();
    expect(screen.getByTestId("book-grid")).toBeTruthy();
  });

  it("轮播项数落在 4–6 本的编排区间内", () => {
    expect(HERO_COUNT).toBeGreaterThanOrEqual(4);
    expect(HERO_COUNT).toBeLessThanOrEqual(6);
  });
});

describe("轮播行为", () => {
  it("dots 数量与轮播项数一致，当前项用 aria-selected 表达", () => {
    renderHome();

    const tabs = screen.getByTestId("featured-hero-dots").querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(HERO_COUNT);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].getAttribute("aria-selected")).toBe("false");
  });

  it("点 dot 可切换", () => {
    renderHome();

    fireEvent.click(screen.getAllByRole("tab", { name: "第 2 本" })[0]);
    expect(screen.getAllByRole("tab", { name: "第 2 本" })[0].getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("左右方向键可切换，并在首尾环绕", () => {
    renderHome();
    const hero = screen.getByTestId("featured-hero");

    fireEvent.keyDown(hero, { key: "ArrowRight" });
    expect(screen.getAllByRole("tab", { name: "第 2 本" })[0].getAttribute("aria-selected")).toBe(
      "true",
    );

    // 从第 2 本往左两次 → 环绕到最后一本
    fireEvent.keyDown(hero, { key: "ArrowLeft" });
    fireEvent.keyDown(hero, { key: "ArrowLeft" });
    expect(
      screen.getAllByRole("tab", { name: `第 ${HERO_COUNT} 本` })[0].getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("切换只改 opacity，不做位移——位移会打破无边缘的错觉", () => {
    const { container } = renderHome();
    const layers = container.querySelectorAll('[data-hero-layer="image"]');

    expect(layers.length).toBe(HERO_COUNT);
    for (const layer of layers) {
      expect(layer.className).toMatch(/opacity-(0|100)/);
      expect(layer.className).not.toMatch(/translate|scale-|rotate-/);
    }
  });

  it("高度写死，不随简介长短变化——切换时页面不能跳", () => {
    const { container } = renderHome();
    const hero = screen.getByTestId("featured-hero");
    const before = hero.className;

    fireEvent.keyDown(hero, { key: "ArrowRight" });

    expect(container.querySelector('[data-testid="featured-hero"]')?.className).toBe(before);
    expect(before).toContain("h-[var(--novel-hero-height-mobile)]");
    expect(before).toContain("md:h-[var(--novel-hero-height)]");
  });

  it("自动播放 7 秒推进一本", () => {
    vi.useFakeTimers();
    try {
      renderHome();
      act(() => {
        vi.advanceTimersByTime(HERO_AUTOPLAY_MS);
      });
      expect(
        screen.getAllByRole("tab", { name: "第 2 本" })[0].getAttribute("aria-selected"),
      ).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("鼠标悬停时暂停自动播放", () => {
    vi.useFakeTimers();
    try {
      renderHome();
      fireEvent.mouseEnter(screen.getByTestId("featured-hero"));
      act(() => {
        vi.advanceTimersByTime(HERO_AUTOPLAY_MS * 3);
      });
      expect(
        screen.getAllByRole("tab", { name: "第 1 本" })[0].getAttribute("aria-selected"),
      ).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("用户偏好减少动效时不自动播放", () => {
    mockMatchMedia(true);
    vi.useFakeTimers();
    try {
      renderHome();
      act(() => {
        vi.advanceTimersByTime(HERO_AUTOPLAY_MS * 3);
      });
      expect(
        screen.getAllByRole("tab", { name: "第 1 本" })[0].getAttribute("aria-selected"),
      ).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("向读屏用户播报当前在第几本", () => {
    const { container } = renderHome();
    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain(`共 ${HERO_COUNT} 本`);
  });
});

describe("Hero 的内容纪律", () => {
  it("轮播不表示排名——文案里没有热门 / TOP / 排行 / 榜", () => {
    const { container } = renderHome();
    const text = container.textContent ?? "";

    for (const forbidden of ["热门", "排行", "榜", "最热", "推荐榜", "TOP"]) {
      expect(text, `Hero 出现了暗示排名的措辞：${forbidden}`).not.toContain(forbidden);
    }
  });

  it("字段边界照旧：Hero 上不出现作者 / 评分 / 阅读量", () => {
    const { container } = renderHome();
    const text = container.textContent ?? "";

    for (const forbidden of ["作者", "评分", "阅读量", "完结", "连载"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text.toLowerCase()).not.toMatch(/author|rating|views/);
  });

  it("简介只取第一段并截断，不让高度随文案变化", () => {
    renderHome();
    const summary = screen.getByTestId("featured-hero-summary");

    expect(summary.className).toContain("line-clamp-2");
    expect(summary.className).toContain("md:line-clamp-4");
    // 只有第一段，不含第二段的内容
    expect(summary.textContent).not.toContain("\n");
  });

  it("遮罩与压黑全部走 token，组件里不出现字面渐变", () => {
    const { container } = renderHome();

    const image = container.querySelector('[data-hero-layer="image"]');
    const scrimX = container.querySelector('[data-hero-layer="scrim-x"]');
    const scrimY = container.querySelector('[data-hero-layer="scrim-y"]');

    expect(image?.className).toContain("[mask-image:var(--novel-hero-mask-mobile)]");
    expect(image?.className).toContain("md:[mask-image:var(--novel-hero-mask)]");
    expect(scrimX?.className).toContain("bg-[image:var(--novel-hero-scrim-x)]");
    expect(scrimY?.className).toContain("bg-[image:var(--novel-hero-scrim-y-mobile)]");
    expect(scrimY?.className).toContain("md:bg-[image:var(--novel-hero-scrim-y)]");
  });

  it("三个图层都对读屏隐藏——它们是背景，不是内容", () => {
    const { container } = renderHome();

    for (const selector of ["image", "scrim-x", "scrim-y"]) {
      for (const node of container.querySelectorAll(`[data-hero-layer="${selector}"]`)) {
        expect(node.getAttribute("aria-hidden")).toBe("true");
      }
    }
  });
});

describe("页头在 Hero 上的形态", () => {
  it("有 Hero 时页头浮起、无底色无分隔线", () => {
    renderHome();

    const header = screen.getByTestId("site-header");
    expect(header.getAttribute("data-header-transparent")).toBe("true");
    expect(header.className).toContain("bg-transparent");
    expect(header.className).not.toContain("bg-novel-bg");
  });

  it("回落形态下页头回到实底", () => {
    renderHome(entries(MOCK_FEATURED_LIST_NO_HERO));

    const header = screen.getByTestId("site-header");
    expect(header.getAttribute("data-header-transparent")).toBe("false");
    expect(header.className).toContain("bg-novel-bg");
  });

  it("展开移动端菜单时页头落回实底，菜单不会压在图上", () => {
    renderHome();

    fireEvent.click(screen.getByRole("button", { name: "打开菜单" }));

    const header = screen.getByTestId("site-header");
    expect(header.getAttribute("data-header-transparent")).toBe("false");
  });

  it("滚过页头高度后恢复底色与分隔线，回到顶部再浮起", async () => {
    renderHome();
    const header = () => screen.getByTestId("site-header");

    // 页头高度是 64px，滚过它就落回实底
    await act(async () => {
      Object.defineProperty(window, "scrollY", { value: 400, configurable: true });
      window.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });

    expect(header().getAttribute("data-header-transparent")).toBe("false");
    expect(header().className).toContain("bg-novel-bg");
    expect(header().className).toContain("border-novel-border");

    await act(async () => {
      Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
      window.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });

    expect(header().getAttribute("data-header-transparent")).toBe("true");
  });

  it("回落形态下不挂滚动监听——页头本来就是实底", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    renderHome(entries(MOCK_FEATURED_LIST_NO_HERO));

    const scrollListeners = addSpy.mock.calls.filter(([type]) => type === "scroll");
    expect(scrollListeners).toHaveLength(0);

    addSpy.mockRestore();
  });
});
