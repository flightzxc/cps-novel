import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeCatalogSelection } from "@/domain/catalog-batch";
import { catalogSelectionWhere, readCatalogBatchContext } from "@/server/catalog-batch/service";

vi.mock("@/app/api/admin/_lib/deps", () => ({ prisma: {} }));
const { canonicalCatalogFilter, readSourceItemsPage, resolveSourceItemFilters } = await import(
  "@/app/(admin)/catalog-sync/_lib/read-source-items"
);

/**
 * 2026-10-06 复核追加：批次上下文/预估（`readCatalogBatchContext`/`catalogSelectionWhere`）
 * 此前不认「推广链接状态」筛选，「已建立书目 + 未领取 + 近 N 天」全选建领推广批次时弹窗预估偏大。
 * 这里钉死的是（真实库上的"总数 = 页面 total = worker selectedCount"见
 * `tests/integration/catalog-batch/postgres.test.ts`「批次上下文认「推广链接状态」」）：
 *   1. 条件片段与页面列表的 where 逐字一致（同一个 `promoLinkStatusIdConstraint`，没有第二份口径）；
 *   2. 只在 manual_review/not_claimed 两个值下才解析一次上下文（做法照 worker `streamSelection`），
 *      "已领取"/"全部"/explicit_ids 不多发任何查询，也不把全量 id 搬进条件。
 */

const NOW = new Date("2026-10-06T02:00:00.000Z");
const MANUAL_IDS = ["manual-1", "manual-2"];

const db = {
  novelSourceItem: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
  genericTaskItem: { findMany: vi.fn() },
  promoLink: { findMany: vi.fn() },
  channelApp: { findMany: vi.fn() },
  $queryRaw: vi.fn(),
};
const asPrisma = () => db as unknown as PrismaClient;

beforeEach(() => {
  vi.clearAllMocks();
  db.novelSourceItem.findMany.mockResolvedValue([]);
  db.novelSourceItem.count.mockResolvedValue(0);
  db.novelSourceItem.groupBy.mockResolvedValue([]);
  db.genericTaskItem.findMany.mockResolvedValue([]);
  db.promoLink.findMany.mockResolvedValue([]);
  db.channelApp.findMany.mockResolvedValue([]);
  db.$queryRaw.mockResolvedValue(MANUAL_IDS.map((id) => ({ id })));
});

const selectionOf = (filter: Record<string, unknown>) =>
  normalizeCatalogSelection({ scope: "all_filtered", filter: { status: "linked", ...filter } }, NOW);

describe("catalogSelectionWhere · promoLinkStatus（与页面列表/worker 同一口径）", () => {
  const ctx = { manualReviewIds: MANUAL_IDS };

  it("已领取：纯 promoLinks 关系过滤器，不带 id 列表", () => {
    const where = catalogSelectionWhere(selectionOf({ promoLinkStatus: "claimed" }));
    expect(where).toMatchObject({ promoLinks: { some: { status: "fetched", deletedAt: null } } });
    expect(where).not.toHaveProperty("id");
  });

  it("未领取：promoLinks none + 排除（有界的）人工核对 id 集合", () => {
    expect(catalogSelectionWhere(selectionOf({ promoLinkStatus: "not_claimed" }), ctx)).toMatchObject({
      promoLinks: { none: { status: "fetched", deletedAt: null } },
      id: { notIn: MANUAL_IDS },
    });
  });

  it("未领取且没有人工核对书：不带 id 条件", () => {
    const where = catalogSelectionWhere(selectionOf({ promoLinkStatus: "not_claimed" }), { manualReviewIds: [] });
    expect(where).toMatchObject({ promoLinks: { none: { status: "fetched", deletedAt: null } } });
    expect(where).not.toHaveProperty("id");
  });

  it("人工核对中：id in 人工核对集合", () => {
    expect(catalogSelectionWhere(selectionOf({ promoLinkStatus: "manual_review" }), ctx)).toMatchObject({ id: { in: MANUAL_IDS } });
  });

  it("全部（缺席）：与改动前逐字一致，没有 promoLinks / id 键，传了上下文也不读", () => {
    const where = catalogSelectionWhere(selectionOf({ sourceLocale: "en" }), ctx);
    expect(where).not.toHaveProperty("promoLinks");
    expect(where).not.toHaveProperty("id");
    expect(where).toEqual(catalogSelectionWhere(selectionOf({ sourceLocale: "en" })));
  });

  it("explicit_ids 不受影响（忽略上下文）", () => {
    const id = "0b8e6f4e-5c7d-4c88-8f0f-2a6f3a0c1d11";
    const selection = normalizeCatalogSelection({ scope: "explicit_ids", ids: [id] }, NOW);
    expect(catalogSelectionWhere(selection, ctx)).toEqual({ id: { in: [id] }, deletedAt: null });
  });
});

describe("readCatalogBatchContext · 上下文只在需要时解析一次（照 worker streamSelection）", () => {
  it.each([
    ["manual_review", 1],
    ["not_claimed", 1],
    ["claimed", 0],
    [undefined, 0],
  ] as const)("promoLinkStatus=%s -> 解析上下文的查询次数 %i", async (promoLinkStatus, expectedQueries) => {
    await readCatalogBatchContext(asPrisma(), selectionOf({ promoLinkStatus }));
    expect(db.$queryRaw).toHaveBeenCalledTimes(expectedQueries);
  });

  it("explicit_ids：不解析上下文", async () => {
    const id = "0b8e6f4e-5c7d-4c88-8f0f-2a6f3a0c1d11";
    await readCatalogBatchContext(asPrisma(), normalizeCatalogSelection({ scope: "explicit_ids", ids: [id] }, NOW));
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("总数、渠道分组、语种分组三个聚合查询用的是同一个带推广链接状态的 where（分组在其上再叠加自己的条件）", async () => {
    await readCatalogBatchContext(asPrisma(), selectionOf({ promoLinkStatus: "not_claimed", sourceCreatedFrom: "2026-09-06" }));
    const where = (db.novelSourceItem.count.mock.calls[0]![0] as { where: object }).where;
    expect(where).toMatchObject({
      promoLinks: { none: { status: "fetched", deletedAt: null } },
      id: { notIn: MANUAL_IDS },
      sourceCreatedAtRaw: { gte: "2026-09-06 00:00:00" },
    });
    const groupWheres = db.novelSourceItem.groupBy.mock.calls.map((call) => (call[0] as { where: { AND: unknown[] } }).where.AND[0]);
    expect(groupWheres).toHaveLength(2);
    for (const groupWhere of groupWheres) expect(groupWhere).toEqual(where);
  });
});

describe("页面列表与批次上下文：同一筛选产出同一个 where（mock 层的全选一致性）", () => {
  it.each([
    { promoLinkStatus: "not_claimed" },
    { promoLinkStatus: "claimed" },
    { promoLinkStatus: "manual_review" },
    { promoLinkStatus: "not_claimed", sourceLocale: "en", sourceCreatedWithin: "30" },
    { promoLinkStatus: "manual_review", sourceCreatedWithin: "90" },
    { sourceCreatedWithin: "7" },
    {},
  ])("筛选 %j", async (query) => {
    const { sourceCreatedWithin, ...rest } = query as { sourceCreatedWithin?: string };
    const filters = resolveSourceItemFilters({ status: "linked", ...rest, sourceCreatedWithin }, NOW);
    await readSourceItemsPage(filters, asPrisma());
    const listWhere = (db.novelSourceItem.count.mock.calls[0]![0] as { where: object }).where;
    db.novelSourceItem.count.mockClear();

    const filter = canonicalCatalogFilter(filters, NOW);
    await readCatalogBatchContext(asPrisma(), normalizeCatalogSelection({ scope: "all_filtered", filter }, NOW));
    const contextWhere = (db.novelSourceItem.count.mock.calls[0]![0] as { where: object }).where;
    expect(contextWhere).toEqual(listWhere);
  });
});
