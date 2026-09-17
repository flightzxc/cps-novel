import { describe, expect, it } from "vitest";

import {
  describeCreateContentOutcome,
  type CreateContentResult,
} from "@/app/(admin)/catalog-sync/_lib/outcome-copy";

const CREATED: CreateContentResult = {
  outcome: "created",
  novelId: "novel-1",
  novelBusinessId: "biz-001",
  locale: "en",
  novelSlug: "the-novel",
};

const ALREADY_EXISTS: CreateContentResult = { ...CREATED, outcome: "already_exists" };

const FIXTURES: readonly CreateContentResult[] = [
  CREATED,
  ALREADY_EXISTS,
  { outcome: "dry_run", plan: { locale: "en", title: "T", novelSlug: "t" } },
  { outcome: "source_item_not_found" },
  { outcome: "source_item_deleted" },
  { outcome: "source_item_ignored" },
  { outcome: "source_item_stale" },
  { outcome: "source_item_inconsistent_state" },
  {
    outcome: "locale_conflict",
    reason: "source_item_already_linked_to_different_locale",
    existingNovelId: "novel-9",
    existingLocale: "ja",
    derivedLocale: "en",
  },
  { outcome: "slug_unhealthy", field: "novel", baseSlug: "" },
  { outcome: "slug_conflict_exhausted", field: "novel", baseSlug: "duplicate-title" },
  { outcome: "concurrent_creation_conflict" },
];

describe("describeCreateContentOutcome · 穷举覆盖", () => {
  it("每种 outcome 都有非空标题与正文", () => {
    for (const fixture of FIXTURES) {
      const copy = describeCreateContentOutcome(fixture);
      expect(copy.title.trim().length, `${fixture.outcome} 标题为空`).toBeGreaterThan(0);
      expect(copy.body.trim().length, `${fixture.outcome} 正文为空`).toBeGreaterThan(0);
      expect(["success", "info", "warning", "danger"]).toContain(copy.tone);
    }
  });

  it("标题互不相同", () => {
    const titles = FIXTURES.map((fixture) => describeCreateContentOutcome(fixture).title);
    expect(new Set(titles).size).toBe(FIXTURES.length);
  });

  it("created 与 already_exists 语气不同", () => {
    expect(describeCreateContentOutcome(CREATED).tone).toBe("success");
    expect(describeCreateContentOutcome(ALREADY_EXISTS).tone).toBe("info");
  });
});
