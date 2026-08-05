import "./setup-cleanup";
import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChapterScreen } from "@/features/public-ui/chapter/ChapterScreen";
import {
  READER_POSITION_STORAGE_KEY,
  readReadingPosition,
  readingPositionKey,
} from "@/features/public-ui/chapter/reader-storage";
import { getMockChapterView } from "@/features/public-ui/fixtures/mock-content";

/**
 * 离开章节时的阅读位置记录。
 *
 * **这个文件盯的是一个已修复的缺陷。** 原实现把「离章前最后记一次」放在
 * `useEffect` 的 cleanup 里；passive cleanup 是在 commit 的 mutation 阶段之后才
 * flush 的，那时旧章节 DOM 已摘除，`getBoundingClientRect()` 全 0，于是位置恒被
 * 覆盖成「末段 / ratio 0」，读者回到该章直接跳到章末。真实浏览器复现：
 * 第 1 章存 `{paragraphIndex:10, ratio:0.975}` → 点下一章后变成
 * `{paragraphIndex:16, ratio:0}` → 回到第 1 章落在 scrollY 2030 / 最大 2069。
 *
 * 修复后：最后一次记录改由 layout effect 的 cleanup 完成（DOM 还在），
 * passive cleanup 只解绑监听与取消 rAF，且 capture 本身对已摘除的树拒绝写入。
 *
 * jsdom 默认没有布局、所有 rect 恒为 0，与「已摘除节点」表现一致——这正是
 * `reader-position.test.tsx` 当初验不出这个缺陷的原因。所以这里补一层可预测的
 * 段落布局，并**如实模拟浏览器对已摘除节点返回全 0**，缺陷才可复现、修复才可验证。
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
 * 给 jsdom 补一层可预测的段落布局：第 n 段占据 [n*100, (n+1)*100)。
 *
 * 关键是**如实模拟浏览器对已摘除节点的行为**：`isConnected === false` 时
 * `getBoundingClientRect()` 返回全 0。缺了这条，jsdom 与真实浏览器在这里就对不上，
 * 守卫是否生效也就无从验证。
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

/** 只滚动，不落盘：留下一个「还没跑的 rAF 帧」。 */
function scrollTo(paragraphIndex: number): void {
  window.scrollTo({ top: paragraphIndex * PARAGRAPH_HEIGHT, behavior: "auto" });
  // jsdom 的 scrollTo 不会派发 scroll，这里补一次产品真正监听的那个事件。
  fireEvent.scroll(window);
}

/** 滚动并同步落盘（pagehide 与 scroll 走同一条 capture，但不必等 rAF）。 */
function readTo(paragraphIndex: number): void {
  scrollTo(paragraphIndex);
  fireEvent(window, new Event("pagehide"));
}

function rawStore(): string | null {
  return window.localStorage.getItem(READER_POSITION_STORAGE_KEY);
}

describe("阅读位置 · 停留期间的记录", () => {
  it("读到第 10 段时，记录的就是第 10 段", () => {
    restoreLayout = installLayout();
    render(<ChapterScreen chapter={CHAPTER_1} />);

    readTo(10);

    expect(readReadingPosition(KEY_1)?.paragraphIndex).toBe(10);
  });

  it("visibilitychange 同样能落盘——切到后台被回收也不丢位置", () => {
    restoreLayout = installLayout();
    render(<ChapterScreen chapter={CHAPTER_1} />);

    scrollTo(7);
    fireEvent(document, new Event("visibilitychange"));

    expect(readReadingPosition(KEY_1)?.paragraphIndex).toBe(7);
  });
});

describe("阅读位置 · 离开章节", () => {
  it("切走后位置仍是第 10 段，不被覆盖成末段", () => {
    restoreLayout = installLayout();
    const { unmount } = render(<ChapterScreen chapter={CHAPTER_1} />);

    readTo(10);
    expect(readReadingPosition(KEY_1)?.paragraphIndex).toBe(10);

    // 切章：passive cleanup 此刻面对的是已摘除的 DOM。
    unmount();

    const saved = readReadingPosition(KEY_1);
    expect(saved?.paragraphIndex, "离开章节不应改变已记录的阅读位置").toBe(10);
    expect(saved?.paragraphIndex).not.toBe(CHAPTER_1.paragraphs.length - 1);
    expect(saved?.ratio).toBeCloseTo(0, 10);
  });

  it("已落盘的记录在离章时一个字节都没被重写——detached 的零 rect 不产生写入", () => {
    restoreLayout = installLayout();
    const { unmount } = render(<ChapterScreen chapter={CHAPTER_1} />);

    readTo(10);
    const before = rawStore();

    unmount();

    // 没有未落盘的滚动，就没有任何理由再写一次；若 passive cleanup 还在
    // 量已摘除的树，这里会看到 updatedAt 变化与末段下标。
    expect(rawStore()).toBe(before);
  });

  it("还没跑的那一帧滚动不会丢：离章前用仍然有效的 DOM 补记一次", () => {
    restoreLayout = installLayout();
    const { unmount } = render(<ChapterScreen chapter={CHAPTER_1} />);

    readTo(3);
    expect(readReadingPosition(KEY_1)?.paragraphIndex).toBe(3);

    // 再滚一段，但不给 rAF 跑的机会就切章。
    scrollTo(12);
    unmount();

    expect(
      readReadingPosition(KEY_1)?.paragraphIndex,
      "离章补记应当量到第 12 段，而不是停在第 3 段或跳到末段",
    ).toBe(12);
  });

  it("只是路过、从未滚动的章节，不留下任何记录", () => {
    restoreLayout = installLayout();
    const { unmount } = render(<ChapterScreen chapter={CHAPTER_2} />);

    expect(readReadingPosition(KEY_2)).toBeNull();
    unmount();

    const saved = readReadingPosition(KEY_2);
    expect(
      saved,
      `未读过的章节被记成第 ${saved?.paragraphIndex} 段（共 ${CHAPTER_2.paragraphs.length} 段）`,
    ).toBeNull();
  });

  it("恢复时那次滚到顶部不会给未读章节凭空建一条记录", () => {
    // 真实浏览器里 `scrollTo(0)` 会派发 scroll 事件（jsdom 的 stub 不会）。
    // 不挡住的话，每翻过一章都会留下一条「第 0 段、段首」的记录——它与「没有记录」
    // 在恢复时等价，纯属占用 200 条上限。这里用显式 scroll 事件复现浏览器行为。
    restoreLayout = installLayout();
    const { unmount } = render(<ChapterScreen chapter={CHAPTER_2} />);

    scrollTo(0);
    fireEvent(window, new Event("pagehide"));
    expect(readReadingPosition(KEY_2)).toBeNull();

    unmount();
    expect(readReadingPosition(KEY_2)).toBeNull();
  });

  it("但读者真的翻回章首时，已有记录会被更新成章首", () => {
    restoreLayout = installLayout();
    render(<ChapterScreen chapter={CHAPTER_1} />);

    readTo(10);
    expect(readReadingPosition(KEY_1)?.paragraphIndex).toBe(10);

    readTo(0);
    expect(readReadingPosition(KEY_1)?.paragraphIndex).toBe(0);
    expect(readReadingPosition(KEY_1)?.ratio).toBe(0);
  });

  it("两章各自的记录互不干扰：路过第 2 章不影响第 1 章", () => {
    restoreLayout = installLayout();

    const first = render(<ChapterScreen chapter={CHAPTER_1} />);
    readTo(9);
    first.unmount();

    const second = render(<ChapterScreen chapter={CHAPTER_2} />);
    second.unmount();

    expect(readReadingPosition(KEY_1)?.paragraphIndex).toBe(9);
    expect(readReadingPosition(KEY_2)).toBeNull();
  });
});

describe("阅读位置 · 几何不可信时拒绝写入", () => {
  it("阅读根被摘出文档后，滚动与离开都不再写存储", () => {
    restoreLayout = installLayout();
    const { container } = render(<ChapterScreen chapter={CHAPTER_1} />);

    readTo(10);
    const before = rawStore();

    // 把整棵树摘出文档，但 React 的监听还挂在 window/document 上。
    container.remove();

    scrollTo(15);
    fireEvent(window, new Event("pagehide"));
    fireEvent(document, new Event("visibilitychange"));

    expect(rawStore(), "已摘除的树上量到的全 0 不得落盘").toBe(before);
    expect(readReadingPosition(KEY_1)?.paragraphIndex).toBe(10);
  });

  it("恢复回原位：存过第 10 段，重新进入该章就回到第 10 段", () => {
    restoreLayout = installLayout();
    const first = render(<ChapterScreen chapter={CHAPTER_1} />);
    readTo(10);
    first.unmount();

    render(<ChapterScreen chapter={CHAPTER_1} />);

    // 第 10 段顶部在 1000px 处，ratio 0 → 落回 1000。
    expect(Math.round(window.scrollY)).toBe(10 * PARAGRAPH_HEIGHT);
  });
});
