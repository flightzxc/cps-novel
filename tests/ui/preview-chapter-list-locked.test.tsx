import "./setup-cleanup";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { PreviewChapterList } from "@/features/public-ui/novel/PreviewChapterList";
import type { PreviewChapterRef } from "@/features/public-ui/types";

/**
 * A3 折中方案（Owner 2026-09-29 修订 D-12 第 2 条）新增用例。规则见
 * `PreviewChapterList.tsx` 头部注释与 `docs/adr/ADR-D12-chapter-list-lock-
 * revision.md`：
 *   - 锁定条目是 `<button>`，不是 `<a>`，不生成任何网址；
 *   - 服务端首屏最多渲染 30 条锁定条目，其余靠"展开全部"按钮在客户端生成；
 *   - 没有 `readOnUpstreamHref` 的书完全不渲染锁定条目、展开按钮、
 *     "阅读更多章节"按钮——行为等同没有这次改动之前。
 */

function chapters(count: number): PreviewChapterRef[] {
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    title: `Chapter ${index + 1}`,
    href: `/dev-preview/novel/${index + 1}`,
  }));
}

describe("PreviewChapterList · 锁定章节", () => {
  it("总章数 > 真实章节数且有推广链接时，追加锁定条目，且锁定条目是按钮而不是链接", () => {
    render(
      <PreviewChapterList
        locale="en"
        chapters={chapters(3)}
        totalChapterCount={10}
        readOnUpstreamHref="/go/abc123"
      />,
    );

    const list = screen.getByTestId("preview-chapter-list");
    // 3 条真实链接 + 7 条锁定条目（10 - 3）
    expect(within(list).getAllByTestId("chapter-list-link")).toHaveLength(3);
    const locked = within(list).getAllByTestId("locked-chapter-item");
    expect(locked).toHaveLength(7);
    for (const item of locked) {
      expect(item.tagName).toBe("BUTTON");
    }
    // 锁定条目不生成任何网址
    for (const item of locked) {
      expect(item.getAttribute("href")).toBeNull();
    }
    expect(screen.getByText("Chapter 4")).toBeTruthy();
    expect(screen.getByText("Chapter 10")).toBeTruthy();
  });

  it("锁定条目不编造章名——只显示编号", () => {
    render(
      <PreviewChapterList
        locale="en"
        chapters={chapters(1)}
        totalChapterCount={3}
        readOnUpstreamHref="/go/abc123"
      />,
    );
    const locked = screen.getAllByTestId("locked-chapter-item");
    expect(locked).toHaveLength(2);
    // 锁定条目里除了 "Chapter N" 与读屏专用提示，没有别的可见文字（不编造章名）
    for (const item of locked) {
      expect(item.textContent).toMatch(/^Chapter \d+/);
    }
  });

  it("服务端首屏最多渲染 30 条锁定条目，超出部分靠“展开全部”按钮补齐", () => {
    render(
      <PreviewChapterList
        locale="en"
        chapters={chapters(1)}
        totalChapterCount={50}
        readOnUpstreamHref="/go/abc123"
      />,
    );

    // 50 - 1 = 49 条锁定，首屏封顶 30
    expect(screen.getAllByTestId("locked-chapter-item")).toHaveLength(30);
    const expandButton = screen.getByTestId("expand-all-chapters");
    // 按钮写的是"全部 N 章"，N = 全书总章数 50（不是锁定条目数 49）
    expect(expandButton.textContent).toBe("Show all 50 chapters");

    fireEvent.click(expandButton);

    expect(screen.getAllByTestId("locked-chapter-item")).toHaveLength(49);
    expect(screen.queryByTestId("expand-all-chapters")).toBeNull();
  });

  it("“展开全部”按钮上的数字是全书总章数：3 章真实 + 262 条锁定 = 265，不是 262", () => {
    render(
      <PreviewChapterList
        locale="en"
        chapters={chapters(3)}
        totalChapterCount={265}
        readOnUpstreamHref="/go/abc123"
      />,
    );
    const expandButton = screen.getByTestId("expand-all-chapters");
    expect(expandButton.textContent).toBe("Show all 265 chapters");
    expect(expandButton.textContent).not.toContain("262");

    fireEvent.click(expandButton);

    // 展开后列表确实显示了全书 265 章：3 条真实链接 + 262 条锁定条目
    const list = screen.getByTestId("preview-chapter-list");
    expect(within(list).getAllByTestId("chapter-list-link")).toHaveLength(3);
    expect(within(list).getAllByTestId("locked-chapter-item")).toHaveLength(262);
  });

  it("真实章节编号有缺口时，按钮数字仍然是全书总章数（锁定区间从最大真实编号之后起算）", () => {
    // 真实编号 1、2、5；总章数 50 → 锁定条目 50 - 5 = 45 条。
    // 按钮既不是 45（锁定条目数），也不是 48（真实条数 3 + 锁定条目数 45）。
    const gapped: PreviewChapterRef[] = [1, 2, 5].map((number) => ({
      number,
      title: `Chapter ${number}`,
      href: `/dev-preview/novel/${number}`,
    }));
    render(
      <PreviewChapterList
        locale="en"
        chapters={gapped}
        totalChapterCount={50}
        readOnUpstreamHref="/go/abc123"
      />,
    );
    expect(screen.getByTestId("expand-all-chapters").textContent).toBe("Show all 50 chapters");
  });

  it("锁定条目 ≤ 30 条时不渲染“展开全部”按钮", () => {
    render(
      <PreviewChapterList
        locale="en"
        chapters={chapters(1)}
        totalChapterCount={10}
        readOnUpstreamHref="/go/abc123"
      />,
    );
    expect(screen.getAllByTestId("locked-chapter-item")).toHaveLength(9);
    expect(screen.queryByTestId("expand-all-chapters")).toBeNull();
  });

  it("点击锁定条目弹出续读弹窗，弹窗里的按钮跳 readOnUpstreamHref", () => {
    render(
      <PreviewChapterList
        locale="en"
        chapters={chapters(1)}
        totalChapterCount={3}
        readOnUpstreamHref="/go/abc123"
      />,
    );

    expect(screen.queryByTestId("continue-reading-modal")).toBeNull();
    fireEvent.click(screen.getAllByTestId("locked-chapter-item")[0]!);

    const modal = screen.getByTestId("continue-reading-modal");
    expect(modal).toBeTruthy();
    // 弹窗按钮会跳转到别处，正文不能说内容"available here"（就在当前页）
    expect(modal.textContent).toContain("Continue with Chapter 2 and the rest of the story.");
    expect(modal.textContent).not.toContain("available here");
    const link = within(modal).getByRole("link", { name: "Continue reading" });
    expect(link.getAttribute("href")).toBe("/go/abc123");
    expect(link.getAttribute("rel")).toBe("nofollow sponsored");

    fireEvent.click(screen.getByTestId("continue-reading-modal-close"));
    expect(screen.queryByTestId("continue-reading-modal")).toBeNull();
  });

  it("列表后有“阅读更多章节”按钮，跳 readOnUpstreamHref", () => {
    render(
      <PreviewChapterList
        locale="en"
        chapters={chapters(1)}
        totalChapterCount={3}
        readOnUpstreamHref="/go/abc123"
      />,
    );
    const readMore = screen.getByTestId("read-more-chapters");
    expect(readMore.getAttribute("href")).toBe("/go/abc123");
    expect(readMore.getAttribute("rel")).toBe("nofollow sponsored");
  });

  it("没有推广链接的书：不渲染锁定条目、展开按钮、阅读更多章节按钮", () => {
    render(<PreviewChapterList locale="en" chapters={chapters(3)} totalChapterCount={10} />);

    expect(screen.queryByTestId("locked-chapter-item")).toBeNull();
    expect(screen.queryByTestId("expand-all-chapters")).toBeNull();
    expect(screen.queryByTestId("read-more-chapters")).toBeNull();
    // 真实章节照常列出
    expect(screen.getAllByTestId("chapter-list-link")).toHaveLength(3);
  });

  it("总章数不大于真实章节数时不追加锁定条目，即便有推广链接", () => {
    render(
      <PreviewChapterList
        locale="en"
        chapters={chapters(3)}
        totalChapterCount={3}
        readOnUpstreamHref="/go/abc123"
      />,
    );
    expect(screen.queryByTestId("locked-chapter-item")).toBeNull();
    // 有推广链接、但没有锁定条目要展示——列表后仍然有"阅读更多章节"吗？
    // 不应该：规则 5/6 把这个按钮绑定在"有锁定条目"这个条件上。
    expect(screen.queryByTestId("read-more-chapters")).toBeNull();
  });

  it("不出现「完整目录」「全部章节」这类表述", () => {
    const { container } = render(
      <PreviewChapterList
        locale="en"
        chapters={chapters(3)}
        totalChapterCount={5000}
        readOnUpstreamHref="/go/abc123"
      />,
    );
    const text = container.textContent ?? "";
    for (const forbidden of ["完整目录", "全部章节", "全书目录", "完整章节", "Full table of contents", "Complete catalog"]) {
      expect(text).not.toContain(forbidden);
    }
  });
});
