import "./setup-cleanup";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { ContinueReadingModal } from "@/features/public-ui/novel/ContinueReadingModal";
import { PreviewChapterList } from "@/features/public-ui/novel/PreviewChapterList";
import type { PreviewChapterRef } from "@/features/public-ui/types";

/**
 * PN-10（`评估_PulseNovel前端SEO审计_2026-10-07.md` 施工单五）：锁定章节弹窗的键盘焦点。
 *
 * 此前弹窗只做了初始聚焦 + Esc，却声明了 `aria-modal`：审计实测在债务书详情页点 Chapter 4
 * 后连续 Tab，焦点序列是 关闭（内）→ 继续阅读（内）→ 遮罩后面的相关推荐链接（外）。
 * 现在要求：Tab / Shift+Tab 只在弹窗内循环（关闭 ↔ 继续阅读）；Esc 与点遮罩照旧关闭；
 * 关闭后焦点回到触发它的锁定章节按钮。
 *
 * jsdom 不会自己移动 Tab 焦点，所以这里的做法是：把焦点放在某个元素上，派发 Tab 键事件，
 * 断言「组件有没有接管（preventDefault）」以及「接管后焦点落在哪」。没有被接管的 Tab 交给浏览器，
 * 断言它**没有**被 preventDefault，证明组件不会在弹窗中间位置乱抢焦点。
 */

function chapters(count: number): PreviewChapterRef[] {
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    title: `Chapter ${index + 1}`,
    href: `/dev-preview/novel/${index + 1}`,
  }));
}

/** `fireEvent` 返回 `false` 表示事件被 `preventDefault()` 了。 */
function pressTab(target: Element | Document, shiftKey = false): { prevented: boolean } {
  const notPrevented = fireEvent.keyDown(target, { key: "Tab", shiftKey });
  return { prevented: !notPrevented };
}

/** 渲染章节列表，聚焦第一个锁定条目并点开弹窗（模拟 Chrome 里的鼠标 / 键盘触发：按钮先拿到焦点）。 */
function openFromLockedItem(itemIndex = 0) {
  const view = render(
    <PreviewChapterList locale="en" chapters={chapters(1)} totalChapterCount={4} readOnUpstreamHref="/go/abc123" />,
  );
  const trigger = screen.getAllByTestId("locked-chapter-item")[itemIndex]!;
  trigger.focus();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  const modal = screen.getByTestId("continue-reading-modal");
  return {
    ...view,
    trigger,
    modal,
    closeButton: within(modal).getByTestId("continue-reading-modal-close"),
    continueLink: within(modal).getByRole("link", { name: "Continue reading" }),
  };
}

describe("ContinueReadingModal · 焦点陷阱（PN-10）", () => {
  it("打开后焦点在弹窗内", () => {
    const { modal } = openFromLockedItem();
    expect(modal.contains(document.activeElement)).toBe(true);
  });

  it("在“继续阅读”（最后一个）上按 Tab → 绕回“关闭”（第一个），且事件被接管", () => {
    const { closeButton, continueLink } = openFromLockedItem();
    continueLink.focus();
    expect(pressTab(continueLink)).toEqual({ prevented: true });
    expect(document.activeElement).toBe(closeButton);
  });

  it("在“关闭”（第一个）上按 Shift+Tab → 绕到“继续阅读”（最后一个），且事件被接管", () => {
    const { closeButton, continueLink } = openFromLockedItem();
    closeButton.focus();
    expect(pressTab(closeButton, true)).toEqual({ prevented: true });
    expect(document.activeElement).toBe(continueLink);
  });

  it("焦点在弹窗容器本身（刚打开时的位置）时按 Shift+Tab → 绕到“继续阅读”", () => {
    const { modal, continueLink } = openFromLockedItem();
    expect(document.activeElement).toBe(modal);
    expect(pressTab(modal, true)).toEqual({ prevented: true });
    expect(document.activeElement).toBe(continueLink);
  });

  it("焦点已经跑到弹窗外时按 Tab → 被拉回弹窗内的第一个元素", () => {
    const { closeButton } = openFromLockedItem();
    const outside = screen.getAllByTestId("chapter-list-link")[0]!;
    outside.focus();
    expect(document.activeElement).toBe(outside);
    expect(pressTab(outside)).toEqual({ prevented: true });
    expect(document.activeElement).toBe(closeButton);
  });

  it("焦点已经跑到弹窗外时按 Shift+Tab → 被拉回弹窗内的最后一个元素", () => {
    const { continueLink } = openFromLockedItem();
    const outside = screen.getAllByTestId("chapter-list-link")[0]!;
    outside.focus();
    expect(pressTab(outside, true)).toEqual({ prevented: true });
    expect(document.activeElement).toBe(continueLink);
  });

  it("弹窗中间位置的 Tab 交给浏览器，不接管（“关闭”上 Tab、“继续阅读”上 Shift+Tab、容器上 Tab）", () => {
    const { modal, closeButton, continueLink } = openFromLockedItem();

    closeButton.focus();
    expect(pressTab(closeButton)).toEqual({ prevented: false });
    expect(document.activeElement).toBe(closeButton);

    continueLink.focus();
    expect(pressTab(continueLink, true)).toEqual({ prevented: false });
    expect(document.activeElement).toBe(continueLink);

    modal.focus();
    expect(pressTab(modal)).toEqual({ prevented: false });
    expect(document.activeElement).toBe(modal);
  });

  it("带 Ctrl / Alt / Meta 的 Tab 不接管", () => {
    const { continueLink } = openFromLockedItem();
    continueLink.focus();
    for (const modifier of ["ctrlKey", "altKey", "metaKey"] as const) {
      const notPrevented = fireEvent.keyDown(continueLink, { key: "Tab", [modifier]: true });
      expect(notPrevented).toBe(true);
      expect(document.activeElement).toBe(continueLink);
    }
  });

  it("父组件重渲染（拿到新的 onClose）不会把焦点从“继续阅读”抢回弹窗容器", () => {
    const view = render(
      <ContinueReadingModal locale="en" chapterNumber={2} href="/go/abc123" onClose={() => {}} />,
    );
    const continueLink = screen.getByRole("link", { name: "Continue reading" });
    continueLink.focus();
    view.rerender(<ContinueReadingModal locale="en" chapterNumber={2} href="/go/abc123" onClose={() => {}} />);
    expect(document.activeElement).toBe(continueLink);
  });
});

describe("ContinueReadingModal · 关闭与焦点归还（PN-10）", () => {
  it("按 Esc 关闭：弹窗消失，焦点回到刚才点的锁定条目按钮", () => {
    const { trigger } = openFromLockedItem();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByTestId("continue-reading-modal")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("点“关闭”按钮：焦点回到触发它的锁定条目按钮", () => {
    const { trigger, closeButton } = openFromLockedItem();
    fireEvent.click(closeButton);
    expect(screen.queryByTestId("continue-reading-modal")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("点遮罩关闭：焦点回到触发它的锁定条目按钮", () => {
    const { trigger } = openFromLockedItem();
    fireEvent.click(screen.getByTestId("continue-reading-modal-backdrop"));
    expect(screen.queryByTestId("continue-reading-modal")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("点的是第 N 个锁定条目，就归还给第 N 个（不是第一个）", () => {
    const { trigger } = openFromLockedItem(2);
    expect(trigger).toBe(screen.getAllByTestId("locked-chapter-item")[2]);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
    expect(document.activeElement).not.toBe(screen.getAllByTestId("locked-chapter-item")[0]);
  });

  it("关闭后再打开另一个条目：每次都归还给各自的触发按钮", () => {
    const first = openFromLockedItem(0);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(first.trigger);

    const second = screen.getAllByTestId("locked-chapter-item")[1]!;
    second.focus();
    fireEvent.click(second);
    expect(screen.getByTestId("continue-reading-modal")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(second);
  });

  it("触发元素在弹窗关闭前已从文档中移除：不抛错，也不把焦点塞给已摘除的元素", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const onClose = vi.fn();
    const view = render(<ContinueReadingModal locale="en" chapterNumber={2} href="/go/abc123" onClose={onClose} />);

    opener.remove();
    expect(() => view.unmount()).not.toThrow();
    expect(document.activeElement).toBe(document.body);
    expect(opener.isConnected).toBe(false);
  });

  it("打开前没有具体焦点元素（<body>，例如 Safari 点击按钮不聚焦）：关闭时不报错，焦点不残留在已摘除的弹窗上", () => {
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    const view = render(<ContinueReadingModal locale="en" chapterNumber={2} href="/go/abc123" onClose={() => {}} />);
    expect(screen.getByTestId("continue-reading-modal")).toBe(document.activeElement);
    expect(() => view.unmount()).not.toThrow();
    expect(document.activeElement).toBe(document.body);
  });

  it("Esc 与点遮罩的既有行为不变：各只调用一次 onClose", () => {
    const onClose = vi.fn();
    render(<ContinueReadingModal locale="en" chapterNumber={2} href="/go/abc123" onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("continue-reading-modal-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(2);
    // 点弹窗本体不算点遮罩
    fireEvent.click(screen.getByTestId("continue-reading-modal"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
