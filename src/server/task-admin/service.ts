import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";

import {
  requireHighRiskAdminCapability,
  type AdminAuthContext,
  type AdminIdentityStore,
  type SessionStore,
} from "@/lib/auth";
import { isUniqueConstraintViolation, withDbRetry } from "@/lib/db/db-retry";
import type { TaskFamily } from "@/lib/tasks";
import { TASK_ITEM_STATUSES, TASK_STATUSES } from "@/domain/database-statuses";
import {
  requireFreshAdminServiceMutation,
  type AdminServiceAuthorization,
} from "@/server/auth/guards";

export const TASK_RETRY_ENTRY_ID = "admin.api.task.retry_failed";
export const MANUAL_REVIEW_RESOLVE_ENTRY_ID = "admin.api.task.manual_review.resolve";
export const TASK_RETRY_AUDIT_ACTION = "task.retry_failed";
export const MANUAL_REVIEW_AUDIT_ACTION = "side_effect_intent.manual_resolve";

// Phase C: catalog_scan folded into GenericTask (taskType = "catalog_scan");
// it is no longer a physical family.
const TASK_FAMILIES = ["channel_sync", "generic"] as const;
// Phase C step C-5: TASK_STATUSES/TASK_ITEM_STATUSES (formerly a third
// literal copy here, alongside task-copy.ts and database-statuses.ts) are
// now sourced from @/domain/database-statuses, the single source of truth.
const ITEM_STATUSES = TASK_ITEM_STATUSES;
const PROMO_STATUSES = ["pending", "fetched", "failed", "registered_disabled"] as const;
const RETRYABLE_PARENT_STATUSES = new Set(["failed", "completed_with_errors"]);
const UNRESOLVED_INTENT_STATUSES = [
  "prepared",
  "claim_retry_blocked",
  "manual_review_required",
] as const;
const MUTATION_REQUEST_LOCK_NAMESPACE = 50_330;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TaskAdminErrorStatus = 400 | 404 | 409;
export type TaskAdminErrorCode =
  | "task_admin_invalid_request"
  | "task_admin_not_found"
  | "task_admin_state_conflict"
  | "task_admin_idempotency_conflict"
  | "task_admin_unresolved_intent"
  | "task_admin_concurrent_write"
  | "task_admin_active_scope_conflict";

export class TaskAdminError extends Error {
  constructor(readonly code: TaskAdminErrorCode, readonly status: TaskAdminErrorStatus) {
    super(code);
    this.name = "TaskAdminError";
  }
}

type ManualResolution = "effect_confirmed" | "no_effect_confirmed";

export type TaskSummaryDto = Readonly<{
  family: TaskFamily;
  taskId: string;
  taskType: string;
  status: string;
  totalCount: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  errorSummary: "redacted" | null;
}>;

export type TaskItemDto = Readonly<{
  family: TaskFamily;
  itemId: string;
  taskId: string;
  status: string;
  attemptCount: number;
  leaseEpoch: string;
  lockedUntil: string | null;
  errorSummary: "redacted" | null;
}>;

export type PromoLinkAdminDto = Readonly<{
  promoLinkId: string;
  novelId: string;
  novelSourceItemId: string;
  channelAppId: string;
  channelAccountId: string;
  offerType: string;
  origin: string;
  publicRedirectCode: string;
  status: string;
  errorKind: string | null;
  fetchedAt: string | null;
  expiresAt: string | null;
  lastAttemptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type ManualReviewDto = Readonly<{
  intentId: string;
  operationType: string;
  targetType: string;
  targetId: string;
  taskItemType: string | null;
  taskItemId: string | null;
  channelAccountId: string | null;
  channelAppId: string | null;
  promoLinkId: string | null;
  status: "manual_review_required";
  committedAt: string;
  createdAt: string;
  guidance: {
    readonly automaticReconciliation: false;
    readonly nextActions: readonly ["upstream_readback", "authorized_rescan"];
  };
}>;

/**
 * Phase C step C-7 (`施工工单_PhaseC_任务模型迁移与ImportProgress_2026-09-06.md`
 * §四): CPS-parity retry for the `generic` family creates a NEW sibling
 * `GenericTask` (carrying only the origin's failed items) instead of
 * resetting the origin task in place — `originTaskId` is that new task's
 * link back to the task it was retried from, `null` when this result came
 * from the `channel_sync` in-place path (unchanged; `ChannelSyncTask` has
 * no `originTaskId` column and this phase does not add one — see the
 * work order's explicit "不改 ChannelSyncTask/Item 结构").
 */
export type RetryFailedTaskResult = Readonly<{
  family: TaskFamily;
  taskId: string;
  originTaskId: string | null;
  status: "pending";
  retriedItemCount: number;
  totalCount: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  wrote: boolean;
  auditId: string;
}>;

export type ManualReviewResolutionResult = Readonly<{
  intentId: string;
  resolution: ManualResolution;
  status: "confirmed" | "failed";
  resolvedAt: string;
  automaticReconciliation: false;
  nextActions: readonly ["upstream_readback", "authorized_rescan"];
  wrote: boolean;
  auditId: string;
}>;

export type TaskAdminMutationDependencies = Readonly<{
  db: PrismaClient;
  identities: AdminIdentityStore;
  sessions: SessionStore;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}>;

type TaskListRow = {
  family: TaskFamily;
  task_id: string;
  task_type: string;
  status: string;
  total_count: number;
  success_count: number;
  failed_count: number;
  skipped_count: number;
  has_error: boolean;
  created_at: Date;
};

type LockedParentRow = {
  id: string;
  status: string;
  channel_account_id: string | null;
  channel_app_id: string | null;
  // Phase C step C-7: only read by the `generic`-family retry path
  // (`createGenericRetryTask`), which needs enough of the origin row to
  // stand up a full sibling `GenericTask`. `channel_sync_task` carries the
  // same four extra columns (see the model in `prisma/schema.prisma`), so
  // `lockParent`'s two branches can select them symmetrically without a
  // union type.
  task_type: string;
  operation_scope_hash: string;
  mode: string;
  params: Prisma.JsonValue;
};

type AuditRow = {
  id: bigint;
  actorId: string | null;
  entityId: string;
  taskType: string | null;
  reason: string | null;
  afterSnapshot: Prisma.JsonValue | null;
};

const GUIDANCE = Object.freeze({
  automaticReconciliation: false as const,
  nextActions: Object.freeze(["upstream_readback", "authorized_rescan"] as const),
});

function invalid(): never {
  throw new TaskAdminError("task_admin_invalid_request", 400);
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) return invalid();
  return value as T;
}

function optionalOneOf<T extends string>(value: unknown, values: readonly T[]): T | null {
  if (value === null || value === undefined || value === "") return null;
  return oneOf(value, values);
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return invalid();
  return value;
}

function optionalUuid(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return uuid(value);
}

function boundedText(value: unknown, maxLength: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength) return invalid();
  return normalized;
}

function limit(value: unknown): number {
  if (value === null || value === undefined || value === "") return 50;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) return invalid();
  return parsed;
}

function iso(value: Date): string;
function iso(value: Date | null): string | null;
function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function authorizeRead(context: AdminAuthContext, env?: NodeJS.ProcessEnv): void {
  requireHighRiskAdminCapability(context, "task:manage", env);
}

function taskSummary(row: TaskListRow): TaskSummaryDto {
  return Object.freeze({
    family: row.family,
    taskId: row.task_id,
    taskType: row.task_type,
    status: row.status,
    totalCount: row.total_count,
    successCount: row.success_count,
    failedCount: row.failed_count,
    skippedCount: row.skipped_count,
    errorSummary: row.has_error ? "redacted" : null,
  });
}

export async function listAdminTasks(
  db: PrismaClient,
  context: AdminAuthContext,
  input: { family?: unknown; status?: unknown; limit?: unknown },
  env?: NodeJS.ProcessEnv,
): Promise<{ items: readonly TaskSummaryDto[]; limit: number }> {
  authorizeRead(context, env);
  const family = optionalOneOf(input.family, TASK_FAMILIES);
  const status = optionalOneOf(input.status, TASK_STATUSES);
  const take = limit(input.limit);
  const rows = await db.$queryRaw<TaskListRow[]>(Prisma.sql`
    SELECT * FROM (
      SELECT 'channel_sync'::text AS family, id AS task_id, task_type, status,
        total_count, success_count, failed_count, skipped_count,
        error IS NOT NULL AS has_error, created_at
      FROM channel_sync_task
      WHERE (${family}::text IS NULL OR ${family} = 'channel_sync')
        AND (${status}::text IS NULL OR status = ${status})
      UNION ALL
      SELECT 'generic'::text AS family, id AS task_id, task_type, status,
        total_count, success_count, failed_count, skipped_count,
        error IS NOT NULL AS has_error, created_at
      FROM generic_task
      WHERE (${family}::text IS NULL OR ${family} = 'generic')
        AND (${status}::text IS NULL OR status = ${status})
    ) task_union
    ORDER BY CASE WHEN status IN ('pending', 'processing') THEN 0 ELSE 1 END,
      created_at DESC, task_id DESC
    LIMIT ${take}
  `);
  return Object.freeze({ items: Object.freeze(rows.map(taskSummary)), limit: take });
}

export async function getAdminTaskDetail(
  db: PrismaClient,
  context: AdminAuthContext,
  input: { family: unknown; taskId: unknown },
  env?: NodeJS.ProcessEnv,
): Promise<TaskSummaryDto> {
  authorizeRead(context, env);
  const family = oneOf(input.family, TASK_FAMILIES);
  const taskId = uuid(input.taskId);
  const table = family === "channel_sync"
    ? Prisma.raw("channel_sync_task")
    : Prisma.raw("generic_task");
  const rows = await db.$queryRaw<TaskListRow[]>(Prisma.sql`
    SELECT ${family}::text AS family, id AS task_id, task_type,
      status, total_count, success_count, failed_count,
      skipped_count::int AS skipped_count,
      error IS NOT NULL AS has_error, created_at
    FROM ${table}
    WHERE id = ${taskId}::uuid
  `);
  if (!rows[0]) throw new TaskAdminError("task_admin_not_found", 404);
  return taskSummary(rows[0]);
}

export async function listAdminTaskItems(
  db: PrismaClient,
  context: AdminAuthContext,
  input: { family: unknown; taskId: unknown; status?: unknown; limit?: unknown },
  env?: NodeJS.ProcessEnv,
): Promise<{ family: TaskFamily; taskId: string; items: readonly TaskItemDto[]; limit: number }> {
  authorizeRead(context, env);
  const family = oneOf(input.family, TASK_FAMILIES);
  const taskId = uuid(input.taskId);
  const status = optionalOneOf(input.status, ITEM_STATUSES);
  const take = limit(input.limit);
  const where = { taskId, ...(status ? { status } : {}) };
  let items: TaskItemDto[];
  if (family === "channel_sync") {
    const rows = await db.channelSyncTaskItem.findMany({
      where,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take,
      select: {
        id: true, taskId: true, status: true, attemptCount: true,
        leaseEpoch: true, lockedUntil: true, error: true,
      },
    });
    items = rows.map((row) => Object.freeze({
      family, itemId: row.id, taskId: row.taskId, status: row.status,
      attemptCount: row.attemptCount, leaseEpoch: row.leaseEpoch.toString(),
      lockedUntil: iso(row.lockedUntil), errorSummary: row.error === null ? null : "redacted",
    }));
  } else {
    const rows = await db.genericTaskItem.findMany({
      where,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take,
      select: {
        id: true, taskId: true, status: true, attemptCount: true,
        leaseEpoch: true, lockedUntil: true, error: true,
      },
    });
    items = rows.map((row) => Object.freeze({
      family, itemId: row.id, taskId: row.taskId, status: row.status,
      attemptCount: row.attemptCount, leaseEpoch: row.leaseEpoch.toString(),
      lockedUntil: iso(row.lockedUntil), errorSummary: row.error === null ? null : "redacted",
    }));
  }
  return Object.freeze({ family, taskId, items: Object.freeze(items), limit: take });
}

export async function listAdminPromoLinks(
  db: PrismaClient,
  context: AdminAuthContext,
  input: { status?: unknown; novelId?: unknown; limit?: unknown },
  env?: NodeJS.ProcessEnv,
): Promise<{ items: readonly PromoLinkAdminDto[]; limit: number }> {
  authorizeRead(context, env);
  const status = optionalOneOf(input.status, PROMO_STATUSES);
  const novelId = optionalUuid(input.novelId);
  const take = limit(input.limit);
  const rows = await db.promoLink.findMany({
    where: { deletedAt: null, ...(status ? { status } : {}), ...(novelId ? { novelId } : {}) },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take,
    select: {
      id: true, novelId: true, novelSourceItemId: true, channelAppId: true,
      channelAccountId: true, offerType: true, origin: true,
      publicRedirectCode: true, status: true, errorKind: true, fetchedAt: true,
      expiresAt: true, lastAttemptedAt: true, createdAt: true, updatedAt: true,
    },
  });
  const items = rows.map((row) => Object.freeze({
    promoLinkId: row.id,
    novelId: row.novelId,
    novelSourceItemId: row.novelSourceItemId,
    channelAppId: row.channelAppId,
    channelAccountId: row.channelAccountId,
    offerType: row.offerType,
    origin: row.origin,
    publicRedirectCode: row.publicRedirectCode,
    status: row.status,
    errorKind: row.errorKind,
    fetchedAt: iso(row.fetchedAt),
    expiresAt: iso(row.expiresAt),
    lastAttemptedAt: iso(row.lastAttemptedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }));
  return Object.freeze({ items: Object.freeze(items), limit: take });
}

export async function listManualReviews(
  db: PrismaClient,
  context: AdminAuthContext,
  input: { limit?: unknown },
  env?: NodeJS.ProcessEnv,
): Promise<{ items: readonly ManualReviewDto[]; limit: number }> {
  authorizeRead(context, env);
  const take = limit(input.limit);
  const rows = await db.sideEffectIntent.findMany({
    where: { status: "manual_review_required" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take,
    select: {
      id: true, operationType: true, targetType: true, targetId: true,
      taskItemType: true, taskItemId: true, channelAccountId: true,
      channelAppId: true, promoLinkId: true, status: true, committedAt: true,
      createdAt: true,
    },
  });
  const items = rows.map((row) => Object.freeze({
    intentId: row.id,
    operationType: row.operationType,
    targetType: row.targetType,
    targetId: row.targetId,
    taskItemType: row.taskItemType,
    taskItemId: row.taskItemId,
    channelAccountId: row.channelAccountId,
    channelAppId: row.channelAppId,
    promoLinkId: row.promoLinkId,
    status: "manual_review_required" as const,
    committedAt: iso(row.committedAt),
    createdAt: iso(row.createdAt),
    guidance: GUIDANCE,
  }));
  return Object.freeze({ items: Object.freeze(items), limit: take });
}

async function lockMutationRequest(tx: Prisma.TransactionClient, requestId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      ${MUTATION_REQUEST_LOCK_NAMESPACE}::int,
      hashtext(${requestId})
    )::text AS lock_result
  `);
}

async function lockParent(
  tx: Prisma.TransactionClient,
  family: TaskFamily,
  taskId: string,
): Promise<LockedParentRow | null> {
  let rows: LockedParentRow[];
  if (family === "channel_sync") {
    rows = await tx.$queryRaw(Prisma.sql`
      SELECT id, status, channel_account_id, channel_app_id, task_type, operation_scope_hash, mode, params
      FROM channel_sync_task WHERE id = ${taskId}::uuid FOR UPDATE
    `);
  } else {
    rows = await tx.$queryRaw(Prisma.sql`
      SELECT id, status, channel_account_id, channel_app_id, task_type, operation_scope_hash, mode, params
      FROM generic_task WHERE id = ${taskId}::uuid FOR UPDATE
    `);
  }
  return rows[0] ?? null;
}

async function committedAudit(
  tx: Prisma.TransactionClient,
  action: string,
  requestId: string,
): Promise<AuditRow | null> {
  return tx.operationAudit.findFirst({
    where: { actorType: "admin", action, requestId },
    select: {
      id: true, actorId: true, entityId: true, taskType: true, reason: true,
      afterSnapshot: true,
    },
  });
}

function jsonObject(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, Prisma.JsonValue>
    : null;
}

/** Replay for the unchanged `channel_sync` in-place-reset path. */
function replayInPlaceRetry(
  audit: AuditRow,
  actorId: string,
  family: TaskFamily,
  taskId: string,
  reason: string,
): RetryFailedTaskResult {
  const after = jsonObject(audit.afterSnapshot);
  if (
    audit.actorId !== actorId
    || audit.entityId !== taskId
    || audit.taskType !== family
    || audit.reason !== reason
    || after?.status !== "pending"
    || typeof after.retriedItemCount !== "number"
    || typeof after.totalCount !== "number"
    || typeof after.successCount !== "number"
    || typeof after.failedCount !== "number"
    || typeof after.skippedCount !== "number"
  ) {
    throw new TaskAdminError("task_admin_idempotency_conflict", 409);
  }
  return Object.freeze({
    family,
    taskId,
    originTaskId: null,
    status: "pending",
    retriedItemCount: after.retriedItemCount,
    totalCount: after.totalCount,
    successCount: after.successCount,
    failedCount: after.failedCount,
    skippedCount: after.skippedCount,
    wrote: false,
    auditId: audit.id.toString(),
  });
}

/**
 * Replay for the `generic`-family CPS-parity path (C-7): the committed
 * audit's `entityId` is still the ORIGIN task (the one the operator named
 * in the request), but the actual pending work lives on the sibling task
 * `createGenericRetryTask` created — `after.newTaskId` — so a resubmission
 * of the same `requestId` must resolve back to that same sibling, not to
 * `originTaskId` itself.
 */
function replayGenericRetry(
  audit: AuditRow,
  actorId: string,
  originTaskId: string,
  reason: string,
): RetryFailedTaskResult {
  const after = jsonObject(audit.afterSnapshot);
  if (
    audit.actorId !== actorId
    || audit.entityId !== originTaskId
    || audit.taskType !== "generic"
    || audit.reason !== reason
    || after?.status !== "pending"
    || typeof after.newTaskId !== "string"
    || typeof after.retriedItemCount !== "number"
  ) {
    throw new TaskAdminError("task_admin_idempotency_conflict", 409);
  }
  return Object.freeze({
    family: "generic",
    taskId: after.newTaskId,
    originTaskId,
    status: "pending",
    retriedItemCount: after.retriedItemCount,
    totalCount: after.retriedItemCount,
    successCount: 0,
    failedCount: 0,
    skippedCount: 0,
    wrote: false,
    auditId: audit.id.toString(),
  });
}

type FailedBinding = { id: string; targetId?: string };

async function failedBindings(
  tx: Prisma.TransactionClient,
  family: TaskFamily,
  taskId: string,
): Promise<FailedBinding[]> {
  if (family === "channel_sync") {
    return tx.channelSyncTaskItem.findMany({
      where: { taskId, status: "failed" },
      select: { id: true },
    });
  }
  return tx.genericTaskItem.findMany({
    where: { taskId, status: "failed" },
    select: { id: true, targetId: true },
  });
}

async function hasUnresolvedIntent(
  tx: Prisma.TransactionClient,
  family: TaskFamily,
  parent: LockedParentRow,
  bindings: FailedBinding[],
): Promise<boolean> {
  const itemIds = bindings.map((item) => item.id);
  const linked = await tx.sideEffectIntent.findFirst({
    where: {
      status: { in: [...UNRESOLVED_INTENT_STATUSES] },
      taskItemId: { in: itemIds },
    },
    select: { id: true },
  });
  if (linked) return true;
  if (family !== "generic") return false;
  const targetIds = bindings.flatMap((item) => item.targetId ? [item.targetId] : []);
  if (targetIds.length === 0) return false;
  const rows = await tx.$queryRaw<Array<{ blocked: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM side_effect_intent
      WHERE status = ANY(${[...UNRESOLVED_INTENT_STATUSES]}::text[])
        AND operation_type = 'promo_link.claim_promo'
        AND request_summary->>'novelSourceItemId' = ANY(${targetIds}::text[])
        AND (${parent.channel_account_id}::uuid IS NULL OR channel_account_id = ${parent.channel_account_id}::uuid)
        AND (${parent.channel_app_id}::uuid IS NULL OR channel_app_id = ${parent.channel_app_id}::uuid)
    ) AS blocked
  `);
  return rows[0]?.blocked === true;
}

async function retryItems(
  tx: Prisma.TransactionClient,
  family: TaskFamily,
  taskId: string,
): Promise<number> {
  const data = {
    status: "pending",
    executionToken: null,
    lockedBy: null,
    lockedUntil: null,
    heartbeatAt: null,
    result: Prisma.DbNull,
    error: Prisma.DbNull,
    finishedAt: null,
  } as const;
  if (family === "channel_sync") {
    return (await tx.channelSyncTaskItem.updateMany({
      where: { taskId, status: "failed" }, data,
    })).count;
  }
  return (await tx.genericTaskItem.updateMany({
    where: { taskId, status: "failed" }, data,
  })).count;
}

type ItemCounts = {
  totalCount: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
};

async function recountAndResetParent(
  tx: Prisma.TransactionClient,
  family: TaskFamily,
  taskId: string,
): Promise<ItemCounts> {
  let counts: ItemCounts;
  if (family === "channel_sync") {
    const [totalCount, successCount, failedCount, skippedCount] = await Promise.all([
      tx.channelSyncTaskItem.count({ where: { taskId } }),
      tx.channelSyncTaskItem.count({ where: { taskId, status: "success" } }),
      tx.channelSyncTaskItem.count({ where: { taskId, status: "failed" } }),
      tx.channelSyncTaskItem.count({ where: { taskId, status: "skipped" } }),
    ]);
    counts = { totalCount, successCount, failedCount, skippedCount };
  } else {
    const [totalCount, successCount, failedCount, skippedCount] = await Promise.all([
      tx.genericTaskItem.count({ where: { taskId } }),
      tx.genericTaskItem.count({ where: { taskId, status: "success" } }),
      tx.genericTaskItem.count({ where: { taskId, status: "failed" } }),
      tx.genericTaskItem.count({ where: { taskId, status: "skipped" } }),
    ]);
    counts = { totalCount, successCount, failedCount, skippedCount };
  }
  const data = {
    status: "pending",
    totalCount: counts.totalCount,
    successCount: counts.successCount,
    failedCount: counts.failedCount,
    completedAt: null,
    result: Prisma.DbNull,
    error: Prisma.DbNull,
  } as const;
  if (family === "channel_sync") {
    await tx.channelSyncTask.update({
      where: { id: taskId }, data: { ...data, skippedCount: counts.skippedCount },
    });
  } else {
    await tx.genericTask.update({
      where: { id: taskId }, data: { ...data, skippedCount: counts.skippedCount },
    });
  }
  return counts;
}

type GenericFailedItem = { targetType: string; targetId: string; payload: Prisma.JsonValue };

/**
 * Phase C step C-7: the `generic`-family half of `retryFailedTask`'s CPS
 * parity. Stands up a brand-new `GenericTask` — `originTaskId` pointing
 * back at `parent.id` — carrying only the origin's currently-failed items,
 * each recreated with its original `targetType`/`targetId`/`payload` (the
 * worker's claim path reads `payload` off the item row, not the parent —
 * `src/lib/tasks/store.ts`'s `claimPendingItem` — so copying it verbatim is
 * what makes the sibling task actually reprocessable, not just a DB record).
 * The origin task itself is left untouched: still `failed`/
 * `completed_with_errors`, still holding its own historical counts — CPS
 * parity means a new sibling task, not resetting the origin in place.
 *
 * `generic_task_origin_key` (`@@unique([taskType, originTaskId])`) is the
 * single source of truth against a second concurrent retry of the very same
 * origin task racing in under a different `requestId` (so the `committedAudit`
 * idempotency replay above never sees it): the `genericTask.create` below
 * throws a real Postgres unique-violation in that case, which the caller's
 * `isUniqueConstraintViolation` catch (already wired for the pre-existing
 * active-scope index) maps to the same `task_admin_active_scope_conflict`
 * (409) — no new error taxonomy needed for this negative case.
 */
async function createGenericRetryTask(
  tx: Prisma.TransactionClient,
  parent: LockedParentRow,
  audit: { actorId: string; requestId: string; reason: string },
): Promise<RetryFailedTaskResult> {
  const failedItems: GenericFailedItem[] = await tx.genericTaskItem.findMany({
    where: { taskId: parent.id, status: "failed" },
    select: { targetType: true, targetId: true, payload: true },
  });
  if (failedItems.length === 0) throw new TaskAdminError("task_admin_state_conflict", 409);

  const created = await tx.genericTask.create({
    data: {
      taskType: parent.task_type,
      channelAccountId: parent.channel_account_id,
      channelAppId: parent.channel_app_id,
      operationScopeHash: parent.operation_scope_hash,
      originTaskId: parent.id,
      mode: parent.mode,
      status: "pending",
      requestToken: randomUUID(),
      totalCount: failedItems.length,
      params: (parent.params ?? {}) as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  await tx.genericTaskItem.createMany({
    data: failedItems.map((row) => ({
      taskId: created.id,
      targetType: row.targetType,
      targetId: row.targetId,
      status: "pending",
      payload: (row.payload ?? {}) as Prisma.InputJsonValue,
    })),
  });
  const auditRow = await tx.operationAudit.create({
    data: {
      actorType: "admin",
      actorId: audit.actorId,
      action: TASK_RETRY_AUDIT_ACTION,
      entityType: "Task",
      entityId: parent.id,
      requestId: audit.requestId,
      taskType: "generic",
      taskId: parent.id,
      reason: audit.reason,
      beforeSnapshot: { status: parent.status, failedItemCount: failedItems.length },
      afterSnapshot: {
        status: "pending",
        newTaskId: created.id,
        retriedItemCount: failedItems.length,
      },
    },
    select: { id: true },
  });
  return Object.freeze({
    family: "generic" as const,
    taskId: created.id,
    originTaskId: parent.id,
    status: "pending" as const,
    retriedItemCount: failedItems.length,
    totalCount: failedItems.length,
    successCount: 0,
    failedCount: 0,
    skippedCount: 0,
    wrote: true,
    auditId: auditRow.id.toString(),
  });
}

export async function retryFailedTask(
  input: {
    authorization: AdminServiceAuthorization;
    requestId: string;
    family: unknown;
    taskId: unknown;
    reason: unknown;
  },
  dependencies: TaskAdminMutationDependencies,
): Promise<RetryFailedTaskResult> {
  const context = await requireFreshAdminServiceMutation(input.authorization, "task:manage", {
    identities: dependencies.identities,
    sessions: dependencies.sessions,
    entryId: TASK_RETRY_ENTRY_ID,
    requestId: input.requestId,
    env: dependencies.env,
    now: dependencies.now,
  });
  const family = oneOf(input.family, TASK_FAMILIES);
  const taskId = uuid(input.taskId);
  const reason = boundedText(input.reason, 2_000);

  try {
    return await withDbRetry(
      () => dependencies.db.$transaction(async (tx) => {
        await lockMutationRequest(tx, input.requestId);
        const parent = await lockParent(tx, family, taskId);
        if (!parent) throw new TaskAdminError("task_admin_not_found", 404);

        const prior = await committedAudit(tx, TASK_RETRY_AUDIT_ACTION, input.requestId);
        if (prior) {
          return family === "generic"
            ? replayGenericRetry(prior, context.identity.id, taskId, reason)
            : replayInPlaceRetry(prior, context.identity.id, family, taskId, reason);
        }
        if (!RETRYABLE_PARENT_STATUSES.has(parent.status)) {
          throw new TaskAdminError("task_admin_state_conflict", 409);
        }

        const bindings = await failedBindings(tx, family, taskId);
        if (bindings.length === 0) throw new TaskAdminError("task_admin_state_conflict", 409);
        if (await hasUnresolvedIntent(tx, family, parent, bindings)) {
          throw new TaskAdminError("task_admin_unresolved_intent", 409);
        }

        if (family === "generic") {
          return await createGenericRetryTask(tx, parent, {
            actorId: context.identity.id,
            requestId: input.requestId,
            reason,
          });
        }

        // `channel_sync` keeps the pre-C-7 in-place-reset semantics
        // unchanged (see the work order's "不改 ChannelSyncTask/Item 结构" —
        // there is no `originTaskId` column to link a sibling task to).
        const retriedItemCount = await retryItems(tx, family, taskId);
        if (retriedItemCount !== bindings.length) {
          throw new TaskAdminError("task_admin_concurrent_write", 409);
        }
        const counts = await recountAndResetParent(tx, family, taskId);
        const auditRow = await tx.operationAudit.create({
          data: {
            actorType: "admin",
            actorId: context.identity.id,
            action: TASK_RETRY_AUDIT_ACTION,
            entityType: "Task",
            entityId: taskId,
            requestId: input.requestId,
            taskType: family,
            taskId,
            reason,
            beforeSnapshot: { status: parent.status, failedItemCount: bindings.length },
            afterSnapshot: {
              status: "pending",
              retriedItemCount,
              ...counts,
            },
          },
          select: { id: true },
        });
        return Object.freeze({
          family,
          taskId,
          originTaskId: null,
          status: "pending" as const,
          retriedItemCount,
          ...counts,
          wrote: true,
          auditId: auditRow.id.toString(),
        });
      }),
      { op: "task-admin.retryFailedTask", itemId: taskId, idempotencyKey: input.requestId },
    );
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      throw new TaskAdminError("task_admin_active_scope_conflict", 409);
    }
    throw error;
  }
}

function manualReplay(
  audit: AuditRow,
  actorId: string,
  intentId: string,
  reason: string,
  resolution: ManualResolution,
): ManualReviewResolutionResult {
  const after = jsonObject(audit.afterSnapshot);
  const expectedStatus = resolution === "effect_confirmed" ? "confirmed" : "failed";
  if (
    audit.actorId !== actorId
    || audit.entityId !== intentId
    || audit.reason !== reason
    || after?.resolution !== resolution
    || after.status !== expectedStatus
    || typeof after.resolvedAt !== "string"
  ) {
    throw new TaskAdminError("task_admin_idempotency_conflict", 409);
  }
  return Object.freeze({
    intentId,
    resolution,
    status: expectedStatus,
    resolvedAt: after.resolvedAt,
    ...GUIDANCE,
    wrote: false,
    auditId: audit.id.toString(),
  });
}

export async function resolveManualReview(
  input: {
    authorization: AdminServiceAuthorization;
    requestId: string;
    intentId: unknown;
    resolution: unknown;
    reason: unknown;
  },
  dependencies: TaskAdminMutationDependencies,
): Promise<ManualReviewResolutionResult> {
  const context = await requireFreshAdminServiceMutation(input.authorization, "task:manage", {
    identities: dependencies.identities,
    sessions: dependencies.sessions,
    entryId: MANUAL_REVIEW_RESOLVE_ENTRY_ID,
    requestId: input.requestId,
    env: dependencies.env,
    now: dependencies.now,
  });
  const intentId = uuid(input.intentId);
  const resolution = oneOf(input.resolution, ["effect_confirmed", "no_effect_confirmed"] as const);
  const reason = boundedText(input.reason, 2_000);
  const status = resolution === "effect_confirmed" ? "confirmed" as const : "failed" as const;
  const now = dependencies.now ?? new Date();

  return withDbRetry(
    () => dependencies.db.$transaction(async (tx) => {
      await lockMutationRequest(tx, input.requestId);
      const prior = await committedAudit(tx, MANUAL_REVIEW_AUDIT_ACTION, input.requestId);
      if (prior) return manualReplay(prior, context.identity.id, intentId, reason, resolution);

      const intent = await tx.sideEffectIntent.findUnique({
        where: { id: intentId },
        select: { id: true, status: true, responseShape: true },
      });
      if (!intent) throw new TaskAdminError("task_admin_not_found", 404);
      if (intent.status !== "manual_review_required") {
        throw new TaskAdminError("task_admin_state_conflict", 409);
      }
      const previousShape = jsonObject(intent.responseShape);
      const responseShape: Prisma.InputJsonObject = {
        ...(previousShape ?? {}),
        manualResolution: resolution,
        resolvedBy: context.identity.id,
        resolvedAt: now.toISOString(),
      };
      const changed = await tx.sideEffectIntent.updateMany({
        where: { id: intentId, status: "manual_review_required" },
        data: { status, responseShape, confirmedAt: now },
      });
      if (changed.count !== 1) {
        throw new TaskAdminError("task_admin_concurrent_write", 409);
      }
      const audit = await tx.operationAudit.create({
        data: {
          actorType: "admin",
          actorId: context.identity.id,
          action: MANUAL_REVIEW_AUDIT_ACTION,
          entityType: "SideEffectIntent",
          entityId: intentId,
          requestId: input.requestId,
          reason,
          beforeSnapshot: { status: "manual_review_required" },
          afterSnapshot: {
            status,
            resolution,
            resolvedAt: now.toISOString(),
            automaticReconciliation: false,
            nextActions: GUIDANCE.nextActions,
          },
        },
        select: { id: true },
      });
      return Object.freeze({
        intentId,
        resolution,
        status,
        resolvedAt: now.toISOString(),
        ...GUIDANCE,
        wrote: true,
        auditId: audit.id.toString(),
      });
    }),
    { op: "task-admin.resolveManualReview", itemId: intentId, idempotencyKey: input.requestId },
  );
}
