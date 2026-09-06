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
