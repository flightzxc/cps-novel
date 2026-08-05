import "./setup-cleanup";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChapterScreen } from "@/features/public-ui/chapter/ChapterScreen";
import { NovelDetailScreen } from "@/features/public-ui/novel/NovelDetailScreen";
import {
  MOCK_NOVEL_DETAIL,
  MOCK_PREVIEW_CHAPTER_TOTAL,
  getMockChapterView,
} from "@/features/public-ui/fixtures/mock-content";
import {
  DEV_PREVIEW_CHAPTER_BASE,
  devPreviewChapterPath,
} from "@/features/public-ui/fixtures/preview-paths";

/**
 * 章节切换（P1-11 交付物 ⑤ 🔴 无整页刷新）。
 *
 * 「不整页刷新」本身是浏览器行为，jsdom 验不了——它在人工验收里用 Network 面板
 * 与 performance navigation 条目确认。这里验的是它成立的**前提**：每章有各自的
 * 地址、上下章指向真实存在的相邻章、地址全部出自单一 helper、边界不渲染死链。
 */

describe("章节切换 · 地址", () => {
  it("每章有各自的地址，不是所有章共用一个", () => {
    const first = getMockChapterView(1)!;
    const second = getMockChapterView(2)!;

    expect(first.nextHref).toBe(devPreviewChapterPath(2));
    expect(second.previousHref).toBe(devPreviewChapterPath(1));
    expect(first.nextHref).not.toBe(second.nextHref);
  });

  it("上下章互为逆操作——从第 2 章往回就是第 1 章", () => {
    const second = getMockChapterView(2)!;
    const backTarget = second.previousHref;
    const first = getMockChapterView(1)!;

    expect(backTarget).toBe(devPreviewChapterPath(first.number));
    expect(first.nextHref).toBe(devPreviewChapterPath(second.number));
  });

  it("地址一律出自单一 helper，组件与假数据都不自己拼", () => {
    for (let n = 1; n <= MOCK_PREVIEW_CHAPTER_TOTAL; n += 1) {
      expect(devPreviewChapterPath(n)).toBe(`${DEV_PREVIEW_CHAPTER_BASE}/${n}`);
    }

    // 详情页列出的每一章都必须真的能点进去，且地址与 helper 一致。
    for (const chapter of MOCK_NOVEL_DETAIL.previewChapters) {
      expect(chapter.href).toBe(devPreviewChapterPath(chapter.number));
      expect(getMockChapterView(chapter.number)).not.toBeNull();
    }
  });

  it("章号越界时没有对应章节，由路由层走 404", () => {
    expect(getMockChapterView(0)).toBeNull();
    expect(getMockChapterView(MOCK_PREVIEW_CHAPTER_TOTAL + 1)).toBeNull();
  });
});

describe("章节切换 · 渲染出的导航", () => {
  it("中间章上下章都渲染，且指向相邻章", () => {
    render(<ChapterScreen chapter={getMockChapterView(2)!} />);

    expect(screen.getByRole("link", { name: "上一章" }).getAttribute("href")).toBe(
      devPreviewChapterPath(1),
    );
    expect(screen.getByRole("link", { name: "下一章" }).getAttribute("href")).toBe(
      devPreviewChapterPath(3),
    );
  });

  it("首章不渲染上一章，末章不渲染下一章——不留死链", () => {
    const { unmount } = render(<ChapterScreen chapter={getMockChapterView(1)!} />);
    expect(screen.queryByRole("link", { name: "上一章" })).toBeNull();
    expect(screen.getByText("已是第一章")).toBeTruthy();
    unmount();

    render(<ChapterScreen chapter={getMockChapterView(MOCK_PREVIEW_CHAPTER_TOTAL)!} />);
    expect(screen.queryByRole("link", { name: "下一章" })).toBeNull();
    expect(screen.getByText("已是最后一章试读")).toBeTruthy();
  });

  it("导航链接保留 rel=prev/next 语义", () => {
    render(<ChapterScreen chapter={getMockChapterView(2)!} />);

    expect(screen.getByRole("link", { name: "上一章" }).getAttribute("rel")).toBe("prev");
    expect(screen.getByRole("link", { name: "下一章" }).getAttribute("rel")).toBe("next");
  });

  it("试读进度随章号推进，分母恒为可试读章数", () => {
    const { unmount } = render(<ChapterScreen chapter={getMockChapterView(2)!} />);
    expect(screen.getByTestId("book-attribution-bar").textContent).toContain(
      `试读 2 / ${MOCK_PREVIEW_CHAPTER_TOTAL}`,
    );
    unmount();

    render(<ChapterScreen chapter={getMockChapterView(3)!} />);
    expect(screen.getByTestId("book-attribution-bar").textContent).toContain(
      `试读 3 / ${MOCK_PREVIEW_CHAPTER_TOTAL}`,
    );
  });

  it("详情页的可试读章节列表逐条指向对应章节页", () => {
    render(<NovelDetailScreen novel={MOCK_NOVEL_DETAIL} />);

    for (const chapter of MOCK_NOVEL_DETAIL.previewChapters) {
      const link = screen.getByRole("link", { name: new RegExp(chapter.title) });
      expect(link.getAttribute("href")).toBe(devPreviewChapterPath(chapter.number));
    }
  });
});
