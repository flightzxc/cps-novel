import { describe, expect, it } from "vitest";
import {
  CHANGDU_INITIAL_MAX_MATERIALIZED_CHAPTERS,
  buildChangduPreviewPlan,
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
});
