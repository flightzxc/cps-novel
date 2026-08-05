import "./setup-cleanup";
import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChapterScreen } from "@/features/public-ui/chapter/ChapterScreen";
import {
  readReadingPosition,
  readingPositionKey,
} from "@/features/public-ui/chapter/reader-storage";
import { getMockChapterView } from "@/features/public-ui/fixtures/mock-content";

/**
 * 🔴 **本文件用于记录一个已确认的产品缺陷，用例会失败。**
 *
 * 模块：`src/features/public-ui/chapter/useReadingPosition.ts`
 * 位置：effect 的 cleanup 里那次 `capture()`（"卸载前最后记一次：切换章节时
 * 这是唯一能留住当前位置的时机"）。
 *
 * 现象：切章时，离开的那一章的阅读位置**不是**被记成读者停留的位置，而是恒被
 * 覆盖成"最后一段、段内占比 0"。于是回到该章会跳到章末，而不是上次读到的地方。
 *
 * 成因：`useReadingPosition` 用的是 `useEffect`（passive effect）。React 的
 * passive cleanup 在 commit 的 mutation 阶段**之后**才 flush，那时旧章节的
 * DOM 子树已经从文档里摘除。对已摘除的节点，`getBoundingClientRect()` 全 0，
 * 于是 `capture()` 里"最后一个 top <= 0 的段落"对每一段都成立 → index 取到
 * 最后一段；`rect.height` 为 0 → ratio 落到 0 分支。
 *
 * 既有测试为什么没发现：jsdom 本来就没有布局，所有 rect 恒为 0，
 * `reader-position.test.tsx` 因此在开头就声明"不验像素"，且从不 unmount。
 * 真实浏览器与 jsdom 在这里"恰好一样错"，缺陷被两边同时掩盖。
 *
 * 真实浏览器复现（Chrome 150 / 1280×720，见本轮交付报告）：
 *   第 1 章滚到第 10 段 → 存储为 `{"mock-1:1":{"paragraphIndex":10,"ratio":0.975}}`
 *   点"下一章"        → 存储被改写为 `{"mock-1:1":{"paragraphIndex":16,"ratio":0}}`
 *   点"上一章"回到第 1 章 → 落在 scrollY 2030 / 最大 2069，即章末
 *
 * 本文件不改生产代码，等 P1-11 模块 Owner 单独修复。
 */

const CHAPTER_1 = getMockChapterView(1)!;
const CHAPTER_2 = getMockChapterView(2)!;
const KEY_1 = readingPositionKey(CHAPTER_1.novel.id, CHAPTER_1.number);
const KEY_2 = readingPositionKey(CHAPTER_2.novel.id, CHAPTER_2.number);

const PARAGRAPH_HEIGHT = 100;

function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/**
 * 给 jsdom 补一层可预测的段落布局。
 *
 * 关键是**如实模拟浏览器对已摘除节点的行为**：`isConnected === false` 时
 * `getBoundingClientRect()` 返回全 0。缺了这条，jsdom 里的 unmount 与真实浏览器
 * 的行为就对不上，这个缺陷也就复现不出来。
 */
function installLayout(): () => void {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function measured(this: Element): DOMRect {
    const attribute = this.getAttribute?.("data-paragraph-index");
    if (attribute === null || attribute === undefined) return original.call(this);
    if (!this.isConnected) return rect(0, 0);
    return rect(Number(attribute) * PARAGRAPH_HEIGHT - window.scrollY, PARAGRAPH_HEIGHT);
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

let restoreLayout: (() => void) | null = null;

afterEach(() => {
  restoreLayout?.();
  restoreLayout = null;
});

/** 滚到某一段的顶部，并触发一次产品自己监听的记录路径。 */
function readTo(paragraphIndex: number): void {
  window.scrollTo({ top: paragraphIndex * PARAGRAPH_HEIGHT, behavior: "auto" });
  // pagehide 走的是与 scroll 相同的 capture()，但它是同步的，不必等 rAF 节流。
  fireEvent(window, new Event("pagehide"));
}

describe("阅读位置 · 离开章节时的记录（🔴 已知缺陷）", () => {
  it("读到第 10 段时，记录的就是第 10 段", () => {
    restoreLayout = installLayout();
    render(<ChapterScreen chapter={CHAPTER_1} />);

    readTo(10);

    // 这一条是对照组：停留期间的记录是对的，缺陷只出在离开那一刻。
    expect(readReadingPosition(KEY_1)?.paragraphIndex).toBe(10);
  });

  it("🔴 切走后位置应当仍是第 10 段，实际被覆盖成末段", () => {
    restoreLayout = installLayout();
    const { unmount } = render(<ChapterScreen chapter={CHAPTER_1} />);

    readTo(10);
    expect(readReadingPosition(KEY_1)?.paragraphIndex).toBe(10);

    // 切章：旧章节卸载，cleanup 里的 capture() 此时面对的是已摘除的 DOM。
    unmount();

    expect(
      readReadingPosition(KEY_1)?.paragraphIndex,
      "离开章节不应改变已记录的阅读位置",
    ).toBe(10);
  });

  it("🔴 只是路过、从未滚动的章节，也被写进一个章末位置", () => {
    restoreLayout = installLayout();
    const { unmount } = render(<ChapterScreen chapter={CHAPTER_2} />);

    // 读者一眼没看就切走了：真实位置是第 0 段。
    expect(readReadingPosition(KEY_2)).toBeNull();
    unmount();

    const saved = readReadingPosition(KEY_2);
    expect(
      saved === null || saved.paragraphIndex === 0,
      `未读过的章节被记成第 ${saved?.paragraphIndex} 段（共 ${CHAPTER_2.paragraphs.length} 段），下次进来会直接跳到章末`,
    ).toBe(true);
  });
});
