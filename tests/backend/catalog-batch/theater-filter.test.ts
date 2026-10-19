import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CatalogSelectionInputError,
  channelAppWhere,
  isCatalogChannelAppId,
  normalizeCatalogSelection,
  type CatalogSelection,
} from "@/domain/catalog-batch";
import { catalogBatchScopeHash, type CatalogBatchPayload } from "@/lib/tasks/catalog-batch";
import { catalogSelectionWhere } from "@/server/catalog-batch/service";
import { parsePayload } from "../../../worker/handlers/catalog-batch";
import {
  planPromoClaimTheaters,
  promoClaimSkipNotice,
  type PromoClaimGroup,
} from "@/app/(admin)/catalog-sync/_lib/promo-claim-theater-skip";

const prismaMock = vi.hoisted(() => ({
  novelSourceItem: { findMany: vi.fn(), count: vi.fn() },
  genericTaskItem: { findMany: vi.fn() },
  promoLink: { findMany: vi.fn() },
  channelApp: { findMany: vi.fn() },
  $queryRaw: vi.fn(),
}));
vi.mock("@/app/api/admin/_lib/deps", () => ({ prisma: prismaMock }));

const { canonicalCatalogFilter, catalogSelectionScopeKey, readSourceItemsPage, resolveSourceItemFilters } = await import(
  "@/app/(admin)/catalog-sync/_lib/read-source-items"
);
const { buildCatalogTheaterOptions, readCatalogTheaterOptions } = await import("@/app/(admin)/catalog-sync/_lib/read-channel-apps");

/**
 * B-44（v0.6.4）：目录同步页"剧场"筛选、"换页也清空勾选"、领取对话框"自动跳过领取暂停剧场"的
 * 纯函数 / DB-mock 单测。页面列表 = worker 枚举 的集合一致性与 web_app 权限在真实 PostgreSQL 上验证
 * （`tests/integration/catalog-batch/postgres.test.ts` 的 B-44 一节）。
 */

const MOBO = "11111111-1111-4111-8111-111111111111";
const PLOT = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

const norm = (filter: Record<string, unknown>) =>
  normalizeCatalogSelection({ scope: "all_filtered", filter } as CatalogSelection);

describe("normalizeCatalogSelection · channelAppId（剧场）", () => {
  it("合法 UUID 保留并转小写、去首尾空白", () => {
    expect(norm({ status: "linked", channelAppId: ` ${MOBO.toUpperCase()} ` })).toEqual({
      scope: "all_filtered",
      filter: { status: "linked", channelAppId: MOBO },
    });
  });

  it.each([["not-a-uuid"], ["11111111-1111-1111-1111"], ["' OR 1=1 --"]])("非法值 %s 拒绝（filter_channel_app_invalid）", (value) => {
    expect(() => norm({ channelAppId: value })).toThrowError(new CatalogSelectionInputError("filter_channel_app_invalid"));
  });

  it("非字符串拒绝", () => {
    expect(() => norm({ channelAppId: 42 })).toThrowError(new CatalogSelectionInputError("filter_channel_app_invalid"));
  });

  it("空串 / 纯空白与不带该键等价", () => {
    expect(norm({ channelAppId: "" })).toEqual(norm({}));
    expect(norm({ channelAppId: "   " })).toEqual(norm({}));
  });

  it("不带该键的历史快照：序列化结果与批次范围哈希逐字不变", () => {
    const historical = norm({ search: "moon", sourceLocale: "en", promoLinkStatus: "not_claimed", sourceCreatedFrom: "2026-09-06" });
    expect(JSON.stringify(historical)).toBe(
      '{"scope":"all_filtered","filter":{"status":"pending","search":"moon","sourceLocale":"en","promoLinkStatus":"not_claimed","sourceCreatedFrom":"2026-09-06"}}',
    );
    const legacy = {
      operation: "promo_claim" as const,
      selection: {
        scope: "all_filtered" as const,
        filter: { status: "pending" as const, search: "moon", sourceLocale: "en", promoLinkStatus: "not_claimed" as const, sourceCreatedFrom: "2026-09-06" },
      },
    };
    expect(catalogBatchScopeHash({ operation: "promo_claim", selection: historical })).toBe(catalogBatchScopeHash(legacy));
  });

  it("新键追加在最后；带剧场的快照与不带的哈希不同（不同剧场的全选批次不会被当成重复）", () => {
    const withTheater = norm({ search: "moon", sourceCreatedFrom: "2026-09-06", channelAppId: MOBO });
    expect(Object.keys((withTheater as { filter: object }).filter)).toEqual(["status", "search", "sourceCreatedFrom", "channelAppId"]);
    const hash = (selection: ReturnType<typeof norm>) => catalogBatchScopeHash({ operation: "promo_claim", selection });
    expect(hash(withTheater)).not.toBe(hash(norm({ search: "moon", sourceCreatedFrom: "2026-09-06" })));
    expect(hash(withTheater)).not.toBe(hash(norm({ search: "moon", sourceCreatedFrom: "2026-09-06", channelAppId: PLOT })));
  });

  it("isCatalogChannelAppId 与规范化同一套 UUID 判定", () => {
    expect(isCatalogChannelAppId(MOBO)).toBe(true);
    expect(isCatalogChannelAppId("x")).toBe(false);
    expect(isCatalogChannelAppId(undefined)).toBe(false);
  });
});

describe("channelAppWhere（页面 / 上下文 / 枚举三处共用的判定片段）", () => {
  it("缺席 = 不加任何条件；带值 = channelAppId 等值", () => {
    expect(channelAppWhere(undefined)).toEqual({});
    expect(channelAppWhere(MOBO)).toEqual({ channelAppId: MOBO });
  });

  it("catalogSelectionWhere（批次上下文 / 预估）带剧场条件，不带时没有该键", () => {
    expect(catalogSelectionWhere(norm({ status: "linked", channelAppId: PLOT }) as never)).toMatchObject({ channelAppId: PLOT, status: "linked" });
    expect(catalogSelectionWhere(norm({ status: "linked" }) as never)).not.toHaveProperty("channelAppId");
  });
});

describe("resolveSourceItemFilters / canonicalCatalogFilter：URL 剧场参数", () => {
  it("合法剧场进入筛选与批次快照（转小写）", () => {
    const filters = resolveSourceItemFilters({ status: "linked", channelAppId: MOBO.toUpperCase() });
    expect(filters.channelAppId).toBe(MOBO);
    expect(canonicalCatalogFilter(filters)).toEqual({ status: "linked", channelAppId: MOBO });
  });

  it("非法剧场参数按「全部剧场」处理，页面不报错，快照与改动前一致", () => {
    for (const value of ["", "abc", "' OR 1=1 --"]) {
      const filters = resolveSourceItemFilters({ status: "linked", channelAppId: value });
      expect(filters, value).not.toHaveProperty("channelAppId");
      expect(canonicalCatalogFilter(filters), value).toEqual({ status: "linked" });
    }
  });
});

describe("readSourceItemsPage：剧场条件进入列表与计数的同一个 where", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.novelSourceItem.findMany.mockResolvedValue([]);
    prismaMock.novelSourceItem.count.mockResolvedValue(0);
    prismaMock.promoLink.findMany.mockResolvedValue([]);
    prismaMock.$queryRaw.mockResolvedValue([]);
  });

  it("带剧场：findMany 与 count 都带 channelAppId", async () => {
    await readSourceItemsPage({ status: "linked", channelAppId: PLOT });
    const expected = expect.objectContaining({ deletedAt: null, status: "linked", channelAppId: PLOT });
    expect(prismaMock.novelSourceItem.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expected }));
    expect(prismaMock.novelSourceItem.count).toHaveBeenCalledWith({ where: expected });
  });

  it("不带剧场：where 里没有 channelAppId 键", async () => {
    await readSourceItemsPage({ status: "linked" });
    const where = prismaMock.novelSourceItem.count.mock.calls[0]![0].where;
    expect(where).not.toHaveProperty("channelAppId");
  });
});

describe("catalogSelectionScopeKey：勾选作用范围（照 CPS：筛选、排序、翻页、每页条数任一变化都清空）", () => {
  const base = { filter: { status: "linked" }, sort: undefined, page: 1, pageSize: 100 } as const;
  const key = (overrides: Partial<{ filter: Record<string, unknown>; sort: string | undefined; page: number; pageSize: number }> = {}) =>
    catalogSelectionScopeKey({ ...base, ...overrides } as Parameters<typeof catalogSelectionScopeKey>[0]);

  it("同样的输入得到同样的 key（不会无故清空勾选）", () => {
    expect(key()).toBe(key());
    expect(key({ sort: "" })).toBe(key({ sort: undefined }));
  });

  it.each([
    ["改排序（10-15 事故的那一步）", { sort: "source_created_desc" }],
    ["翻页", { page: 2 }],
    ["改每页条数", { pageSize: 200 }],
    ["换剧场", { filter: { status: "linked", channelAppId: PLOT } }],
    ["改其它筛选", { filter: { status: "pending" } }],
  ] as const)("%s → key 变化 → 勾选清空", (_label, overrides) => {
    expect(key(overrides as never)).not.toBe(key());
  });
});

describe("buildCatalogTheaterOptions / readCatalogTheaterOptions：剧场下拉", () => {
  const row = (id: string, channel: string, sourceApp: string, status = "active") => ({ id, status, channel: { name: channel }, sourceApp: { name: sourceApp } });

  it("只有一个渠道时标签就是剧场名；停用的照列并标明", () => {
    expect(buildCatalogTheaterOptions([row(MOBO, "畅读网文", "MoboReader"), row(PLOT, "畅读网文", "PlotNovel", "inactive")])).toEqual([
      { id: MOBO, label: "MoboReader" },
      { id: PLOT, label: "PlotNovel（已停用）" },
    ]);
  });

  it("多个渠道时加渠道名前缀，同名剧场分得清", () => {
    expect(buildCatalogTheaterOptions([row(MOBO, "A", "MoboReader"), row(OTHER, "B", "MoboReader")]).map((option) => option.label)).toEqual([
      "A · MoboReader",
      "B · MoboReader",
    ]);
  });

  it("查询按 channel_app 列出，不按状态或能力过滤", async () => {
    prismaMock.channelApp.findMany.mockResolvedValue([row(MOBO, "畅读网文", "MoboReader")]);
    await expect(readCatalogTheaterOptions()).resolves.toEqual([{ id: MOBO, label: "MoboReader" }]);
    const args = prismaMock.channelApp.findMany.mock.calls.at(-1)![0];
    expect(args.where).toBeUndefined();
    expect(args.select).toEqual({ id: true, status: true, channel: { select: { name: true } }, sourceApp: { select: { name: true } } });
  });
});

describe("worker parsePayload：剧场键", () => {
  function payload(filter: Record<string, unknown>): Record<string, unknown> {
    return {
      operation: "promo_claim",
      selection: { scope: "all_filtered", filter: { status: "linked", ...filter } },
      actorId: "actor-1",
      requestId: "request-1",
      submittedAt: new Date("2026-10-19T00:00:00.000Z").toISOString(),
      expiresAt: new Date("2026-10-20T00:00:00.000Z").toISOString(),
    } satisfies Partial<CatalogBatchPayload> & Record<string, unknown>;
  }

  it("不带该键的历史载荷照常解析", () => {
    expect(parsePayload(payload({})).selection).toEqual({ scope: "all_filtered", filter: { status: "linked" } });
  });

  it("合法 UUID 通过并原样带到 selection 里", () => {
    expect(parsePayload(payload({ channelAppId: MOBO })).selection).toMatchObject({ filter: { channelAppId: MOBO } });
  });

  it.each([["x"], [42], [""]])("畸形剧场键 %s 拒绝（否则枚举会拿畸形值去比较）", (value) => {
    expect(() => parsePayload(payload({ channelAppId: value }))).toThrow("catalog_batch_payload_invalid");
  });
});

describe("planPromoClaimTheaters：领取对话框自动跳过领取暂停的剧场", () => {
  const group = (channelAppId: string, sourceAppName: string, eligibleCount: number, claimCapabilityEnabled: boolean): PromoClaimGroup => ({
    channelAppId,
    channelCode: "changdu",
    channelName: "畅读网文",
    sourceAppCode: sourceAppName.toLowerCase(),
    sourceAppName,
    active: true,
    claimCapabilityEnabled,
    eligibleCount,
    accounts: [{ id: "acc", name: "Main" }],
  });
  const mobo = group(MOBO, "MoboReader", 2, true);
  const plot = group(PLOT, "PlotNovel", 1, false);
  const ids = { a: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", b: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", c: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
  const itemChannelAppIds = { [ids.a]: MOBO, [ids.b]: MOBO, [ids.c]: PLOT };

  it("没有暂停剧场：原样提交，不跳过任何书", () => {
    const selection = { scope: "explicit_ids", ids: [ids.a, ids.b] } as const;
    expect(planPromoClaimTheaters(selection, [mobo], itemChannelAppIds)).toEqual({
      kind: "submit", selection, claimGroups: [mobo], skippedGroups: [], skippedCount: 0,
    });
  });

  it("勾选模式混选：暂停剧场的书从 ids 里去掉，只剩可领取剧场的分组", () => {
    const plan = planPromoClaimTheaters({ scope: "explicit_ids", ids: [ids.a, ids.b, ids.c] }, [mobo, plot], itemChannelAppIds);
    expect(plan).toEqual({
      kind: "submit",
      selection: { scope: "explicit_ids", ids: [ids.a, ids.b] },
      claimGroups: [mobo],
      skippedGroups: [plot],
      skippedCount: 1,
    });
  });

  it("勾选里找不到所属剧场的 id 保留（由 worker 的分组能力校验兜底），不会被误删", () => {
    const unknown = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const plan = planPromoClaimTheaters({ scope: "explicit_ids", ids: [ids.a, ids.c, unknown] }, [mobo, plot], itemChannelAppIds);
    expect(plan.kind === "submit" && plan.selection).toEqual({ scope: "explicit_ids", ids: [ids.a, unknown] });
  });

  it("全选模式、只剩一个可领取剧场：快照收窄到该剧场", () => {
    const plan = planPromoClaimTheaters({ scope: "all_filtered", filter: { status: "linked", search: "moon" } }, [mobo, plot], {});
    expect(plan.kind === "submit" && plan.selection).toEqual({
      scope: "all_filtered",
      filter: { status: "linked", search: "moon", channelAppId: MOBO },
    });
  });

  it("全选模式、可领取剧场不止一个且含暂停剧场：拦下，请先选定剧场", () => {
    const other = group(OTHER, "OtherApp", 3, true);
    expect(planPromoClaimTheaters({ scope: "all_filtered", filter: { status: "linked" } }, [mobo, other, plot], {})).toEqual({
      kind: "all_filtered_needs_theater", skippedGroups: [plot],
    });
  });

  it("所选全在暂停剧场：all_paused（对话框照旧整单拦下）", () => {
    expect(planPromoClaimTheaters({ scope: "explicit_ids", ids: [ids.c] }, [plot], itemChannelAppIds)).toEqual({ kind: "all_paused" });
    expect(planPromoClaimTheaters({ scope: "all_filtered", filter: { status: "linked", channelAppId: PLOT } }, [plot], {})).toEqual({ kind: "all_paused" });
  });

  it("能力判断只认服务端给的 claimCapabilityEnabled === false；缺失（老夹具）按可领取处理", () => {
    const legacy = { ...mobo, claimCapabilityEnabled: undefined } as unknown as PromoClaimGroup;
    expect(planPromoClaimTheaters({ scope: "explicit_ids", ids: [ids.a] }, [legacy], itemChannelAppIds)).toMatchObject({ kind: "submit", skippedCount: 0 });
  });

  it("提示文案：已跳过 N 本（剧场名 领取暂停），剧场名缺失时退回渠道名", () => {
    expect(promoClaimSkipNotice([plot], 33)).toBe("已跳过 33 本（PlotNovel 领取暂停）");
    expect(promoClaimSkipNotice([{ ...plot, sourceAppName: undefined }], 1234)).toBe("已跳过 1,234 本（畅读网文 领取暂停）");
  });
});

describe("normalizeCatalogSelection 接受 planPromoClaimTheaters 收窄后的快照", () => {
  it("收窄出来的 channelAppId 通过服务端同一套校验", () => {
    expect(normalizeCatalogSelection({ scope: "all_filtered", filter: { status: "linked", channelAppId: randomUUID() } }).scope).toBe("all_filtered");
  });
});
