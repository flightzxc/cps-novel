import { describe, expect, it } from "vitest";

import {
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
    for (const status of ["pending", "processing", "completed", "disabled"]) {
      expect(isRetryableTaskStatus(status)).toBe(false);
    }
  });
});

describe("task-copy · TASK_STATUSES/TASK_ITEM_STATUSES single source of truth (C-5)", () => {
  it("matches the frozen 6-value task-status set the generic_task/channel_sync_task CHECK constraints enforce", () => {
    // Matches database-governance.md §4's Task line and the
    // generic_task_status_check/channel_sync_task_status_check CHECK clauses
    // verified live in tests/integration/tasks/p1-13-postgres-acceptance.test.ts's
    // frozenChecks. A drift here (e.g. someone dropping "disabled" from one
    // copy but not the CHECK) would previously have gone unnoticed at the
    // unit-test layer -- there was no test asserting this exact set.
    expect(TASK_STATUSES).toEqual([
      "pending",
      "processing",
      "completed",
      "completed_with_errors",
      "failed",
      "disabled",
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
