import { describe, expect, it } from "vitest";

import { splitChapterParagraphs } from "@/lib/site/paragraphs";

describe("splitChapterParagraphs", () => {
  it("splits on blank lines", () => {
    expect(splitChapterParagraphs("One.\n\nTwo.")).toEqual(["One.", "Two."]);
  });

  it("returns an empty array for blank bodies", () => {
    expect(splitChapterParagraphs("   \n\n")).toEqual([]);
  });
});
