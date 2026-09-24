import { describe, expect, it } from "vitest";
import { CatalogSelectionInputError, normalizeCatalogSelection } from "@/domain/catalog-batch";
import {
  classifyPromoLinkRowStatus,
  promoLinkStatusIdConstraint,
  type PromoLinkStatusSets,
} from "@/lib/tasks/promo-link-status-filter";

/**
 * B-4（施工提示词_Sonnet_B4_目录同步页推广链接状态筛选_2026-09-24）：纯函数
 * 单测——`normalizeCatalogSelection`'s 新字段校验、`promoLinkStatusIdConstraint`/
 * `classifyPromoLinkRowStatus` 的三桶互斥/覆盖全部判定。真正的数据库查询
 * 正确性（`resolvePromoLinkStatusSets` 本身、以及"全选一致性"）由
 * `tests/integration/catalog-batch/promo-link-status-filter-postgres.test.ts`
 * 的真实 Postgres 用例覆盖——这里只锁死不依赖数据库的判定逻辑本身。
 */

function sets(overrides: Partial<{ fetched: readonly string[]; manualReview: readonly string[] }> = {}): PromoLinkStatusSets {
  return {
    fetchedSourceItemIds: new Set(overrides.fetched ?? []),
    manualReviewSourceItemIds: new Set(overrides.manualReview ?? []),
  };
}

describe("normalizeCatalogSelection · promoLinkStatus (B-4)", () => {
  it("absent field normalizes to absent (全部) -- old persisted selections without this key stay backward compatible", () => {
    const normalized = normalizeCatalogSelection({ scope: "all_filtered", filter: { status: "linked" } });
    expect(normalized).toMatchObject({ scope: "all_filtered", filter: { status: "linked" } });
    if (normalized.scope === "all_filtered") {
      expect(normalized.filter).not.toHaveProperty("promoLinkStatus");
    }
  });

  it.each(["not_claimed", "claimed", "manual_review"])("accepts %s", (value) => {
    const normalized = normalizeCatalogSelection({ scope: "all_filtered", filter: { status: "linked", promoLinkStatus: value } });
    expect(normalized).toMatchObject({ scope: "all_filtered", filter: { promoLinkStatus: value } });
  });

  it("empty string normalizes to absent, same as omitting the field", () => {
    const normalized = normalizeCatalogSelection({ scope: "all_filtered", filter: { status: "linked", promoLinkStatus: "" } });
    if (normalized.scope === "all_filtered") {
      expect(normalized.filter).not.toHaveProperty("promoLinkStatus");
    }
  });

  it.each(["bogus", "fetched", "NOT_CLAIMED", "not-claimed"])("rejects an unrecognized value %j", (value) => {
    expect(() => normalizeCatalogSelection({ scope: "all_filtered", filter: { status: "linked", promoLinkStatus: value } }))
      .toThrow(CatalogSelectionInputError);
  });

  it("a whitespace-only value trims to absent (全部), same as the empty string -- matches this file's existing search/sourceLocale trimming convention", () => {
    const normalized = normalizeCatalogSelection({ scope: "all_filtered", filter: { status: "linked", promoLinkStatus: "   " } });
    if (normalized.scope === "all_filtered") {
      expect(normalized.filter).not.toHaveProperty("promoLinkStatus");
    }
  });

  it("rejects a non-string value", () => {
    expect(() => normalizeCatalogSelection({ scope: "all_filtered", filter: { status: "linked", promoLinkStatus: 1 as unknown as string } }))
      .toThrow(CatalogSelectionInputError);
  });
});

describe("promoLinkStatusIdConstraint (B-4)", () => {
  it("undefined filter ('全部') -> no id constraint at all", () => {
    expect(promoLinkStatusIdConstraint(undefined, sets({ fetched: ["a"], manualReview: ["b"] }))).toEqual({});
  });

  it("'claimed' -> id IN the fetched set only", () => {
    expect(promoLinkStatusIdConstraint("claimed", sets({ fetched: ["a", "b"], manualReview: ["c"] })))
      .toEqual({ id: { in: expect.arrayContaining(["a", "b"]) } });
  });

  it("'manual_review' -> id IN the manual-review set, minus anything already fetched", () => {
    // "b" is in both sets -- a book that first hit manual review and later
    // succeeded on retry must count as claimed, not manual_review.
    const result = promoLinkStatusIdConstraint("manual_review", sets({ fetched: ["b"], manualReview: ["b", "c"] }));
    expect(result).toEqual({ id: { in: ["c"] } });
  });

  it("'not_claimed' -> id NOT IN the union of fetched + manual-review-minus-fetched", () => {
    const result = promoLinkStatusIdConstraint("not_claimed", sets({ fetched: ["a"], manualReview: ["a", "b"] }));
    expect(result.id && "notIn" in result.id ? new Set(result.id.notIn) : null).toEqual(new Set(["a", "b"]));
  });

  it("'not_claimed' with both sets empty -> no id constraint (never an empty notIn)", () => {
    expect(promoLinkStatusIdConstraint("not_claimed", sets())).toEqual({});
  });

  it("the three buckets are mutually exclusive and exhaustive over a fixed universe", () => {
    const universe = ["a", "b", "c", "d", "e"];
    const s = sets({ fetched: ["a", "b"], manualReview: ["b", "c"] }); // "b" overlaps both -> must land in "claimed" only
    const claimed = new Set((promoLinkStatusIdConstraint("claimed", s).id as { in: string[] }).in);
    const manualReview = new Set((promoLinkStatusIdConstraint("manual_review", s).id as { in: string[] }).in);
    const notClaimedConstraint = promoLinkStatusIdConstraint("not_claimed", s).id as { notIn: string[] };
    const notClaimed = new Set(universe.filter((id) => !notClaimedConstraint.notIn.includes(id)));

    for (const id of universe) {
      const memberships = [claimed.has(id), manualReview.has(id), notClaimed.has(id)].filter(Boolean).length;
      expect(memberships).toBe(1);
    }
    expect(claimed.size + manualReview.size + notClaimed.size).toBe(universe.length);
  });
});

describe("classifyPromoLinkRowStatus (B-4)", () => {
  it("claimed takes priority over manual_review when a row is in both sets", () => {
    expect(classifyPromoLinkRowStatus("x", sets({ fetched: ["x"], manualReview: ["x"] }))).toBe("claimed");
  });

  it("manual_review when only in the manual-review set", () => {
    expect(classifyPromoLinkRowStatus("x", sets({ manualReview: ["x"] }))).toBe("manual_review");
  });

  it("not_claimed when in neither set", () => {
    expect(classifyPromoLinkRowStatus("x", sets({ fetched: ["y"], manualReview: ["z"] }))).toBe("not_claimed");
  });
});
