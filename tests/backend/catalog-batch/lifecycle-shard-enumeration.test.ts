import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  assignCatalogPageHints,
  buildLifecycleShardPlan,
  chunkMembersIntoShards,
  isLifecycleBatchPayload,
  parsePayload,
  sortMembersByCatalogPosition,
  type LifecycleShardGroupPlan,
} from "../../../worker/handlers/catalog-batch";
import type { CatalogBatchPayload } from "@/lib/tasks/catalog-batch";
import { CATALOG_POSITION_TRUSTED_SIGNATURE, type CatalogPosition } from "@/lib/tasks/moboreader";

/**
 * 领推广链接生命周期，正式修复第 2 阶段第 2 步（`docs/adr/ADR-PROMO-CLAIM-
 * BATCH-LIFECYCLE.md` 设计 §5.2/§5.3）：`worker/handlers/catalog-batch.ts`
 * 枚举切分片这一步里，与数据库无关的三块纯逻辑——批次载荷解析里的生命周期
 * 字段一致性校验、分片大小切块、`shardPlan` 构造——单独抽出来做单测。真正
 * 建分片（分组、requestToken/scopeHash 唯一性、任务控制标记、8 万条规模）
 * 只在真实 Postgres 上验证（`tests/integration/catalog-batch/
 * promo-claim-lifecycle-shard-enumeration-postgres.test.ts`），因为那部分
 * 本质上离不开数据库事务与真实查询计划。
 */

function baseFields(overrides: Partial<CatalogBatchPayload> = {}): Record<string, unknown> {
  return {
    operation: "promo_claim",
    selection: { scope: "explicit_ids", ids: [randomUUID()] },
    actorId: "actor-1",
    requestId: "request-1",
    submittedAt: new Date("2026-09-23T00:00:00.000Z").toISOString(),
    expiresAt: new Date("2026-09-24T00:00:00.000Z").toISOString(),
    channelAccounts: { [randomUUID()]: randomUUID() },
    ...overrides,
  };
}

describe("parsePayload: lifecycle fields are all-or-nothing (阶段2 第2步)", () => {
  it("parses a legacy payload with none of the four lifecycle fields", () => {
    const payload = parsePayload(baseFields());
    expect(payload.lifecycleVersion).toBeUndefined();
    expect(payload.lifecycleRole).toBeUndefined();
    expect(payload.approvedAt).toBeUndefined();
    expect(payload.approvalValidUntil).toBeUndefined();
  });

  it("parses a well-formed lifecycle batch payload (all four fields present and consistent)", () => {
    const approvedAt = new Date("2026-09-23T00:00:00.000Z").toISOString();
    const approvalValidUntil = new Date("2026-09-24T00:00:00.000Z").toISOString();
    const payload = parsePayload(baseFields({
      lifecycleVersion: 1,
      lifecycleRole: "batch",
      approvedAt,
      approvalValidUntil,
    } as Partial<CatalogBatchPayload>));
    expect(payload.lifecycleVersion).toBe(1);
    expect(payload.lifecycleRole).toBe("batch");
    expect(payload.approvedAt).toBe(approvedAt);
    expect(payload.approvalValidUntil).toBe(approvalValidUntil);
  });

  it.each([
    ["lifecycleVersion only", { lifecycleVersion: 1 }],
    ["lifecycleRole only", { lifecycleRole: "batch" }],
    ["approvedAt only", { approvedAt: new Date().toISOString() }],
    ["approvalValidUntil only", { approvalValidUntil: new Date().toISOString() }],
    ["version+role but missing both timestamps", { lifecycleVersion: 1, lifecycleRole: "batch" }],
  ])("rejects a partial combination: %s", (_label, partial) => {
    expect(() => parsePayload(baseFields(partial as Partial<CatalogBatchPayload>))).toThrow("catalog_batch_payload_invalid");
  });

  it("rejects lifecycleRole 'shard' at the batch payload layer (a batch's own role must be 'batch')", () => {
    expect(() => parsePayload(baseFields({
      lifecycleVersion: 1,
      lifecycleRole: "shard",
      approvedAt: new Date().toISOString(),
      approvalValidUntil: new Date().toISOString(),
    } as Partial<CatalogBatchPayload>))).toThrow("catalog_batch_payload_invalid");
  });

  it("rejects lifecycle fields on a non-promo_claim operation", () => {
    expect(() => parsePayload(baseFields({
      operation: "novel_materialize",
      channelAccounts: undefined,
      lifecycleVersion: 1,
      lifecycleRole: "batch",
      approvedAt: new Date().toISOString(),
      approvalValidUntil: new Date().toISOString(),
    } as Partial<CatalogBatchPayload>))).toThrow("catalog_batch_payload_invalid");
  });

  it.each(["not-a-date", "", 12345])("rejects an unparseable approvedAt (%p)", (bad) => {
    expect(() => parsePayload(baseFields({
      lifecycleVersion: 1,
      lifecycleRole: "batch",
      approvedAt: bad,
      approvalValidUntil: new Date().toISOString(),
    } as unknown as Partial<CatalogBatchPayload>))).toThrow("catalog_batch_payload_invalid");
  });

  it.each(["not-a-date", "", 12345])("rejects an unparseable approvalValidUntil (%p)", (bad) => {
    expect(() => parsePayload(baseFields({
      lifecycleVersion: 1,
      lifecycleRole: "batch",
      approvedAt: new Date().toISOString(),
      approvalValidUntil: bad,
    } as unknown as Partial<CatalogBatchPayload>))).toThrow("catalog_batch_payload_invalid");
  });
});

describe("isLifecycleBatchPayload", () => {
  const lifecycleFields = {
    lifecycleVersion: 1 as const,
    lifecycleRole: "batch" as const,
    approvedAt: new Date().toISOString(),
    approvalValidUntil: new Date().toISOString(),
  };

  it("is true only for operation=promo_claim + lifecycleVersion=1 + lifecycleRole=batch", () => {
    expect(isLifecycleBatchPayload(parsePayload(baseFields(lifecycleFields)))).toBe(true);
  });

  it("is false for a legacy payload (no lifecycle fields)", () => {
    expect(isLifecycleBatchPayload(parsePayload(baseFields()))).toBe(false);
  });

  it("is false when lifecycleRole is 'shard' rather than 'batch'", () => {
    // Constructed directly (bypassing parsePayload's own rejection above) to
    // isolate isLifecycleBatchPayload's own judgment from parsePayload's.
    const payload = { ...parsePayload(baseFields()), lifecycleVersion: 1, lifecycleRole: "shard" } as CatalogBatchPayload;
    expect(isLifecycleBatchPayload(payload)).toBe(false);
  });

  it("is false for novel_materialize even if lifecycle fields were somehow present", () => {
    const payload = { ...parsePayload(baseFields()), operation: "novel_materialize", ...lifecycleFields } as CatalogBatchPayload;
    expect(isLifecycleBatchPayload(payload)).toBe(false);
  });
});

describe("chunkMembersIntoShards: shard-size boundary cases (设计 §5.3)", () => {
  const members = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `m${i}` }));

  it("splits an exact multiple with no remainder", () => {
    const shards = chunkMembersIntoShards(members(100), 25);
    expect(shards).toHaveLength(4);
    expect(shards.every((shard) => shard.length === 25)).toBe(true);
  });

  it("leaves a final, smaller shard for a remainder", () => {
    const shards = chunkMembersIntoShards(members(101), 25);
    expect(shards.map((s) => s.length)).toEqual([25, 25, 25, 25, 1]);
  });

  it("handles a single member", () => {
    const shards = chunkMembersIntoShards(members(1), 50);
    expect(shards).toEqual([[{ id: "m0" }]]);
  });

  it("produces exactly one shard when shardSize is at or above the member count (upper-bound sizing scenario)", () => {
    const shards = chunkMembersIntoShards(members(10), 1_000);
    expect(shards).toHaveLength(1);
    expect(shards[0]).toHaveLength(10);
  });

  it("produces one shard per member when shardSize is 1", () => {
    const shards = chunkMembersIntoShards(members(5), 1);
    expect(shards).toHaveLength(5);
    expect(shards.every((shard) => shard.length === 1)).toBe(true);
  });

  it("preserves member order across shard boundaries", () => {
    const shards = chunkMembersIntoShards(members(7), 3);
    expect(shards.flat()).toEqual(members(7));
  });

  it("returns an empty array for zero members", () => {
    expect(chunkMembersIntoShards([], 50)).toEqual([]);
  });

  it.each([0, -1, Number.NaN])("throws rather than looping forever on a non-positive shardSize (%p)", (badSize) => {
    expect(() => chunkMembersIntoShards(members(3), badSize)).toThrow();
  });
});

describe("buildLifecycleShardPlan: shardPlan shape (设计 §5.2)", () => {
  const config = { shardWindowMinutes: 90, shardSizeMin: 50, shardSizeMax: 1_000 };

  function group(overrides: Partial<LifecycleShardGroupPlan> = {}): LifecycleShardGroupPlan {
    return {
      channelAppId: randomUUID(),
      channelAccountId: randomUUID(),
      memberCount: 100,
      shardSize: 50,
      shardCount: 2,
      sizingBasis: { p90Seconds: 5, sampleCount: 0, source: "fallback_insufficient_sample" },
      ...overrides,
    };
  }

  it("exposes flat shardSize/sizingBasis convenience fields for the single-group (single-account) case", () => {
    const only = group();
    const plan = buildLifecycleShardPlan([only], config);
    expect(plan).toMatchObject({
      windowMinutes: 90,
      shardSizeMin: 50,
      shardSizeMax: 1_000,
      shardCount: 2,
      shardSize: 50,
      sizingBasis: only.sizingBasis,
    });
    expect(plan.groups).toEqual([only]);
  });

  it("omits the flat shardSize/sizingBasis fields and sums shardCount across multiple groups", () => {
    const first = group({ shardCount: 2, shardSize: 50 });
    const second = group({ shardCount: 3, shardSize: 20, sizingBasis: { p90Seconds: 12, sampleCount: 500, source: "measured_recent_completed_items" } });
    const plan = buildLifecycleShardPlan([first, second], config);
    expect(plan.shardCount).toBe(5);
    expect(plan.groups).toEqual([first, second]);
    expect(plan).not.toHaveProperty("shardSize");
    expect(plan).not.toHaveProperty("sizingBasis");
  });

  it("handles zero groups (every group blocked before shard creation)", () => {
    const plan = buildLifecycleShardPlan([], config);
    expect(plan).toMatchObject({ windowMinutes: 90, shardSizeMin: 50, shardSizeMax: 1_000, shardCount: 0, groups: [] });
    expect(plan).not.toHaveProperty("shardSize");
  });
});

/**
 * 领推广链接正式修复第 5 阶段·5-A（`设计_领推广按接口限速与预读集合化_
 * 阶段4-5_2026-09-24.md` §6.2 第 2/3 条，Owner 裁决 E5/E8）：目录页位置登记
 * 之后，枚举切分片按页坐标排序 + 计算两个载荷提示键，这两块与数据库无关的
 * 纯逻辑单独单测。真正在真实成员集合（含 8 万级规模）上验证排序与提示键落
 * 到分片条目 payload 里，见 `tests/integration/catalog-batch/
 * promo-claim-catalog-position-sort-postgres.test.ts`。
 */
function trustedPosition(pageIndex: number, overrides: Partial<CatalogPosition> = {}): CatalogPosition {
  return {
    pageIndex,
    pageSize: CATALOG_POSITION_TRUSTED_SIGNATURE.pageSize,
    orderType: CATALOG_POSITION_TRUSTED_SIGNATURE.orderType,
    nameEmpty: CATALOG_POSITION_TRUSTED_SIGNATURE.nameEmpty,
    observedAt: "2026-09-24T00:00:00.000Z",
    scanTaskId: randomUUID(),
    ...overrides,
  };
}

function member(id: string, catalogPosition: unknown = null) {
  return { id, catalogPosition };
}

describe("sortMembersByCatalogPosition (5-A 设计 §6.2 第 2 条)", () => {
  it("sorts by trusted pageIndex ascending, ignoring input order", () => {
    const a = member("a", trustedPosition(3));
    const b = member("b", trustedPosition(1));
    const c = member("c", trustedPosition(2));
    expect(sortMembersByCatalogPosition([a, b, c]).map((m) => m.id)).toEqual(["b", "c", "a"]);
  });

  it("breaks a same-page tie by id ascending", () => {
    const a = member("b-id", trustedPosition(5));
    const b = member("a-id", trustedPosition(5));
    expect(sortMembersByCatalogPosition([a, b]).map((m) => m.id)).toEqual(["a-id", "b-id"]);
  });

  it("sorts every unregistered (null) member to the tail, by id ascending among themselves", () => {
    const registered = member("z", trustedPosition(1));
    const unregA = member("b", null);
    const unregB = member("a", null);
    const sorted = sortMembersByCatalogPosition([unregA, registered, unregB]);
    expect(sorted.map((m) => m.id)).toEqual(["z", "a", "b"]);
  });

  it("treats a signature-mismatched registration (e.g. legacy pageSize=20) exactly like unregistered — not adopted for sort order", () => {
    const trusted = member("trusted", trustedPosition(1));
    const staleLegacy = member("stale", trustedPosition(1, { pageSize: 20 }));
    const namedSearch = member("named", trustedPosition(1, { nameEmpty: false }));
    const sorted = sortMembersByCatalogPosition([staleLegacy, namedSearch, trusted]);
    // The trusted-page-1 member sorts first; the two mismatched-signature
    // members fall to the tail in id order, exactly as if they had no
    // catalog_position at all — this is the mutation target for "坐标签名
    // 不匹配仍被采信 → 红" (设计 9.2 验收第 3 条).
    expect(sorted.map((m) => m.id)).toEqual(["trusted", "named", "stale"]);
  });

  it("degrades to plain id-ascending order when nothing is registered — byte-identical to pre-5-A behavior", () => {
    const members = [member("c"), member("a"), member("b")];
    expect(sortMembersByCatalogPosition(members).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the input array", () => {
    const members = [member("b", trustedPosition(2)), member("a", trustedPosition(1))];
    const copy = [...members];
    sortMembersByCatalogPosition(members);
    expect(members).toEqual(copy);
  });
});

describe("assignCatalogPageHints (5-A 设计 §6.1/§6.2 第 3 条, E8 阈值=2)", () => {
  it("assigns preReadMode='page' when a page group has at least the threshold's worth of members", () => {
    const members = [
      member("a", trustedPosition(7)),
      member("b", trustedPosition(7)),
    ];
    const hints = assignCatalogPageHints(members, 2);
    expect(hints.get("a")).toEqual({ catalogPageHint: 7, preReadMode: "page" });
    expect(hints.get("b")).toEqual({ catalogPageHint: 7, preReadMode: "page" });
  });

  it("assigns preReadMode='title' when a page group has fewer members than the threshold (boundary: exactly one below)", () => {
    const members = [member("solo", trustedPosition(9))];
    const hints = assignCatalogPageHints(members, 2);
    expect(hints.get("solo")).toEqual({ catalogPageHint: 9, preReadMode: "title" });
  });

  it("threshold is inclusive: a page group exactly at the threshold counts as 'page'", () => {
    const members = [member("a", trustedPosition(4)), member("b", trustedPosition(4))];
    expect(assignCatalogPageHints(members, 2).get("a")?.preReadMode).toBe("page");
  });

  it("an unregistered member always gets catalogPageHint=null and preReadMode='title', regardless of how many other unregistered members exist", () => {
    const members = [member("a", null), member("b", null), member("c", null)];
    const hints = assignCatalogPageHints(members, 2);
    for (const id of ["a", "b", "c"]) {
      expect(hints.get(id)).toEqual({ catalogPageHint: null, preReadMode: "title" });
    }
  });

  it("a signature-mismatched registration is treated as unregistered for hinting too", () => {
    const stale = member("stale", trustedPosition(1, { orderType: 1 }));
    const trusted1 = member("t1", trustedPosition(1));
    const trusted2 = member("t2", trustedPosition(1));
    const hints = assignCatalogPageHints([stale, trusted1, trusted2], 2);
    expect(hints.get("stale")).toEqual({ catalogPageHint: null, preReadMode: "title" });
    // The two genuinely-page-1 members still form a group of 2 without the
    // mismatched one padding the count.
    expect(hints.get("t1")?.preReadMode).toBe("page");
  });

  it("page-group size is computed over the whole member list, independent of any later shard slicing", () => {
    const members = Array.from({ length: 5 }, (_, i) => member(`m${i}`, trustedPosition(1)));
    const hints = assignCatalogPageHints(members, 2);
    for (const m of members) expect(hints.get(m.id)?.preReadMode).toBe("page");
  });

  it("defaults minGroupMembers to PROMO_CLAIM_PAGE_GROUP_MIN_MEMBERS (2) when not passed explicitly", () => {
    const solo = member("solo", trustedPosition(1));
    expect(assignCatalogPageHints([solo]).get("solo")?.preReadMode).toBe("title");
    const pair = [member("a", trustedPosition(2)), member("b", trustedPosition(2))];
    expect(assignCatalogPageHints(pair).get("a")?.preReadMode).toBe("page");
  });
});
