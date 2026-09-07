import { Prisma, type PrismaClient } from "@prisma/client";

import {
  requireHighRiskAdminCapability,
  type AdminAuthContext,
  type AdminIdentityStore,
  type SessionStore,
} from "@/lib/auth";
import { isUniqueConstraintViolation, withDbRetry } from "@/lib/db/db-retry";
import { MOBOREADER_TASK_TYPES, type TaskFamily } from "@/lib/tasks";
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
  /**
   * C-10 (Phase E rework, 2026-09-07): the task's own stable stop-reason
   * code (e.g. `"upstream_error"`), read from `result.stopReason` — never
   * the raw `result`/`error` blob the "X9 read DTO allowlists" contract
   * test (`tests/backend/task-admin/read-contracts.test.ts`) forbids this
   * projection from leaking. Optional and only present when the task
   * actually has one, from a fixed enum (`CATALOG_SCAN_STOP_REASONS`
   * below) — never free text. Absent (not `null`) when there is none, so
   * every pre-existing `toEqual` fixture in that contract test still
   * matches without modification.
   */
  stopReason?: string;
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
  /**
   * C-10: the *origin* failed item's derived stop reason, e.g.
   * `"upstream_error (HTTP 401) @ 第 1 页"` — built from the item's own
   * `error.code` (only ever surfaced when it is exactly `"upstream_error"`)
   * plus the numeric `error.detail.httpStatus` / `error.detail.pageIndex`
   * `sanitizePersistedTaskError` (`src/lib/tasks/errors.ts`) already
   * allowlisted before persistence. A cascaded item (`result.stoppedBeforeFetch
   * === true`, set by `persistCatalogUpstreamFailure` in
   * `worker/handlers/moboreader.ts`) never gets one — only the one item that
   * actually hit the upstream failure does. Optional for the same
   * frozen-contract-test reason as `TaskSummaryDto.stopReason` above.
   */
  stopReason?: string;
  /**
   * C-9 (task-detail route, Phase E rework, 2026-09-07): a catalog-scan
   * item's page number, e.g. `5` — derived from `GenericTaskItem.targetId`
   * (the page index, stored as text) only when `targetType` is exactly
   * `"catalog_page"`, and only after re-parsing it as a positive integer.
   * Deliberately never named `targetId`/`pageIndex` — both are on the "X9
   * read DTO allowlists" contract test's forbidden-key list this file's
   * other derived fields already respect; this is a distinctly-named,
   * re-validated value, the same discipline as `stopReason` above, not a
   * raw pass-through of the target identifier. Absent for every other
   * item (channel_sync items have no `targetId` at all).
   */
  pageNumber?: number;
}>;

/**
 * The finite set of `GenericTaskItem.result.stopReason` / `GenericTask.
 * result.stopReason` values this codebase's catalog-scan handler
 * (`worker/handlers/moboreader.ts`) ever writes — see the identical literal
 * array in `src/lib/tasks/store.ts`'s `finalizeTaskItem`. Read back here as
 * an explicit allowlist (not a blind pass-through of whatever string is in
 * the JSONB column) so a future handler bug can never smuggle free text
 * into this admin-read projection through `result.stopReason`.
 */
const CATALOG_SCAN_STOP_REASONS = new Set([
  "expected_total_reached",
  "expected_pages_reached",
  "empty_page",
  "short_page",
  "safety_limit",
  "upstream_error",
]);

function jsonPlainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Task-level derived stop reason for the tasks-list "失败原因" column — a bare
 * stable code, e.g. `"upstream_error"`.
 *
 * C-10b (Phase E rework, 2026-09-07): eligibility is `hasError === true` OR
 * `status === "failed"` OR `status === "completed_with_errors"` (the two
 * terminal-with-failure members of `TASK_STATUSES`,
 * `src/domain/database-statuses.ts`) — not `hasError` alone. A
 * `completed_with_errors` catalog_scan task can finish with `error IS NULL`
 * (only `result.stopReason` records why it stopped short), so gating on
 * `hasError` alone withheld a real, well-formed stop reason. `completed`/
 * `pending`/`processing`/`disabled` with `hasError === false` are still
 * withheld — this only widens the two already-failure-shaped statuses.
 */
function deriveTaskStopReason(status: string, hasError: boolean, result: unknown): string | undefined {
  const eligible = hasError || status === "failed" || status === "completed_with_errors";
  if (!eligible) return undefined;
  const stopReason = jsonPlainObject(result)?.stopReason;
  return typeof stopReason === "string" && CATALOG_SCAN_STOP_REASONS.has(stopReason)
    ? stopReason
    : undefined;
}

/**
 * Item-level derived stop reason for the task-detail panel's "停止原因"
 * line — only for the *origin* failed item (not a cascaded
 * `stoppedBeforeFetch` item), and only for the `"upstream_error"` contract
 * code, the sole case C-10 covers. `httpStatus`/`pageIndex` are read only
 * as `number`, never interpolated as free text.
 */
function deriveItemStopReason(status: string, result: unknown, error: unknown): string | undefined {
  if (status !== "failed") return undefined;
  const resultObject = jsonPlainObject(result);
  if (!resultObject || resultObject.stoppedBeforeFetch === true) return undefined;
  const errorObject = jsonPlainObject(error);
  const code = errorObject?.code;
  if (typeof code !== "string" || !CATALOG_SCAN_STOP_REASONS.has(code)) return undefined;
  const detail = jsonPlainObject(errorObject?.detail);
  const httpStatus = detail?.httpStatus;
  const pageIndex = detail?.pageIndex;
  const statusPart = typeof httpStatus === "number" ? ` (HTTP ${httpStatus})` : "";
  const pagePart = typeof pageIndex === "number" ? ` @ 第 ${pageIndex} 页` : "";
  return `${code}${statusPart}${pagePart}`;
}

/**
 * C-9: `GenericTaskItem.targetId` is the page index encoded as text — see
 * `TaskItemDto.pageNumber`'s doc comment above for why this is re-validated
 * (never a raw pass-through) and never surfaced under a `targetId`/
 * `pageIndex` key.
 */
function derivePageNumber(targetType: string | undefined, targetId: string | undefined): number | undefined {
  if (targetType !== "catalog_page" || targetId === undefined) return undefined;
  const parsed = Number(targetId);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

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

export type RetryFailedTaskResult = Readonly<{
  family: TaskFamily;
  taskId: string;
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
  /** C-10: read only to derive `TaskSummaryDto.stopReason` — never itself exposed. */
  result: Prisma.JsonValue | null;
  /**
   * C-9 (task-detail route): the four fields below are only ever selected by
   * `getAdminTaskDetail`'s own query — `listAdminTasks`'s query never adds
   * them to its SELECT list, so they stay `undefined` there and every
   * pre-existing `listAdminTasks` fixture (including the "X9 read DTO
   * allowlists" contract test's poisoned rows) is unaffected. `params` is
   * read only to derive `TaskDetailDto.catalogScanConfig` — never itself
   * exposed, same discipline as `result` above.
   */
  updated_at?: Date;
  mode?: string;
  channel_account_id?: string | null;
  params?: Prisma.JsonValue | null;
};

type LockedParentRow = {
  id: string;
  status: string;
  channel_account_id: string | null;
  channel_app_id: string | null;
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

function pageNumberInput(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return invalid();
  return parsed;
}

function optionalPageNumberInput(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  return pageNumberInput(value);
}

/**
 * C-9 (task-detail route, Phase E rework, 2026-09-07): CPS-style
 * task-configuration summary for `/tasks/[id]`, extracted field by field
 * from `GenericTask.params` — the raw blob itself never leaves this
 * function (`params` stays on the "X9 read DTO allowlists" contract test's
 * FORBIDDEN_KEYS list; this returns a curated, individually re-typed
 * subset, the same discipline `deriveTaskStopReason`/`deriveItemStopReason`
 * already apply to `result`/`error`). Only ever populated for a
 * `catalog_scan` task — every other taskType's `params` shape is out of
 * scope for this work order.
 */
export type CatalogScanConfigDto = Readonly<{
  pageStart?: number;
  pageEnd?: number;
  pageSize?: number;
  safetyMaxPages?: number;
  languages?: readonly string[];
  source?: "manual";
  requestId?: string;
}>;

function deriveCatalogScanConfig(taskType: string, params: unknown): CatalogScanConfigDto | undefined {
  if (taskType !== MOBOREADER_TASK_TYPES.catalogScan) return undefined;
  const paramsObject = jsonPlainObject(params);
  if (!paramsObject) return undefined;
  const pageStart = typeof paramsObject.pageStart === "number" ? paramsObject.pageStart : undefined;
  const pageEnd = typeof paramsObject.pageEnd === "number" ? paramsObject.pageEnd : undefined;
  const pageSize = typeof paramsObject.pageSize === "number" ? paramsObject.pageSize : undefined;
  const safetyMaxPages = typeof paramsObject.safetyMaxPages === "number" ? paramsObject.safetyMaxPages : undefined;
  const requestId = typeof paramsObject.requestId === "string" ? paramsObject.requestId.slice(0, 200) : undefined;
  const source = paramsObject.source === "manual" ? "manual" as const : undefined;
  const languagesRaw = paramsObject.languages;
  // `sanitizeLanguageList` (`src/lib/tasks/moboreader.ts`) already dedupes
  // before writing `params.languages` — re-deduping here too is cheap
  // defense-in-depth against a future writer regressing that guarantee,
  // not a correction of anything this codebase's own writer currently does.
  const languages = Array.isArray(languagesRaw)
    ? Object.freeze(Array.from(new Set(
        languagesRaw.filter((value): value is string => typeof value === "string"),
      )).slice(0, 64))
    : undefined;
  if (
    pageStart === undefined && pageEnd === undefined && pageSize === undefined
    && safetyMaxPages === undefined && requestId === undefined && source === undefined
    && (languages === undefined || languages.length === 0)
  ) {
    return undefined;
  }
  return Object.freeze({ pageStart, pageEnd, pageSize, safetyMaxPages, requestId, source, languages });
}

/**
 * C-9: CPS-style catalog-scan audit summary — 上游返回 total / 实际抓取条数 /
 * 最后一页 — derived only from the task's own `result` JSON, never a
 * pass-through. `observedTotal`/`actualFetchedCount` reuse the exact
 * aggregates `persistCatalogPage`/`persistCatalogUpstreamFailure`
 * (`worker/handlers/moboreader.ts`) already computed and stored
 * (`catalogObservedTotal`, the SQL-summed `batchActualCount`) rather than
 * re-deriving a `Σ returnedCount` scan over every item here.
 * `lastCompletedPage` reuses the worker's own `result.checkpoint.
 * lastCompletedPage` (set on every successful page, carried forward through
 * a later failure) as "the max page actually fetched". Only ever populated
 * for a `catalog_scan` task.
 */
export type CatalogScanAuditDto = Readonly<{
  observedTotal?: number;
  actualFetchedCount?: number;
  lastCompletedPage?: number;
}>;

function deriveCatalogScanAudit(taskType: string, result: unknown): CatalogScanAuditDto | undefined {
  if (taskType !== MOBOREADER_TASK_TYPES.catalogScan) return undefined;
  const resultObject = jsonPlainObject(result);
  if (!resultObject) return undefined;
  const observedTotal = typeof resultObject.catalogObservedTotal === "number"
    ? resultObject.catalogObservedTotal
    : undefined;
  const actualFetchedCount = typeof resultObject.batchActualCount === "number"
    ? resultObject.batchActualCount
    : undefined;
  const checkpoint = jsonPlainObject(resultObject.checkpoint);
  const lastCompletedPageRaw = checkpoint?.lastCompletedPage;
  const lastCompletedPage = typeof lastCompletedPageRaw === "number" && Number.isSafeInteger(lastCompletedPageRaw)
    ? lastCompletedPageRaw
    : undefined;
  if (observedTotal === undefined && actualFetchedCount === undefined && lastCompletedPage === undefined) {
    return undefined;
  }
  return Object.freeze({ observedTotal, actualFetchedCount, lastCompletedPage });
}

/**
 * C-9: `getAdminTaskDetail`'s richer return shape — every added field is
 * additive/optional on top of `TaskSummaryDto`, so every existing caller
 * that only knows about `TaskSummaryDto` keeps compiling and every existing
 * `listAdminTasks`/`taskSummary` fixture is untouched (this type is never
 * produced by `listAdminTasks`).
 */
export type TaskDetailDto = TaskSummaryDto & Readonly<{
  mode?: string;
  channelAccountId?: string;
  createdAt?: string;
  updatedAt?: string;
  catalogScanConfig?: CatalogScanConfigDto;
  catalogScanAudit?: CatalogScanAuditDto;
  /**
   * C-10b: the *origin* failed item's richer derived stop-reason line (e.g.
   * `"upstream_error (HTTP 401) @ 第 1 页"`, the same `deriveItemStopReason`
   * output `TaskItemDto.stopReason` uses) — read via one extra query in
   * `getAdminTaskDetail` itself, so it is always available regardless of
   * which items page happens to be currently loaded (unlike the per-item
   * `TaskItemDto.stopReason`, which only exists for whichever row is on the
   * loaded page). Only ever populated for a `family === "generic"` task
   * whose `taskType` is `MOBOREADER_TASK_TYPES.catalogScan`; every other
   * task leaves this absent and pays no extra query. Never the raw
   * `error`/`result` blob — same allowlisted-derivation discipline as every
   * other field here.
   */
  originStopReason?: string;
}>;

function taskSummary(row: TaskListRow): TaskSummaryDto {
  const stopReason = deriveTaskStopReason(row.status, row.has_error, row.result);
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
    ...(stopReason !== undefined ? { stopReason } : {}),
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
        error IS NOT NULL AS has_error, created_at, result
      FROM channel_sync_task
      WHERE (${family}::text IS NULL OR ${family} = 'channel_sync')
        AND (${status}::text IS NULL OR status = ${status})
      UNION ALL
      SELECT 'generic'::text AS family, id AS task_id, task_type, status,
        total_count, success_count, failed_count, skipped_count,
        error IS NOT NULL AS has_error, created_at, result
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

type OriginTaskItemRow = {
  status: string;
  result: Prisma.JsonValue | null;
  error: Prisma.JsonValue | null;
};

/**
 * C-10b: the *origin* catalog_scan item — the one `catalog_page` item that
 * actually hit the upstream failure, as opposed to every later page the
 * worker cascaded to `failed` with `result.stoppedBeforeFetch === true`
 * (`persistCatalogUpstreamFailure`, `worker/handlers/moboreader.ts`) without
 * ever attempting them. Ordered by `target_id` (the page index, stored as
 * text) cast to int ascending, so the earliest page — the one that was
 * actually fetched and failed — sorts first even though `target_id` is a
 * VARCHAR column. Never called for a non-catalog_scan task (see the
 * `family`/`taskType` guard at the call site in `getAdminTaskDetail`).
 */
async function deriveOriginStopReason(db: PrismaClient, taskId: string): Promise<string | undefined> {
  const rows = await db.$queryRaw<OriginTaskItemRow[]>(Prisma.sql`
    SELECT status, result, error FROM generic_task_item
    WHERE task_id = ${taskId}::uuid
      AND target_type = 'catalog_page'
      AND status = 'failed'
      AND COALESCE(result->>'stoppedBeforeFetch', 'false') <> 'true'
    ORDER BY (target_id)::int ASC
    LIMIT 1
  `);
  const origin = rows[0];
  return origin ? deriveItemStopReason(origin.status, origin.result, origin.error) : undefined;
}

export async function getAdminTaskDetail(
  db: PrismaClient,
  context: AdminAuthContext,
  input: { family: unknown; taskId: unknown },
  env?: NodeJS.ProcessEnv,
): Promise<TaskDetailDto> {
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
      error IS NOT NULL AS has_error, created_at, updated_at,
      mode, channel_account_id, params, result
    FROM ${table}
    WHERE id = ${taskId}::uuid
  `);
  const row = rows[0];
  if (!row) throw new TaskAdminError("task_admin_not_found", 404);
  const catalogScanConfig = deriveCatalogScanConfig(row.task_type, row.params);
  const catalogScanAudit = deriveCatalogScanAudit(row.task_type, row.result);
  const originStopReason = family === "generic" && row.task_type === MOBOREADER_TASK_TYPES.catalogScan
    ? await deriveOriginStopReason(db, taskId)
    : undefined;
  return Object.freeze({
    ...taskSummary(row),
    ...(row.mode !== undefined ? { mode: row.mode } : {}),
    ...(row.channel_account_id ? { channelAccountId: row.channel_account_id } : {}),
    createdAt: iso(row.created_at),
    ...(row.updated_at ? { updatedAt: iso(row.updated_at) } : {}),
    ...(catalogScanConfig ? { catalogScanConfig } : {}),
    ...(catalogScanAudit ? { catalogScanAudit } : {}),
    ...(originStopReason !== undefined ? { originStopReason } : {}),
  });
}

export async function listAdminTaskItems(
  db: PrismaClient,
  context: AdminAuthContext,
  input: { family: unknown; taskId: unknown; status?: unknown; limit?: unknown; page?: unknown },
  env?: NodeJS.ProcessEnv,
): Promise<{
  family: TaskFamily;
  taskId: string;
  items: readonly TaskItemDto[];
  limit: number;
  /**
   * C-9 (task-detail route): `page`/`pageSize`/`total`/`totalPages` are
   * populated only when the caller passes `page` — the pre-existing
   * flat-`limit` callers (the old same-page panel, `/api/admin/tasks/items`)
   * never do, so this stays absent for them, byte-identical to the prior
   * return shape. Same `{page,total,totalPages}` field names as
   * `AdminContentPage<T>` (`src/domain/admin-content.ts`) so the detail
   * page can reuse the existing `ContentPagination` component verbatim.
   */
  page?: number;
  pageSize?: number;
  total?: number;
  totalPages?: number;
}> {
  authorizeRead(context, env);
  const family = oneOf(input.family, TASK_FAMILIES);
  const taskId = uuid(input.taskId);
  const status = optionalOneOf(input.status, ITEM_STATUSES);
  const take = limit(input.limit);
  const page = optionalPageNumberInput(input.page);
  const skip = page !== undefined ? (page - 1) * take : undefined;
  const where = { taskId, ...(status ? { status } : {}) };
  let items: TaskItemDto[];
  let total: number | undefined;
  if (family === "channel_sync") {
    const [rows, count] = await Promise.all([
      db.channelSyncTaskItem.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        ...(skip !== undefined ? { skip } : {}),
        take,
        select: {
          id: true, taskId: true, status: true, attemptCount: true,
          leaseEpoch: true, lockedUntil: true, error: true, result: true,
        },
      }),
      page !== undefined ? db.channelSyncTaskItem.count({ where }) : Promise.resolve(undefined),
    ]);
    total = count;
    items = rows.map((row) => {
      const stopReason = deriveItemStopReason(row.status, row.result, row.error);
      return Object.freeze({
        family, itemId: row.id, taskId: row.taskId, status: row.status,
        attemptCount: row.attemptCount, leaseEpoch: row.leaseEpoch.toString(),
        lockedUntil: iso(row.lockedUntil), errorSummary: row.error === null ? null : "redacted",
        ...(stopReason !== undefined ? { stopReason } : {}),
      });
    });
  } else {
    const [rows, count] = await Promise.all([
      db.genericTaskItem.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        ...(skip !== undefined ? { skip } : {}),
        take,
        select: {
          id: true, taskId: true, status: true, attemptCount: true,
          leaseEpoch: true, lockedUntil: true, error: true, result: true,
          targetType: true, targetId: true,
        },
      }),
      page !== undefined ? db.genericTaskItem.count({ where }) : Promise.resolve(undefined),
    ]);
    total = count;
    items = rows.map((row) => {
      const stopReason = deriveItemStopReason(row.status, row.result, row.error);
      const pageNumber = derivePageNumber(row.targetType, row.targetId);
      return Object.freeze({
        family, itemId: row.id, taskId: row.taskId, status: row.status,
        attemptCount: row.attemptCount, leaseEpoch: row.leaseEpoch.toString(),
        lockedUntil: iso(row.lockedUntil), errorSummary: row.error === null ? null : "redacted",
        ...(stopReason !== undefined ? { stopReason } : {}),
        ...(pageNumber !== undefined ? { pageNumber } : {}),
      });
    });
  }
  return Object.freeze({
    family,
    taskId,
    items: Object.freeze(items),
    limit: take,
    ...(page !== undefined ? {
      page,
      pageSize: take,
      total: total ?? 0,
      totalPages: Math.ceil((total ?? 0) / take),
    } : {}),
  });
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
      SELECT id, status, channel_account_id, channel_app_id
      FROM channel_sync_task WHERE id = ${taskId}::uuid FOR UPDATE
    `);
  } else {
    rows = await tx.$queryRaw(Prisma.sql`
      SELECT id, status, channel_account_id, channel_app_id
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

function replayRetry(
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
        if (prior) return replayRetry(prior, context.identity.id, family, taskId, reason);
        if (!RETRYABLE_PARENT_STATUSES.has(parent.status)) {
          throw new TaskAdminError("task_admin_state_conflict", 409);
        }

        const bindings = await failedBindings(tx, family, taskId);
        if (bindings.length === 0) throw new TaskAdminError("task_admin_state_conflict", 409);
        if (await hasUnresolvedIntent(tx, family, parent, bindings)) {
          throw new TaskAdminError("task_admin_unresolved_intent", 409);
        }

        const retriedItemCount = await retryItems(tx, family, taskId);
        if (retriedItemCount !== bindings.length) {
          throw new TaskAdminError("task_admin_concurrent_write", 409);
        }
        const counts = await recountAndResetParent(tx, family, taskId);
        const audit = await tx.operationAudit.create({
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
          status: "pending" as const,
          retriedItemCount,
          ...counts,
          wrote: true,
          auditId: audit.id.toString(),
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
