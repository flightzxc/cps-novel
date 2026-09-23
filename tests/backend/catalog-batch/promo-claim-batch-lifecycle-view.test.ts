import { describe, expect, it } from "vitest";

import {
  derivePromoClaimBatchCounts,
  estimatePromoClaimBatchEtaMinutes,
  isShardTerminalStatus,
  type PromoClaimShardSummaryDto,
} from "@/domain/catalog-batch";

/**
 * 阶段2 第4步（施工任务 3.5）：批次详情页"分片列表 / 领取统计 / 预计完成
 * 时间"两个纯派生函数的边界测试——不接触数据库，服务端只负责把
 * `generic_task`/`generic_task_item` 聚合成 `PromoClaimShardSummaryDto[]`
 * 传进来。
 */

function shard(overrides: Partial<PromoClaimShardSummaryDto> = {}): PromoClaimShardSummaryDto {
  return {
    taskId: "shard-1",
    shardIndex: 0,
    status: "disabled",
    releaseCount: 0,
    missedDeadlineCount: 0,
    totalCount: 1,
    successCount: 0,
    manualReviewCount: 0,
    failedCount: 0,
    skippedCount: 0,
    ...overrides,
  };
}

describe("isShardTerminalStatus", () => {
  it("completed/completed_with_errors/failed/cancelled 是终态", () => {
    for (const status of ["completed", "completed_with_errors", "failed", "cancelled"]) {
      expect(isShardTerminalStatus(status)).toBe(true);
    }
  });

  it("disabled/paused/pending/processing 都不是终态——还可能被 scheduler/运营继续推进", () => {
    for (const status of ["disabled", "paused", "pending", "processing"]) {
      expect(isShardTerminalStatus(status)).toBe(false);
    }
  });
});

describe("derivePromoClaimBatchCounts", () => {
  it("单个分片：total/claimed/withCode/manualReview/failed/remaining 全部正确派生", () => {
    const counts = derivePromoClaimBatchCounts([
      shard({ totalCount: 10, successCount: 6, manualReviewCount: 2, failedCount: 1, skippedCount: 1 }),
    ]);
    expect(counts).toEqual({
      total: 10,
      claimed: 8, // success(6) + failed(1) + skipped(1)
      withCode: 4, // success(6) - manualReview(2)
      manualReview: 2,
      failed: 1,
      remaining: 2, // 10 - 6 - 1 - 1
    });
  });

  it("多个分片按元素求和", () => {
    const counts = derivePromoClaimBatchCounts([
      shard({ totalCount: 5, successCount: 5 }),
      shard({ totalCount: 5, successCount: 0, failedCount: 0, skippedCount: 0 }),
    ]);
    expect(counts).toEqual({ total: 10, claimed: 5, withCode: 5, manualReview: 0, failed: 0, remaining: 5 });
  });

  it("空分片数组时全部为 0（理论上不会发生，枚举总会建至少一片，但不能崩）", () => {
    expect(derivePromoClaimBatchCounts([])).toEqual({ total: 0, claimed: 0, withCode: 0, manualReview: 0, failed: 0, remaining: 0 });
  });

  it("remaining 永远不为负——即使聚合口径万一出现漂移", () => {
    const counts = derivePromoClaimBatchCounts([shard({ totalCount: 1, successCount: 1, failedCount: 1 })]);
    expect(counts.remaining).toBe(0);
  });
});

describe("estimatePromoClaimBatchEtaMinutes", () => {
  const now = new Date("2026-09-23T12:00:00.000Z");

  it("没有分片时返回 null", () => {
    expect(estimatePromoClaimBatchEtaMinutes([], 90, now)).toBeNull();
  });

  it("全部分片已终态时返回 0", () => {
    const shards = [shard({ status: "completed" }), shard({ status: "failed" })];
    expect(estimatePromoClaimBatchEtaMinutes(shards, 90, now)).toBe(0);
  });

  it("当前放行分片按剩余窗口时间计，其余排队分片各按整窗口时间计", () => {
    const deadlineAt = new Date(now.getTime() + 30 * 60_000).toISOString(); // 还剩 30 分钟
    const shards = [
      shard({ status: "pending", deadlineAt }),
      shard({ status: "disabled" }),
      shard({ status: "disabled" }),
    ];
    // 30（当前片剩余）+ 2 * 90（两片排队）= 210
    expect(estimatePromoClaimBatchEtaMinutes(shards, 90, now)).toBe(210);
  });

  it("没有分片处于 pending/processing（例如刚暂停）时，所有未终态分片都按整窗口时间计", () => {
    const shards = [shard({ status: "paused" }), shard({ status: "disabled" })];
    expect(estimatePromoClaimBatchEtaMinutes(shards, 90, now)).toBe(180);
  });

  it("当前放行分片已经过了 deadline（错过截止时间待重新放行）时按 0 计，不倒扣", () => {
    const pastDeadline = new Date(now.getTime() - 5 * 60_000).toISOString();
    const shards = [shard({ status: "pending", deadlineAt: pastDeadline })];
    expect(estimatePromoClaimBatchEtaMinutes(shards, 90, now)).toBe(0);
  });

  it("当前放行分片缺少 deadlineAt（理论上不会发生）时回退按整窗口时间计——fail-closed，不是 0", () => {
    const shards = [shard({ status: "processing" })];
    expect(estimatePromoClaimBatchEtaMinutes(shards, 90, now)).toBe(90);
  });
});
