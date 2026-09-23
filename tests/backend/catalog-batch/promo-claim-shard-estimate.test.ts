import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { estimatePromoClaimShardPlan } from "@/server/catalog-batch";
import type { CatalogBatchContext } from "@/domain/catalog-batch";

/**
 * 阶段2 第4步（施工任务 3.6）：目录同步页提交确认弹窗"预计分 N 片、预计
 * 耗时 X 小时"的预估——`estimatePromoClaimShardPlan` 本身不接触真实数据库
 * 结构，只是把 `resolveLifecycleShardSize`（枚举时同一套 p90 取样逻辑）的
 * 结果按渠道分组汇总，所以这里用一个假 db（只实现 `$queryRaw`，按查询里
 * 唯一的 `channelAccountId` 参数返回预先配置好的 p90/样本量）覆盖。
 */
function fakeDb(p90ByAccount: Readonly<Record<string, { p90Seconds: number | null; sampleCount: number }>>): PrismaClient {
  return {
    $queryRaw: async (query: { values: readonly unknown[] }) => {
      // `measureRecentShardP90` 的 SQL 先插值 PROMO_LINK_CLAIM_TASK_TYPE
      // （task_type 过滤），channelAccountId 是第二个插值参数——不是第一个。
      const accountId = query.values[1] as string;
      const fixture = p90ByAccount[accountId] ?? { p90Seconds: null, sampleCount: 0 };
      return [{ p90_seconds: fixture.p90Seconds, sample_count: fixture.sampleCount }];
    },
  } as unknown as PrismaClient;
}

function channelGroup(overrides: Partial<CatalogBatchContext["channelGroups"][number]> = {}): CatalogBatchContext["channelGroups"][number] {
  return {
    channelAppId: "app-1", channelCode: "c1", channelName: "Channel 1",
    active: true, claimCapabilityEnabled: true, eligibleCount: 100, accounts: [],
    ...overrides,
  };
}

const ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  PROMO_CLAIM_SHARD_WINDOW_MINUTES: "90",
  PROMO_CLAIM_SHARD_SIZE_MIN: "50",
  PROMO_CLAIM_SHARD_SIZE_MAX: "1000",
};

describe("estimatePromoClaimShardPlan", () => {
  it("样本不足时按回退 p90（5 秒）计算，单渠道单账号：756 本/片 -> 1 片", async () => {
    const db = fakeDb({ "account-1": { p90Seconds: null, sampleCount: 0 } });
    const context = { channelGroups: [channelGroup({ channelAppId: "app-1", eligibleCount: 100 })] };
    const estimate = await estimatePromoClaimShardPlan(db, context, { "app-1": "account-1" }, ENV);
    expect(estimate.groups).toEqual([{ channelAppId: "app-1", channelAccountId: "account-1", eligibleCount: 100, shardSize: 756, shardCount: 1 }]);
    expect(estimate.totalShardCount).toBe(1);
    expect(estimate.windowMinutes).toBe(90);
    expect(estimate.estimatedHours).toBe(1.5); // 1 片 * 90 分钟 = 1.5 小时。
  });

  it("样本充足（>= 50）时使用实测 p90，分片数按 ceil(eligibleCount / shardSize) 计算", async () => {
    const db = fakeDb({ "account-1": { p90Seconds: 10, sampleCount: 60 } });
    // floor(0.7 * 90 * 60 / 10) = floor(378) = 378。
    const context = { channelGroups: [channelGroup({ channelAppId: "app-1", eligibleCount: 1000 })] };
    const estimate = await estimatePromoClaimShardPlan(db, context, { "app-1": "account-1" }, ENV);
    expect(estimate.groups[0]).toMatchObject({ shardSize: 378, shardCount: 3 }); // ceil(1000/378) = 3。
  });

  it("没有选定账户的渠道分组不计入预估", async () => {
    const db = fakeDb({});
    const context = { channelGroups: [channelGroup({ channelAppId: "app-1" }), channelGroup({ channelAppId: "app-2", eligibleCount: 50 })] };
    const estimate = await estimatePromoClaimShardPlan(db, context, { "app-1": "account-1" }, ENV);
    expect(estimate.groups).toHaveLength(1);
    expect(estimate.groups[0]!.channelAppId).toBe("app-1");
  });

  it("eligibleCount 为 0 的分组不计入预估（即使选了账户）", async () => {
    const db = fakeDb({ "account-1": { p90Seconds: null, sampleCount: 0 } });
    const context = { channelGroups: [channelGroup({ channelAppId: "app-1", eligibleCount: 0 })] };
    const estimate = await estimatePromoClaimShardPlan(db, context, { "app-1": "account-1" }, ENV);
    expect(estimate.groups).toHaveLength(0);
    expect(estimate.totalShardCount).toBe(0);
    expect(estimate.estimatedHours).toBe(0);
  });

  it("同一账号名下多个渠道分组：分片数按窗口时间顺序相加（串行）", async () => {
    const db = fakeDb({ "account-1": { p90Seconds: null, sampleCount: 0 } });
    const context = {
      channelGroups: [
        channelGroup({ channelAppId: "app-1", eligibleCount: 756 }), // 1 片
        channelGroup({ channelAppId: "app-2", eligibleCount: 1512 }), // 2 片
      ],
    };
    const estimate = await estimatePromoClaimShardPlan(db, context, { "app-1": "account-1", "app-2": "account-1" }, ENV);
    expect(estimate.totalShardCount).toBe(3);
    // 同一账号 3 片全部串行：3 * 90 分钟 = 4.5 小时。
    expect(estimate.estimatedHours).toBe(4.5);
  });

  it("不同账号并行执行：总预计耗时取账号间的最大值，不是相加", async () => {
    const db = fakeDb({
      "account-1": { p90Seconds: null, sampleCount: 0 },
      "account-2": { p90Seconds: null, sampleCount: 0 },
    });
    const context = {
      channelGroups: [
        channelGroup({ channelAppId: "app-1", eligibleCount: 756 }), // account-1：1 片
        channelGroup({ channelAppId: "app-2", eligibleCount: 756 * 3 }), // account-2：3 片
      ],
    };
    const estimate = await estimatePromoClaimShardPlan(db, context, { "app-1": "account-1", "app-2": "account-2" }, ENV);
    expect(estimate.totalShardCount).toBe(4); // 1 + 3，展示总分片数时两个账号都算。
    // account-1: 1*90=90 分钟；account-2: 3*90=270 分钟 -> 取更大值 270 分钟 = 4.5 小时（不是 90+270=360 分钟）。
    expect(estimate.estimatedHours).toBe(4.5);
  });

  it("没有任何分组入选时返回全 0，不抛错", async () => {
    const db = fakeDb({});
    const estimate = await estimatePromoClaimShardPlan(db, { channelGroups: [] }, {}, ENV);
    expect(estimate).toEqual({ totalShardCount: 0, estimatedHours: 0, windowMinutes: 90, groups: [] });
  });
});
