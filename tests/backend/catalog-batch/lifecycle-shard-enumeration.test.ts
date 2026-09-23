import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  buildLifecycleShardPlan,
  chunkMembersIntoShards,
  isLifecycleBatchPayload,
  parsePayload,
  type LifecycleShardGroupPlan,
} from "../../../worker/handlers/catalog-batch";
import type { CatalogBatchPayload } from "@/lib/tasks/catalog-batch";

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
