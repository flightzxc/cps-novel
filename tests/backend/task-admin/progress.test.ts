import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { P2_04_ADMIN_REGISTRY } from "@/app/api/admin/_lib/registry";
import { requireAdminRouteAccess } from "@/server/auth/guards";
import { getAdminTaskProgress, TaskAdminError } from "@/server/task-admin";

import { newStores, NOW, seedTaskAdmin } from "./test-support";

const GENERIC_TASK_ID = "10000000-0000-4000-8000-000000000010";
const CHANNEL_SYNC_TASK_ID = "10000000-0000-4000-8000-000000000011";

async function readContext() {
  const stores = newStores();
  const admin = seedTaskAdmin(stores);
  const { context } = await requireAdminRouteAccess(
    { pathname: "/api/admin/tasks/progress", method: "GET", sessionToken: admin.token },
    { identities: stores, sessions: stores, registry: P2_04_ADMIN_REGISTRY, now: NOW },
  );
  return context;
}

function fakeGenericDb(overrides: {
  task?: Record<string, unknown> | null;
  failedItems?: Record<string, unknown>[];
  processingItem?: Record<string, unknown> | null;
  /**
   * C-12: the row `loadCatalogBookAggregates` (`../service.ts`) returns —
   * only ever queried when `task.result.catalogObservedTotal` and
   * `task.params.pageSize` are both present, so every pre-existing fixture
   * here (none of which sets `result`/`params`) never touches this at all.
   */
  bookAggregateRows?: Record<string, unknown>[];
}) {
  return {
    genericTask: {
      findUnique: async () => overrides.task ?? null,
    },
    genericTaskItem: {
      findMany: async () => overrides.failedItems ?? [],
      findFirst: async () => overrides.processingItem ?? null,
    },
    channelSyncTask: {
      findUnique: async () => null,
    },
    channelSyncTaskItem: {
      findMany: async () => [],
      findFirst: async () => null,
    },
    $queryRaw: async () => overrides.bookAggregateRows ?? [],
  } as unknown as PrismaClient;
}

function fakeChannelSyncDb(overrides: {
  task?: Record<string, unknown> | null;
  failedItems?: Record<string, unknown>[];
  processingItem?: Record<string, unknown> | null;
}) {
  return {
    genericTask: { findUnique: async () => null },
    genericTaskItem: { findMany: async () => [], findFirst: async () => null },
    channelSyncTask: { findUnique: async () => overrides.task ?? null },
    channelSyncTaskItem: {
      findMany: async () => overrides.failedItems ?? [],
      findFirst: async () => overrides.processingItem ?? null,
    },
  } as unknown as PrismaClient;
}

const baseGenericTask = {
  taskType: "catalog_scan",
  status: "processing",
  totalCount: 4,
  successCount: 1,
  failedCount: 1,
  skippedCount: 0,
  error: null,
  createdAt: NOW,
  updatedAt: NOW,
};

describe("getAdminTaskProgress (C-6 CPS-parity flat progress read)", () => {
  it("returns the flat CPS shape read straight off GenericTask's own counter columns", async () => {
    const context = await readContext();
    const db = fakeGenericDb({ task: baseGenericTask });

    const result = await getAdminTaskProgress(db, context, { taskId: GENERIC_TASK_ID });

    expect(result).toMatchObject({
      taskType: "catalog_scan",
      status: "processing",
      total: 4,
      success: 1,
      failed: 1,
      skip: 0,
      processed: 2,
      percent: 50,
      taskErrors: [],
      items: [],
    });
    expect(result.createdAt).toBe(NOW.toISOString());
    expect(result.updatedAt).toBe(NOW.toISOString());
  });

  it("maps completed_with_errors -> partial_failed (the one mapping the work order names explicitly)", async () => {
    const context = await readContext();
    const db = fakeGenericDb({ task: { ...baseGenericTask, status: "completed_with_errors" } });

    const result = await getAdminTaskProgress(db, context, { taskId: GENERIC_TASK_ID });

    expect(result.status).toBe("partial_failed");
  });

  it("maps disabled -> paused (administratively blocked, not an attempted-and-failed outcome)", async () => {
    const context = await readContext();
    const db = fakeGenericDb({ task: { ...baseGenericTask, status: "disabled" } });

    const result = await getAdminTaskProgress(db, context, { taskId: GENERIC_TASK_ID });

    expect(result.status).toBe("paused");
  });

  it("surfaces the task-level sanitized error message as a single taskErrors entry", async () => {
    const context = await readContext();
    const db = fakeGenericDb({
      task: { ...baseGenericTask, status: "failed", error: { code: "upstream_error", message: "MoboReader catalog read failed" } },
    });

    const result = await getAdminTaskProgress(db, context, { taskId: GENERIC_TASK_ID });

    expect(result.taskErrors).toEqual(["MoboReader catalog read failed"]);
  });

  it("surfaces failed items' sanitized error message as an expandable-list entry", async () => {
    const context = await readContext();
    const db = fakeGenericDb({
      task: baseGenericTask,
      failedItems: [{
        id: "item-1",
        error: { code: "upstream_error", message: "page 3 failed" },
        createdAt: NOW,
      }],
    });

    const result = await getAdminTaskProgress(db, context, { taskId: GENERIC_TASK_ID });

    expect(result.items).toEqual([{ id: "item-1", status: "failed", errorMessage: "page 3 failed", createdAt: NOW.toISOString() }]);
  });

  it("builds a currentItem message for a catalog_page target", async () => {
    const context = await readContext();
    const db = fakeGenericDb({
      task: baseGenericTask,
      processingItem: { targetType: "catalog_page", targetId: "7" },
    });

    const result = await getAdminTaskProgress(db, context, { taskId: GENERIC_TASK_ID });

    expect(result.currentItem).toEqual({
      targetType: "catalog_page",
      targetId: "7",
      status: "processing",
      message: "正在抓取目录第 7 页",
    });
  });

  it("omits currentItem entirely when no item is processing", async () => {
    const context = await readContext();
    const db = fakeGenericDb({ task: baseGenericTask, processingItem: null });

    const result = await getAdminTaskProgress(db, context, { taskId: GENERIC_TASK_ID });

    expect(result).not.toHaveProperty("currentItem");
  });

  it("falls back to ChannelSyncTask when the id is not a GenericTask, with a title-derived currentItem message", async () => {
    const context = await readContext();
    const db = fakeChannelSyncDb({
      task: {
        taskType: "moboreader.preview_refresh.v1",
        status: "processing",
        totalCount: 2,
        successCount: 0,
        failedCount: 0,
        skippedCount: 0,
        error: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      processingItem: {
        novelSourceItemId: "source-1",
        novelSourceItem: { title: "Example Novel" },
      },
    });

    const result = await getAdminTaskProgress(db, context, { taskId: CHANNEL_SYNC_TASK_ID });

    expect(result.taskType).toBe("moboreader.preview_refresh.v1");
    expect(result.currentItem).toEqual({
      targetType: "novel_source_item",
      targetId: "source-1",
      status: "processing",
      message: "正在处理《Example Novel》",
    });
  });

  it("rejects a malformed taskId before touching the database", async () => {
    const context = await readContext();
    const db = fakeGenericDb({});

    await expect(getAdminTaskProgress(db, context, { taskId: "not-a-uuid" }))
      .rejects.toMatchObject({ code: "task_admin_invalid_request", status: 400 });
  });

  it("404s when the id matches neither GenericTask nor ChannelSyncTask", async () => {
    const context = await readContext();
    const db = fakeGenericDb({ task: null });

    await expect(getAdminTaskProgress(db, context, { taskId: GENERIC_TASK_ID }))
      .rejects.toBeInstanceOf(TaskAdminError);
    await expect(getAdminTaskProgress(db, context, { taskId: GENERIC_TASK_ID }))
      .rejects.toMatchObject({ code: "task_admin_not_found", status: 404 });
  });
});

/**
 * C-12 (`施工工单_C12_目录任务计量口径改为本_2026-09-07.md`): once a
 * catalog_scan task's book counts are derivable, this flat progress DTO's
 * `total`/`success`/`failed`/`percent` switch to book ("本") units and the
 * pre-C-12 page-based figures move to `pageCounts` — the work order's "同样
 * 对目录任务返回本口径的 total/success/failed/percent，页口径保留在附加字段
 * 里". Before that (no `result`/`params` on the task row, or before the
 * first page completes), the DTO stays byte-identical to the pre-C-12 shape
 * — already proven by every test above, none of which sets `result`/
 * `params` on its `baseGenericTask` fixture.
 */
describe("getAdminTaskProgress (C-12 book-counts projection)", () => {
  const catalogScanTaskWithBookCounts = {
    taskType: "catalog_scan",
    status: "processing",
    totalCount: 2000, // safety-fuse pre-created page count — must never leak into `total` once bookCounts applies.
    successCount: 4,
    failedCount: 0,
    skippedCount: 0,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    result: { catalogObservedTotal: 89 },
    params: { pageSize: 20 },
  };

  it("switches total/success/failed/percent to book units and moves the page-based figures to pageCounts", async () => {
    const context = await readContext();
    const db = fakeGenericDb({
      task: catalogScanTaskWithBookCounts,
      bookAggregateRows: [{ task_id: GENERIC_TASK_ID, fetched: 80n, pages_scanned: 4n, failed_pages: 0n }],
    });

    const result = await getAdminTaskProgress(db, context, { taskId: GENERIC_TASK_ID });

    expect(result.total).toBe(89); // upstreamTotal, not the 2000-page safety fuse.
    expect(result.success).toBe(80); // fetched books, not 4 pages.
    expect(result.failed).toBe(0);
    expect(result.skip).toBe(0);
    expect(result.processed).toBe(80);
    expect(result.percent).toBe(90); // round(80 / 89 * 100)
    expect(result.pageCounts).toEqual({
      total: 2000,
      success: 4,
      failed: 0,
      percent: 0, // pre-C-12 page-based percent: round(4 / 2000 * 100)
      pagesScanned: 4,
      pagesTotalExpected: 5, // ceil(89 / 20)
    });
  });

  it("builds the page-and-book currentItem message once bookCounts is derivable", async () => {
    const context = await readContext();
    const db = fakeGenericDb({
      task: catalogScanTaskWithBookCounts,
      processingItem: { targetType: "catalog_page", targetId: "5" },
      bookAggregateRows: [{ task_id: GENERIC_TASK_ID, fetched: 80n, pages_scanned: 4n, failed_pages: 0n }],
    });

    const result = await getAdminTaskProgress(db, context, { taskId: GENERIC_TASK_ID });

    expect(result.currentItem).toEqual({
      targetType: "catalog_page",
      targetId: "5",
      status: "processing",
      message: "正在抓取目录第 5 / 5 页（已获取 80 / 89 本）",
    });
  });

  it("failedBooks excludes cascaded pages via the aggregate's failed_pages, multiplied by pageSize", async () => {
    const context = await readContext();
    const db = fakeGenericDb({
      task: {
        ...catalogScanTaskWithBookCounts,
        status: "completed_with_errors",
        successCount: 4,
        failedCount: 1997, // physical item count, including 1995 cascaded surplus pages.
      },
      bookAggregateRows: [{ task_id: GENERIC_TASK_ID, fetched: 80n, pages_scanned: 5n, failed_pages: 1n }],
    });

    const result = await getAdminTaskProgress(db, context, { taskId: GENERIC_TASK_ID });

    expect(result.failed).toBe(20); // 1 non-cascaded failed page × pageSize 20, not 1997.
    expect(result.pageCounts?.failed).toBe(1997); // page-based figure preserved verbatim in pageCounts.
  });

  it("falls back to the pre-C-12 page-based shape when catalogObservedTotal is not yet known (no pageCounts, no bookCounts-driven message)", async () => {
    const context = await readContext();
    const db = fakeGenericDb({
      task: { ...catalogScanTaskWithBookCounts, result: {}, successCount: 0 },
      processingItem: { targetType: "catalog_page", targetId: "1" },
    });

    const result = await getAdminTaskProgress(db, context, { taskId: GENERIC_TASK_ID });

    expect(result.total).toBe(2000);
    expect(result).not.toHaveProperty("pageCounts");
    expect(result.currentItem?.message).toBe("正在抓取目录第 1 页");
  });
});
