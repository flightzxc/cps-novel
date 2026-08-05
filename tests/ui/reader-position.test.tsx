import "./setup-cleanup";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChapterScreen } from "@/features/public-ui/chapter/ChapterScreen";
import {
  READER_POSITION_MAX_ENTRIES,
  READER_POSITION_STORAGE_KEY,
  readReadingPosition,
  readingPositionKey,
  writeReadingPosition,
} from "@/features/public-ui/chapter/reader-storage";
import { getMockChapterView } from "@/features/public-ui/fixtures/mock-content";

/**
 * 阅读位置记忆与恢复（P1-11 交付物 ④），粒度 `novel + chapter`。
 *
 * jsdom 没有真实布局，所有元素的 getBoundingClientRect 恒为 0——所以这里不试图
 * 验证「滚到了正确的像素」，那需要真实浏览器。这里验的是可以在 jsdom 里确定验证
 * 的三件事：键的粒度、存储层的收敛与淘汰、以及"有没有存过位置"决定的滚动分支。
 * 像素级正确性放在本地起服务的人工验收里。
 */

const CHAPTER_1 = getMockChapterView(1)!;
const CHAPTER_2 = getMockChapterView(2)!;

describe("阅读位置 · 键的粒度", () => {
  it("键同时含 novel 与 chapter——不同章互不覆盖", () => {
    const key1 = readingPositionKey("novel-a", 1);
    const key2 = readingPositionKey("novel-a", 2);
    const other = readingPositionKey("novel-b", 1);

    expect(key1).not.toBe(key2);
    expect(key1).not.toBe(other);

    writeReadingPosition(key1, { paragraphIndex: 3, ratio: 0.5 });
    writeReadingPosition(key2, { paragraphIndex: 7, ratio: 0.1 });
    writeReadingPosition(other, { paragraphIndex: 1, ratio: 0.9 });

    expect(readReadingPosition(key1)?.paragraphIndex).toBe(3);
    expect(readReadingPosition(key2)?.paragraphIndex).toBe(7);
    expect(readReadingPosition(other)?.paragraphIndex).toBe(1);
  });

  it("同书换书名不影响位置——键用的是不透明标识而不是书名", () => {
    // ChapterNovelRef.id 存在的理由就是这条：书名会改，改了不能丢位置。
    expect(CHAPTER_1.novel.id).toBe(CHAPTER_2.novel.id);
    expect(CHAPTER_1.novel.id).not.toBe(CHAPTER_1.novel.title);
  });
});

describe("阅读位置 · 存储层收敛", () => {
  it("没存过时返回 null", () => {
    expect(readReadingPosition(readingPositionKey("never", 1))).toBeNull();
  });

  it("损坏的 JSON 当作没存过", () => {
    window.localStorage.setItem(READER_POSITION_STORAGE_KEY, "{ 这不是 JSON");
    expect(readReadingPosition(readingPositionKey("novel-a", 1))).toBeNull();
  });

  it("段落下标不是非负整数时视为无效", () => {
    const key = readingPositionKey("novel-a", 1);
    window.localStorage.setItem(
      READER_POSITION_STORAGE_KEY,
      JSON.stringify({ [key]: { paragraphIndex: -2, ratio: 0.5, updatedAt: 1 } }),
    );
    expect(readReadingPosition(key)).toBeNull();

    window.localStorage.setItem(
      READER_POSITION_STORAGE_KEY,
      JSON.stringify({ [key]: { paragraphIndex: 1.5, ratio: 0.5, updatedAt: 1 } }),
    );
    expect(readReadingPosition(key)).toBeNull();
  });

  it("段内占比夹回 0～1", () => {
    const key = readingPositionKey("novel-a", 1);
    window.localStorage.setItem(
      READER_POSITION_STORAGE_KEY,
      JSON.stringify({ [key]: { paragraphIndex: 2, ratio: 4.2, updatedAt: 1 } }),
    );
    expect(readReadingPosition(key)?.ratio).toBe(1);
  });

  it("条数超上限时丢最旧的，不让存储无界增长", () => {
    for (let i = 0; i < READER_POSITION_MAX_ENTRIES + 10; i += 1) {
      writeReadingPosition(readingPositionKey("novel-a", i), {
        paragraphIndex: 1,
        ratio: 0,
      });
    }

    const raw = window.localStorage.getItem(READER_POSITION_STORAGE_KEY) ?? "{}";
    const stored = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(stored).length).toBeLessThanOrEqual(READER_POSITION_MAX_ENTRIES);
    // 最后写的一定还在——被淘汰的应该是最旧的那批。
    expect(
      stored[readingPositionKey("novel-a", READER_POSITION_MAX_ENTRIES + 9)],
    ).toBeTruthy();
  });
});

describe("阅读位置 · 滚动分支", () => {
  it("没有存过位置的章节，挂载时显式滚到顶", () => {
    // 章节导航带 scroll={false}，App Router 不再管滚动。没有存过位置时
    // 必须自己回到顶部，否则切到新章会停在上一章的滚动量上。
    const scrollTo = vi.spyOn(window, "scrollTo");

    render(<ChapterScreen chapter={CHAPTER_2} />);

    expect(scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ top: 0, behavior: "auto" }),
    );
    scrollTo.mockRestore();
  });

  it("位置太靠前时不跳——刚开头就跳一下反而突兀", () => {
    writeReadingPosition(readingPositionKey(CHAPTER_1.novel.id, 1), {
      paragraphIndex: 0,
      ratio: 0.2,
    });
    const scrollTo = vi.spyOn(window, "scrollTo");

    render(<ChapterScreen chapter={CHAPTER_1} />);

    // 走的是「回到顶部」这一支，而不是恢复到第 0 段的某个偏移。
    expect(scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ top: 0, behavior: "auto" }),
    );
    scrollTo.mockRestore();
  });

  it("存过的段落下标超出本章段落数时忽略，退回顶部", () => {
    writeReadingPosition(readingPositionKey(CHAPTER_1.novel.id, 1), {
      paragraphIndex: 9999,
      ratio: 0.5,
    });
    const scrollTo = vi.spyOn(window, "scrollTo");

    render(<ChapterScreen chapter={CHAPTER_1} />);

    expect(scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ top: 0, behavior: "auto" }),
    );
    scrollTo.mockRestore();
  });

  it("正文每段都带锚点下标，供位置恢复定位", () => {
    render(<ChapterScreen chapter={CHAPTER_1} />);

    const paragraphs = screen
      .getByTestId("reader-body")
      .querySelectorAll("[data-paragraph-index]");

    expect(paragraphs).toHaveLength(CHAPTER_1.paragraphs.length);
    expect(paragraphs[0].getAttribute("data-paragraph-index")).toBe("0");
  });
});
