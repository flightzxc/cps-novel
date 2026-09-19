import "./setup-cleanup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { HomeScreen } from "@/features/public-ui/home/HomeScreen";
import { FeaturedNovel } from "@/features/public-ui/home/FeaturedNovel";
import {
  MOCK_CATEGORIES,
  MOCK_FEATURED_LIST,
  MOCK_FEATURED_LIST_NO_HERO,
  MOCK_NOVEL_CARDS,
} from "@/features/public-ui/fixtures/mock-content";

/**
 * 首页「主推位 → 浏览区」的留白契约。
 *
 * 数值来自评审稿《首页主推位视觉方案》2a / 2b / 2d：
 *   Hero 桌面 620 / 移动 560（页头含在 Hero 内）
 *   Hero 之后作品区顶部内边距 桌面 8px / 移动 16px
 *   区块小标题下内边距 12px（分隔线）
 *   分隔线到书卡 桌面 32px / 移动 24px
 *
 * 🔴 这个文件存在的原因：这三段留白原本分散在三个组件里各给各的
 * （主推位 `md:pb-8` + 题材导航 `md:pt-14` + 作品区 `md:pt-16`），
 * 谁都不算错，叠起来桌面端从主推按钮底沿到「作品」标题空了 186px。
 * 单看任何一个文件都看不出来，所以契约钉在这里，按「区块之间」断言，
 * 不按「某个组件的 padding」断言。
 *
 * jsdom 没有布局引擎，量不出像素，因此断言落在 class 上——这几个值同时也是
 * 人读代码时唯一的依据，漂了就是漂了。
 */

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

function renderHome({
  featuredList = entries(),
  categories = MOCK_CATEGORIES,
}: {
  featuredList?: ReturnType<typeof entries>;
  categories?: typeof MOCK_CATEGORIES;
} = {}) {
  return render(
    <HomeScreen
      locale="en"
      featuredList={featuredList}
      novels={MOCK_NOVEL_CARDS}
      categories={categories}
      browseAllHref="/dev-preview/collection"
    />,
  );
}

beforeEach(() => mockMatchMedia(false));
afterEach(() => vi.unstubAllGlobals());

describe("主推位到浏览区的留白", () => {
  it("有 Hero 时浏览区顶部只补 8px（移动 16px）——Hero 自己已经留了 72px 内部空间", () => {
    renderHome();

    const browse = screen.getByTestId("home-browse");
    expect(browse.className).toContain("pt-4");
    expect(browse.className).toContain("md:pt-2");
  });

  /**
   * 2026-09-19 前：没有 heroImageUrl 时首页整体回落到封面编排版
   * （FeaturedNovel），这条断言验证的是回落版跟 Hero 版共用同一套顶部留白。
   * 新契约下没有「回落」这个中间态了——`MOCK_FEATURED_LIST_NO_HERO` 里每一项
   * 仍带 coverUrl，Hero 照常渲染（模糊氛围底），`hasFeatured` 判断跟着
   * `hasHero` 走，留白值不变，但理由变了：不再是「两种主推形态共用一套值」，
   * 而是「同一种形态（Hero），背景来源不同而已」。
   */
  it("没有 heroImageUrl 时 Hero 仍渲染，浏览区顶部留白不变", () => {
    renderHome({ featuredList: entries(MOCK_FEATURED_LIST_NO_HERO) });

    expect(screen.getByTestId("featured-hero")).toBeTruthy();
    const browse = screen.getByTestId("home-browse");
    expect(browse.className).toContain("pt-4");
    expect(browse.className).toContain("md:pt-2");
  });

  it("主推位整块缺席时浏览区改为自己撑开顶部留白，不贴到页头", () => {
    renderHome({ featuredList: [] });

    const browse = screen.getByTestId("home-browse");
    expect(browse.className).toContain("pt-10");
    expect(browse.className).toContain("md:pt-14");
  });

  it("作品区不再自带顶部留白——顶部留白只有浏览区一处来源", () => {
    const { container } = renderHome();

    const works = container.querySelector('section[aria-labelledby="all-works"]');
    expect(works).not.toBeNull();
    expect(works!.className).not.toMatch(/(^|\s)(md:)?pt-\d/);
  });
});

describe("全站题材导航的归属", () => {
  it("题材导航不自带上下留白，不再单独占一条横带", () => {
    renderHome();

    const nav = screen.getByTestId("home-category-nav");
    expect(nav.className).not.toMatch(/(^|\s)(md:)?pt-\d/);
    expect(nav.className).toContain("mb-5");
    expect(nav.className).toContain("md:mb-6");
  });

  it("题材导航和作品网格同属浏览区这一个容器", () => {
    renderHome();

    const browse = screen.getByTestId("home-browse");
    expect(browse.contains(screen.getByTestId("home-category-nav"))).toBe(true);
    expect(browse.contains(screen.getByTestId("book-grid"))).toBe(true);
  });

  it("题材导航排在区块小标题之前——它是全站入口，不是这一格网格的筛选器", () => {
    const { container } = renderHome();

    const nav = screen.getByTestId("home-category-nav");
    const heading = container.querySelector("#all-works")!;
    expect(nav.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("没有可展示题材时整排消失，不留空容器", () => {
    renderHome({ categories: [] });

    expect(screen.queryByTestId("home-category-nav")).toBeNull();
  });

  /**
   * 这条原本查的是 FeaturedNovel（`section[aria-labelledby="featured-title"]`），
   * 通过 `MOCK_FEATURED_LIST_NO_HERO` 触发首页回落。新契约下 HomeScreen 永远
   * 不渲染 FeaturedNovel，选择器会落空——改成查 Hero 自己的结构
   * （`[data-testid="featured-hero"]`），元信息→标签→简介的顺序是同一条不变量，
   * 只是现在这个不变量归 Hero 管。
   */
  it("作品自己的标签仍在元信息之后、简介之前，没有被题材导航顶掉", () => {
    const { container } = renderHome({ featuredList: entries(MOCK_FEATURED_LIST_NO_HERO) });

    const hero = container.querySelector('[data-testid="featured-hero"]')!;
    const meta = hero.querySelector('[data-testid="meta-list"]')!;
    const tags = hero.querySelector('[data-testid="tag-list"]')!;
    const summary = hero.querySelector('[data-testid="featured-hero-summary"]')!;

    expect(meta.compareDocumentPosition(tags) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tags.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("区块小标题的分隔线节奏", () => {
  it("标题行下内边距 12px，分隔线到书卡 24px（桌面 32px）", () => {
    const { container } = renderHome();

    const heading = container.querySelector("#all-works")!;
    const rule = heading.parentElement!;
    const block = rule.parentElement!;

    expect(rule.className).toContain("pb-3");
    expect(block.className).toContain("mb-6");
    expect(block.className).toContain("md:mb-8");
  });
});

/**
 * 2026-09-19 前：`HomeScreen` 在没有横版物料时会渲染 `FeaturedNovel`，这个
 * describe 块验证的就是那次渲染的留白值。`HomeScreen` 现在永远不引用
 * `FeaturedNovel` 了（见 `HomeScreen.tsx` 与 `FeaturedNovel.tsx` 顶部注释），
 * 所以不能再通过 `renderHome` 触发它——直接单测这个保留下来的组件本身，
 * 留白契约数值没有变，只是不再由 HomeScreen 集成测试覆盖到。
 */
describe("封面编排版 FeaturedNovel（组件已保留但不再被 HomeScreen 使用）", () => {
  it("上下留白压到 32/48px 与 24/32px，不再上下各留半屏", () => {
    const { container } = render(
      <FeaturedNovel
        locale="en"
        novel={MOCK_FEATURED_LIST_NO_HERO[0]}
        detailHref="/dev-preview/novel"
        startReadingHref="/dev-preview/chapter"
      />,
    );

    const featured = container.querySelector('section[aria-labelledby="featured-title"]')!;
    expect(featured.className).toContain("pt-8");
    expect(featured.className).toContain("pb-6");
    expect(featured.className).toContain("md:pt-12");
    expect(featured.className).toContain("md:pb-8");
  });
});
