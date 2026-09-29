import "./setup-cleanup";
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { NovelDetailScreen } from "@/features/public-ui/novel/NovelDetailScreen";
import {
  MOCK_NOVEL_CARDS,
  MOCK_NOVEL_DETAIL,
  MOCK_NOVEL_DETAIL_SPARSE,
} from "@/features/public-ui/fixtures/mock-content";

describe("小说详情页 · 字段边界", () => {
  it("不渲染作者、评分、阅读量的任何占位", () => {
    const { container } = render(<NovelDetailScreen locale="en" novel={MOCK_NOVEL_DETAIL} />);
    const text = container.textContent ?? "";

    for (const forbidden of [
      "作者",
      "评分",
      "阅读量",
      "播放量",
      "完结",
      "连载",
      "国家",
      "暂无",
      "未知",
      "待补充",
    ]) {
      expect(text, `详情页出现了禁止字段占位：${forbidden}`).not.toContain(forbidden);
    }
    expect(text.toLowerCase()).not.toMatch(/author|rating|views|country|completed|ongoing/);
  });

  it("不渲染分成比例与渠道真实码", () => {
    const { container } = render(<NovelDetailScreen locale="en" novel={MOCK_NOVEL_DETAIL} />);
    const html = container.innerHTML;

    expect(html).not.toMatch(/split[_-]?ratio/i);
    expect(html).not.toMatch(/upstream[_-]?code/i);
  });

  /**
   * Owner 2026-09-29 修订 D-12 第 2 条（A3 折中方案）：总章数 > 真实章节数
   * 且有 `readOnUpstreamHref` 时，会追加锁定条目——但锁定条目只显示编号、
   * 不编造章名，且服务端首屏封顶 30 条（详见
   * `tests/ui/preview-chapter-list-locked.test.tsx`）。这条用例改断言以
   * 反映新规则，不是放宽——真实章节数仍然只有 fixture 里的 3 条，"不编造
   * 内容"这条底线没有变。
   */
  it("展示总章数这个客观标量；真实章节只有 3 条，锁定条目额外追加且封顶 30 条", () => {
    render(<NovelDetailScreen locale="en" novel={MOCK_NOVEL_DETAIL} />);

    // 元信息行的 "265 chapters" 与章节列表说明的 "265 chapters total" 都含
    // 这个子串，用 getAllByText 而不是 getByText——两处都合法存在，不是重复。
    expect(screen.getAllByText(/265 chapters/).length).toBeGreaterThanOrEqual(2);
    const list = screen.getByTestId("preview-chapter-list");
    expect(within(list).getAllByTestId("chapter-list-link")).toHaveLength(3);
    // MOCK_NOVEL_DETAIL 带 readOnUpstreamHref，锁定条目 = 265 - 3 = 262，服务端首屏封顶 30
    expect(within(list).getAllByTestId("locked-chapter-item")).toHaveLength(30);
  });
});

describe("小说详情页 · 可试读章节区块", () => {
  it("嵌在详情页内，锚点为 preview-chapters，不建独立目录路由", () => {
    const { container } = render(<NovelDetailScreen locale="en" novel={MOCK_NOVEL_DETAIL} />);
    const block = container.querySelector("#preview-chapters");

    expect(block).toBeTruthy();
    expect(block?.getAttribute("data-testid")).toBe("preview-chapters");
  });

  it("真实章节渲染为可点击链接，且只渲染 fixture 里实际存在的章节（锁定条目不算在内）", () => {
    render(<NovelDetailScreen locale="en" novel={MOCK_NOVEL_DETAIL} />);

    const items = screen.getByTestId("preview-chapter-list").querySelectorAll('[data-testid="chapter-list-link"]');
    expect(items).toHaveLength(MOCK_NOVEL_DETAIL.previewChapters.length);

    for (const chapter of MOCK_NOVEL_DETAIL.previewChapters) {
      expect(screen.getByText(chapter.title)).toBeTruthy();
    }
  });

  // A3（Owner 2026-09-29 修订 D-12 第 2 条）：标题从 "Preview chapters" 改成
  // "Chapter list"，不使用"完整目录/全部章节"这类措辞——断言改为跟随新标题。
  it("不出现「完整目录」「全部章节」这类表述，标题固定为 Chapter list", () => {
    const { container } = render(<NovelDetailScreen locale="en" novel={MOCK_NOVEL_DETAIL} />);
    const text = container.textContent ?? "";

    for (const forbidden of ["完整目录", "全部章节", "全书目录", "完整章节"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(screen.getByText("Chapter list")).toBeTruthy();
  });

  /**
   * Owner 决策 2026-09-18（发布与 Preview 解耦）：没有试读的文章可以正常发布，
   * 于是「零章节」成为一个正常且长期存在的页面形态，不再是一个要向读者交代的
   * 异常。此前这里渲染「可试读章节」标题 + 一张 `novel.noPreviewChapters` 空
   * 状态卡片——那是把后台的采集缺口当产品文案讲出去。现在整块消失，与同页
   * 标签区/推荐区取齐。
   *
   * 三条一起断言：列表没有、空壳提示没有、连区块本身都不在——只断言第一条的话，
   * 把空状态卡片换成另一句「暂无试读」仍然能过。
   */
  it("没有可试读章节时整块不渲染——不留空列表，也不显示「暂无试读」这类空壳提示", () => {
    const { container } = render(<NovelDetailScreen locale="en" novel={MOCK_NOVEL_DETAIL_SPARSE} />);

    expect(screen.queryByTestId("preview-chapter-list")).toBeNull();
    expect(screen.queryByTestId("preview-chapters-empty")).toBeNull();
    expect(screen.queryByTestId("preview-chapters")).toBeNull();
    // 页面其余部分照常渲染：没有试读 ≠ 页面坏了。
    expect(container.textContent).toContain(MOCK_NOVEL_DETAIL_SPARSE.title);
  });
});

describe("小说详情页 · 标签与元信息", () => {
  it("标签为空时整个标签区块消失", () => {
    const { container } = render(<NovelDetailScreen locale="en" novel={MOCK_NOVEL_DETAIL_SPARSE} />);
    expect(container.querySelector('[data-testid="tag-list"]')).toBeNull();
  });

  // A1：语言代码展示已删除（元信息不再渲染 locale.label），这条用例的断言
  // 从"渲染 English"改成"不渲染 English"——理由见交接文档 A1。
  it("元信息是流式的，只渲染真实存在的项（A1 起不再包含语言代码）", () => {
    render(<NovelDetailScreen locale="en" novel={MOCK_NOVEL_DETAIL_SPARSE} />);

    const meta = screen.getAllByTestId("meta-list")[0];
    // 稀疏这本没有可试读章节，所以「可试读 N 章」这一项不出现
    expect(meta.textContent).not.toContain("English");
    expect(meta.textContent).toContain("88 chapters");
    expect(meta.textContent).not.toContain("preview chapters");
  });
});

describe("小说详情页 · 行动区", () => {
  // C: "Start preview" → "Start reading"。
  // B1：详情页现在还有固定底部浮窗（StickyCTA），它也渲染一个 "Continue
  // reading" 链接——用 getAllByRole 取第一个（DOM 顺序里行动区在浮窗之前），
  // 不代表放宽断言，只是同名链接从 1 个变成 2 个后要挑对目标。
  it("站内试读为主动作，正式阅读为次动作", () => {
    render(<NovelDetailScreen locale="en" novel={MOCK_NOVEL_DETAIL} />);

    const preview = screen.getByRole("link", { name: "Start reading" });
    const upstream = screen.getAllByRole("link", { name: "Continue reading" })[0]!;

    expect(preview.className).toContain("bg-novel-accent");
    expect(upstream.className).toContain("border-novel-border-strong");
    expect(upstream.className).not.toContain("bg-novel-accent");
  });

  it("正式阅读入口带 nofollow sponsored", () => {
    render(<NovelDetailScreen locale="en" novel={MOCK_NOVEL_DETAIL} />);
    for (const link of screen.getAllByRole("link", { name: "Continue reading" })) {
      expect(link.getAttribute("rel")).toBe("nofollow sponsored");
    }
  });

  it("没有公开跳转码时不渲染正式阅读入口", () => {
    render(<NovelDetailScreen locale="en" novel={MOCK_NOVEL_DETAIL_SPARSE} />);
    expect(screen.queryByRole("link", { name: "Continue reading" })).toBeNull();
  });
});

describe("小说详情页 · 推荐结构", () => {
  it("本轮不接推荐数据时整块不渲染，不留空框", () => {
    render(<NovelDetailScreen locale="en" novel={MOCK_NOVEL_DETAIL} />);
    expect(screen.queryByRole("heading", { name: "Related works" })).toBeNull();
  });

  it("传入数据时才渲染，且复用同一种卡片", () => {
    const { container } = render(
      <NovelDetailScreen locale="en" novel={MOCK_NOVEL_DETAIL} related={MOCK_NOVEL_CARDS.slice(0, 3)} />,
    );

    expect(screen.getByRole("heading", { name: "Related works" })).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="book-card"]')).toHaveLength(3);
  });

  // A4/B3："新书推荐"——与"相关推荐"同一份"无数据不渲染/有数据才渲染"契约，
  // 独立的一块（不是 relatedTitle 的别名）。
  it("newReleases：本轮不接数据时整块不渲染，不留空框", () => {
    render(<NovelDetailScreen locale="en" novel={MOCK_NOVEL_DETAIL} />);
    expect(screen.queryByRole("heading", { name: "New releases" })).toBeNull();
  });

  it("newReleases：传入数据时才渲染，与 related 各自独立", () => {
    const { container } = render(
      <NovelDetailScreen
        locale="en"
        novel={MOCK_NOVEL_DETAIL}
        related={MOCK_NOVEL_CARDS.slice(0, 2)}
        newReleases={MOCK_NOVEL_CARDS.slice(2, 5)}
      />,
    );

    expect(screen.getByRole("heading", { name: "Related works" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "New releases" })).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="book-card"]')).toHaveLength(5);
  });

  // 运营原文口径：推荐模块的卡片只显示封面加书名，不显示标签（也不显示简介）
  // ——即便候选书本身带标签（MOCK_NOVEL_CARDS 的前两本都带），推荐区块里也
  // 不能渲染出来。首页/分类页的 BookCard 不受影响，见 book-card.test.tsx。
  it("推荐模块的卡片只有封面和书名，不显示标签", () => {
    const { container } = render(
      <NovelDetailScreen
        locale="en"
        novel={MOCK_NOVEL_DETAIL}
        related={MOCK_NOVEL_CARDS.slice(0, 2)}
        newReleases={MOCK_NOVEL_CARDS.slice(2, 4)}
      />,
    );

    const relatedSection = container.querySelector("#related-works")!;
    const newReleasesSection = container.querySelector("#new-releases")!;
    expect(relatedSection.querySelector('[data-testid="tag-list"]')).toBeNull();
    expect(newReleasesSection.querySelector('[data-testid="tag-list"]')).toBeNull();
    // MOCK_NOVEL_CARDS 前两本分别带 "言情"/"都市"/"言情" 标签——确认这些
    // 标签文字确实没有出现在推荐区块内（不是标签区块隐藏了但文字还在）。
    expect(relatedSection.textContent).not.toContain("言情");
    expect(relatedSection.textContent).not.toContain("都市");
    // 卡片仍然是同一个 book-card，且每张卡片本身没有打上 minimal 标记之外的差异。
    for (const card of relatedSection.querySelectorAll('[data-testid="book-card"]')) {
      expect(card.getAttribute("data-card-minimal")).toBe("true");
    }
  });
});

/**
 * 新增用例（交接文档"测试与门禁"一节要求）：小说页恰好一个 H1。
 *
 * A2/D2：`NovelDetailScreen.tsx` 此前把 `novel.contentBody`（文章模板生成的
 * 正文，默认模板第一行是 `<h1>{novel_title}</h1>`）整段用
 * `dangerouslySetInnerHTML` 插进页面，导致页面出现第二个 H1。这个区块已经
 * 删除；`contentBody` 数据本身与它在 SEO/FAQ JSON-LD 里的用途不受影响
 * （novel-detail.tsx 页面层仍然读它来抽取 FAQ）——这里验证的是**可视渲染**
 * 层面不再重复出现 H1，不是说这个字段被删掉了。
 */
describe("小说详情页 · 只有一个 H1（A2/D2）", () => {
  it("即便 novel.contentBody 里带 <h1>，页面渲染出的 H1 仍然只有一个", () => {
    const { container } = render(
      <NovelDetailScreen
        locale="en"
        novel={{
          ...MOCK_NOVEL_DETAIL,
          contentBody: `<h1>${MOCK_NOVEL_DETAIL.title}</h1><p>Some generated article body.</p>`,
        }}
      />,
    );

    expect(container.querySelectorAll("h1")).toHaveLength(1);
    // contentBody 本身不再被可视渲染——生成的正文段落不应该出现在页面文本里
    expect(container.textContent).not.toContain("Some generated article body.");
  });

  it("没有 contentBody 时同样只有一个 H1", () => {
    const { container } = render(<NovelDetailScreen locale="en" novel={MOCK_NOVEL_DETAIL} />);
    expect(container.querySelectorAll("h1")).toHaveLength(1);
  });
});