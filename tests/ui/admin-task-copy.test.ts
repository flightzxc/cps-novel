import { describe, expect, it } from "vitest";

import {
  catalogBatchBlockedReasons,
  catalogBatchPromoClaimCountLabels,
  isRetryableTaskStatus,
  itemStatusOptionsFor,
  LIST_LIMIT_NOTE,
  taskFamilyLabel,
  TASK_ITEM_STATUSES,
  TASK_LIST_MAX_LIMIT,
  TASK_STATUSES,
} from "@/app/(admin)/tasks/_lib/task-copy";
import {
  TASK_ITEM_STATUSES as DOMAIN_TASK_ITEM_STATUSES,
  TASK_STATUSES as DOMAIN_TASK_STATUSES,
} from "@/domain/database-statuses";

describe("task-copy · batch blocked reason labels", () => {
  it("labels locale eligibility blocks in Chinese and withholds unknown reason keys", () => {
    const labels = catalogBatchBlockedReasons({
      missing_locale: 2,
      unsupported_locale: 3,
      internal_reason: 99,
    });

    expect(labels).toEqual([
      "来源语言缺失：2 条",
      "来源语言暂不受产品支持：3 条",
    ]);
    expect(labels.join(" ")).not.toContain("internal_reason");
  });

  /**
   * 阶段2 第4步（施工任务 3.4）曾引入的跨批次排队冲突说明。2026-10-06 修订
   * 之后新批次不再产生这两个原因码，但历史批次的结果里仍然带着它们——中文
   * 说明必须保留，老批次在后台才显示得出原因（验收场景 F）。
   */
  it("keeps the Chinese labels of the historical cross-batch reasons (old batches still show them)", () => {
    expect(catalogBatchBlockedReasons({ queued_in_other_batch: 5 })).toEqual(["已在其它排队中的批次里：5 条"]);
    expect(catalogBatchBlockedReasons({ active_item_conflict: 2 })).toEqual(["条目已有进行中的任务：2 条"]);
    expect(catalogBatchBlockedReasons({ queued_in_other_batch: 5, active_item_conflict: 2 })).toEqual([
      "已在其它排队中的批次里：5 条",
      "条目已有进行中的任务：2 条",
    ]);
  });
});

describe("task-copy · lifecycle promo-claim batch counts", () => {
  it("labels 已有推广码 / 待人工核对 / 重叠提示 in Chinese, only when positive", () => {
    expect(catalogBatchPromoClaimCountLabels({
      alreadyHasPromoCodeCount: 12,
      manualReviewPendingCount: 3,
      inOtherUnfinishedBatchNoticeCount: 5,
    })).toEqual([
      "已有推广码 12 本（未入队）",
      "待人工核对 3 本（未入队）",
      "其中 5 本同时在其它未完成的批次里，跑到时会自动跳过",
    ]);
  });

  it("shows nothing for zero/absent counts, so a 未领取-filtered batch and every historical batch render exactly as before", () => {
    expect(catalogBatchPromoClaimCountLabels(undefined)).toEqual([]);
    expect(catalogBatchPromoClaimCountLabels({})).toEqual([]);
    expect(catalogBatchPromoClaimCountLabels({
      alreadyHasPromoCodeCount: 0, manualReviewPendingCount: 0, inOtherUnfinishedBatchNoticeCount: null,
    })).toEqual([]);
  });
});

/**
 * `_lib/task-copy.ts` mirrors private enums from
 * `src/server/task-admin/service.ts` (`TASK_FAMILIES`,
 * `RETRYABLE_PARENT_STATUSES`). These are pure-logic assertions that the
 * mirror agrees with the service's actual behaviour, independent of any
 * component rendering it.
 *
 * Phase C: `catalog_scan` folded into GenericTask (`taskType =
 * "catalog_scan"`); it is no longer a family, so there is no third label and
 * no `skipped` exclusion to test here anymore — both remaining families
 * genuinely support `skipped`.
 */
describe("task-copy · family labels", () => {
  it("labels both known families in Chinese", () => {
    expect(taskFamilyLabel("channel_sync")).toBe("渠道同步");
    expect(taskFamilyLabel("generic")).toBe("通用任务");
  });

  it("passes an unknown family through verbatim rather than inventing a label", () => {
    expect(taskFamilyLabel("something_new")).toBe("something_new");
  });
});

describe("task-copy · retryable status gate", () => {
  it("matches RETRYABLE_PARENT_STATUSES in the service exactly", () => {
    expect(isRetryableTaskStatus("failed")).toBe(true);
    expect(isRetryableTaskStatus("completed_with_errors")).toBe(true);
  });

  it("refuses every other parent status", () => {
    for (const status of ["pending", "processing", "completed", "disabled", "paused", "cancelled"]) {
      expect(isRetryableTaskStatus(status)).toBe(false);
    }
  });
});

describe("task-copy · TASK_STATUSES/TASK_ITEM_STATUSES single source of truth (C-5)", () => {
  it("matches the frozen 8-value task-status set the generic_task/channel_sync_task CHECK constraints enforce", () => {
    // Matches database-governance.md §4's Task line and the
    // generic_task_status_check/channel_sync_task_status_check CHECK clauses
    // verified live in tests/integration/tasks/p1-13-postgres-acceptance.test.ts's
    // frozenChecks. A drift here (e.g. someone dropping "disabled" from one
    // copy but not the CHECK) would previously have gone unnoticed at the
    // unit-test layer -- there was no test asserting this exact set.
    //
    // X10 task control (`20260916090000_x10_task_control_paused_cancelled`):
    // grew from 6 to 8 values -- "paused"/"cancelled" are now real,
    // CHECK-enforced statuses pauseTask/abortTask write directly, replacing
    // the interim "disabled" + JSON-marker workaround for those two manual
    // operations. "disabled" itself is unchanged and still there (the
    // worker's own system hold, plus the three older unrelated meanings,
    // keep using it).
    expect(TASK_STATUSES).toEqual([
      "pending",
      "processing",
      "completed",
      "completed_with_errors",
      "failed",
      "disabled",
      "paused",
      "cancelled",
    ]);
  });

  it("re-exports @/domain/database-statuses's TASK_STATUSES/TASK_ITEM_STATUSES verbatim, not a second copy", () => {
    // Phase C step C-5: task-copy.ts and src/server/task-admin/service.ts
    // both import these from database-statuses.ts instead of each keeping
    // their own literal array. Asserting reference equality (not just deep
    // equality) is what actually distinguishes "single source of truth" from
    // "two arrays that currently happen to match".
    expect(TASK_STATUSES).toBe(DOMAIN_TASK_STATUSES);
    expect(TASK_ITEM_STATUSES).toBe(DOMAIN_TASK_ITEM_STATUSES);
  });
});

describe("task-copy · item status options per family", () => {
  it("keeps `skipped` for both channel_sync and generic", () => {
    expect(itemStatusOptionsFor("channel_sync")).toContain("skipped");
    expect(itemStatusOptionsFor("generic")).toContain("skipped");
  });
});

describe("task-copy · list limit ceiling", () => {
  it("is pinned to the service's hard cap of 100, not an arbitrary UI choice", () => {
    expect(TASK_LIST_MAX_LIMIT).toBe(100);
  });

  it("the note tells the operator there is no page 2, rather than implying one exists", () => {
    expect(LIST_LIMIT_NOTE).toContain("100");
    expect(LIST_LIMIT_NOTE).toMatch(/没有翻页|不存在第 ?2 ?页/);
    expect(LIST_LIMIT_NOTE).toMatch(/筛选/);
  });
});
