import { describe, expect, it } from "vitest";

import {
  isRetryableTaskStatus,
  itemStatusOptionsFor,
  LIST_LIMIT_NOTE,
  taskFamilyLabel,
  TASK_LIST_MAX_LIMIT,
} from "@/app/(admin)/tasks/_lib/task-copy";

/**
 * `_lib/task-copy.ts` mirrors private enums from
 * `src/server/task-admin/service.ts` (`TASK_FAMILIES`, `RETRYABLE_PARENT_STATUSES`,
 * the `catalog_scan` × `skipped` exclusion). These are pure-logic assertions
 * that the mirror agrees with the service's actual behaviour, independent of
 * any component rendering it.
 */
describe("task-copy · family labels", () => {
  it("labels all three known families in Chinese", () => {
    expect(taskFamilyLabel("catalog_scan")).toBe("目录扫描");
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

describe("task-copy · item status options per family", () => {
  it("drops `skipped` for catalog_scan — CatalogScanTaskItem has no such status", () => {
    expect(itemStatusOptionsFor("catalog_scan")).not.toContain("skipped");
  });

  it("keeps `skipped` for channel_sync and generic", () => {
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
