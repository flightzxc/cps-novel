import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  beijingDateKey,
  CatalogSelectionInputError,
  isValidCatalogDateKey,
  normalizeCatalogSelection,
  parseSourceCreatedPreset,
  resolveSourceCreatedFromPreset,
  SOURCE_CREATED_PRESET_DAYS,
  sourceCreatedAtRawWhere,
} from "@/domain/catalog-batch";
import { catalogBatchScopeHash, type CatalogBatchPayload } from "@/lib/tasks/catalog-batch";
import { catalogSelectionWhere } from "@/server/catalog-batch/service";
import { parsePayload } from "../../../worker/handlers/catalog-batch";

const prismaMock = vi.hoisted(() => ({
  novelSourceItem: { findMany: vi.fn(), count: vi.fn() },
  genericTaskItem: { findMany: vi.fn() },
  promoLink: { findMany: vi.fn() },
  $queryRaw: vi.fn(),
}));
vi.mock("@/app/api/admin/_lib/deps", () => ({ prisma: prismaMock }));

const { canonicalCatalogFilter, readSourceItemsPage, resolveSourceItemFilters } = await import(
  "@/app/(admin)/catalog-sync/_lib/read-source-items"
);

/**
 * 2026-10-06（开发单_Sonnet_目录同步页上游上架时间筛选）：纯函数/DB-mock 单测。
 * 真正的"页面列表 = worker 枚举""含当天边界""排序"在真实 PostgreSQL 上验证
 * （`tests/integration/catalog-batch/postgres.test.ts` 里"上架时间"一节）；
 * 这里钉死的是：预设换算（可注入"今天"）、规范化校验、历史快照逐字不变、
 * 三处共用的判定片段、URL 预设→快照日期的唯一换算点、worker 载荷解析。
 */

// 固定的"今天"：北京时间 2026-10-06 10:00（= UTC 02:00）。
const NOW = new Date("2026-10-06T02:00:00.000Z");

describe("上架时间预设换算（场景 C：固定今天）", () => {
  it.each([
    [7, "2026-09-29"],
    [30, "2026-09-06"],
    [90, "2026-07-08"],
    [180, "2026-04-09"],
    [365, "2025-10-06"],
  ] as const)("近 %i 天 -> %s（开发单示例：近 90 天 = 2026-07-08 起）", (days, expected) => {
    expect(resolveSourceCreatedFromPreset(days, NOW)).toBe(expected);
  });

  it("预设集合固定为 7/30/90/180/365", () => {
    expect([...SOURCE_CREATED_PRESET_DAYS]).toEqual([7, 30, 90, 180, 365]);
  });

  it("以北京时间的今天为基准：UTC 15:59:59 仍是北京当天，UTC 16:00:00 已是次日", () => {
    expect(beijingDateKey(new Date("2026-10-05T15:59:59.999Z"))).toBe("2026-10-05");
    expect(beijingDateKey(new Date("2026-10-05T16:00:00.000Z"))).toBe("2026-10-06");
    expect(resolveSourceCreatedFromPreset(30, new Date("2026-10-05T15:59:59.999Z"))).toBe("2026-09-05");
    expect(resolveSourceCreatedFromPreset(30, new Date("2026-10-05T16:00:00.000Z"))).toBe("2026-09-06");
  });

  it("跨月/跨年/闰年换算正确", () => {
    expect(resolveSourceCreatedFromPreset(7, new Date("2026-01-03T02:00:00.000Z"))).toBe("2025-12-27");
    expect(resolveSourceCreatedFromPreset(365, new Date("2024-03-01T02:00:00.000Z"))).toBe("2023-03-02");
  });

  it.each([undefined, "", "0", "8", "30.5", "abc", "-30", "1e2"])("URL 里不在预设集合内的值 %j 视为全部", (value) => {
    expect(parseSourceCreatedPreset(value)).toBeUndefined();
  });
  it.each([["7", 7], [" 30 ", 30], ["90", 90], ["180", 180], ["365", 365]] as const)("URL 预设 %j -> %i", (value, expected) => {
    expect(parseSourceCreatedPreset(value)).toBe(expected);
  });
});

describe("normalizeCatalogSelection · sourceCreatedFrom（场景 C/D）", () => {
  const norm = (filter: Record<string, unknown>, now: Date = NOW) =>
    normalizeCatalogSelection({ scope: "all_filtered", filter: { status: "pending", ...filter } }, now);
  const invalid = (value: unknown, now: Date = NOW) => {
    try {
      norm({ sourceCreatedFrom: value }, now);
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogSelectionInputError);
      expect((error as CatalogSelectionInputError).code).toBe("filter_source_created_from_invalid");
      return;
    }
    throw new Error(`expected filter_source_created_from_invalid for ${JSON.stringify(value)}`);
  };

  it("合法日期原样保留，是绝对日期键 YYYY-MM-DD", () => {
    const normalized = norm({ sourceCreatedFrom: "2026-09-06" });
    expect(normalized).toMatchObject({ scope: "all_filtered", filter: { status: "pending", sourceCreatedFrom: "2026-09-06" } });
    if (normalized.scope === "all_filtered") expect(normalized.filter.sourceCreatedFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("今天（北京时间）本身合法；明天非法", () => {
    expect(norm({ sourceCreatedFrom: "2026-10-06" })).toMatchObject({ filter: { sourceCreatedFrom: "2026-10-06" } });
    invalid("2026-10-07");
  });

  it("'不得晚于今天'按北京时间判定，且 now 可注入（UTC 16:00 后北京已是次日）", () => {
    const beforeMidnight = new Date("2026-10-05T15:59:59.999Z");
    const afterMidnight = new Date("2026-10-05T16:00:00.000Z");
    invalid("2026-10-06", beforeMidnight);
    expect(norm({ sourceCreatedFrom: "2026-10-06" }, afterMidnight)).toMatchObject({ filter: { sourceCreatedFrom: "2026-10-06" } });
  });

  it.each(["2026-02-30", "2026-13-01", "2026-00-10", "2026-1-1", "20260906", "2026/09/06", "2026-09-06 00:00:00", "2026-09-06T00:00:00Z", "abc", "0000-01-01", "２０２６-09-06"])(
    "非法日期 %j -> filter_source_created_from_invalid",
    (value) => invalid(value),
  );

  it.each([123, null, {}, [], true])("非字符串 %j -> filter_source_created_from_invalid", (value) => invalid(value));

  it("空串/纯空白与不带该键等价（和 promoLinkStatus 同一约定），首尾空白会被裁掉", () => {
    for (const value of ["", "   "]) {
      const normalized = norm({ sourceCreatedFrom: value });
      if (normalized.scope === "all_filtered") expect(normalized.filter).not.toHaveProperty("sourceCreatedFrom");
    }
    expect(norm({ sourceCreatedFrom: " 2026-09-06 " })).toMatchObject({ filter: { sourceCreatedFrom: "2026-09-06" } });
  });

  it("不带该键的历史快照：规范化结果逐字不变（无新键、键序不变、批次范围哈希不变）", () => {
    const historical = norm({ search: "moon", sourceLocale: "en", promoLinkStatus: "not_claimed" });
    expect(JSON.stringify(historical)).toBe(
      '{"scope":"all_filtered","filter":{"status":"pending","search":"moon","sourceLocale":"en","promoLinkStatus":"not_claimed"}}',
    );
    // 与改动前的哈希口径相同：`JSON.stringify` 的结果里没有任何新键。
    const legacyJson = JSON.stringify({
      operation: "promo_claim",
      selection: { scope: "all_filtered", filter: { status: "pending", search: "moon", sourceLocale: "en", promoLinkStatus: "not_claimed" } },
    });
    expect(JSON.stringify({ operation: "promo_claim", selection: historical })).toBe(legacyJson);
    expect(catalogBatchScopeHash({ operation: "promo_claim", selection: historical })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("新键追加在最后，不改变其它键的相对顺序", () => {
    const normalized = norm({ search: "moon", sourceLocale: "en", promoLinkStatus: "claimed", sourceCreatedFrom: "2026-09-06" });
    expect(Object.keys((normalized as { filter: object }).filter)).toEqual([
      "status", "search", "sourceLocale", "promoLinkStatus", "sourceCreatedFrom",
    ]);
  });

  it("explicit_ids 选择不受影响", () => {
    const id = randomUUID();
    expect(normalizeCatalogSelection({ scope: "explicit_ids", ids: [id] }, NOW)).toEqual({ scope: "explicit_ids", ids: [id] });
  });
});

describe("isValidCatalogDateKey", () => {
  it.each(["2026-09-06", "2024-02-29", "1999-12-31"])("接受 %s", (value) => expect(isValidCatalogDateKey(value)).toBe(true));
  it.each(["2025-02-29", "2026-04-31", "2026-9-6", "", "2026-09-06 ", "0000-01-01"])("拒绝 %j", (value) => expect(isValidCatalogDateKey(value)).toBe(false));
});

describe("sourceCreatedAtRawWhere（页面/上下文/枚举三处共用的判定片段）", () => {
  it("缺席 = 不加任何条件", () => {
    expect(sourceCreatedAtRawWhere(undefined)).toEqual({});
    expect(sourceCreatedAtRawWhere("")).toEqual({});
  });
  it("下界含当天零点（>=），上界只是格式护栏", () => {
    expect(sourceCreatedAtRawWhere("2026-09-06")).toEqual({
      sourceCreatedAtRaw: { gte: "2026-09-06 00:00:00", lte: "9999-12-31 23:59:59" },
    });
  });
});

describe("catalogSelectionWhere（批次上下文/预估）带上架时间条件", () => {
  const filterSelection = (filter: Record<string, unknown>) =>
    normalizeCatalogSelection({ scope: "all_filtered", filter: { status: "pending", ...filter } }, NOW);

  it("带 sourceCreatedFrom 时与三处共用同一个片段", () => {
    const where = catalogSelectionWhere(filterSelection({ sourceLocale: "en", sourceCreatedFrom: "2026-09-06" }));
    expect(where).toMatchObject({ deletedAt: null, status: "pending", sourceLocale: "en", ...sourceCreatedAtRawWhere("2026-09-06") });
  });
  it("不带时没有 sourceCreatedAtRaw 键（历史快照集合不变）", () => {
    expect(catalogSelectionWhere(filterSelection({ sourceLocale: "en" }))).not.toHaveProperty("sourceCreatedAtRaw");
  });
});

describe("resolveSourceItemFilters：URL 预设 -> 快照日期的唯一换算点", () => {
  it("近 30 天 -> sourceCreatedFrom 绝对日期，canonicalCatalogFilter 带出同一个日期", () => {
    const filters = resolveSourceItemFilters({ status: "pending", sourceCreatedWithin: "30" }, NOW);
    expect(filters).toMatchObject({ status: "pending", sourceCreatedFrom: "2026-09-06" });
    expect(filters).not.toHaveProperty("sourceCreatedWithin");
    expect(canonicalCatalogFilter(filters, NOW)).toEqual({ status: "pending", sourceCreatedFrom: "2026-09-06" });
  });
  it("全部（缺席/空/未知预设）-> 没有 sourceCreatedFrom，快照与改动前逐字一致", () => {
    for (const sourceCreatedWithin of [undefined, "", "31", "abc"]) {
      const filters = resolveSourceItemFilters({ status: "pending", search: "x", sourceCreatedWithin }, NOW);
      expect(filters).not.toHaveProperty("sourceCreatedFrom");
      expect(canonicalCatalogFilter(filters, NOW)).toEqual({ status: "pending", search: "x" });
    }
  });
  it("URL 里直接带的 sourceCreatedFrom 不被采信（日期只由预设换算产生）", () => {
    const filters = resolveSourceItemFilters({ status: "pending", sourceCreatedFrom: "1999-01-01" }, NOW);
    expect(filters).not.toHaveProperty("sourceCreatedFrom");
  });
  it("sort 只认 source_created_desc，其它值落回默认", () => {
    expect(resolveSourceItemFilters({ sort: "source_created_desc" }, NOW)).toMatchObject({ sort: "source_created_desc" });
    for (const sort of [undefined, "", "lastSeenAt", "SOURCE_CREATED_DESC"]) {
      expect(resolveSourceItemFilters({ sort }, NOW)).not.toHaveProperty("sort");
    }
  });
  it("排序不进入批次快照", () => {
    const filters = resolveSourceItemFilters({ status: "pending", sort: "source_created_desc", sourceCreatedWithin: "7" }, NOW);
    expect(canonicalCatalogFilter(filters, NOW)).toEqual({ status: "pending", sourceCreatedFrom: "2026-09-29" });
  });
});

describe("readSourceItemsPage 查询契约：上架时间筛选与排序（场景 A/E 的 mock 层）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.novelSourceItem.findMany.mockResolvedValue([]);
    prismaMock.novelSourceItem.count.mockResolvedValue(0);
    prismaMock.promoLink.findMany.mockResolvedValue([]);
    prismaMock.$queryRaw.mockResolvedValue([]);
  });

  // 页面列表与 count 必须用同一个 where。
  it("带 sourceCreatedFrom：findMany 与 count 都带下界条件，与其它筛选取交集", async () => {
    const from = new Date();
    const today = beijingDateKey(from);
    await readSourceItemsPage({ status: "pending", sourceLocale: "en", sourceCreatedFrom: today });
    const expected = expect.objectContaining({
      deletedAt: null, status: "pending", sourceLocale: "en",
      sourceCreatedAtRaw: { gte: `${today} 00:00:00`, lte: "9999-12-31 23:59:59" },
    });
    expect(prismaMock.novelSourceItem.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expected }));
    expect(prismaMock.novelSourceItem.count).toHaveBeenCalledWith({ where: expected });
  });

  it("不带 sourceCreatedFrom：where 里没有 sourceCreatedAtRaw 键，默认排序不变", async () => {
    await readSourceItemsPage({ status: "pending" });
    const args = prismaMock.novelSourceItem.findMany.mock.calls[0]![0] as { where: object; orderBy: unknown };
    expect(args.where).not.toHaveProperty("sourceCreatedAtRaw");
    expect(args.orderBy).toEqual([{ lastSeenAt: "desc" }, { id: "asc" }]);
  });

  it("sort=source_created_desc：原始字符串倒序、空值垫底、id 升序兜底", async () => {
    await readSourceItemsPage({ status: "pending", sort: "source_created_desc" });
    expect(prismaMock.novelSourceItem.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ sourceCreatedAtRaw: { sort: "desc", nulls: "last" } }, { id: "asc" }],
    }));
  });

  it("未知 sort 值落回默认排序", async () => {
    await readSourceItemsPage({ status: "pending", sort: "bogus" });
    expect(prismaMock.novelSourceItem.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ lastSeenAt: "desc" }, { id: "asc" }],
    }));
  });

  it("行里带出上游上架时间原始字符串（缺失为 null），供运营目视核对", async () => {
    const row = (id: string, raw: string | null) => ({
      id, title: id, description: "", coverUrl: null, totalChapterCount: 1, paidFromChapter: null, sourceLocale: "en",
      sourceLanguageCode: "en", sourceLanguageName: null, status: "pending", novelId: null, lastSeenAt: null,
      sourceCreatedAtRaw: raw, channelAppId: "app",
      channelApp: { channel: { code: "c", name: "C" }, sourceApp: { code: "s", name: "S" } },
    });
    prismaMock.novelSourceItem.findMany.mockResolvedValue([row("a", "2026-09-06 08:00:00"), row("b", null)]);
    prismaMock.novelSourceItem.count.mockResolvedValue(2);
    const page = await readSourceItemsPage({ status: "pending" });
    expect(page.items.map((item) => item.sourceCreatedAtRaw)).toEqual(["2026-09-06 08:00:00", null]);
  });

  it("非法 sourceCreatedFrom（未来日期）直接抛 filter_source_created_from_invalid，不会悄悄当成全部", async () => {
    await expect(readSourceItemsPage({ status: "pending", sourceCreatedFrom: "2999-01-01" }))
      .rejects.toMatchObject({ code: "filter_source_created_from_invalid" });
  });
});

describe("worker parsePayload：上架时间键（场景 D 的 worker 侧）", () => {
  function payload(filter: Record<string, unknown>): Record<string, unknown> {
    return {
      operation: "promo_claim",
      selection: { scope: "all_filtered", filter: { status: "pending", ...filter } },
      actorId: "actor-1",
      requestId: "request-1",
      submittedAt: new Date("2026-10-06T00:00:00.000Z").toISOString(),
      expiresAt: new Date("2026-10-07T00:00:00.000Z").toISOString(),
    } satisfies Partial<CatalogBatchPayload> & Record<string, unknown>;
  }

  it("不带该键的历史载荷照常解析", () => {
    expect(parsePayload(payload({ sourceLocale: "en" })).selection).toMatchObject({ scope: "all_filtered", filter: { status: "pending", sourceLocale: "en" } });
  });
  it("合法 YYYY-MM-DD 通过，并原样带到 selection 里", () => {
    expect(parsePayload(payload({ sourceCreatedFrom: "2026-09-06" })).selection).toMatchObject({
      filter: { sourceCreatedFrom: "2026-09-06" },
    });
  });
  it.each(["garbage", "2026-02-30", "2026-9-6", "", 20260906, null, {}])("畸形值 %j -> catalog_batch_payload_invalid", (value) => {
    expect(() => parsePayload(payload({ sourceCreatedFrom: value }))).toThrow("catalog_batch_payload_invalid");
  });
});
