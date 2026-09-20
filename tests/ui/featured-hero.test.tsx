import "./setup-cleanup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HomeScreen } from "@/features/public-ui/home/HomeScreen";
import { HERO_AUTOPLAY_MS } from "@/features/public-ui/home/FeaturedHero";
import type { NovelDetailView } from "@/features/public-ui/types";
import {
  MOCK_FEATURED_LIST,
  MOCK_FEATURED_LIST_NO_HERO,
  MOCK_FEATURED_LIST_NO_IMAGE,
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
    <HomeScreen locale="en" featuredList={featuredList} novels={MOCK_NOVEL_CARDS} />,
  );
}

/**
 * fixture 里进入 Hero 轮播的本数。2026-09-19 起首页不再按 heroImageUrl 过滤，
 * 主推列表里每一项都进 Hero，所以这就是 `MOCK_FEATURED_LIST.length` 本身——
 * 名字留着不改，是因为下面好几个断言仍然按「轮播项数」而不是「列表长度」
 * 去读它，含义没变。
 */
const HERO_COUNT = MOCK_FEATURED_LIST.length;

beforeEach(() => mockMatchMedia(false));
afterEach(() => vi.unstubAllGlobals());

describe("主推位形态选择", () => {
  it("有主推列表时渲染通栏 Hero", () => {
    renderHome();
    expect(screen.getByTestId("featured-hero")).toBeTruthy();
  });

  /**
   * 2026-09-19 前的契约：只把带 heroImageUrl 的放进轮播，没有横版物料的一本
   * 会被摘出去。Owner 已推翻这条前提——海阅不存在横版素材，继续按物料有无
   * 摘条目，等于轮播永远摘掉大部分本子。新契约：主推列表里每一项都进 Hero，
   * 不管有没有 heroImageUrl，摘掉的编排位不复存在。
   */
  it("全部主推项都进轮播，不因为没有横版物料被摘出去", () => {
    // fixture 里 mock-9 刻意不带 heroImageUrl，只带 coverUrl
    const withoutHeroImage = MOCK_FEATURED_LIST.filter((n) => !n.heroImageUrl);
    expect(withoutHeroImage.length).toBeGreaterThan(0);

    renderHome();
    expect(
      screen.getByTestId("featured-hero-dots").querySelectorAll('[role="tab"]'),
    ).toHaveLength(MOCK_FEATURED_LIST.length);
  });

  /**
   * 2026-09-19 前的契约：一本都没有横版物料时首页整体回落到封面编排版
   * （FeaturedNovel）。Owner 已推翻——海阅不存在、也不会等横版素材，继续
   * 「回落」等于首页主推位永久停在这个例外态。新契约：Hero 恒渲染，没有
   * heroImageUrl 时改用 coverUrl 做模糊氛围底，FeaturedNovel 不再被使用。
   */
  it("一本都没有横版物料时 Hero 仍整体渲染，用 coverUrl 做模糊氛围底", () => {
    const { container } = renderHome(entries(MOCK_FEATURED_LIST_NO_HERO));

    expect(screen.getByTestId("featured-hero")).toBeTruthy();
    expect(
      screen.getByTestId("featured-hero-dots").querySelectorAll('[role="tab"]'),
    ).toHaveLength(MOCK_FEATURED_LIST_NO_HERO.length);

    // 旧的封面编排版必须真的没有被渲染，不只是「没找到就算了」——注意「Featured」
    // 这个眉标文案 Hero 自己也会显示（`t("home.featuredEyebrow")` 默认值），
    // 不能拿它当「回落到 FeaturedNovel」的判据，真正的判据是 #featured-title
    // 这个 id 不存在。
    expect(container.querySelector('section[aria-labelledby="featured-title"]')).toBeNull();

    // 每一项都应该解析成 cover-atmosphere 背景，而不是被悄悄跳过
    const layers = container.querySelectorAll('[data-hero-layer="image"]');
    expect(layers).toHaveLength(MOCK_FEATURED_LIST_NO_HERO.length);
    for (const layer of layers) {
      expect(layer.getAttribute("data-hero-background")).toBe("cover-atmosphere");
    }
  });

  it("主推列表为空时主推位整块不渲染，首页直接从网格开始", () => {
    renderHome([]);

    expect(screen.queryByTestId("featured-hero")).toBeNull();
    expect(screen.queryByText("Featured")).toBeNull();
    expect(screen.getByTestId("book-grid")).toBeTruthy();
  });

  it("轮播项数落在 4–6 本的编排区间内", () => {
    expect(HERO_COUNT).toBeGreaterThanOrEqual(4);
    expect(HERO_COUNT).toBeLessThanOrEqual(6);
  });

  it("HomeScreen 在任何情况下都不渲染 FeaturedNovel（旧双栏回落版）", () => {
    // 三种输入分别对应三档来源优先级：全带 heroImageUrl / 全不带但有 coverUrl /
    // 两者都没有。旧代码只在第二种情况下会掉进 FeaturedNovel。
    for (const list of [MOCK_FEATURED_LIST, MOCK_FEATURED_LIST_NO_HERO, MOCK_FEATURED_LIST_NO_IMAGE]) {
      const { container, unmount } = renderHome(entries(list));
      expect(container.querySelector('section[aria-labelledby="featured-title"]')).toBeNull();
      unmount();
    }
  });
});

describe("露头轮播 · 数量边界与可访问性", () => {
  function renderN(n: number) {
    return renderHome(entries(MOCK_FEATURED_LIST.slice(0, n)));
  }
  const peeks = (c: HTMLElement) =>
    [...c.querySelectorAll('[data-testid="featured-hero-banner-peek"]')];

  /** Owner 2026-09-20 钉死的三档边界。 */
  it("1 本：不露头，只渲染一张", () => {
    const { container } = renderN(1);
    expect(container.querySelectorAll('[data-testid="featured-hero-banner"]')).toHaveLength(1);
    expect(peeks(container)).toHaveLength(0);
  });

  /**
   * 2 本做环形的话，左右露出的会是同一本邻居——等于把同一本书复制到两边。
   * 所以 2 本走单侧预览：当前项之外只有另一本，只能出现在一侧。
   */
  it("2 本：单侧预览，同一本邻居不会同时出现在左右两侧", () => {
    const { container } = renderN(2);
    const list = peeks(container);
    expect(list).toHaveLength(1);

    // 露出的必须是「另一本」，不是当前这本
    const currentTitle = MOCK_FEATURED_LIST[0].title;
    expect(list[0].textContent).not.toContain(currentTitle);
    expect(list[0].textContent).toContain(MOCK_FEATURED_LIST[1].title);
  });

  it("≥3 本：环形，左右各有一个且互不相同", () => {
    const { container } = renderN(3);
    const list = peeks(container);
    expect(list).toHaveLength(2);
    expect(list[0].textContent).not.toBe(list[1].textContent);
    // 两侧都不是当前这本
    for (const el of list) {
      expect(el.textContent).not.toContain(MOCK_FEATURED_LIST[0].title);
    }
  });

  /**
   * 露头在视觉上只露一条边，DOM 里却是完整内容。不屏蔽的话读屏会把所有主推项
   * 的标题简介连着念一遍，键盘 Tab 也会走进看不见的按钮里。
   */
  it("露头项对读屏隐藏，且其中所有可聚焦元素都不可 Tab", () => {
    const { container } = renderN(3);
    const list = peeks(container);
    expect(list.length).toBeGreaterThan(0);

    for (const el of list) {
      // 整棵子树移出 Tab 序列与无障碍树。只靠逐元素 tabIndex 是不够的——
      // TagList 里的标签也是 <a href>，那条路径穿不到参数。
      expect(el.hasAttribute("inert")).toBe(true);
      expect(el.getAttribute("aria-hidden")).toBe("true");
      expect(el.querySelectorAll("a[href], button").length).toBeGreaterThan(0);
    }

    // 当前项反过来必须完全可达，别把两边一起关掉
    const cur = container.querySelector('[data-testid="featured-hero-banner"]')!;
    expect(cur.hasAttribute("inert")).toBe(false);
    expect(cur.getAttribute("aria-hidden")).toBeNull();
    for (const f of cur.querySelectorAll("a[href]")) {
      expect(f.getAttribute("tabindex")).toBeNull();
    }
  });

  it("远端项只占位不渲染内容——轨道几何靠宽度维持，不必下载 3n 张封面", () => {
    const { container } = renderN(5);
    const track = container.querySelector('[data-testid="featured-hero-track"]')!;
    // 5 本 → 三份拷贝 15 个槽位，但只有当前项 ±1 共 3 个有内容
    expect(track.children).toHaveLength(15);
    expect(track.querySelectorAll("img")).toHaveLength(3);
  });
});

describe("Hero 背景来源三档优先级", () => {
  const BASE: NovelDetailView = {
    id: "priority-base",
    title: "Priority Fixture",
    description: "For background priority tests only.",
    locale: { code: "en", label: "English" },
    totalChapterCount: 10,
    tags: [],
    previewChapters: [],
  };

  function renderWithNovel(novel: NovelDetailView) {
    return render(
      <HomeScreen
        locale="en"
        featuredList={[{ novel, detailHref: "/dev-preview/novel" }]}
        novels={MOCK_NOVEL_CARDS}
      />,
    );
  }

  it("第 1 档：heroImageUrl 存在时清晰铺底，不加模糊/scale", () => {
    const { container } = renderWithNovel({
      ...BASE,
      heroImageUrl: "https://example.test/hero.jpg",
      coverUrl: "https://example.test/cover.jpg",
    });

    const outer = container.querySelector('[data-hero-layer="image"]')!;
    const inner = container.querySelector('[data-hero-layer="image-fill"]')!;
    expect(outer.getAttribute("data-hero-background")).toBe("hero");
    expect((inner as HTMLElement).style.backgroundImage).toContain("hero.jpg");
    expect(inner.className).not.toMatch(/contrast|blur|scale|brightness|saturate/);
  });

  it("第 2 档：只有 coverUrl 时用它做模糊氛围底", () => {
    const { container } = renderWithNovel({ ...BASE, coverUrl: "https://example.test/cover.jpg" });

    const outer = container.querySelector('[data-hero-layer="image"]')!;
    const inner = container.querySelector('[data-hero-layer="image-fill"]')!;
    expect(outer.getAttribute("data-hero-background")).toBe("cover-atmosphere");
    expect((inner as HTMLElement).style.backgroundImage).toContain("cover.jpg");
    expect(inner.className).toContain("var(--novel-hero-cover-contrast)");
    expect(inner.className).toContain("var(--novel-hero-cover-blur)");
    expect(inner.className).toContain("var(--novel-hero-cover-scale)");
    expect(inner.className).toContain("var(--novel-hero-cover-brightness)");
    expect(inner.className).toContain("var(--novel-hero-cover-saturate)");
    // 滤镜链顺序固定 contrast → blur → brightness → saturate，contrast 必须在
    // blur 之前（对原始未模糊图像先压缩动态范围），顺序乱了两个封面之间的
    // 氛围区亮度收敛效果会变差，见 globals.css 对应 token 注释的返工记录。
    // 只匹配「函数名后紧跟左括号」的调用形式，避开 --novel-hero-cover-blur
    // 这类 token 名字里也含有同一个单词的干扰。
    const filterOrder = inner.className.match(/(contrast|blur|brightness|saturate)\(/g);
    expect(filterOrder).toEqual(["contrast(", "blur(", "brightness(", "saturate("]);
  });

  it("第 3 档：两者都没有时不渲染任何图层，Hero 本体仍然渲染", () => {
    const { container } = renderWithNovel({ ...BASE });

    expect(screen.getByTestId("featured-hero")).toBeTruthy();
    expect(container.querySelector('[data-hero-layer="image"]')).toBeNull();
    expect(container.querySelector('[data-hero-layer="image-fill"]')).toBeNull();
    expect(screen.getByText(BASE.title)).toBeTruthy();
  });

  it("模糊层与 mask 分属两层：mask 在外层，filter/scale 在内层，不能合并回一层", () => {
    const { container } = renderWithNovel({ ...BASE, coverUrl: "https://example.test/cover.jpg" });

    const outer = container.querySelector('[data-hero-layer="image"]')!;
    const inner = container.querySelector('[data-hero-layer="image-fill"]')!;

    expect(outer).not.toBe(inner);
    expect(outer.contains(inner)).toBe(true);
    // mask 只能在外层，不能出现在内层
    expect(outer.className).toContain("mask-image");
    expect(inner.className).not.toContain("mask-image");
    // filter/scale 只能在内层，不能出现在外层——否则会把 mask 的渐隐边界一起缩放出去
    expect(outer.className).not.toMatch(/blur|scale/);
    expect(inner.className).toMatch(/blur/);
  });
});

describe("轮播行为", () => {
  it("dots 数量与轮播项数一致，当前项用 aria-selected 表达", () => {
    renderHome();

    const hero = screen.getByTestId("featured-hero");
    expect(hero.getAttribute("aria-label")).toBe("Featured works");
    expect(hero.getAttribute("aria-roledescription")).toBe("carousel");
    expect(screen.getByRole("tablist", { name: "Switch featured work" })).toBeTruthy();

    const tabs = screen.getByTestId("featured-hero-dots").querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(HERO_COUNT);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].getAttribute("aria-selected")).toBe("false");
  });

  /**
   * 运营编排位期望 4–6 本，但「期望 4–6 本」不等于凑得出 4–6 本：真实库里只有
   * 一本带横版物料时，Hero 仍然成立，成立的形态是**一张主视觉 + 没有轮播控件**。
   * 🔴 不允许为了凑够条目伪造数据，也不允许因为不足多条就把有效的横版主视觉
   * 退回封面编排版——那等于用「不够多」惩罚「有物料」。
   */
  it("只有一本时展示单张主视觉，轮播控件整块不渲染", () => {
    renderHome(entries([MOCK_FEATURED_LIST[0]]));

    expect(screen.getByTestId("featured-hero")).toBeTruthy();
    expect(screen.queryByTestId("featured-hero-dots")).toBeNull();
  });

  /**
   * 断言的是「定时器根本没被装上」，不是「切换后下标没变」——后者在只有一本时
   * 恒成立（`(0 + 1) % 1 === 0`），用它当断言等于什么都没测。
   */
  it("只有一本时根本不装自动播放定时器", () => {
    const setInterval = vi.spyOn(window, "setInterval");
    try {
      renderHome(entries([MOCK_FEATURED_LIST[0]]));
      expect(setInterval).not.toHaveBeenCalled();

      setInterval.mockClear();
      cleanup();
      renderHome();
      expect(setInterval).toHaveBeenCalled();
    } finally {
      setInterval.mockRestore();
    }
  });

  it("点 dot 可切换", () => {
    renderHome();

    fireEvent.click(screen.getAllByRole("tab", { name: "Work 2" })[0]);
    expect(screen.getAllByRole("tab", { name: "Work 2" })[0].getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("左右方向键可切换，并在首尾环绕", () => {
    renderHome();
    const hero = screen.getByTestId("featured-hero");

    fireEvent.keyDown(hero, { key: "ArrowRight" });
    expect(screen.getAllByRole("tab", { name: "Work 2" })[0].getAttribute("aria-selected")).toBe(
      "true",
    );

    // 从第 2 本往左两次 → 环绕到最后一本
    fireEvent.keyDown(hero, { key: "ArrowLeft" });
    fireEvent.keyDown(hero, { key: "ArrowLeft" });
    expect(
      screen.getAllByRole("tab", { name: `Work ${HERO_COUNT}` })[0].getAttribute("aria-selected"),
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
        screen.getAllByRole("tab", { name: "Work 2" })[0].getAttribute("aria-selected"),
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
        screen.getAllByRole("tab", { name: "Work 1" })[0].getAttribute("aria-selected"),
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
        screen.getAllByRole("tab", { name: "Work 1" })[0].getAttribute("aria-selected"),
      ).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("向读屏用户播报当前在第几本", () => {
    const { container } = renderHome();
    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain(`of ${HERO_COUNT}`);
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

  /**
   * 2026-09-19 实测缺陷的回归闸。
   *
   * 按钮带 `whitespace-nowrap`，flex 项又有默认的 `min-width:auto`，所以移动端
   * 那两枚 `flex-1` 按钮**压不窄**——它们会一起把行顶宽。360px 宽实测：俄语顶出
   * 内容容器 49px、德语 34px、越南语 13px；而 Hero 是 `overflow-hidden`，第二枚
   * 按钮直接被裁掉，页面还不横向滚动，肉眼只看得出「按钮怎么少了半截」。
   * 少了 `flex-wrap` 这个缺陷就会原样回来，所以钉在这里。
   */
  it("移动端按钮行可换行——长文案语种不会把第二枚按钮顶出容器被裁掉", () => {
    const { container } = renderHome();

    const row = container.querySelector('[data-testid="featured-hero"] a[href="/dev-preview/chapter"]')
      ?.parentElement;
    expect(row).not.toBeNull();
    expect(row!.className).toContain("flex-wrap");
  });

  it("字段边界照旧：Hero 上不出现作者 / 评分 / 阅读量", () => {
    const { container } = renderHome();
    const text = container.textContent ?? "";

    for (const forbidden of ["作者", "评分", "阅读量", "完结", "连载"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text.toLowerCase()).not.toMatch(/author|rating|views/);
  });

  /**
   * 行数上限的演变：4 → 3（2026-09-19 结构改向，简介进了定高 banner）
   * → 2（2026-09-20 首屏密度轮，banner 从 400 收到 360）。
   *
   * 移动端这一轮起整段**不显示**（`hidden`，但留在 DOM 里）：390px 下文字列
   * 只有 ~190px，简介要占掉两行的高度，而那两行在首屏里的代价是下面少露半排
   * 书卡。留在 DOM 里是刻意的——读屏和爬虫拿到的内容不随视口宽度缩水。
   *
   * 🔴 断言必须用 `md:line-clamp-2` 全串匹配，不能只写 `line-clamp-2`：
   * 后者是前者的子串，`md:` 档改成任何行数都照样通过。同理要显式断言
   * **没有**无前缀的 `line-clamp-*`（移动端靠 hidden 而不是截断）。
   */
  it("简介只取第一段；桌面截断 2 行，移动端整段不显示但留在 DOM 里", () => {
    renderHome();
    const summary = screen.getByTestId("featured-hero-summary");
    const wrapper = summary.parentElement!;

    // 截断在 <p> 自己身上
    expect(summary.className.split(/\s+/)).toContain("line-clamp-2");
    // 🔴 承重：clamp 元素上**不许**再出现 display 工具类。`line-clamp-N` 靠
    // `display:-webkit-box` 生效，同层写个 `block` 就把它顶掉，属性还在但完全
    // 失效。2026-09-20 真实素材 UAT 下越南语简介因此渲染了 6 行而不是 2 行。
    // 通用守卫见 tests/ui/tailwind-display-conflicts.test.tsx。
    expect(summary.className).not.toMatch(/(^|\s)(md:)?(block|hidden|flex|inline-flex)(\s|$)/);
    // 「窄屏不显示」由外层 div 承担
    expect(wrapper.className.split(/\s+/)).toContain("hidden");
    expect(wrapper.className.split(/\s+/)).toContain("md:block");
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

  /**
   * 2026-09-19 前：没有 heroImageUrl 时首页整体回落，页头也跟着回到实底。
   * 新契约下 `MOCK_FEATURED_LIST_NO_HERO` 里的每一项仍然带 coverUrl，Hero
   * 照常渲染（模糊氛围底），页头因此**仍然浮起**——headerOverlay 只看
   * `hasHero`（=featuredList 非空），不再关心具体渲染的是哪一档背景。
   * 页头真正回到实底的唯一情形是主推列表整个为空。
   */
  it("没有 heroImageUrl 但仍有 Hero 时页头维持浮起，不回落到实底", () => {
    renderHome(entries(MOCK_FEATURED_LIST_NO_HERO));

    const header = screen.getByTestId("site-header");
    expect(header.getAttribute("data-header-transparent")).toBe("true");
    expect(header.className).toContain("bg-transparent");
  });

  it("主推列表整个为空时页头才回到实底", () => {
    renderHome([]);

    const header = screen.getByTestId("site-header");
    expect(header.getAttribute("data-header-transparent")).toBe("false");
    expect(header.className).toContain("bg-novel-bg");
  });

  it("展开移动端菜单时页头落回实底，菜单不会压在图上", () => {
    renderHome();

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

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

  /**
   * 没有 heroImageUrl 时 Hero 仍然渲染（走 coverUrl 模糊氛围底），页头依旧
   * 浮起，所以滚动监听依旧要挂——这跟旧契约的「回落态不挂监听」正好相反。
   * 真正不挂监听的情形是主推列表为空、页头本来就是实底。
   */
  it("没有 heroImageUrl 但仍有 Hero 时照样挂滚动监听", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    renderHome(entries(MOCK_FEATURED_LIST_NO_HERO));

    const scrollListeners = addSpy.mock.calls.filter(([type]) => type === "scroll");
    expect(scrollListeners.length).toBeGreaterThan(0);

    addSpy.mockRestore();
  });

  it("主推列表为空时不挂滚动监听——页头本来就是实底", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    renderHome([]);

    const scrollListeners = addSpy.mock.calls.filter(([type]) => type === "scroll");
    expect(scrollListeners).toHaveLength(0);

    addSpy.mockRestore();
  });
});
