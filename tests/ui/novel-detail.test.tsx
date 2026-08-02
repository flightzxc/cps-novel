import "./setup-cleanup";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { NovelDetailScreen } from "@/features/public-ui/novel/NovelDetailScreen";
import {
  MOCK_NOVEL_CARDS,
  MOCK_NOVEL_DETAIL,
  MOCK_NOVEL_DETAIL_SPARSE,
} from "@/features/public-ui/fixtures/mock-content";

describe("小说详情页 · 字段边界", () => {
  it("不渲染作者、评分、阅读量的任何占位", () => {
    const { container } = render(<NovelDetailScreen novel={MOCK_NOVEL_DETAIL} />);
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
    const { container } = render(<NovelDetailScreen novel={MOCK_NOVEL_DETAIL} />);
    const html = container.innerHTML;

    expect(html).not.toMatch(/split[_-]?ratio/i);
    expect(html).not.toMatch(/upstream[_-]?code/i);
  });

  it("展示总章数这个客观标量，但不据此生成章节行", () => {
    render(<NovelDetailScreen novel={MOCK_NOVEL_DETAIL} />);

    expect(screen.getByText(/共 265 章/)).toBeTruthy();
    // 总章数 265，实际只列出 fixture 里的 3 条
    expect(screen.getByTestId("preview-chapter-list").querySelectorAll("li")).toHaveLength(3);
  });
});

describe("小说详情页 · 可试读章节区块", () => {
  it("嵌在详情页内，锚点为 preview-chapters，不建独立目录路由", () => {
    const { container } = render(<NovelDetailScreen novel={MOCK_NOVEL_DETAIL} />);
    const block = container.querySelector("#preview-chapters");

    expect(block).toBeTruthy();
    expect(block?.getAttribute("data-testid")).toBe("preview-chapters");
  });

  it("只渲染 fixture 里实际存在的章节", () => {
    render(<NovelDetailScreen novel={MOCK_NOVEL_DETAIL} />);

    const items = screen.getByTestId("preview-chapter-list").querySelectorAll("li");
    expect(items).toHaveLength(MOCK_NOVEL_DETAIL.previewChapters.length);

    for (const chapter of MOCK_NOVEL_DETAIL.previewChapters) {
      expect(screen.getByText(chapter.title)).toBeTruthy();
    }
  });

  it("不出现「完整目录」「全部章节」这类表述", () => {
    const { container } = render(<NovelDetailScreen novel={MOCK_NOVEL_DETAIL} />);
    const text = container.textContent ?? "";

    for (const forbidden of ["完整目录", "全部章节", "全书目录", "完整章节"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(screen.getByText("可试读章节")).toBeTruthy();
  });

  it("没有可试读章节时给出空状态，不留空列表", () => {
    render(<NovelDetailScreen novel={MOCK_NOVEL_DETAIL_SPARSE} />);

    expect(screen.getByTestId("preview-chapters-empty")).toBeTruthy();
    expect(screen.queryByTestId("preview-chapter-list")).toBeNull();
  });
});

describe("小说详情页 · 标签与元信息", () => {
  it("标签为空时整个标签区块消失", () => {
    const { container } = render(<NovelDetailScreen novel={MOCK_NOVEL_DETAIL_SPARSE} />);
    expect(container.querySelector('[data-testid="tag-list"]')).toBeNull();
  });

  it("元信息是流式的，只渲染真实存在的项", () => {
    render(<NovelDetailScreen novel={MOCK_NOVEL_DETAIL_SPARSE} />);

    const meta = screen.getAllByTestId("meta-list")[0];
    // 稀疏这本没有可试读章节，所以「可试读 N 章」这一项不出现
    expect(meta.textContent).toContain("English");
    expect(meta.textContent).toContain("共 88 章");
    expect(meta.textContent).not.toContain("可试读");
  });
});

describe("小说详情页 · 行动区", () => {
  it("站内试读为主动作，正式阅读为次动作", () => {
    render(<NovelDetailScreen novel={MOCK_NOVEL_DETAIL} />);

    const preview = screen.getByRole("link", { name: "开始试读" });
    const upstream = screen.getByRole("link", { name: "前往正式阅读" });

    expect(preview.className).toContain("bg-novel-accent");
    expect(upstream.className).toContain("border-novel-border-strong");
    expect(upstream.className).not.toContain("bg-novel-accent");
  });

  it("正式阅读入口带 nofollow sponsored", () => {
    render(<NovelDetailScreen novel={MOCK_NOVEL_DETAIL} />);
    expect(
      screen.getByRole("link", { name: "前往正式阅读" }).getAttribute("rel"),
    ).toBe("nofollow sponsored");
  });

  it("没有公开跳转码时不渲染正式阅读入口", () => {
    render(<NovelDetailScreen novel={MOCK_NOVEL_DETAIL_SPARSE} />);
    expect(screen.queryByRole("link", { name: "前往正式阅读" })).toBeNull();
  });
});

describe("小说详情页 · 推荐结构", () => {
  it("本轮不接推荐数据时整块不渲染，不留空框", () => {
    render(<NovelDetailScreen novel={MOCK_NOVEL_DETAIL} />);
    expect(screen.queryByRole("heading", { name: "相关作品" })).toBeNull();
  });

  it("传入数据时才渲染，且复用同一种卡片", () => {
    const { container } = render(
      <NovelDetailScreen novel={MOCK_NOVEL_DETAIL} related={MOCK_NOVEL_CARDS.slice(0, 3)} />,
    );

    expect(screen.getByRole("heading", { name: "相关作品" })).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="book-card"]')).toHaveLength(3);
  });
});