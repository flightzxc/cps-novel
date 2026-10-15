import { describe, expect, it } from "vitest";
import {
  CHANGDU_INITIAL_MAX_MATERIALIZED_CHAPTERS,
  buildChangduPreviewPlan,
  isBlankPreviewContent,
} from "@/lib/preview";

function chapters(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    i: index + 1,
    chapterID: `chapter-${index + 1}`,
    chapterName: `Chapter ${index + 1}`,
    chapterShowName: null,
    chapterContent: `body-${index + 1}`,
  }));
}

describe("Changdu preview policy materialization", () => {
  it.each([[5, 3], [3, 3], [2, 2], [1, 1]])("materializes actual %i chapters to policy cap as %i", (actual, expected) => {
    const plan = buildChangduPreviewPlan({
      chapterList: chapters(actual),
      maxMaterializedChapters: CHANGDU_INITIAL_MAX_MATERIALIZED_CHAPTERS,
      trustedCompleteResponse: true,
    });
    expect(plan.authoritative).toBe(true);
    expect(plan.materializedCount).toBe(expected);
    expect(plan.chapters.map(({ i }) => i)).toEqual(Array.from({ length: expected }, (_, index) => index + 1));
  });

  it.each([1, 2, 5])("uses database-supplied policy cap %i instead of a hard-coded three", (cap) => {
    const plan = buildChangduPreviewPlan({
      chapterList: chapters(5),
      maxMaterializedChapters: cap,
      trustedCompleteResponse: true,
    });
    expect(plan.materializedCount).toBe(cap);
  });

  it("does not fabricate chapters from scalar allEpis or totalChapterCount", () => {
    const plan = buildChangduPreviewPlan({ chapterList: [], maxMaterializedChapters: 3, trustedCompleteResponse: true });
    expect(plan).toMatchObject({ authoritative: false, materializedCount: 0, chapters: [] });
    expect(plan).not.toHaveProperty("allEpis");
    expect(plan).not.toHaveProperty("totalChapterCount");
  });

  it("retains old state by producing no authoritative plan for failed, empty or malformed refreshes", () => {
    expect(buildChangduPreviewPlan({ chapterList: chapters(2), maxMaterializedChapters: 3, trustedCompleteResponse: false }).authoritative).toBe(false);
    expect(buildChangduPreviewPlan({ chapterList: [], maxMaterializedChapters: 3, trustedCompleteResponse: true }).authoritative).toBe(false);
    expect(buildChangduPreviewPlan({ chapterList: [{ ...chapters(1)[0], chapterContent: "" }], maxMaterializedChapters: 3, trustedCompleteResponse: true }).authoritative).toBe(false);
  });

  it("sorts a successful complete response and makes it authoritative", () => {
    const plan = buildChangduPreviewPlan({ chapterList: chapters(3).reverse(), maxMaterializedChapters: 3, trustedCompleteResponse: true });
    expect(plan).toMatchObject({ authoritative: true, materializedCount: 3 });
    expect(plan.chapters.map(({ i }) => i)).toEqual([1, 2, 3]);
    expect(plan.chapters.every(({ contentHash }) => /^[a-f0-9]{64}$/.test(contentHash))).toBe(true);
  });

  it("has no payEpisFrom-triggered action surface", () => {
    const plan = buildChangduPreviewPlan({ chapterList: chapters(2), maxMaterializedChapters: 3, trustedCompleteResponse: true });
    expect(plan).not.toHaveProperty("payEpisFrom");
    expect(plan).not.toHaveProperty("indexNow");
    expect(plan).not.toHaveProperty("delete");
    expect(plan).not.toHaveProperty("seo");
  });

  describe("B-42：空正文章节跳过，不再整本作废", () => {
    const withEmpty = (count: number, empty: readonly number[], blank = "") =>
      chapters(count).map((chapter) => (empty.includes(chapter.i) ? { ...chapter, chapterContent: blank } : chapter));

    it("第 2 章为空：保留 1、3，空章节号单列", () => {
      const plan = buildChangduPreviewPlan({ chapterList: withEmpty(3, [2]), maxMaterializedChapters: 3, trustedCompleteResponse: true });
      expect(plan).toMatchObject({ authoritative: true, reason: "authoritative_non_empty", materializedCount: 2, upstreamCount: 3, emptyChapterNumbers: [2] });
      expect(plan.chapters.map(({ i }) => i)).toEqual([1, 3]);
    });

    it("第 1 章为空：试读从第一个非空章节开始；纯空白与空串同样算空", () => {
      const plan = buildChangduPreviewPlan({ chapterList: withEmpty(3, [1], " \n\t "), maxMaterializedChapters: 3, trustedCompleteResponse: true });
      expect(plan.chapters.map(({ i }) => i)).toEqual([2, 3]);
      expect(plan.emptyChapterNumbers).toEqual([1]);
    });

    it("跳过空章节后按非空章节取到上限", () => {
      const plan = buildChangduPreviewPlan({ chapterList: withEmpty(5, [1, 3]).reverse(), maxMaterializedChapters: 3, trustedCompleteResponse: true });
      expect(plan.chapters.map(({ i }) => i)).toEqual([2, 4, 5]);
      expect(plan.emptyChapterNumbers).toEqual([1, 3]);
    });

    it("全部为空：不可信、什么都不写（all_content_empty）", () => {
      const plan = buildChangduPreviewPlan({ chapterList: withEmpty(3, [1, 2, 3]), maxMaterializedChapters: 3, trustedCompleteResponse: true });
      expect(plan).toMatchObject({ authoritative: false, reason: "all_content_empty", materializedCount: 0, chapters: [], emptyChapterNumbers: [] });
    });

    it("🔴 空正文行的身份照旧校验：重复序号 / 重复 ID 仍让整份不可信", () => {
      const list = chapters(3);
      const duplicateNumber = [...list, { ...list[0]!, chapterID: "other", chapterContent: "" }];
      const duplicateId = [...list, { ...list[1]!, i: 9, chapterContent: "" }];
      for (const chapterList of [duplicateNumber, duplicateId]) {
        expect(buildChangduPreviewPlan({ chapterList, maxMaterializedChapters: 3, trustedCompleteResponse: true })).toMatchObject({ authoritative: false, reason: "untrusted_or_empty" });
      }
    });

    it("isBlankPreviewContent 与原适配器的判定一致（!content.trim()）", () => {
      for (const value of ["", " ", "\n\t", "\u3000", "\u00a0"]) expect(isBlankPreviewContent(value)).toBe(true);
      for (const value of ["a", " a ", "0"]) expect(isBlankPreviewContent(value)).toBe(false);
    });
  });
});
