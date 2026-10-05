import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { readCatalogBatchSummary } from "@/server/catalog-batch";

/**
 * 2026-10-06 追加（第五件）：`readCatalogBatchSummary` 给目录同步页弹窗补了
 * `selectedCount` 与三个生命周期计数。批次结果 JSON 里没有对应键（老批次、旧路径、
 * 纳入书目批次）时一律返回 `null`，不能补 0——弹窗靠"是否为 null"决定显示哪一版。
 * 这里用只实现 `genericTask.findFirst` 的假 db 覆盖读接口本身（真实库口径另见
 * `tests/integration/catalog-batch/postgres.test.ts` 与
 * `tests/integration/tasks/promo-claim-batch-control-postgres.test.ts`）。
 */
const ACTOR = "actor-1";

function fakeDb(result: unknown, overrides: Partial<{ status: string; params: unknown; childStatuses: readonly string[] }> = {}): PrismaClient {
  return {
    genericTask: {
      findFirst: async () => ({
        id: "task-1",
        status: overrides.status ?? "completed",
        params: "params" in overrides ? overrides.params : { actorId: ACTOR },
        result,
        items: [],
        childTasks: (overrides.childStatuses ?? []).map((status) => ({ status, totalCount: 1, successCount: 0, failedCount: 0, skippedCount: 0 })),
      }),
    },
  } as unknown as PrismaClient;
}

describe("readCatalogBatchSummary 新计数字段", () => {
  it("生命周期批次的结果里有四个键：原样返回数值（含 0）", async () => {
    const summary = await readCatalogBatchSummary(fakeDb({
      enumerationStatus: "completed", selectedCount: 20, submittedCount: 10, ineligibleCount: 2, alreadyLinkedCount: 0,
      alreadyHasPromoCodeCount: 4, manualReviewPendingCount: 0, inOtherUnfinishedBatchNoticeCount: 5,
      blockedCount: 1, blockedReasonCounts: { missing_channel_account: 1 },
    }), "task-1", ACTOR);
    expect(summary).toMatchObject({
      selectedCount: 20, submittedCount: 10, ineligibleCount: 2, alreadyLinkedCount: 0,
      alreadyHasPromoCodeCount: 4, manualReviewPendingCount: 0, inOtherUnfinishedBatchNoticeCount: 5, blockedCount: 1,
    });
  });

  it("老批次（结果里没有新键）：四个新字段一律为 null，旧字段不变", async () => {
    const summary = await readCatalogBatchSummary(fakeDb({
      enumerationStatus: "completed", submittedCount: 3, ineligibleCount: 1, alreadyLinkedCount: 0,
      blockedReasonCounts: { queued_in_other_batch: 2 },
    }), "task-1", ACTOR);
    expect(summary).toEqual({
      taskId: "task-1", phase: "completed_with_errors",
      selectedCount: null, submittedCount: 3, ineligibleCount: 1, alreadyLinkedCount: 0,
      alreadyHasPromoCodeCount: null, manualReviewPendingCount: null, inOtherUnfinishedBatchNoticeCount: null,
      blockedCount: 2,
    });
  });

  it("枚举尚未完成（结果为空）：全部计数为 null；非数值的脏值也按缺失处理", async () => {
    const empty = await readCatalogBatchSummary(fakeDb(null, { status: "pending" }), "task-1", ACTOR);
    expect(empty).toMatchObject({
      selectedCount: null, submittedCount: null, ineligibleCount: null,
      alreadyHasPromoCodeCount: null, manualReviewPendingCount: null, inOtherUnfinishedBatchNoticeCount: null,
    });
    const dirty = await readCatalogBatchSummary(fakeDb({
      selectedCount: "20", alreadyHasPromoCodeCount: "4", manualReviewPendingCount: null, inOtherUnfinishedBatchNoticeCount: {},
    }, { status: "pending" }), "task-1", ACTOR);
    expect(dirty).toMatchObject({
      selectedCount: null, alreadyHasPromoCodeCount: null, manualReviewPendingCount: null, inOtherUnfinishedBatchNoticeCount: null,
    });
  });

  it("不是本人的批次仍返回 null（新字段不改变鉴权口径）", async () => {
    expect(await readCatalogBatchSummary(fakeDb({ selectedCount: 1 }), "task-1", "someone-else")).toBeNull();
  });
});
