import { describe, expect, it } from "vitest";

import {
  ArticleGenerateSelectionError,
  normalizeArticleGenerateFilter,
  normalizeArticleGenerateSelection,
} from "@/domain/article-generation";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

describe("normalizeArticleGenerateFilter", () => {
  it("trims search/locales and drops blank values", () => {
    expect(normalizeArticleGenerateFilter({ search: "Alpha ", locales: [" en "] })).toEqual({
      search: "Alpha",
      locales: ["en"],
    });
    expect(normalizeArticleGenerateFilter({ search: "   ", locales: ["  ", ""] })).toEqual({});
    expect(normalizeArticleGenerateFilter({ search: " Alpha ", locales: ["en"] }))
      .toEqual(normalizeArticleGenerateFilter({ search: "Alpha", locales: ["en"] }));
  });

  it("dedupes and sorts locales regardless of input order, producing a stable fingerprint", () => {
    const shuffled = normalizeArticleGenerateFilter({ locales: ["ja", "en", " en ", "EN".toLowerCase()] });
    const sorted = normalizeArticleGenerateFilter({ locales: ["en", "ja"] });
    expect(shuffled).toEqual({ locales: ["en", "ja"] });
    expect(shuffled).toEqual(sorted);
    // The fingerprint downstream (`articleGenerateParentScopeHash`,
    // `src/lib/tasks/article-generate.ts`) is a plain `JSON.stringify` hash
    // — proving object equality here is the same thing as proving the
    // fingerprint is stable regardless of chip click order.
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(sorted));
  });

  it("an empty or all-blank locales array means the key is absent, same convention as search", () => {
    expect(normalizeArticleGenerateFilter({ locales: [] })).toEqual({});
    expect(normalizeArticleGenerateFilter({ locales: ["   ", ""] })).toEqual({});
    expect(normalizeArticleGenerateFilter({})).toEqual({});
    expect(normalizeArticleGenerateFilter(undefined)).toEqual({});
  });

  it("rejects a non-array locales value and a non-string entry", () => {
    expect(() => normalizeArticleGenerateFilter({ locales: "en" as unknown as string[] }))
      .toThrow(/filter_locales_invalid/);
    expect(() => normalizeArticleGenerateFilter({ locales: [1 as unknown as string] }))
      .toThrow(/filter_locales_invalid/);
  });

  it("rejects a single locale entry over the per-entry length cap", () => {
    expect(() => normalizeArticleGenerateFilter({ locales: ["x".repeat(17)] }))
      .toThrow(/filter_locale_too_long/);
    // Exactly at the cap (matches `Novel.locale @db.VarChar(16)`) is fine.
    expect(normalizeArticleGenerateFilter({ locales: ["x".repeat(16)] })).toEqual({ locales: ["x".repeat(16)] });
  });

  it("rejects a locales array over the sensible count cap", () => {
    const tooMany = Array.from({ length: 51 }, (_, index) => `l${index}`);
    expect(() => normalizeArticleGenerateFilter({ locales: tooMany })).toThrow(/filter_locales_too_many/);
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
      filter: { search: "  older  ", locales: ["en"] },
    });
    expect(normalized).toEqual({
      scope: "all_filtered",
      filter: { search: "older", locales: ["en"] },
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
