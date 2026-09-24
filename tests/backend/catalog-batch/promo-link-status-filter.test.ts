import { describe, expect, it, vi } from "vitest";
import { CatalogSelectionInputError, normalizeCatalogSelection } from "@/domain/catalog-batch";
import {
  classifyPromoLinkRowStatuses,
  MANUAL_REVIEW_ID_CAP,
  promoLinkStatusIdConstraint,
  PromoLinkManualReviewScaleError,
  resolvePromoLinkStatusContext,
  type PromoLinkStatusContext,
} from "@/lib/tasks/promo-link-status-filter";

/**
 * B-4（施工提示词_Sonnet_B4_目录同步页推广链接状态筛选_2026-09-24；Opus
 * 复核 2026-09-24 追加规模修复）：纯函数/DB-mock 单测——`normalizeCatalogSelection`
 * 的新字段校验、`promoLinkStatusIdConstraint`（现在对"已领取"/"未领取"产出
 * `promoLinks` 关系过滤器,不再是全量 id 列表）、`classifyPromoLinkRowStatuses`
 * （页面级、按传入的少量 id 查询,不加载全表）、以及"人工核对中"桶的硬上限
 * 保护。真正的规模正确性（8 万级书目/3.5 万+已领取时不报错）由
 * `tests/integration/catalog-batch/postgres.test.ts` 的真实 Postgres 规模
 * 回归用例覆盖——mock 测试测不出 Prisma/Postgres 的参数数量上限。
 */

function context(manualReviewIds: readonly string[] = []): PromoLinkStatusContext {
  return { manualReviewIds };
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

describe("promoLinkStatusIdConstraint (B-4, Opus 复核后的规模修复)", () => {
  it("undefined filter ('全部') -> no constraint at all, even with a non-empty context", () => {
    expect(promoLinkStatusIdConstraint(undefined, context(["a", "b"]))).toEqual({});
  });

  it("'claimed' -> a promoLinks relation filter, never an id list -- context is not read at all", () => {
    expect(promoLinkStatusIdConstraint("claimed", context(["a", "b"]))).toEqual({
      promoLinks: { some: { status: "fetched", deletedAt: null } },
    });
    // Omitting context entirely must not throw or change the result -- "claimed" never needs it.
    expect(promoLinkStatusIdConstraint("claimed", undefined)).toEqual({
      promoLinks: { some: { status: "fetched", deletedAt: null } },
    });
  });

  it("'manual_review' -> id IN the context's (already fetched-excluded) manual-review id list", () => {
    expect(promoLinkStatusIdConstraint("manual_review", context(["c"]))).toEqual({ id: { in: ["c"] } });
  });

  it("'manual_review' with an empty/absent context -> id IN [] (matches nothing), never undefined behavior", () => {
    expect(promoLinkStatusIdConstraint("manual_review", context([]))).toEqual({ id: { in: [] } });
    expect(promoLinkStatusIdConstraint("manual_review", undefined)).toEqual({ id: { in: [] } });
  });

  it("'not_claimed' -> a promoLinks 'none' relation filter PLUS id NOT IN the (small) manual-review set", () => {
    expect(promoLinkStatusIdConstraint("not_claimed", context(["a", "b"]))).toEqual({
      promoLinks: { none: { status: "fetched", deletedAt: null } },
      id: { notIn: ["a", "b"] },
    });
  });

  it("'not_claimed' with an empty manual-review set -> just the relation filter, no id key at all (never an empty notIn)", () => {
    expect(promoLinkStatusIdConstraint("not_claimed", context([]))).toEqual({
      promoLinks: { none: { status: "fetched", deletedAt: null } },
    });
    expect(promoLinkStatusIdConstraint("not_claimed", undefined)).toEqual({
      promoLinks: { none: { status: "fetched", deletedAt: null } },
    });
  });

  it("never materializes an 'already claimed' id list -- the whole point of the scale fix -- regardless of how large the context's manualReviewIds happens to be", () => {
    // A relation filter's shape does not grow with catalog size -- assert
    // the "claimed" result stays a fixed small object even when the
    // (unrelated) manual-review context is non-trivial.
    const bigManualReview = Array.from({ length: 4_000 }, (_, i) => `manual-${i}`);
    const result = promoLinkStatusIdConstraint("claimed", context(bigManualReview));
    expect(JSON.stringify(result).length).toBeLessThan(200);
  });
});

describe("resolvePromoLinkStatusContext (B-4, 硬上限保护)", () => {
  function fakeDb(rows: Array<{ id: string }>) {
    return { promoLink: { findMany: vi.fn() }, $queryRaw: vi.fn().mockResolvedValue(rows) };
  }

  it("returns the raw-SQL result verbatim as manualReviewIds when under the cap", async () => {
    const db = fakeDb([{ id: "a" }, { id: "b" }]);
    const result = await resolvePromoLinkStatusContext(db);
    expect(result).toEqual({ manualReviewIds: ["a", "b"] });
  });

  it(`throws PromoLinkManualReviewScaleError when the result exceeds MANUAL_REVIEW_ID_CAP (${MANUAL_REVIEW_ID_CAP})`, async () => {
    const overCap = Array.from({ length: MANUAL_REVIEW_ID_CAP + 1 }, (_, i) => ({ id: `id-${i}` }));
    const db = fakeDb(overCap);
    await expect(resolvePromoLinkStatusContext(db)).rejects.toThrow(PromoLinkManualReviewScaleError);
  });

  it("does not throw at exactly the cap (boundary)", async () => {
    const atCap = Array.from({ length: MANUAL_REVIEW_ID_CAP }, (_, i) => ({ id: `id-${i}` }));
    const db = fakeDb(atCap);
    const result = await resolvePromoLinkStatusContext(db);
    expect(result.manualReviewIds).toHaveLength(MANUAL_REVIEW_ID_CAP);
  });
});

describe("classifyPromoLinkRowStatuses (B-4, page-scoped only)", () => {
  it("makes zero queries for an empty row-id list", async () => {
    const promoLinkFindMany = vi.fn();
    const queryRaw = vi.fn();
    const result = await classifyPromoLinkRowStatuses({ promoLink: { findMany: promoLinkFindMany }, $queryRaw: queryRaw }, []);
    expect(result.size).toBe(0);
    expect(promoLinkFindMany).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("scopes both underlying queries to exactly the given row ids -- never a full-table scan", async () => {
    const promoLinkFindMany = vi.fn().mockResolvedValue([]);
    const queryRaw = vi.fn().mockResolvedValue([]);
    await classifyPromoLinkRowStatuses({ promoLink: { findMany: promoLinkFindMany }, $queryRaw: queryRaw }, ["x", "y"]);
    expect(promoLinkFindMany).toHaveBeenCalledWith({
      where: { novelSourceItemId: { in: ["x", "y"] }, status: "fetched", deletedAt: null },
      select: { novelSourceItemId: true },
      distinct: ["novelSourceItemId"],
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("claimed takes priority over manual_review when a row is in both result sets", async () => {
    const db = {
      promoLink: { findMany: vi.fn().mockResolvedValue([{ novelSourceItemId: "x" }]) },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "x" }]),
    };
    const result = await classifyPromoLinkRowStatuses(db, ["x"]);
    expect(result.get("x")).toBe("claimed");
  });

  it("manual_review when only in the manual-review result", async () => {
    const db = { promoLink: { findMany: vi.fn().mockResolvedValue([]) }, $queryRaw: vi.fn().mockResolvedValue([{ id: "x" }]) };
    const result = await classifyPromoLinkRowStatuses(db, ["x"]);
    expect(result.get("x")).toBe("manual_review");
  });

  it("not_claimed when in neither result, and every requested id is present in the map", async () => {
    const db = { promoLink: { findMany: vi.fn().mockResolvedValue([]) }, $queryRaw: vi.fn().mockResolvedValue([]) };
    const result = await classifyPromoLinkRowStatuses(db, ["x", "y"]);
    expect(result.get("x")).toBe("not_claimed");
    expect(result.get("y")).toBe("not_claimed");
    expect(result.size).toBe(2);
  });
});
