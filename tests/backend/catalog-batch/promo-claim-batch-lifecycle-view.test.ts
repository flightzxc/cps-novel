import { describe, expect, it } from "vitest";

import {
  classifyPromoClaimItemOutcome,
  derivePromoClaimBatchCounts,
  estimatePromoClaimBatchEtaMinutes,
  isShardTerminalStatus,
  type PromoClaimItemOutcomeBucket,
  type PromoClaimShardSummaryDto,
} from "@/domain/catalog-batch";

/**
 * 阶段2 第4步（施工任务 3.5，Opus 复核 2026-09-24 F1 收口）：批次详情页
 * "分片列表 / 领取统计 / 预计完成时间"三个纯派生函数的边界测试——不接触
 * 数据库，服务端只负责把 generic_task/generic_task_item 聚合成
 * PromoClaimShardSummaryDto[] 传进来（六个桶已经按
 * classifyPromoClaimItemOutcome 同一套口径在 SQL 里算好）。
 */

function shard(overrides: Partial<PromoClaimShardSummaryDto> = {}): PromoClaimShardSummaryDto {
  return {
    taskId: "shard-1",
    shardIndex: 0,
    status: "disabled",
    releaseCount: 0,
    missedDeadlineCount: 0,
    totalCount: 1,
    claimedCount: 0,
    withCodeCount: 0,
    manualReviewCount: 0,
    failedCount: 0,
    skippedCount: 0,
    remainingCount: 0,
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

/**
 * Opus 复核（2026-09-24 F1）钉死的六分类口径。每一条用例对应
 * worker/handlers/promo-link-claim.ts 里真实会写的一种 (status, decision)
 * 组合——不是凭空构造的边界值。
 */
describe("classifyPromoClaimItemOutcome（六分类口径，F1 钉死）", () => {
  it.each([
    ["success", "claimed", "claimed"],
    ["success", "readback_recovered", "claimed"],
    ["success", "already_available", "withCode"],
    ["skipped", "already_fetched", "withCode"],
    ["success", "manual_review_required", "manualReview"],
    ["failed", null, "failed"],
    ["failed", "claim_failed", "failed"],
    ["pending", null, "remaining"],
    ["processing", null, "remaining"],
  ] satisfies Array<[string, string | null, PromoClaimItemOutcomeBucket]>)(
    "(%s, %s) -> %s",
    (status, decision, expected) => {
      expect(classifyPromoClaimItemOutcome(status, decision)).toBe(expected);
    },
  );

  it("跳过（skipped）：decision 不是 already_fetched 时归入 skipped，含人工中止前未尝试（decision 缺失，只有 error.code）", () => {
    expect(classifyPromoClaimItemOutcome("skipped", null)).toBe("skipped"); // 人工中止级联：result 无 decision，只有 error.code=task_manually_aborted。
    expect(classifyPromoClaimItemOutcome("skipped", "would_claim")).toBe("skipped"); // dry-run 预演。
    expect(classifyPromoClaimItemOutcome("skipped", "would_skip_capability_disabled")).toBe("skipped"); // dry-run 预演。
  });

  /**
   * 两个 Opus 六分类表原文未显式覆盖的 success 型 decision——见
   * classifyPromoClaimItemOutcome 自己的 doc comment 对这两条判断依据的
   * 完整说明，这里只锁定判定结果本身。
   */
  it("success + already_fetched（apply 模式下 DB 记录已是 fetched）并入 withCode，与 already_available 同一语义", () => {
    expect(classifyPromoClaimItemOutcome("success", "already_fetched")).toBe("withCode");
  });

  it("success + capability_disabled（能力位在枚举后被关闭）并入 failed（Opus 第二轮复核修正），不进人工核对列表", () => {
    expect(classifyPromoClaimItemOutcome("success", "capability_disabled")).toBe("failed");
  });

  it("success + 任何未识别的 decision 字符串（fail-safe）并入 manualReview，不静默计成已领取", () => {
    expect(classifyPromoClaimItemOutcome("success", "some_future_decision_value")).toBe("manualReview");
    expect(classifyPromoClaimItemOutcome("success", null)).toBe("manualReview");
    expect(classifyPromoClaimItemOutcome("success", undefined)).toBe("manualReview");
  });

  it("理论上不会出现的 status（不在 CHECK 约束取值内）同样 fail-safe 归入 manualReview，不抛异常也不被漏计", () => {
    expect(classifyPromoClaimItemOutcome("some_unknown_status", "claimed")).toBe("manualReview");
  });
});

describe("derivePromoClaimBatchCounts", () => {
  it("单个分片：七个字段原样求和（分类已经在上游算好，这里只是加总）", () => {
    const counts = derivePromoClaimBatchCounts([
      shard({ totalCount: 10, claimedCount: 4, withCodeCount: 2, manualReviewCount: 1, failedCount: 1, skippedCount: 1, remainingCount: 1 }),
    ]);
    expect(counts).toEqual({ total: 10, claimed: 4, withCode: 2, manualReview: 1, failed: 1, skipped: 1, remaining: 1 });
  });

  it("多个分片按元素求和", () => {
    const counts = derivePromoClaimBatchCounts([
      shard({ totalCount: 5, claimedCount: 5 }),
      shard({ totalCount: 5, remainingCount: 5 }),
    ]);
    expect(counts).toEqual({ total: 10, claimed: 5, withCode: 0, manualReview: 0, failed: 0, skipped: 0, remaining: 5 });
  });

  it("空分片数组时全部为 0（理论上不会发生，枚举总会建至少一片，但不能崩）", () => {
    expect(derivePromoClaimBatchCounts([])).toEqual({ total: 0, claimed: 0, withCode: 0, manualReview: 0, failed: 0, skipped: 0, remaining: 0 });
  });

  /**
   * Opus 复核要求的不变量：六类（claimed/withCode/manualReview/failed/
   * skipped/remaining）互斥、加总等于 total。构造一个覆盖全部六个桶、且
   * 每个分片桶值都是通过 classifyPromoClaimItemOutcome 真实分类出来的
   * "完整条目清单"，逐条分类后按分片聚合，断言总和守恒——这条用例把纯
   * 分类函数与纯聚合函数串起来一起验证，而不是像上面几条用例那样直接
   * 摆好每个桶的数字。
   */
  it("不变量：六类互斥且加总等于 total——用真实条目清单逐条分类后聚合验证", () => {
    const items: Array<{ status: string; decision: string | null }> = [
      { status: "success", decision: "claimed" },
      { status: "success", decision: "readback_recovered" },
      { status: "success", decision: "already_available" },
      { status: "skipped", decision: "already_fetched" },
      { status: "success", decision: "already_fetched" },
      { status: "success", decision: "manual_review_required" },
      { status: "success", decision: "capability_disabled" },
      { status: "failed", decision: null },
      { status: "skipped", decision: null },
      { status: "pending", decision: null },
      { status: "processing", decision: null },
    ];
    const bucketCounts: Record<PromoClaimItemOutcomeBucket, number> = {
      claimed: 0, withCode: 0, manualReview: 0, failed: 0, skipped: 0, remaining: 0,
    };
    for (const item of items) bucketCounts[classifyPromoClaimItemOutcome(item.status, item.decision)] += 1;

    const oneShard = shard({
      totalCount: items.length,
      claimedCount: bucketCounts.claimed,
      withCodeCount: bucketCounts.withCode,
      manualReviewCount: bucketCounts.manualReview,
      failedCount: bucketCounts.failed,
      skippedCount: bucketCounts.skipped,
      remainingCount: bucketCounts.remaining,
    });
    const counts = derivePromoClaimBatchCounts([oneShard]);
    expect(counts.claimed + counts.withCode + counts.manualReview + counts.failed + counts.skipped + counts.remaining).toBe(counts.total);
    expect(counts.total).toBe(items.length);
    // 逐类锁定具体数字，防止"总和守恒但个别桶算错互相抵消"这种更隐蔽的回归。
    expect(counts).toEqual({
      total: 11,
      claimed: 2, // claimed, readback_recovered
      withCode: 3, // already_available, skipped+already_fetched, success+already_fetched
      manualReview: 1, // manual_review_required
      failed: 2, // failed(status), capability_disabled（Opus 第二轮复核修正，不再算进 manualReview）
      skipped: 1, // 只有 decision=null 的 skipped 才落在这里，already_fetched 那条已经分流到 withCode
      remaining: 2, // pending, processing
    });
  });

  it("六类求和永远等于 total——对照上面那条不变量用例：这里单独断言求和函数本身没有独立 bug", () => {
    const counts = derivePromoClaimBatchCounts([
      shard({ totalCount: 6, claimedCount: 1, withCodeCount: 1, manualReviewCount: 1, failedCount: 1, skippedCount: 1, remainingCount: 1 }),
    ]);
    expect(counts.claimed + counts.withCode + counts.manualReview + counts.failed + counts.skipped + counts.remaining).toBe(counts.total);
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
