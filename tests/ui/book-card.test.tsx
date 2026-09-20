import "./setup-cleanup";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { BookCard } from "@/features/public-ui/book/BookCard";
import { BookGrid } from "@/features/public-ui/book/BookGrid";
import type { NovelCardView } from "@/features/public-ui/types";

const WITH_TAGS: NovelCardView = {
  id: "a",
  title: "The Lantern Keeper's Daughter",
  coverUrl: "data:image/svg+xml;utf8,%3Csvg%3E%3C/svg%3E",
  tags: [
    { slug: "romance", label: "言情" },
    { slug: "modern", label: "都市" },
  ],
  locale: { code: "en", label: "English" },
  href: "/novel/a",
};

const WITHOUT_TAGS: NovelCardView = {
  id: "b",
  title: "Nine Winters in the Glass House",
  tags: [],
  href: "/novel/b",
};

describe("书籍卡片", () => {
  it("渲染封面、书名与标签", () => {
    render(<BookCard locale="en" novel={WITH_TAGS} />);

    expect(screen.getByRole("heading", { name: WITH_TAGS.title })).toBeTruthy();
    expect(screen.getByAltText(`Cover of ${WITH_TAGS.title}`)).toBeTruthy();
    expect(screen.getByText("言情")).toBeTruthy();
    expect(screen.getByText("都市")).toBeTruthy();
  });

  it("标签为空时整个标签区块消失，不留空位", () => {
    const { container } = render(<BookCard locale="en" novel={WITHOUT_TAGS} />);
    expect(container.querySelector('[data-testid="tag-list"]')).toBeNull();
  });

  it("缺封面时渲染占位块，卡片版面不塌", () => {
    const { container } = render(<BookCard locale="en" novel={WITHOUT_TAGS} />);
    expect(container.querySelector("img")).toBeNull();
    // 占位块仍然按封面比例占位
    const slot = container.querySelector('[style*="--novel-cover-aspect"]');
    expect(slot).toBeTruthy();
  });

  it("封面比例只走 token，不出现字面比例", () => {
    const { container } = render(<BookCard locale="en" novel={WITH_TAGS} />);
    const slot = container.querySelector('[style*="aspect-ratio"]') as HTMLElement;
    expect(slot.getAttribute("style")).toContain("var(--novel-cover-aspect)");
    expect(slot.getAttribute("style")).not.toMatch(/3\s*\/\s*4|2\s*\/\s*3/);
  });

  it("卡片上不出现分销接口不提供的字段", () => {
    const { container } = render(<BookCard locale="en" novel={WITH_TAGS} />);
    const text = container.textContent ?? "";

    for (const forbidden of ["作者", "评分", "阅读量", "播放量", "完结", "连载", "国家"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text.toLowerCase()).not.toMatch(/author|rating|views/);
  });
});

describe("卡片网格", () => {
  it("首页与聚合页共用同一种卡片", () => {
    const { container } = render(<BookGrid locale="en" novels={[WITH_TAGS, WITHOUT_TAGS]} />);
    expect(container.querySelectorAll('[data-testid="book-card"]')).toHaveLength(2);
  });

  it("密度刻意低于视频类竞品：移动 2 列 / 桌面 5 列", () => {
    const { container } = render(<BookGrid locale="en" novels={[WITH_TAGS]} />);
    const grid = container.querySelector('[data-testid="book-grid"]') as HTMLElement;

    expect(grid.className).toContain("grid-cols-2");
    expect(grid.className).toContain("lg:grid-cols-5");
    expect(grid.className).not.toContain("grid-cols-6");
  });

  it("空集合渲染空状态而不是空网格", () => {
    render(<BookGrid locale="en" novels={[]} emptyMessage="这个题材下暂时没有可以阅读的作品。" />);
    expect(screen.getByTestId("book-grid-empty").textContent).toBe(
      "这个题材下暂时没有可以阅读的作品。",
    );
  });
});

/**
 * 首页紧凑档（`variant="home"`，2026-09-20 首屏密度轮）。
 *
 * 这个 describe 守的是**边界**，不是效果：紧凑只能发生在「首页」×「窄屏」
 * 这一格里。`BookCard` 的注释里写着「首页与聚合页共用一个组件」，这条口子
 * 一旦漏到默认档，聚合页 / 题材页的窄屏卡片就会跟着掉信息——而那是本轮
 * 明确划到范围外的。列数同理：首屏密度不许拿列数去换。
 *
 * jsdom 不求值媒体查询，所以这里断言的是**类名的档位**而不是渲染结果：
 * `hidden md:block` 这一对在语义上就是「窄屏隐藏、md 起恢复」。
 */
describe("首页紧凑档只作用于「首页 × 窄屏」这一格", () => {
  const FULL: NovelCardView = { ...WITH_TAGS, summary: "一段会在窄屏被收起的简介。" };

  function partsOf(container: HTMLElement) {
    const card = container.querySelector('[data-testid="book-card"]')!;
    const summary = card.querySelector("p.line-clamp-3")!;
    return {
      card,
      summary,
      // 🔴 简介的「窄屏隐藏」在**外层 div** 上，不在 <p> 上：`line-clamp-3` 靠
      // `display:-webkit-box` 生效，同层再写 `md:block` 会把截断顶掉（2026-09-20
      // 实测，见 tests/ui/tailwind-display-conflicts.test.tsx）。
      summaryWrap: summary.parentElement!,
      localeLine: [...card.querySelectorAll("p")].find((p) => p.textContent === "English")!,
      tagWrap: card.querySelector('[data-testid="tag-list"]')!.parentElement!,
      title: card.querySelector("h3")!,
    };
  }

  it("默认档的卡片在任何宽度下都是完整的——聚合页 / 题材页不受影响", () => {
    const { container } = render(<BookGrid locale="en" novels={[FULL]} />);
    const { card, summaryWrap, localeLine, tagWrap, title } = partsOf(container);

    expect(card.getAttribute("data-card-compact")).toBeNull();
    for (const el of [summaryWrap, localeLine, tagWrap]) {
      expect(el.className.split(/\s+/)).not.toContain("hidden");
    }
    // 书名在默认档不截断
    expect(title.className).not.toMatch(/line-clamp-/);
  });

  it("首页档在窄屏收起简介 / 语种 / 标签，md 起原样恢复，且内容仍在 DOM 里", () => {
    const { container } = render(<BookGrid locale="en" novels={[FULL]} variant="home" />);
    const { card, summary, summaryWrap, localeLine, tagWrap, title } = partsOf(container);

    expect(card.getAttribute("data-card-compact")).toBe("mobile");
    for (const el of [summaryWrap, localeLine, tagWrap]) {
      const cls = el.className.split(/\s+/);
      expect(cls).toContain("hidden");
      expect(cls).toContain("md:block");
    }
    // 截断留在 <p> 上，且该元素不许再带 display 工具类
    expect(summary.className.split(/\s+/)).toContain("line-clamp-3");
    expect(summary.className).not.toMatch(/(^|\s)(md:)?(block|hidden|flex|inline-flex)(\s|$)/);
    // 🔴 收起 ≠ 不渲染：读屏与爬虫拿到的内容不能随视口宽度缩水
    expect(summary.textContent).toBe(FULL.summary);
    expect(screen.getByText("言情")).toBeTruthy();
    // 书名窄屏 2 行封顶，md 起解除
    expect(title.className.split(/\s+/)).toContain("line-clamp-2");
    expect(title.className.split(/\s+/)).toContain("md:line-clamp-none");
  });

  /**
   * 列数（Owner 2026-09-20 拍板）。
   *
   * 首页窄屏 3 列，但**窄于 360px 退回 2 列**：320 下 3 列的槽位只有 85px。
   * 断点必须是 `min-[360px]:`，不能借 `sm`(640)——360–639 这一段正是主力
   * 机型（390 / 393 / 412 / 430 全在里面），借 `sm` 等于整段拿不到 3 列。
   * 这条用例把「哪个断点」也钉住，就是为了防住「顺手换成 sm」那种改法。
   *
   * 🔴 默认档必须保持窄屏 2 列。首页改 3 列时把两档一起改掉，是这条最想
   * 防住的回归——聚合页 / 题材页没有主推 banner 抢空间，不需要这个密度。
   */
  it("首页档窄屏 3 列、<360 退回 2 列，且默认档仍是窄屏 2 列", () => {
    const home = render(<BookGrid locale="en" novels={[FULL]} variant="home" />);
    const homeCls = home.container
      .querySelector('[data-testid="book-grid"]')!
      .className.split(/\s+/);

    expect(homeCls).toContain("grid-cols-2"); // <360 的兜底
    expect(homeCls).toContain("min-[360px]:grid-cols-3");
    expect(homeCls).toContain("lg:grid-cols-5");
    // 借 sm 会让 360–639 拿不到 3 列
    expect(homeCls).not.toContain("sm:grid-cols-3");
    home.unmount();

    const plain = render(<BookGrid locale="en" novels={[FULL]} />);
    const plainCls = plain.container
      .querySelector('[data-testid="book-grid"]')!
      .className.split(/\s+/);

    expect(plainCls).toContain("grid-cols-2");
    expect(plainCls).toContain("sm:grid-cols-3");
    expect(plainCls).toContain("lg:grid-cols-5");
    expect(plainCls).not.toContain("min-[360px]:grid-cols-3");
    plain.unmount();
  });

  it("首页档窄屏行距收到 20px，桌面两档一致", () => {
    const { container } = render(<BookGrid locale="en" novels={[FULL]} variant="home" />);
    const cls = container.querySelector('[data-testid="book-grid"]')!.className.split(/\s+/);

    expect(cls).toContain("gap-y-5");
    expect(cls).not.toContain("gap-y-8");
    expect(cls).toContain("md:gap-y-10");
  });

  /**
   * 3 列槽位窄（390 下 106px），书名有两件事必须跟着走，否则 3 列就不成立：
   *   - 字号降到 `text-sm`：16px 下一行放不下 7 个字母，两行截断后只剩首词；
   *   - `break-words`：`grid-cols-*` 的轨道是 `minmax(0,1fr)`，不给断词的话
   *     一个放不下的长单词会横着溢出槽位。
   * 两者都只在窄屏，`md` 起恢复 `text-base`、解除截断。
   */
  it("紧凑档书名窄屏降到 text-sm 且允许断词，md 起恢复", () => {
    const { container } = render(<BookGrid locale="en" novels={[FULL]} variant="home" />);
    const cls = container.querySelector("h3")!.className.split(/\s+/);

    expect(cls).toContain("text-sm");
    expect(cls).toContain("break-words");
    expect(cls).toContain("md:text-base");
    expect(cls).toContain("line-clamp-2");
    expect(cls).toContain("md:line-clamp-none");
  });
});