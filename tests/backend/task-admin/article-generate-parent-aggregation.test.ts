import { readFile } from "node:fs/promises";
import path from "node:path";

import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { P2_04_ADMIN_REGISTRY } from "@/app/api/admin/_lib/registry";
import { ARTICLE_GENERATE_BATCH_TASK_TYPE, ARTICLE_GENERATE_TASK_TYPE } from "@/lib/tasks/article-generate";
import { PARENT_BATCH_TASK_TYPES } from "@/lib/tasks/parent-batch";
import { requireAdminRouteAccess } from "@/server/auth/guards";
import {
  getAdminTaskDetail,
  getAdminTaskProgress,
  listAdminTasks,
  retryFailedTask,
} from "@/server/task-admin";

import {
  issueTaskAuthorization,
  newStores,
  NOW,
  seedTaskAdmin,
  TASK_ID,
  TaskAdminFakeDb,
} from "./test-support";

const PARENT_ID = TASK_ID;
const CHILD_A = "20000000-0000-4000-8000-000000000001";
const CHILD_B = "20000000-0000-4000-8000-000000000002";

async function readContext(pathname: string) {
  const stores = newStores();
  const admin = seedTaskAdmin(stores);
  const { context } = await requireAdminRouteAccess(
    { pathname, method: "GET", sessionToken: admin.token },
    { identities: stores, sessions: stores, registry: P2_04_ADMIN_REGISTRY, now: NOW },
  );
  return context;
}

type ChildRow = {
  id: string;
  taskType: string;
  status: string;
  totalCount: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
};

function parentRow(overrides: Record<string, unknown> = {}) {
  return {
    family: "generic",
    task_id: PARENT_ID,
    task_type: ARTICLE_GENERATE_BATCH_TASK_TYPE,
    status: "completed",
    total_count: 1,
    success_count: 1,
    failed_count: 0,
    skipped_count: 0,
    has_error: false,
    created_at: NOW,
    updated_at: NOW,
    mode: "apply",
    channel_account_id: null,
    params: {},
    result: {
      enumerationStatus: "completed",
      selectedCount: 400,
      submittedCount: 400,
      blockedCount: 0,
      blockedReasonCounts: {},
      childTaskCount: 2,
    },
    ...overrides,
  };
}

function fakeParentBatchDb(input: {
  parent?: Record<string, unknown>;
  children: readonly ChildRow[];
  listRow?: Record<string, unknown>;
}) {
  const parent = input.parent ?? parentRow();
  const children = [...input.children];
  return {
    $queryRaw: async (query: { strings?: readonly string[] } | string) => {
      const sql = typeof query === "string" ? query : (query.strings ?? []).join("?");
      if (sql.includes("task_union") || sql.includes("UNION ALL")) {
        return [input.listRow ?? parent];
      }
      return [parent];
    },
    genericTask: {
      findUnique: async () => ({
        taskType: parent.task_type,
        status: parent.status,
        totalCount: parent.total_count,
        successCount: parent.success_count,
        failedCount: parent.failed_count,
        skippedCount: parent.skipped_count,
        error: null,
        createdAt: parent.created_at,
        updatedAt: parent.updated_at,
        result: parent.result,
        params: parent.params,
      }),
      aggregate: async () => ({
        _sum: {
          totalCount: children.reduce((sum, child) => sum + child.totalCount, 0),
          successCount: children.reduce((sum, child) => sum + child.successCount, 0),
          failedCount: children.reduce((sum, child) => sum + child.failedCount, 0),
          skippedCount: children.reduce((sum, child) => sum + child.skippedCount, 0),
        },
      }),
      groupBy: async () => {
        const counts = new Map<string, number>();
        for (const child of children) counts.set(child.status, (counts.get(child.status) ?? 0) + 1);
        return [...counts.entries()].map(([status, count]) => ({ status, _count: { _all: count } }));
      },
      findMany: async () => children.map((child) => ({
        id: child.id,
        taskType: child.taskType,
        status: child.status,
      })),
    },
    genericTaskItem: {
      findMany: async () => [],
      findFirst: async () => null,
    },
    channelSyncTask: { findUnique: async () => null },
    channelSyncTaskItem: {
      findMany: async () => [],
      findFirst: async () => null,
    },
  } as unknown as PrismaClient;
}

const pendingChildren: ChildRow[] = [
  { id: CHILD_A, taskType: ARTICLE_GENERATE_TASK_TYPE, status: "pending", totalCount: 200, successCount: 0, failedCount: 0, skippedCount: 0 },
  { id: CHILD_B, taskType: ARTICLE_GENERATE_TASK_TYPE, status: "pending", totalCount: 200, successCount: 0, failedCount: 0, skippedCount: 0 },
];

describe("article.generate.batch.v1 parent read model (R2-01)", () => {
  it("keeps PARENT_BATCH_TASK_TYPES wired into list SQL", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src/server/task-admin/service.ts"), "utf8");
    expect(source).toContain("PARENT_BATCH_TASK_TYPES");
    expect(PARENT_BATCH_TASK_TYPES).toEqual(["batch.materialize.v1", "article.generate.batch.v1"]);
  });

  it("does not treat finished enumeration + pending children as completed 1/1", async () => {
    const db = fakeParentBatchDb({ children: pendingChildren });
    const listContext = await readContext("/api/admin/tasks");
    const detailContext = await readContext("/api/admin/tasks/detail");
    const progressContext = await readContext("/api/admin/tasks/progress");

    const detail = await getAdminTaskDetail(db, detailContext, { family: "generic", taskId: PARENT_ID }, {} as NodeJS.ProcessEnv);
    const progress = await getAdminTaskProgress(db, progressContext, { taskId: PARENT_ID }, {} as NodeJS.ProcessEnv);
    const list = await listAdminTasks(db, listContext, {}, {} as NodeJS.ProcessEnv);

    expect(detail.status).toBe("processing");
    expect(detail.totalCount).toBe(400);
    expect(detail.successCount).toBe(0);
    expect(detail.catalogBatch).toMatchObject({
      phase: "executing",
      submittedCount: 400,
      ineligibleCount: null,
      alreadyLinkedCount: null,
      blockedCount: 0,
      blockedReasonCounts: {},
    });
    expect(detail.catalogBatch?.childTasks).toEqual([
      { taskId: CHILD_A, taskType: ARTICLE_GENERATE_TASK_TYPE, status: "pending" },
      { taskId: CHILD_B, taskType: ARTICLE_GENERATE_TASK_TYPE, status: "pending" },
    ]);

    expect(progress.status).toBe("processing");
    expect(progress.total).toBe(400);
    expect(progress.success).toBe(0);
    expect(progress.catalogBatch).toEqual({ phase: "executing" });

    const listRow = {
      ...parentRow(),
      status: "processing",
      total_count: 400,
      success_count: 0,
    };
    const listed = await listAdminTasks(
      fakeParentBatchDb({ children: pendingChildren, listRow }),
      listContext,
      {},
      {} as NodeJS.ProcessEnv,
    );
    expect(listed.items[0]).toMatchObject({
      taskType: ARTICLE_GENERATE_BATCH_TASK_TYPE,
      status: "processing",
      totalCount: 400,
      successCount: 0,
      catalogBatch: expect.objectContaining({
        phase: "executing",
        submittedCount: 400,
        ineligibleCount: null,
        alreadyLinkedCount: null,
      }),
    });
    expect(list.items[0]?.taskType).toBe(ARTICLE_GENERATE_BATCH_TASK_TYPE);
  });

  it("rolls mixed children into completed_with_errors, not 1/1 success", async () => {
    const children: ChildRow[] = [
      { id: CHILD_A, taskType: ARTICLE_GENERATE_TASK_TYPE, status: "completed", totalCount: 200, successCount: 180, failedCount: 20, skippedCount: 0 },
      { id: CHILD_B, taskType: ARTICLE_GENERATE_TASK_TYPE, status: "failed", totalCount: 200, successCount: 0, failedCount: 200, skippedCount: 0 },
    ];
    const db = fakeParentBatchDb({ children });
    const detail = await getAdminTaskDetail(
      db,
      await readContext("/api/admin/tasks/detail"),
      { family: "generic", taskId: PARENT_ID },
      {} as NodeJS.ProcessEnv,
    );
    const progress = await getAdminTaskProgress(
      db,
      await readContext("/api/admin/tasks/progress"),
      { taskId: PARENT_ID },
      {} as NodeJS.ProcessEnv,
    );
    expect(detail.status).toBe("completed_with_errors");
    expect(detail.totalCount).toBe(400);
    expect(detail.successCount).toBe(180);
    expect(detail.failedCount).toBe(220);
    expect(detail.catalogBatch?.phase).toBe("completed_with_errors");
    expect(progress.status).toBe("partial_failed");
    expect(progress.total).toBe(400);
    expect(progress.success).toBe(180);
    expect(progress.failed).toBe(220);
    expect(progress.catalogBatch?.phase).toBe("completed_with_errors");
  });

  it("treats all-failed children as failed, not parent enum success", async () => {
    const children: ChildRow[] = [
      { id: CHILD_A, taskType: ARTICLE_GENERATE_TASK_TYPE, status: "failed", totalCount: 200, successCount: 0, failedCount: 200, skippedCount: 0 },
      { id: CHILD_B, taskType: ARTICLE_GENERATE_TASK_TYPE, status: "failed", totalCount: 200, successCount: 0, failedCount: 200, skippedCount: 0 },
    ];
    const db = fakeParentBatchDb({ children });
    const detail = await getAdminTaskDetail(
      db,
      await readContext("/api/admin/tasks/detail"),
      { family: "generic", taskId: PARENT_ID },
      {} as NodeJS.ProcessEnv,
    );
    const progress = await getAdminTaskProgress(
      db,
      await readContext("/api/admin/tasks/progress"),
      { taskId: PARENT_ID },
      {} as NodeJS.ProcessEnv,
    );
    expect(detail.status).toBe("failed");
    expect(detail.successCount).toBe(0);
    expect(detail.failedCount).toBe(400);
    expect(detail.catalogBatch?.phase).toBe("failed");
    expect(progress.status).toBe("failed");
    expect(progress.success).toBe(0);
    expect(progress.catalogBatch?.phase).toBe("failed");
  });

  it("zero-match enumeration is 0 submitted, not success of 1 book", async () => {
    const db = fakeParentBatchDb({
      parent: parentRow({
        result: { enumerationStatus: "completed", submittedCount: 0, childTaskCount: 0 },
      }),
      children: [],
    });
    const detail = await getAdminTaskDetail(
      db,
      await readContext("/api/admin/tasks/detail"),
      { family: "generic", taskId: PARENT_ID },
      {} as NodeJS.ProcessEnv,
    );
    const progress = await getAdminTaskProgress(
      db,
      await readContext("/api/admin/tasks/progress"),
      { taskId: PARENT_ID },
      {} as NodeJS.ProcessEnv,
    );
    expect(detail.status).toBe("completed");
    expect(detail.totalCount).toBe(0);
    expect(detail.successCount).toBe(0);
    expect(detail.catalogBatch).toMatchObject({
      phase: "completed",
      submittedCount: 0,
    });
    expect(detail.catalogBatch?.childTasks).toEqual([]);
    expect(progress.status).toBe("completed");
    expect(progress.total).toBe(0);
    expect(progress.success).toBe(0);
    expect(progress.catalogBatch).toEqual({ phase: "completed" });
  });

  it("projects an all-blocked enumeration as blocked, not failed child items", async () => {
    const db = fakeParentBatchDb({
      parent: parentRow({
        result: {
          enumerationStatus: "completed",
          selectedCount: 200,
          submittedCount: 0,
          blockedCount: 200,
          blockedReasonCounts: { promo_link_missing: 200 },
          childTaskCount: 0,
        },
      }),
      children: [],
    });
    const detail = await getAdminTaskDetail(
      db,
      await readContext("/api/admin/tasks/detail"),
      { family: "generic", taskId: PARENT_ID },
      {} as NodeJS.ProcessEnv,
    );
    expect(detail).toMatchObject({
      status: "completed_with_errors",
      totalCount: 0,
      failedCount: 0,
      articleAdmission: {
        selectedCount: 200,
        submittedCount: 0,
        blockedCount: 200,
        blockedReasonCounts: { promo_link_missing: 200 },
      },
    });
    expect(detail.catalogBatch?.childTasks).toEqual([]);
  });

  it("refuses parent-batch retry with 409", async () => {
    const stores = newStores();
    const admin = seedTaskAdmin(stores);
    const ticket = await issueTaskAuthorization(stores, {
      token: admin.token,
      pathname: "/api/admin/tasks/retry-failed",
    });
    const fake = new TaskAdminFakeDb();
    fake.parents.get("generic")!.taskType = ARTICLE_GENERATE_BATCH_TASK_TYPE;

    await expect(retryFailedTask(
      { ...ticket, family: "generic", taskId: PARENT_ID },
      { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW },
    )).rejects.toMatchObject({ code: "task_admin_state_conflict", status: 409 });
    expect(fake.parentUpdateCalls.get("generic") ?? 0).toBe(0);
  });
});
