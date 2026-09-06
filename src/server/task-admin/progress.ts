import type { PrismaClient } from "@prisma/client";

import { requireHighRiskAdminCapability, type AdminAuthContext } from "@/lib/auth";

import { TaskAdminError } from "./service";

/**
 * C-6 (`施工工单_PhaseC_任务模型迁移与ImportProgress_2026-09-06.md`
 * §三/ImportProgress 移植): CPS-parity flat progress contract.
 *
 * CPS reference: `src/app/api/tasks/[id]/progress/route.ts` (read-only copy
 * at `/Users/chenweifeng/Documents/产品原型及文档/cps项目/cps-admin-v851-admin-host`).
 * That endpoint reads straight off `BatchTask`'s own counter columns and
 * returns one flat object; `ImportProgress` (`src/components/import-progress.tsx`
 * there) polls it every 2s and never sees a family/table split. This module
 * is the 海阅 equivalent: `GenericTask`/`ChannelSyncTask` already carry the
 * same counter columns CPS's `BatchTask` does (`totalCount`/`successCount`/
 * `failedCount`/`skippedCount`), so this is a straight read, not a new
 * aggregation mechanism.
 *
 * Route shape deviates from CPS's `/api/tasks/{id}/progress` path-segment
 * URL: this app's admin route registry (`src/server/auth/registry.ts`,
 * `resolveAdminRoute`) matches `route.path` by exact string equality with no
 * wildcard/pattern support, so a `[id]` dynamic segment can never be
 * registered for a fixed capability. Every other parameterized GET in this
 * admin API (`/api/admin/tasks/detail`, `/api/admin/tasks/items`) already
 * uses a fixed path plus a query string for exactly this reason; this
 * endpoint follows the same convention (`/api/admin/tasks/progress?taskId=`).
 *
 * The response BODY, unlike the route's URL, is intentionally NOT this app's
 * usual `{ok:true,data:{...}}` envelope (see `jsonOk` in
 * `src/app/api/admin/_lib/respond.ts`) — the whole point of C-6 is that the
 * ported `ImportProgress` component's `fetch(...).then(res => res.json())`
 * expects the flat CPS shape directly, unchanged from the reference
 * implementation.
 */

export type TaskProgressStatus = "pending" | "processing" | "completed" | "partial_failed" | "failed" | "paused";

export type TaskProgressItemError = Readonly<{
  id: string;
  status: "failed";
  errorMessage: string;
  createdAt: string;
}>;

export type TaskProgressCurrentItem = Readonly<{
  targetType: string;
  targetId: string;
  status: "processing";
  message: string;
}>;

export type TaskProgressDto = Readonly<{
  taskType: string;
  status: TaskProgressStatus;
  total: number;
  success: number;
  failed: number;
  skip: number;
  processed: number;
  percent: number;
  createdAt: string;
  updatedAt: string;
  taskErrors: readonly string[];
  items: readonly TaskProgressItemError[];
  currentItem?: TaskProgressCurrentItem;
}>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireTaskId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TaskAdminError("task_admin_invalid_request", 400);
  }
  return value;
}

function iso(value: Date): string {
  return value.toISOString();
}

/**
 * `completed_with_errors` -> `partial_failed` is the one mapping the work
 * order names explicitly (same bridge CPS's own `changdu-source-sync`
 * bridge handler already performs the other direction). `disabled` (task
 * retained, execution administratively prohibited -- see
 * `src/domain/database-statuses.ts`'s `TASK_STATUS_SEMANTICS`) maps to
 * CPS's `paused`: both mean "this task exists and is not going to progress
 * on its own", which is a closer semantic fit than `failed` (an attempted
 * and unsuccessful outcome) -- and the ported component already has a
 * dedicated `paused` badge/color, unused otherwise in this app.
 */
function mapStatus(raw: string): TaskProgressStatus {
  if (raw === "completed_with_errors") return "partial_failed";
  if (raw === "disabled") return "paused";
  return raw as TaskProgressStatus;
}

function taskErrorsFrom(error: unknown): readonly string[] {
  if (!error || typeof error !== "object" || Array.isArray(error)) return [];
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" && message.length > 0 ? [message] : [];
}

type GenericTaskRow = {
  taskType: string;
  status: string;
  totalCount: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  error: unknown;
  createdAt: Date;
  updatedAt: Date;
};

function toDto(task: GenericTaskRow, items: readonly TaskProgressItemError[], currentItem?: TaskProgressCurrentItem): TaskProgressDto {
  const processed = task.successCount + task.failedCount + task.skippedCount;
  const percent = task.totalCount > 0 ? Math.round((processed / task.totalCount) * 100) : 0;
  return Object.freeze({
    taskType: task.taskType,
    status: mapStatus(task.status),
    total: task.totalCount,
    success: task.successCount,
    failed: task.failedCount,
    skip: task.skippedCount,
    processed,
    percent,
    createdAt: iso(task.createdAt),
    updatedAt: iso(task.updatedAt),
    taskErrors: taskErrorsFrom(task.error),
    items,
    ...(currentItem ? { currentItem } : {}),
  });
}

/**
 * `targetType`/`targetId` are the only identity a GenericTaskItem carries.
 * `catalog_page` (the moboreader catalog-scan taskType) has a natural,
 * cheap-to-render message; every other taskType falls back to a generic
 * "target #id" phrasing rather than guessing a domain-specific one -- adding
 * a per-taskType message table is not this task's job and would only ever
 * be exercised by the one host page C-6 actually wires up (catalog-sync).
 */
function genericCurrentItemMessage(targetType: string, targetId: string): string {
  if (targetType === "catalog_page") return `正在抓取目录第 ${targetId} 页`;
  return `正在处理 ${targetType} #${targetId}`;
}

async function loadGenericProgress(db: PrismaClient, taskId: string): Promise<TaskProgressDto | null> {
  const task = await db.genericTask.findUnique({
    where: { id: taskId },
    select: {
      taskType: true, status: true, totalCount: true, successCount: true,
      failedCount: true, skippedCount: true, error: true, createdAt: true, updatedAt: true,
    },
  });
  if (!task) return null;
  const [failedItems, processingItem] = await Promise.all([
    db.genericTaskItem.findMany({
      where: { taskId, status: "failed" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 100,
      select: { id: true, error: true, createdAt: true },
    }),
    db.genericTaskItem.findFirst({
      where: { taskId, status: "processing" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { targetType: true, targetId: true },
    }),
  ]);
  const items = failedItems.map((item) => Object.freeze({
    id: item.id,
    status: "failed" as const,
    errorMessage: taskErrorsFrom(item.error)[0] ?? "任务失败",
    createdAt: iso(item.createdAt),
  }));
  const currentItem = processingItem
    ? Object.freeze({
      targetType: processingItem.targetType,
      targetId: processingItem.targetId,
      status: "processing" as const,
      message: genericCurrentItemMessage(processingItem.targetType, processingItem.targetId),
    })
    : undefined;
  return toDto(task, items, currentItem);
}

async function loadChannelSyncProgress(db: PrismaClient, taskId: string): Promise<TaskProgressDto | null> {
  const task = await db.channelSyncTask.findUnique({
    where: { id: taskId },
    select: {
      taskType: true, status: true, totalCount: true, successCount: true,
      failedCount: true, skippedCount: true, error: true, createdAt: true, updatedAt: true,
    },
  });
  if (!task) return null;
  const [failedItems, processingItem] = await Promise.all([
    db.channelSyncTaskItem.findMany({
      where: { taskId, status: "failed" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 100,
      select: { id: true, error: true, createdAt: true },
    }),
    db.channelSyncTaskItem.findFirst({
      where: { taskId, status: "processing" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        novelSourceItemId: true,
        novelSourceItem: { select: { title: true } },
      },
    }),
  ]);
  const items = failedItems.map((item) => Object.freeze({
    id: item.id,
    status: "failed" as const,
    errorMessage: taskErrorsFrom(item.error)[0] ?? "任务失败",
    createdAt: iso(item.createdAt),
  }));
  const currentItem = processingItem
    ? Object.freeze({
      targetType: "novel_source_item",
      targetId: processingItem.novelSourceItemId,
      status: "processing" as const,
      message: `正在处理《${processingItem.novelSourceItem.title}》`,
    })
    : undefined;
  return toDto(task, items, currentItem);
}

/**
 * Reads by id only, no `family` parameter -- CPS's own `/api/tasks/[id]/
 * progress` is likewise single-id, because CPS has exactly one physical
 * task table. This app has two (`GenericTask`, `ChannelSyncTask`); ids are
 * server-generated UUIDs from independent sequences, so probing one table
 * and falling back to the other is a correct (never ambiguous) lookup, not
 * a guess.
 */
export async function getAdminTaskProgress(
  db: PrismaClient,
  context: AdminAuthContext,
  input: { taskId: unknown },
  env?: NodeJS.ProcessEnv,
): Promise<TaskProgressDto> {
  requireHighRiskAdminCapability(context, "task:manage", env);
  const taskId = requireTaskId(input.taskId);
  const generic = await loadGenericProgress(db, taskId);
  if (generic) return generic;
  const channelSync = await loadChannelSyncProgress(db, taskId);
  if (channelSync) return channelSync;
  throw new TaskAdminError("task_admin_not_found", 404);
}
