import "./setup-cleanup";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChapterScreen } from "@/features/public-ui/chapter/ChapterScreen";
import { MOCK_CHAPTER } from "@/features/public-ui/fixtures/mock-content";

/**
 * PN-03：阅读设置面板不能被固定底部续读条盖住。
 *
 * 缺陷现场（英语试读阅读器，360×800）：面板与续读条（StickyCTA）都是
 * `fixed bottom-0 z-40`，DOM 里更靠后的续读条盖在面板上，面板底部「重置」按钮
 * 的中心点 `elementFromPoint` 命中的是 `/go/…` 推广链接。
 *
 * jsdom 没有布局，证明不了「谁盖住谁」——真正的遮挡证据在浏览器验收
 * （`document.elementFromPoint`）。这里做的是**类名契约**：把造成遮挡的那几个
 * 类钉死，做法同 `design-tokens.test.ts`。任何一条被改回去，面板在窄屏就会再次
 * 被续读条盖住或在矮屏被裁出视口，这里先红。
 */

/** 取元素 class 里形如 `z-50` 的层级数值；没有则返回 null。只认无前缀的那一个。 */
function zIndexOf(element: HTMLElement): number | null {
  for (const token of Array.from(element.classList)) {
    const match = /^z-(\d+)$/.exec(token);
    if (match) {
      return Number(match[1]);
    }
  }
  return null;
}

function renderWithPanelOpen() {
  render(<ChapterScreen locale="en" chapter={MOCK_CHAPTER} />);
  fireEvent.click(screen.getByTestId("reader-settings-toggle"));
  return {
    panel: screen.getByTestId("reader-settings-panel"),
    bar: screen.getByTestId("sticky-cta"),
  };
}

describe("阅读设置面板 · 层级契约（PN-03）", () => {
  it("夹具章节带续读链接：打开设置时续读条仍在场（否则本组断言没有意义）", () => {
    const { panel, bar } = renderWithPanelOpen();

    expect(MOCK_CHAPTER.readOnUpstreamHref).toBeTruthy();
    expect(bar.querySelector("a")?.getAttribute("href")).toBe(MOCK_CHAPTER.readOnUpstreamHref);
    // 面板不在续读条内部——两者是兄弟层，比较的才是同一个层叠上下文里的 z-index。
    expect(bar.contains(panel)).toBe(false);
    expect(panel.contains(bar)).toBe(false);
  });

  it("面板层级严格高于续读条（面板 z-50 / 续读条 z-40）", () => {
    const { panel, bar } = renderWithPanelOpen();

    const panelZ = zIndexOf(panel);
    const barZ = zIndexOf(bar);

    expect(panelZ, "面板必须声明 z-* 层级").not.toBeNull();
    expect(barZ, "续读条必须声明 z-* 层级").not.toBeNull();
    // 相对关系：同层时 DOM 靠后者在上，续读条在 DOM 末尾，所以必须是严格大于。
    expect(panelZ as number).toBeGreaterThan(barZ as number);
    // 绝对值也钉死：续读条层级保持 z-40（本单不改 StickyCTA，也不引入
    // 「面板打开时隐藏续读条」的跨组件状态）；面板为 z-50。
    expect(barZ).toBe(40);
    expect(panelZ).toBe(50);
  });

  it("桌面形态（md:absolute）沿用同一个 z-50，不另写 md:z-* 把它降回去", () => {
    const { panel } = renderWithPanelOpen();

    expect(panel.classList.contains("md:absolute")).toBe(true);
    const mdZ = Array.from(panel.classList).filter((token) => token.startsWith("md:z-"));
    expect(mdZ).toEqual([]);
  });
});

describe("阅读设置面板 · 矮屏滚动与安全区契约（PN-03）", () => {
  it("移动端有最大高度，并在面板内部滚动、滚动不外溢到正文", () => {
    const { panel } = renderWithPanelOpen();

    expect(panel.classList.contains("max-h-[85dvh]")).toBe(true);
    expect(panel.classList.contains("overflow-y-auto")).toBe(true);
    expect(panel.classList.contains("overscroll-contain")).toBe(true);
  });

  it("桌面端把最大高度与滚动复位，锚定面板形态不变", () => {
    const { panel } = renderWithPanelOpen();

    expect(panel.classList.contains("md:max-h-none")).toBe(true);
    expect(panel.classList.contains("md:overflow-visible")).toBe(true);
    expect(panel.classList.contains("md:overscroll-auto")).toBe(true);
    // 桌面位置不改：仍是按钮下方、贴按钮末端、定宽。末端用逻辑类 md:end-0（从左到右时
    // 与原先的 md:right-0 计算值相同；从右到左时跟着按钮走，见 rtl-logical-direction.test.tsx）。
    for (const token of ["md:top-full", "md:end-0", "md:bottom-auto", "md:mt-2", "md:w-[22rem]"]) {
      expect(panel.classList.contains(token), token).toBe(true);
    }
  });

  it("移动端底部内边距叠加安全区，桌面端复位为 p-5 的 1.25rem", () => {
    const { panel } = renderWithPanelOpen();

    const safeAreaPadding = Array.from(panel.classList).filter(
      (token) => token.startsWith("pb-[") && token.includes("env(safe-area-inset-bottom)"),
    );
    expect(safeAreaPadding).toHaveLength(1);
    // 叠加而不是替换：安全区之外仍保留原有的 1.25rem 内边距。
    expect(safeAreaPadding[0]).toContain("1.25rem");
    expect(panel.classList.contains("md:pb-5")).toBe(true);
  });

  it("面板里的『重置』与『关闭』都在面板内部（会随面板一起滚动，而不是漂在面板外）", () => {
    const { panel } = renderWithPanelOpen();

    const close = screen.getByRole("button", { name: "Close reading settings" });
    const reset = screen.getByRole("button", { name: "Reset to defaults" });
    expect(panel.contains(close)).toBe(true);
    expect(panel.contains(reset)).toBe(true);
  });
});
