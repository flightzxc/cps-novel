import { describe, expect, it } from "vitest";

import {
  ArticleGenerateSelectionError,
  normalizeArticleGenerateFilter,
  normalizeArticleGenerateSelection,
} from "@/domain/article-generation";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

describe("normalizeArticleGenerateFilter", () => {
  it("trims search/locale and drops blank values", () => {
    expect(normalizeArticleGenerateFilter({ search: "Alpha ", locale: " en " })).toEqual({
      search: "Alpha",
      locale: "en",
    });
    expect(normalizeArticleGenerateFilter({ search: "   ", locale: "  " })).toEqual({});
    expect(normalizeArticleGenerateFilter({ search: " Alpha ", locale: "en" }))
      .toEqual(normalizeArticleGenerateFilter({ search: "Alpha", locale: "en" }));
  });
});

describe("normalizeArticleGenerateSelection", () => {
  it("caps explicit ids at 200 and rejects invalid uuids", () => {
    const tooMany = Array.from({ length: 201 }, (_, index) =>
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    expect(() => normalizeArticleGenerateSelection({ scope: "explicit_ids", novelIds: tooMany })).toThrow(
      ArticleGenerateSelectionError,
    );
    expect(() =>
      normalizeArticleGenerateSelection({ scope: "explicit_ids", novelIds: ["not-a-uuid"] }),
    ).toThrow(/novel_id_invalid/);
  });

  it("keeps all_filtered as a filter snapshot, not an id list", () => {
    const normalized = normalizeArticleGenerateSelection({
      scope: "all_filtered",
      filter: { search: "  older  ", locale: "en" },
    });
    expect(normalized).toEqual({
      scope: "all_filtered",
      filter: { search: "older", locale: "en" },
    });
    expect(normalized).not.toHaveProperty("novelIds");
  });

  it("dedupes and sorts explicit ids", () => {
    expect(
      normalizeArticleGenerateSelection({ scope: "explicit_ids", novelIds: [ID_B, ID_A, ID_B.toUpperCase()] }),
    ).toEqual({
      scope: "explicit_ids",
      novelIds: [ID_A, ID_B],
    });
  });
});
