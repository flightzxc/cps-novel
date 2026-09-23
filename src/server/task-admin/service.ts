import { Prisma, type PrismaClient } from "@prisma/client";

import {
  requireHighRiskAdminCapability,
  type AdminAuthContext,
  type AdminIdentityStore,
  type SessionStore,
} from "@/lib/auth";
import { chunkIds } from "@/lib/db/chunked-id-lookup";
import { isUniqueConstraintViolation, withDbRetry } from "@/lib/db/db-retry";
import {
  CATALOG_BATCH_TASK_TYPE,
  catalogFinalizeGeneration,
  isLifecycleBatchParams,
  isLifecycleShardParams,
  MOBOREADER_CATALOG_FINALIZE_TARGET_ID,
  MOBOREADER_CATALOG_TARGET_TYPES,
  MOBOREADER_TASK_TYPES,
  PARENT_BATCH_TASK_TYPES,
  PROMO_CLAIM_LIFECYCLE_DEFAULTS,
  PROMO_LINK_CLAIM_TASK_TYPE,
  abortPromoClaimBatchTx,
  isParentBatchTaskType,
  mergeTaskControlResult,
  pausePromoClaimBatchTx,
  reapprovePromoClaimBatchTx,
  readTaskControlMarker,
  resolvePromoClaimLifecycleConfig,
  resumePromoClaimBatchTx,
  terminatePendingTaskItems,
  type PromoClaimBatchControlError,
  type TaskControlMarker,
  type TaskFamily,
} from "@/lib/tasks";
import {
  ARTICLE_GENERATE_BATCH_TASK_TYPE,
  ARTICLE_GENERATE_BATCH_TASK_TYPE_V2,
  ARTICLE_GENERATE_TASK_TYPE,
} from "@/lib/tasks/article-generate";
import { resolveClaimCredentialAdmission } from "@/lib/credentials/claim-readiness";
import type { ArticleGenerateBlockedReason } from "@/domain/article-generation";
import { TASK_ITEM_STATUSES, TASK_STATUSES } from "@/domain/database-statuses";
import {
  deriveCatalogBatchPhase,
  derivePromoClaimBatchCounts,
  estimatePromoClaimBatchEtaMinutes,
  type PromoClaimBatchLifecycleDto,
  type PromoClaimShardSummaryDto,
} from "@/domain/catalog-batch";
import {
  requireFreshAdminServiceMutation,
  type AdminServiceAuthorization,
} from "@/server/auth/guards";

import { projectSafeTaskFailure, type SafeTaskFailureDto } from "./safe-task-error";

export const TASK_RETRY_ENTRY_ID = "admin.api.task.retry_failed";
export const CATALOG_FINALIZE_RETRY_ENTRY_ID = "admin.api.task.retry_catalog_finalize";
export const MANUAL_REVIEW_RESOLVE_ENTRY_ID = "admin.api.task.manual_review.resolve";
export const TASK_RETRY_AUDIT_ACTION = "task.retry_failed";
export const CATALOG_FINALIZE_RETRY_AUDIT_ACTION = "moboreader.catalog_finalize.retry_requested";
export const MANUAL_REVIEW_AUDIT_ACTION = "side_effect_intent.manual_resolve";
export const TASK_PAUSE_ENTRY_ID = "admin.api.task.pause";
export const TASK_RESUME_ENTRY_ID = "admin.api.task.resume";
export const TASK_ABORT_ENTRY_ID = "admin.api.task.abort";
export const TASK_PAUSE_AUDIT_ACTION = "task.pause";
export const TASK_RESUME_AUDIT_ACTION = "task.resume";
export const TASK_ABORT_AUDIT_ACTION = "task.abort";
/** `terminatePendingTaskItems`'s reason code for items cascaded by a manual abort — distinct from `task_system_hold` (the worker's own halt) so the two are never confused when reading an item's own `error.code`. */
export const TASK_ABORT_TERMINATION_REASON = "task_manually_aborted";

// 阶段2 第4步（施工任务 3.1/3.3）：批次级暂停/恢复/中止/重新批准。这四个
// 动作只对生命周期批次（`lifecycleVersion === 1 && lifecycleRole ===
// "batch"`）生效，级联到它名下的分片——与上面单任务的 pause/resume/abort
// 完全独立的一组 entry id / audit action，绝不复用 `task.pause` 等字面量，
// 这样一次幂等重放的 `committedAudit` 查询不会在两组语义之间互相误判。
export const PROMO_CLAIM_BATCH_PAUSE_ENTRY_ID = "admin.api.promo_claim_batch.pause";
export const PROMO_CLAIM_BATCH_RESUME_ENTRY_ID = "admin.api.promo_claim_batch.resume";
export const PROMO_CLAIM_BATCH_ABORT_ENTRY_ID = "admin.api.promo_claim_batch.abort";
export const PROMO_CLAIM_BATCH_REAPPROVE_ENTRY_ID = "admin.api.promo_claim_batch.reapprove";
export const PROMO_CLAIM_BATCH_PAUSE_AUDIT_ACTION = "promo_claim_batch.pause";
export const PROMO_CLAIM_BATCH_RESUME_AUDIT_ACTION = "promo_claim_batch.resume";
export const PROMO_CLAIM_BATCH_ABORT_AUDIT_ACTION = "promo_claim_batch.abort";
export const PROMO_CLAIM_BATCH_REAPPROVE_AUDIT_ACTION = "promo_claim_batch.reapprove";

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
  | "task_admin_active_scope_conflict"
  /**
   * X10 task control (pause/resume/abort): `resumeTask` re-validated a
   * taskType's own precondition (currently only `promo_link.claim.v1`'s
   * credential admission check) and it still refuses right now. Distinct
   * from `task_admin_state_conflict` — the task's own status/marker were
   * exactly right for a resume attempt; it is some *external* fact (the
   * credential) that is not, and the operator's remediation is different
   * ("go fix the credential", not "refresh, this button should not have
   * been enabled").
   */
  | "task_admin_precondition_failed";

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
  failure?: SafeTaskFailureDto;
  articleAdmission?: Readonly<{
    selectedCount: number;
    submittedCount: number;
    blockedCount: number;
    blockedReasonCounts: Readonly<Partial<Record<ArticleGenerateBlockedReason, number>>>;
  }>;
  catalogBatch?: Readonly<{
    phase: "queued" | "disabled" | "paused" | "cancelled" | "materializing" | "executing" | "completed" | "completed_with_errors" | "failed" | "expired";
    submittedCount: number | null;
    ineligibleCount: number | null;
    alreadyLinkedCount?: number | null;
    blockedCount?: number;
    blockedReasonCounts?: Readonly<Record<string, number>>;
    childTasks?: readonly Readonly<{ taskId: string; taskType: string; status: string }>[];
    /**
     * 阶段2 第4步（施工任务 3.5）：只对生命周期批次（`lifecycleVersion === 1
     * && lifecycleRole === "batch"` 的 `batch.materialize.v1`）填充——分片
     * 列表、领取统计、预计完成时间。旧路径批次（`novel_materialize`/
     * `article.generate.*`/开关关闭时的 `promo_claim`）继续只用上面的
     * `childTasks`，这个字段始终缺失，不是空对象。
     */
    promoClaimLifecycle?: PromoClaimBatchLifecycleDto;
  }>;
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
  /**
   * C-12 (`施工工单_C12_目录任务计量口径改为本_2026-09-07.md`): for a
   * `catalog_scan` task, the operator-facing "本" (book) counts —
   * `totalCount`/`successCount`/`failedCount` above stay page-denominated
   * (Phase C's frozen task shape, one item = one page, is unchanged), but an
   * operator reading "总计 6000 / 成功 355" cannot tell how many books that
   * is, and 6000 is the safety-fuse page count, not the real one. See
   * `computeCatalogBookCounts`/`loadCatalogBookCountsBatch` below for the
   * derivation. Absent — not a partially-filled object — whenever
   * `result.catalogObservedTotal` (no page has completed yet) or
   * `params.pageSize` is not yet known; every other taskType never gets
   * this field at all.
   */
  bookCounts?: CatalogBookCountsDto;
  /** Catalog worker phase projected without adding a new database status. */
  catalogPhase?: "paging" | "finalizing" | "completed" | "failed";
  /**
   * X10 task control (pause/resume/abort): the task's own
   * `result.taskControl` marker (`src/lib/tasks/task-control.ts`), read and
   * validated by `readTaskControlMarker` — never the raw `result` blob, and
   * never itself the source of truth for *what state* the row is in (that is
   * the `status` field above — this DTO's `status` is the real, formal
   * `paused`/`cancelled`/`disabled`/... column value). Present only when
   * `status` is `"paused"`, `"cancelled"`, or `"disabled"` *and* the row
   * actually carries this module's marker; a `disabled` row from any of this
   * codebase's three pre-existing reasons (a legacy out-of-band flip, a
   * feature-flag-off task, or a catalog-batch double-gate refusal) carries
   * no marker and leaves this field absent, exactly like every other
   * optional DTO field here. This is what lets the UI tell
   * 人工暂停/人工中止/系统保护停止 apart from each other and from the
   * earlier, unrelated meanings of `disabled` — audit/display detail only
   * (who/why), layered on top of the formal status.
   */
  taskControl?: TaskControlMarker;
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
  failure?: SafeTaskFailureDto;
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
 * (`worker/handlers/moboreader.ts`) ever writes, PLUS (D-7, Phase E rework
 * 2, 2026-09-07) `"finalize_failed"` — a distinct kind of value read from
 * `error.code` rather than `result.stopReason` by `deriveItemStopReason`
 * below, written by `worker/runtime/worker.ts`'s `handleFinalizeFailure`
 * when `finalizeTaskItem`'s own write transaction fails outside the
 * handler. The first six are still the identical literal array in
 * `src/lib/tasks/store.ts`'s `finalizeTaskItem` (that array governs a
 * different thing — the sibling-page cascade-stop mechanism, which
 * `finalize_failed` deliberately does not participate in: one item's
 * finalize failing is not a reason to stop reading the rest of a catalog
 * scan). Read back here as an explicit allowlist (not a blind pass-through
 * of whatever string is in the JSONB column) so a future handler/runtime
 * bug can never smuggle free text into this admin-read projection through
 * `result.stopReason` / `error.code`.
 */
const CATALOG_SCAN_STOP_REASONS = new Set([
  "expected_total_reached",
  "expected_pages_reached",
  "empty_page",
  "short_page",
  "safety_limit",
  "upstream_error",
  "finalize_failed",
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

export type RetryCatalogFinalizeResult = Readonly<{
  family: "generic";
  taskId: string;
  status: "pending";
  generation: number;
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
  /**
   * C-10: read to derive `TaskSummaryDto.stopReason`. C-12: also read (only
   * for a `catalog_scan` row) to derive `TaskSummaryDto.bookCounts` via
   * `catalogObservedTotalOf`/`loadCatalogBookCountsBatch`. Never itself
   * exposed.
   */
  result: Prisma.JsonValue | null;
  error?: Prisma.JsonValue | null;
  /**
   * C-9 (task-detail route): the three fields below are only ever selected
   * by `getAdminTaskDetail`'s own query — `listAdminTasks`'s query never
   * adds them to its SELECT list, so they stay `undefined` there and every
   * pre-existing `listAdminTasks` fixture (including the "X9 read DTO
   * allowlists" contract test's poisoned rows) is unaffected.
   */
  updated_at?: Date;
  mode?: string;
  channel_account_id?: string | null;
  /**
   * C-9: read only to derive `TaskDetailDto.catalogScanConfig` — never
   * itself exposed, same discipline as `result` above. C-12
   * (`施工工单_C12_目录任务计量口径改为本_2026-09-07.md`): unlike the four
   * fields above, `listAdminTasks`'s own query now also selects this (both
   * `channel_sync_task` and `generic_task` already carry the column) to
   * derive `TaskSummaryDto.bookCounts`'s `pageSize` — still never exposed
   * raw, still curated exclusively through `deriveCatalogScanConfig`.
   */
  params?: Prisma.JsonValue | null;
};

type LockedParentRow = {
  id: string;
  status: string;
  task_type: string;
  channel_account_id: string | null;
  channel_app_id: string | null;
  /**
   * X10 task control: read only so `pauseTask`/`abortTask` can merge their
   * `taskControl` marker onto whatever `result` already holds
   * (`mergeTaskControlResult`) rather than clobbering a taskType's own
   * business-result fields. Audit metadata only — `resumeTask`/`abortTask`
   * decide eligibility off `status` (`"paused"`/`"cancelled"` are now real
   * CHECK-enforced column values), never by reading this field.
   */
  result: Prisma.JsonValue | null;
  /**
   * 阶段2 第4步：`resumeTask` 需要判定"这是一个生命周期分片"
   * （`isLifecycleShardParams`）以拒绝对分片的直接单任务恢复——见
   * `resumeTask` 自身的 doc comment。其余调用点（`pauseTask`/`abortTask`）
   * 不读这个字段，多选出来的这一列对它们零影响。
   */
  params: Prisma.JsonValue | null;
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

function optionalBoundedText(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return invalid();
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) return invalid();
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
 * C-12 (`施工工单_C12_目录任务计量口径改为本_2026-09-07.md`): the
 * operator-facing "本" (book) counts for a `catalog_scan` task, all derived
 * from data this file already reads for other reasons plus one aggregate
 * SQL query (`loadCatalogBookAggregates` below) — never a schema change,
 * never a per-item `findMany` + JS-side reduce over however many thousand
 * `generic_task_item` rows a scan created.
 */
export type CatalogBookCountsDto = Readonly<{
  /** `result.catalogObservedTotal` — the upstream-reported book total. */
  upstreamTotal: number;
  /** Σ `result.returnedCount` over this task's successful, non-cascaded catalog pages. */
  fetched: number;
  /** Exact failed source-item count; null when page failures cannot identify individual books. */
  failedBooks: number | null;
  /** Actually executed catalog pages that failed; never converted into books. */
  failedPages?: number;
  /** Pages actually fetched from upstream (success or failure), excluding any `stoppedBeforeFetch` cascade. */
  pagesScanned: number;
  /** `ceil(upstreamTotal / pageSize)` — the real page count, never the safety-fuse pre-created count. */
  pagesTotalExpected: number;
  /** `fetched / upstreamTotal`, rounded and capped at 100. */
  percent: number;
}>;

type CatalogBookAggregateRow = {
  task_id: string;
  fetched: bigint;
  pages_scanned: bigint;
  failed_pages: bigint;
};

/**
 * C-12: one aggregate SQL query for however many catalog_scan task ids are
 * passed — `GROUP BY task_id` so `listAdminTasks` (potentially several
 * catalog_scan rows on one page) pays for exactly one extra query for the
 * whole list, not one per row. `stoppedBeforeFetch` (set by both
 * `persistCatalogPage`'s normal end-of-scan cascade and
 * `persistCatalogUpstreamFailure`'s upstream-error cascade,
 * `worker/handlers/moboreader.ts`) is excluded from every aggregate here:
 * those items were pre-created by the safety fuse but never actually
 * fetched, so they contribute to neither "pages scanned" nor "failed
 * pages" — the work order's "保险丝预建的多余页项...不得计入失败或跳过".
 * A normal-cascade item is `status = 'success'` with `returnedCount: 0`
 * already, so `fetched`'s sum needs no separate exclusion for it.
 */
async function loadCatalogBookAggregates(
  db: PrismaClient,
  taskIds: readonly string[],
): Promise<Map<string, { fetched: number; pagesScanned: number; failedPages: number }>> {
  if (taskIds.length === 0) return new Map();
  const rows = await db.$queryRaw<CatalogBookAggregateRow[]>(Prisma.sql`
    SELECT
      task_id,
      COALESCE(SUM((result->>'returnedCount')::int) FILTER (WHERE status = 'success'), 0)::bigint AS fetched,
      COUNT(*) FILTER (
        WHERE target_type = 'catalog_page' AND status IN ('success', 'failed')
          AND COALESCE(result->>'stoppedBeforeFetch', 'false') <> 'true'
      )::bigint AS pages_scanned,
      COUNT(*) FILTER (
        WHERE target_type IN ('catalog_page', 'catalog_recovery_page') AND status = 'failed'
          AND COALESCE(result->>'stoppedBeforeFetch', 'false') <> 'true'
      )::bigint AS failed_pages
    FROM generic_task_item
    WHERE task_id = ANY(${taskIds}::uuid[])
      AND target_type IN ('catalog_page', 'catalog_recovery_page')
    GROUP BY task_id
  `);
  return new Map(rows.map((row) => [row.task_id, {
    fetched: Number(row.fetched),
    pagesScanned: Number(row.pages_scanned),
    failedPages: Number(row.failed_pages),
  }]));
}

function catalogObservedTotalOf(result: unknown): number | undefined {
  const value = jsonPlainObject(result)?.catalogObservedTotal;
  return typeof value === "number" ? value : undefined;
}

function deriveBookCounts(
  observedTotal: number,
  pageSize: number,
  taskStatus: string,
  aggregate: { fetched: number; pagesScanned: number; failedPages: number } | undefined,
): CatalogBookCountsDto {
  const fetched = aggregate?.fetched ?? 0;
  const pagesScanned = aggregate?.pagesScanned ?? 0;
  const failedPages = aggregate?.failedPages ?? 0;
  return Object.freeze({
    upstreamTotal: observedTotal,
    fetched,
    failedBooks: failedPages === 0 ? 0 : null,
    failedPages,
    pagesScanned,
    pagesTotalExpected: Math.ceil(observedTotal / pageSize),
    percent: observedTotal <= 0
      ? 0
      : taskStatus === "completed" && fetched >= observedTotal
        ? 100
        : Math.min(99.99, Math.floor((fetched / observedTotal) * 10_000) / 100),
  });
}

export type CatalogBookCountsInput = {
  taskId: string;
  taskType: string;
  result: unknown;
  params: unknown;
  status?: string;
};

function catalogBookCountsPrerequisites(
  input: CatalogBookCountsInput,
): { observedTotal: number; pageSize: number } | undefined {
  if (input.taskType !== MOBOREADER_TASK_TYPES.catalogScan) return undefined;
  const observedTotal = catalogObservedTotalOf(input.result);
  const pageSize = deriveCatalogScanConfig(input.taskType, input.params)?.pageSize;
  if (observedTotal === undefined || pageSize === undefined || pageSize <= 0) return undefined;
  return { observedTotal, pageSize };
}

/**
 * C-12: batched entry point `listAdminTasks` uses — issues at most one
 * aggregate SQL query total (`loadCatalogBookAggregates`), regardless of
 * how many catalog_scan rows are on the page, and zero queries at all when
 * none of them have both `catalogObservedTotal` and `pageSize` known yet.
 * Every non-catalog_scan / not-yet-derivable input is simply absent from
 * the returned map (never a partially-filled `CatalogBookCountsDto`).
 */
export async function loadCatalogBookCountsBatch(
  db: PrismaClient,
  inputs: readonly CatalogBookCountsInput[],
): Promise<Map<string, CatalogBookCountsDto>> {
  const prerequisites = new Map<string, { observedTotal: number; pageSize: number; status: string }>();
  for (const input of inputs) {
    const prereq = catalogBookCountsPrerequisites(input);
    if (prereq) prerequisites.set(input.taskId, { ...prereq, status: input.status ?? "processing" });
  }
  const aggregates = await loadCatalogBookAggregates(db, Array.from(prerequisites.keys()));
  const result = new Map<string, CatalogBookCountsDto>();
  for (const [taskId, prereq] of prerequisites) {
    result.set(taskId, deriveBookCounts(prereq.observedTotal, prereq.pageSize, prereq.status, aggregates.get(taskId)));
  }
  return result;
}

/**
 * C-12: single-task convenience wrapper around
 * `loadCatalogBookCountsBatch` — used by `getAdminTaskDetail` (this file)
 * and `getAdminTaskProgress` (`./progress.ts`), both of which already have
 * `result`/`params` in hand from their own primary query and only need one
 * task's worth of aggregation.
 */
export async function loadCatalogBookCounts(
  db: PrismaClient,
  input: CatalogBookCountsInput,
): Promise<CatalogBookCountsDto | undefined> {
  const map = await loadCatalogBookCountsBatch(db, [input]);
  return map.get(input.taskId);
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
   * 阶段2 第4步（施工任务 3.5，旧路径缺陷修复）：只对 parent-batch 任务类型
   * 填充——批次自身、未经派生的原始 `status` 列值（`deriveCatalogBatchParentRow`
   * 派生之前）。批次自己的枚举条目一旦处理完，`status` 列几乎总是很快变成
   * 终态（通常是 `completed`），即使它的分片/子任务仍在运行——`taskSummary`
   * 顶层的 `status` 字段是"派生后"的展示状态（会正确地把仍有活跃子任务的批次
   * 显示成 processing），但批次级暂停/恢复/中止的服务端接口只认这个原始列值。
   * 页面必须用这个字段（而不是派生后的 `status`）来决定是否显示暂停/恢复/
   * 中止按钮，否则会出现"按钮显示可点，点了却 409"（2026-09-23 Owner 实际
   * 遇到：父批次 bfae6a25 已完成，真正在跑的是子任务）。
   */
  parentRawStatus?: string;
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
  catalogFinalize?: Readonly<{
    status: string;
    attemptCount: number;
    generation: number;
    retryable: boolean;
  }>;
}>;

function taskSummary(row: TaskListRow, bookCounts?: CatalogBookCountsDto): TaskSummaryDto {
  const stopReason = deriveTaskStopReason(row.status, row.has_error, row.result);
  const hasStoredError = row.error !== undefined ? row.error !== null : row.has_error;
  const failure = hasStoredError ? projectSafeTaskFailure(row.error) : undefined;
  const resultObject = jsonPlainObject(row.result);
  const allowedBlockedReasons = new Set([
    "channel_binding_or_capability_unavailable",
    "active_scope_conflict",
    "missing_locale",
    "unsupported_locale",
    // 阶段2 第4步（施工任务 3.4）：书已挂在另一个批次仍在排队的生命周期
    // 分片下——见 `worker/handlers/catalog-batch.ts` 的 `queuedElsewhere`
    // 查询、`task-copy.ts` 的 `queued_in_other_batch` 中文说明。
    "queued_in_other_batch",
  ]);
  const blockedReasonCounts = resultObject?.blockedReasonCounts && typeof resultObject.blockedReasonCounts === "object" && !Array.isArray(resultObject.blockedReasonCounts)
    ? Object.fromEntries(Object.entries(resultObject.blockedReasonCounts as Record<string, unknown>)
      .filter((entry): entry is [string, number] => allowedBlockedReasons.has(entry[0]) && typeof entry[1] === "number" && entry[1] > 0))
    : {};
  const isCatalogMaterialize = row.task_type === CATALOG_BATCH_TASK_TYPE;
  const articleBlockedReasons = new Set<ArticleGenerateBlockedReason>([
    "novel_not_found",
    "novel_deleted",
    "already_exists",
    "article_soft_deleted",
    "promo_link_missing",
    "promo_link_not_ready",
    "promo_link_deleted",
  ]);
  const articleBlockedReasonCounts = resultObject?.blockedReasonCounts
    && typeof resultObject.blockedReasonCounts === "object"
    && !Array.isArray(resultObject.blockedReasonCounts)
    ? Object.fromEntries(Object.entries(resultObject.blockedReasonCounts as Record<string, unknown>)
      .filter((entry): entry is [ArticleGenerateBlockedReason, number] =>
        articleBlockedReasons.has(entry[0] as ArticleGenerateBlockedReason)
        && typeof entry[1] === "number" && Number.isSafeInteger(entry[1]) && entry[1] > 0))
    : {};
  const isArticleGenerate = row.task_type === ARTICLE_GENERATE_TASK_TYPE
    || row.task_type === ARTICLE_GENERATE_BATCH_TASK_TYPE
    || row.task_type === ARTICLE_GENERATE_BATCH_TASK_TYPE_V2;
  const articleAdmission = isArticleGenerate
    && typeof resultObject?.selectedCount === "number"
    && typeof resultObject?.submittedCount === "number"
    ? {
        selectedCount: resultObject.selectedCount,
        submittedCount: resultObject.submittedCount,
        blockedCount: Object.values(articleBlockedReasonCounts).reduce((sum, count) => sum + count, 0),
        blockedReasonCounts: articleBlockedReasonCounts,
      }
    : undefined;
  const catalogBatch = isParentBatchTaskType(row.task_type) ? {
    phase: deriveCatalogBatchPhase({
      parentStatus: row.status,
      enumerationStatus: resultObject?.enumerationStatus,
    }),
    submittedCount: typeof resultObject?.submittedCount === "number" ? resultObject.submittedCount : null,
    ineligibleCount: isCatalogMaterialize && typeof resultObject?.ineligibleCount === "number"
      ? resultObject.ineligibleCount
      : null,
    alreadyLinkedCount: isCatalogMaterialize && typeof resultObject?.alreadyLinkedCount === "number"
      ? resultObject.alreadyLinkedCount
      : null,
    blockedCount: isCatalogMaterialize
      ? Object.values(blockedReasonCounts).reduce((sum, count) => sum + count, 0)
      : 0,
    blockedReasonCounts: isCatalogMaterialize ? blockedReasonCounts : {},
  } : undefined;
  // X10 task control: only ever derivable off a paused/cancelled/disabled
  // row, and only when the row actually carries the marker — see
  // `TaskSummaryDto.taskControl`'s own doc comment for why an unmarked
  // `disabled` row must stay absent here. `status` itself (not this marker)
  // is what determines the row is paused/cancelled in the first place.
  const taskControl = row.status === "paused" || row.status === "cancelled" || row.status === "disabled"
    ? readTaskControlMarker(row.result)
    : undefined;
  const finalization = jsonPlainObject(resultObject?.finalization);
  const catalogPhase = row.task_type !== MOBOREADER_TASK_TYPES.catalogScan
    ? undefined
    : row.status === "completed"
      ? "completed" as const
      : row.status === "failed" || row.status === "completed_with_errors"
        ? "failed" as const
        : finalization?.status === "pending" || finalization?.status === "processing"
          ? "finalizing" as const
          : "paging" as const;
  return Object.freeze({
    family: row.family,
    taskId: row.task_id,
    taskType: row.task_type,
    status: row.status,
    totalCount: row.total_count,
    successCount: row.success_count,
    failedCount: row.failed_count,
    skippedCount: row.skipped_count,
    errorSummary: hasStoredError ? "redacted" : null,
    ...(failure ? { failure } : {}),
    ...(articleAdmission ? { articleAdmission } : {}),
    ...(catalogBatch ? { catalogBatch } : {}),
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(bookCounts !== undefined ? { bookCounts } : {}),
    ...(catalogPhase ? { catalogPhase } : {}),
    ...(taskControl ? { taskControl } : {}),
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
  const parentBatchTypes = Prisma.join(
    PARENT_BATCH_TASK_TYPES.map((taskType) => Prisma.sql`${taskType}`),
  );
  const rows = await db.$queryRaw<TaskListRow[]>(Prisma.sql`
    SELECT * FROM (
      SELECT 'channel_sync'::text AS family, id AS task_id, task_type, status,
        total_count, success_count, failed_count, skipped_count,
        error IS NOT NULL AS has_error, created_at, result, params, error
      FROM channel_sync_task
      WHERE (${family}::text IS NULL OR ${family} = 'channel_sync')
        AND (${status}::text IS NULL OR status = ${status})
      UNION ALL
      SELECT 'generic'::text AS family, task_id, task_type, status,
        total_count, success_count, failed_count, skipped_count,
        has_error, created_at, result, params, error
      FROM (
        SELECT g.id AS task_id, g.task_type,
          -- X10 task control: paused/cancelled win outright, same as
          -- disabled below (an admin who paused/aborted this catalog_batch
          -- parent must never see it silently recomputed from enumeration
          -- state or child counts) -- see deriveCatalogBatchParentRow's own
          -- comment (this file, below) and deriveCatalogBatchPhase's
          -- (@/domain/catalog-batch) for the same guard applied to the
          -- single-task detail read and the pure phase derivation.
          CASE WHEN g.task_type NOT IN (${parentBatchTypes}) THEN g.status
            WHEN g.status = 'paused' THEN 'paused'
            WHEN g.status = 'cancelled' THEN 'cancelled'
            WHEN g.status = 'disabled' THEN 'disabled'
            WHEN g.result->>'enumerationStatus' = 'expired' THEN 'completed_with_errors'
            WHEN g.result->>'enumerationStatus' IS DISTINCT FROM 'completed' THEN g.status
            WHEN COALESCE(c.active_count, 0) > 0 THEN 'processing'
            WHEN COALESCE(c.cancelled_tasks, 0) > 0 THEN 'cancelled'
            WHEN COALESCE(c.paused_tasks, 0) > 0 THEN 'paused'
            WHEN COALESCE(c.disabled_tasks, 0) > 0 THEN 'disabled'
            WHEN COALESCE(c.total_tasks, 0) > 0 AND c.hard_failed_tasks = c.total_tasks THEN 'failed'
            WHEN COALESCE(c.failed_tasks, 0) > 0 OR EXISTS (
              SELECT 1 FROM jsonb_each(COALESCE(g.result->'blockedReasonCounts', '{}'::jsonb)) blocked
              WHERE jsonb_typeof(blocked.value) = 'number' AND (blocked.value #>> '{}')::numeric > 0
            ) THEN 'completed_with_errors'
            ELSE 'completed' END AS status,
          CASE WHEN g.task_type IN (${parentBatchTypes}) AND g.result->>'enumerationStatus' = 'completed'
            THEN COALESCE(c.total_count, 0) ELSE g.total_count END::int AS total_count,
          CASE WHEN g.task_type IN (${parentBatchTypes}) THEN COALESCE(c.success_count, 0) ELSE g.success_count END::int AS success_count,
          CASE WHEN g.task_type IN (${parentBatchTypes}) THEN COALESCE(c.failed_count, 0) ELSE g.failed_count END::int AS failed_count,
          CASE WHEN g.task_type IN (${parentBatchTypes}) THEN COALESCE(c.skipped_count, 0) ELSE g.skipped_count END::int AS skipped_count,
          (g.error IS NOT NULL OR COALESCE(c.failed_tasks, 0) > 0
            OR COALESCE(g.result->>'enumerationStatus' = 'expired', false)
            OR EXISTS (
              SELECT 1 FROM jsonb_each(COALESCE(g.result->'blockedReasonCounts', '{}'::jsonb)) blocked
              WHERE jsonb_typeof(blocked.value) = 'number' AND (blocked.value #>> '{}')::numeric > 0
            )) AS has_error,
          g.created_at, g.result, g.params, g.error
        FROM generic_task g
        LEFT JOIN LATERAL (
          SELECT SUM(total_count)::int total_count, SUM(success_count)::int success_count,
            SUM(failed_count)::int failed_count, SUM(skipped_count)::int skipped_count,
            COUNT(*)::int total_tasks,
            COUNT(*) FILTER (WHERE status IN ('pending','processing'))::int active_count,
            COUNT(*) FILTER (WHERE status = 'disabled')::int disabled_tasks,
            -- X10 task control: a child paused/aborted through the same
            -- generic TaskControlButtons UI bubbles up the same way a
            -- disabled child always has (see the CASE below) -- mirrors
            -- deriveCatalogBatchPhase's own childStatuses handling
            -- (@/domain/catalog-batch).
            COUNT(*) FILTER (WHERE status = 'paused')::int paused_tasks,
            COUNT(*) FILTER (WHERE status = 'cancelled')::int cancelled_tasks,
            COUNT(*) FILTER (WHERE status IN ('failed','completed_with_errors'))::int failed_tasks
            ,COUNT(*) FILTER (WHERE status = 'failed')::int hard_failed_tasks
          FROM generic_task child WHERE child.parent_task_id = g.id AND child.origin_task_id IS NULL
        ) c ON true
        WHERE g.parent_task_id IS NULL
      ) generic_derived
      WHERE (${family}::text IS NULL OR ${family} = 'generic')
        AND (${status}::text IS NULL OR status = ${status})
    ) task_union
    ORDER BY CASE WHEN status IN ('pending', 'processing') THEN 0 ELSE 1 END,
      created_at DESC, task_id DESC
    LIMIT ${take}
  `);
  // C-12: batched — at most one extra aggregate query for the whole page,
  // regardless of how many catalog_scan rows it contains (never one query
  // per row, and zero when none has both catalogObservedTotal/pageSize yet).
  const bookCounts = await loadCatalogBookCountsBatch(
    db,
    rows
      .filter((row) => row.family === "generic" && row.task_type === MOBOREADER_TASK_TYPES.catalogScan)
      .map((row) => ({ taskId: row.task_id, taskType: row.task_type, result: row.result, params: row.params, status: row.status })),
  );
  return Object.freeze({
    items: Object.freeze(rows.map((row) => taskSummary(row, bookCounts.get(row.task_id)))),
    limit: take,
  });
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

async function deriveCatalogBatchParentRow(db: PrismaClient, row: TaskListRow): Promise<TaskListRow> {
  if (!isParentBatchTaskType(row.task_type)) return row;
  const children = await db.genericTask.aggregate({ where: { parentTaskId: row.task_id, originTaskId: null },
    _sum: { totalCount: true, successCount: true, failedCount: true, skippedCount: true } });
  const states = await db.genericTask.groupBy({ by: ["status"], where: { parentTaskId: row.task_id, originTaskId: null }, _count: { _all: true } });
  const active = states.some((state) => ["pending", "processing"].includes(state.status));
  const disabled = states.some((state) => state.status === "disabled");
  // X10 task control: same reasoning as `disabled` above -- a child paused
  // or aborted through the generic TaskControlButtons UI bubbles up the
  // same way, mirroring deriveCatalogBatchPhase's (@/domain/catalog-batch)
  // own childStatuses handling and this file's listAdminTasks raw-SQL
  // sibling above.
  const cancelledChild = states.some((state) => state.status === "cancelled");
  const pausedChild = states.some((state) => state.status === "paused");
  const failed = states.some((state) => ["failed", "completed_with_errors"].includes(state.status));
  const allFailed = states.length > 0 && states.every((state) => state.status === "failed");
  const result = jsonPlainObject(row.result);
  const blocked = Boolean(result?.blockedReasonCounts && typeof result.blockedReasonCounts === "object"
    && Object.values(result.blockedReasonCounts as Record<string, unknown>).some((value) => typeof value === "number" && value > 0));
  // X10 task control: `row.status` (the parent's own status) can itself now
  // be `paused`/`cancelled` (an admin acted directly on the parent), not
  // only `disabled` -- checked first, same as `disabled`, so an explicit
  // pause/abort of the parent is never re-derived from enumeration state or
  // child counts below.
  const status = row.status === "disabled" ? "disabled"
    : row.status === "paused" ? "paused"
    : row.status === "cancelled" ? "cancelled"
    : result?.enumerationStatus === "expired" ? "completed_with_errors"
    : result?.enumerationStatus !== "completed" ? row.status
    : active ? "processing" : cancelledChild ? "cancelled" : pausedChild ? "paused" : disabled ? "disabled" : allFailed ? "failed" : failed || blocked ? "completed_with_errors" : "completed";
  return { ...row, status,
    total_count: result?.enumerationStatus === "completed" ? children._sum.totalCount ?? 0 : row.total_count,
    success_count: children._sum.successCount ?? 0, failed_count: children._sum.failedCount ?? 0,
    skipped_count: children._sum.skippedCount ?? 0, has_error: row.has_error || failed || blocked || result?.enumerationStatus === "expired",
  };
}

type PromoClaimShardAggregateRow = {
  shard_id: string;
  params: Prisma.JsonValue | null;
  status: string;
  result: Prisma.JsonValue | null;
  total_count: number;
  success_count: number;
  failed_count: number;
  skipped_count: number;
  manual_review_count: number;
};

/**
 * 阶段2 第4步（施工任务 3.5）：批次详情页的分片列表 + 领取统计 + 预计完成
 * 时间。一次聚合 SQL 查询拿到每个分片自身的状态/参数与它名下条目的计数——
 * "人工核对"通过 `generic_task_item.result->>'decision' =
 * 'manual_review_required'` 识别：这类条目的 `status` 仍然是 `success`
 * （worker/handlers/promo-link-claim.ts 对人工核对场景就是这样写的——已经
 * 收尾，不是失败，只是没有真正拿到新推广码），单看 `status` 无法把它和真正
 * 拿到码的条目区分开。只对生命周期批次调用；只有一次数据库往返，不管批次
 * 有多少个分片。
 */
async function loadPromoClaimBatchLifecycle(
  db: PrismaClient,
  batchId: string,
  batchResult: unknown,
): Promise<PromoClaimBatchLifecycleDto> {
  const rows = await db.$queryRaw<PromoClaimShardAggregateRow[]>(Prisma.sql`
    SELECT s.id AS shard_id, s.params, s.status, s.result,
      COUNT(i.id)::int AS total_count,
      COUNT(*) FILTER (WHERE i.status = 'success')::int AS success_count,
      COUNT(*) FILTER (WHERE i.status = 'failed')::int AS failed_count,
      COUNT(*) FILTER (WHERE i.status = 'skipped')::int AS skipped_count,
      COUNT(*) FILTER (WHERE i.status = 'success' AND i.result->>'decision' = 'manual_review_required')::int AS manual_review_count
    FROM generic_task s
    LEFT JOIN generic_task_item i ON i.task_id = s.id
    WHERE s.parent_task_id = ${batchId}::uuid AND s.task_type = ${PROMO_LINK_CLAIM_TASK_TYPE}
      AND s.params->>'lifecycleVersion' = '1' AND s.params->>'lifecycleRole' = 'shard'
    GROUP BY s.id
    ORDER BY (s.params->>'shardIndex')::int ASC
  `);
  const shards: PromoClaimShardSummaryDto[] = rows.map((row) => {
    const params = jsonPlainObject(row.params) ?? {};
    const marker = readTaskControlMarker(row.result);
    return Object.freeze({
      taskId: row.shard_id,
      shardIndex: typeof params.shardIndex === "number" ? params.shardIndex : 0,
      status: row.status,
      releaseCount: typeof params.releaseCount === "number" ? params.releaseCount : 0,
      missedDeadlineCount: typeof params.missedDeadlineCount === "number" ? params.missedDeadlineCount : 0,
      ...(typeof params.releasedAt === "string" ? { releasedAt: params.releasedAt } : {}),
      ...(typeof params.deadlineAt === "string" ? { deadlineAt: params.deadlineAt } : {}),
      totalCount: row.total_count,
      successCount: row.success_count,
      manualReviewCount: row.manual_review_count,
      failedCount: row.failed_count,
      skippedCount: row.skipped_count,
      ...(marker ? { holdKind: marker.kind, ...(marker.reasonCode ? { holdReasonCode: marker.reasonCode } : {}) } : {}),
    });
  });
  const shardPlanRaw = jsonPlainObject(jsonPlainObject(batchResult)?.shardPlan);
  const shardPlan = shardPlanRaw ? Object.freeze({
    windowMinutes: typeof shardPlanRaw.windowMinutes === "number" ? shardPlanRaw.windowMinutes : PROMO_CLAIM_LIFECYCLE_DEFAULTS.shardWindowMinutes,
    shardSizeMin: typeof shardPlanRaw.shardSizeMin === "number" ? shardPlanRaw.shardSizeMin : PROMO_CLAIM_LIFECYCLE_DEFAULTS.shardSizeMin,
    shardSizeMax: typeof shardPlanRaw.shardSizeMax === "number" ? shardPlanRaw.shardSizeMax : PROMO_CLAIM_LIFECYCLE_DEFAULTS.shardSizeMax,
    shardCount: typeof shardPlanRaw.shardCount === "number" ? shardPlanRaw.shardCount : shards.length,
    ...(typeof shardPlanRaw.shardSize === "number" ? { shardSize: shardPlanRaw.shardSize } : {}),
  }) : undefined;
  const windowMinutes = shardPlan?.windowMinutes ?? PROMO_CLAIM_LIFECYCLE_DEFAULTS.shardWindowMinutes;
  return Object.freeze({
    shardPlan,
    shards: Object.freeze(shards),
    counts: derivePromoClaimBatchCounts(shards),
    etaMinutes: estimatePromoClaimBatchEtaMinutes(shards, windowMinutes, new Date()),
  });
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
      mode, channel_account_id, params, result, error
    FROM ${table}
    WHERE id = ${taskId}::uuid
  `);
  const rawRow = rows[0];
  if (!rawRow) throw new TaskAdminError("task_admin_not_found", 404);
  const row = await deriveCatalogBatchParentRow(db, rawRow);
  const catalogScanConfig = deriveCatalogScanConfig(row.task_type, row.params);
  const catalogScanAudit = deriveCatalogScanAudit(row.task_type, row.result);
  const isCatalogScan = family === "generic" && row.task_type === MOBOREADER_TASK_TYPES.catalogScan;
  const originStopReason = isCatalogScan ? await deriveOriginStopReason(db, taskId) : undefined;
  const catalogFinalizeItem = isCatalogScan ? await db.genericTaskItem.findUnique({
    where: { taskId_targetType_targetId: {
      taskId,
      targetType: MOBOREADER_CATALOG_TARGET_TYPES.finalize,
      targetId: MOBOREADER_CATALOG_FINALIZE_TARGET_ID,
    } },
    select: { status: true, attemptCount: true, payload: true },
  }) : null;
  const catalogFinalize = catalogFinalizeItem ? {
    status: catalogFinalizeItem.status,
    attemptCount: catalogFinalizeItem.attemptCount,
    generation: catalogFinalizeGeneration(finalizePayload(catalogFinalizeItem.payload).generation),
    retryable: catalogFinalizeItem.status === "failed" && RETRYABLE_PARENT_STATUSES.has(row.status),
  } : undefined;
  // C-12: only issues its aggregate SQL query when catalogObservedTotal/
  // pageSize are already known (both read from `row.result`/`row.params`
  // this function already fetched) — a catalog_scan task with no completed
  // page yet costs no extra query, same as a non-catalog_scan task.
  const bookCounts = isCatalogScan
    ? await loadCatalogBookCounts(db, { taskId, taskType: row.task_type, result: row.result, params: row.params, status: row.status })
    : undefined;
  const childTasks = isParentBatchTaskType(row.task_type) ? await db.genericTask.findMany({
    where: { parentTaskId: taskId, originTaskId: null }, orderBy: { createdAt: "asc" },
    select: { id: true, taskType: true, status: true },
  }) : [];
  // 阶段2 第4步（施工任务 3.5）：只对生命周期批次（batch.materialize.v1 且
  // params.lifecycleVersion=1/lifecycleRole=batch）加这一次额外聚合查询。
  const isLifecycleBatch = family === "generic"
    && row.task_type === CATALOG_BATCH_TASK_TYPE
    && isLifecycleBatchParams(rawRow.params);
  const promoClaimLifecycle = isLifecycleBatch
    ? await loadPromoClaimBatchLifecycle(db, taskId, rawRow.result)
    : undefined;
  const summary = taskSummary(row, bookCounts);
  return Object.freeze({
    ...summary,
    ...(summary.catalogBatch ? { catalogBatch: { ...summary.catalogBatch,
      childTasks: childTasks.map((child) => ({ taskId: child.id, taskType: child.taskType, status: child.status })),
      ...(promoClaimLifecycle ? { promoClaimLifecycle } : {}),
    } } : {}),
    // 旧路径缺陷修复（3.5）：批次自身未经派生的原始 status 列值，供页面决定
    // 批次级暂停/恢复/中止按钮的可点性——见 `TaskDetailDto.parentRawStatus`
    // 自己的 doc comment。
    ...(isParentBatchTaskType(row.task_type) ? { parentRawStatus: rawRow.status } : {}),
    ...(row.mode !== undefined ? { mode: row.mode } : {}),
    ...(row.channel_account_id ? { channelAccountId: row.channel_account_id } : {}),
    createdAt: iso(row.created_at),
    ...(row.updated_at ? { updatedAt: iso(row.updated_at) } : {}),
    ...(catalogScanConfig ? { catalogScanConfig } : {}),
    ...(catalogScanAudit ? { catalogScanAudit } : {}),
    ...(originStopReason !== undefined ? { originStopReason } : {}),
    ...(catalogFinalize ? { catalogFinalize } : {}),
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
      const failure = row.status === "failed" ? projectSafeTaskFailure(row.error) : undefined;
      return Object.freeze({
        family, itemId: row.id, taskId: row.taskId, status: row.status,
        attemptCount: row.attemptCount, leaseEpoch: row.leaseEpoch.toString(),
        lockedUntil: iso(row.lockedUntil), errorSummary: row.error === null ? null : "redacted",
        ...(failure ? { failure } : {}),
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
      const failure = row.status === "failed" ? projectSafeTaskFailure(row.error) : undefined;
      const pageNumber = derivePageNumber(row.targetType, row.targetId);
      return Object.freeze({
        family, itemId: row.id, taskId: row.taskId, status: row.status,
        attemptCount: row.attemptCount, leaseEpoch: row.leaseEpoch.toString(),
        lockedUntil: iso(row.lockedUntil), errorSummary: row.error === null ? null : "redacted",
        ...(failure ? { failure } : {}),
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
      SELECT id, status, task_type, channel_account_id, channel_app_id, result, params
      FROM channel_sync_task WHERE id = ${taskId}::uuid FOR UPDATE
    `);
  } else {
    rows = await tx.$queryRaw(Prisma.sql`
      SELECT id, status, task_type, channel_account_id, channel_app_id, result, params
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
  reason: string | null,
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

function replayCatalogFinalizeRetry(
  audit: AuditRow,
  actorId: string,
  taskId: string,
  reason: string | null,
): RetryCatalogFinalizeResult {
  const after = jsonObject(audit.afterSnapshot);
  if (
    audit.actorId !== actorId
    || audit.entityId !== taskId
    || audit.taskType !== MOBOREADER_TASK_TYPES.catalogScan
    || audit.reason !== reason
    || after?.status !== "pending"
    || typeof after.generation !== "number"
  ) throw new TaskAdminError("task_admin_idempotency_conflict", 409);
  return Object.freeze({
    family: "generic",
    taskId,
    status: "pending",
    generation: after.generation,
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
  // C-15 audit (施工工单_C15 §二.4): `itemIds` here is every *failed* item of
  // one task. `channel_sync` failed-item counts are no longer bounded well
  // under Postgres's 32,767 bind-variable cap once C-15 lets
  // `enqueueMoboreaderPreviewRefreshTask` actually create a
  // `moboreader.preview_refresh.v1` task spanning a full catalog (up to
  // ~96,660 items) -- if every item of such a task failed, an operator's
  // "failed retry" click would rebuild the exact same overflow this work
  // order fixes, just in this query instead. Chunked defensively even though
  // no single incident has hit this path yet.
  let linked = false;
  for (const idChunk of chunkIds(itemIds)) {
    const found = await tx.sideEffectIntent.findFirst({
      where: {
        status: { in: [...UNRESOLVED_INTENT_STATUSES] },
        taskItemId: { in: idChunk },
      },
      select: { id: true },
    });
    if (found) { linked = true; break; }
  }
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

function finalizePayload(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, Prisma.JsonValue>
    : {};
}

async function rearmCatalogFinalize(
  tx: Prisma.TransactionClient,
  input: {
    taskId: string;
    parentResult: Prisma.JsonValue | null;
    actorId: string;
    requestId: string;
    resetFailedPages: boolean;
  },
): Promise<{ generation: number; retriedItemCount: number; counts: ItemCounts }> {
  const existing = await tx.genericTaskItem.findUnique({
    where: { taskId_targetType_targetId: {
      taskId: input.taskId,
      targetType: MOBOREADER_CATALOG_TARGET_TYPES.finalize,
      targetId: MOBOREADER_CATALOG_FINALIZE_TARGET_ID,
    } },
    select: { payload: true },
  });
  const existingPayload = finalizePayload(existing?.payload ?? null);
  const result = finalizePayload(input.parentResult);
  const finalization = finalizePayload(result.finalization ?? null);
  const generation = Math.max(
    catalogFinalizeGeneration(existingPayload.generation),
    catalogFinalizeGeneration(finalization.generation),
  ) + 1;
  const payload = {
    kind: MOBOREADER_CATALOG_TARGET_TYPES.finalize,
    actorId: typeof existingPayload.actorId === "string" ? existingPayload.actorId : input.actorId,
    requestId: input.requestId,
    generation,
  } satisfies Prisma.InputJsonObject;

  const retriedItemCount = input.resetFailedPages
    ? (await tx.genericTaskItem.updateMany({
        where: {
          taskId: input.taskId,
          targetType: { in: [MOBOREADER_CATALOG_TARGET_TYPES.page, MOBOREADER_CATALOG_TARGET_TYPES.recoveryPage] },
          status: "failed",
        },
        data: {
          status: "pending", executionToken: null, lockedBy: null, lockedUntil: null,
          heartbeatAt: null, result: Prisma.DbNull, error: Prisma.DbNull, finishedAt: null,
        },
      })).count
    : 0;

  await tx.genericTaskItem.upsert({
    where: { taskId_targetType_targetId: {
      taskId: input.taskId,
      targetType: MOBOREADER_CATALOG_TARGET_TYPES.finalize,
      targetId: MOBOREADER_CATALOG_FINALIZE_TARGET_ID,
    } },
    create: {
      taskId: input.taskId,
      targetType: MOBOREADER_CATALOG_TARGET_TYPES.finalize,
      targetId: MOBOREADER_CATALOG_FINALIZE_TARGET_ID,
      payload,
    },
    update: {
      status: "pending", attemptCount: 0, executionToken: null, lockedBy: null,
      lockedUntil: null, heartbeatAt: null, result: Prisma.DbNull,
      error: Prisma.DbNull, finishedAt: null, payload,
    },
  });
  const [totalCount, successCount, failedCount, skippedCount] = await Promise.all([
    tx.genericTaskItem.count({ where: { taskId: input.taskId, targetType: MOBOREADER_CATALOG_TARGET_TYPES.page } }),
    tx.genericTaskItem.count({ where: { taskId: input.taskId, targetType: MOBOREADER_CATALOG_TARGET_TYPES.page, status: "success" } }),
    tx.genericTaskItem.count({ where: { taskId: input.taskId, targetType: MOBOREADER_CATALOG_TARGET_TYPES.page, status: "failed" } }),
    tx.genericTaskItem.count({ where: { taskId: input.taskId, targetType: MOBOREADER_CATALOG_TARGET_TYPES.page, status: "skipped" } }),
  ]);
  const counts = { totalCount, successCount, failedCount, skippedCount };
  await tx.genericTask.update({
    where: { id: input.taskId },
    data: {
      status: "pending", completedAt: null, error: Prisma.DbNull, ...counts,
      result: {
        ...result,
        finalization: {
          status: "pending",
          targetId: MOBOREADER_CATALOG_FINALIZE_TARGET_ID,
          generation,
        },
        terminalState: "processing",
        previewEnqueue: null,
      },
    },
  });
  return { generation, retriedItemCount, counts };
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
    reason?: unknown;
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
  const reason = optionalBoundedText(input.reason, 2_000);

  try {
    return await withDbRetry(
      () => dependencies.db.$transaction(async (tx) => {
        await lockMutationRequest(tx, input.requestId);
        const parent = await lockParent(tx, family, taskId);
        if (!parent) throw new TaskAdminError("task_admin_not_found", 404);
        if (family === "generic" && isParentBatchTaskType(parent.task_type)) {
          throw new TaskAdminError("task_admin_state_conflict", 409);
        }

        const prior = await committedAudit(tx, TASK_RETRY_AUDIT_ACTION, input.requestId);
        if (prior) return replayRetry(prior, context.identity.id, family, taskId, reason);
        if (!RETRYABLE_PARENT_STATUSES.has(parent.status)) {
          throw new TaskAdminError("task_admin_state_conflict", 409);
        }

        const isCatalogScan = family === "generic" && parent.task_type === MOBOREADER_TASK_TYPES.catalogScan;
        const bindings = isCatalogScan
          ? await tx.genericTaskItem.findMany({
              where: {
                taskId,
                status: "failed",
                targetType: { in: [MOBOREADER_CATALOG_TARGET_TYPES.page, MOBOREADER_CATALOG_TARGET_TYPES.recoveryPage] },
              },
              select: { id: true, targetId: true },
            })
          : await failedBindings(tx, family, taskId);
        if (bindings.length === 0) throw new TaskAdminError("task_admin_state_conflict", 409);
        if (await hasUnresolvedIntent(tx, family, parent, bindings)) {
          throw new TaskAdminError("task_admin_unresolved_intent", 409);
        }

        const catalogRetry = isCatalogScan
          ? await rearmCatalogFinalize(tx, {
              taskId,
              parentResult: parent.result,
              actorId: context.identity.id,
              requestId: input.requestId,
              resetFailedPages: true,
            })
          : null;
        const retriedItemCount = catalogRetry?.retriedItemCount ?? await retryItems(tx, family, taskId);
        if (retriedItemCount !== bindings.length) {
          throw new TaskAdminError("task_admin_concurrent_write", 409);
        }
        const counts = catalogRetry?.counts ?? await recountAndResetParent(tx, family, taskId);
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
              ...(catalogRetry ? { finalizeGeneration: catalogRetry.generation } : {}),
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

export async function retryCatalogFinalizeTask(
  input: {
    authorization: AdminServiceAuthorization;
    requestId: string;
    taskId: unknown;
    reason?: unknown;
  },
  dependencies: TaskAdminMutationDependencies,
): Promise<RetryCatalogFinalizeResult> {
  const context = await requireFreshAdminServiceMutation(input.authorization, "task:manage", {
    identities: dependencies.identities,
    sessions: dependencies.sessions,
    entryId: CATALOG_FINALIZE_RETRY_ENTRY_ID,
    requestId: input.requestId,
    env: dependencies.env,
    now: dependencies.now,
  });
  const taskId = uuid(input.taskId);
  const reason = optionalBoundedText(input.reason, 2_000);
  return withDbRetry(
    () => dependencies.db.$transaction(async (tx) => {
      await lockMutationRequest(tx, input.requestId);
      const parent = await lockParent(tx, "generic", taskId);
      if (!parent) throw new TaskAdminError("task_admin_not_found", 404);
      const prior = await committedAudit(tx, CATALOG_FINALIZE_RETRY_AUDIT_ACTION, input.requestId);
      if (prior) return replayCatalogFinalizeRetry(prior, context.identity.id, taskId, reason);
      if (parent.task_type !== MOBOREADER_TASK_TYPES.catalogScan || !RETRYABLE_PARENT_STATUSES.has(parent.status)) {
        throw new TaskAdminError("task_admin_state_conflict", 409);
      }
      const processingCount = await tx.genericTaskItem.count({ where: { taskId, status: "processing" } });
      if (processingCount !== 0) throw new TaskAdminError("task_admin_concurrent_write", 409);
      const finalizeItem = await tx.genericTaskItem.findUnique({
        where: { taskId_targetType_targetId: {
          taskId,
          targetType: MOBOREADER_CATALOG_TARGET_TYPES.finalize,
          targetId: MOBOREADER_CATALOG_FINALIZE_TARGET_ID,
        } },
        select: { status: true, attemptCount: true },
      });
      if (!finalizeItem || finalizeItem.status !== "failed") {
        throw new TaskAdminError("task_admin_state_conflict", 409);
      }
      const rearmed = await rearmCatalogFinalize(tx, {
        taskId,
        parentResult: parent.result,
        actorId: context.identity.id,
        requestId: input.requestId,
        resetFailedPages: false,
      });
      const audit = await tx.operationAudit.create({
        data: {
          actorType: "admin",
          actorId: context.identity.id,
          action: CATALOG_FINALIZE_RETRY_AUDIT_ACTION,
          entityType: "GenericTask",
          entityId: taskId,
          requestId: input.requestId,
          taskType: MOBOREADER_TASK_TYPES.catalogScan,
          taskId,
          reason,
          beforeSnapshot: { status: parent.status, attemptCount: finalizeItem.attemptCount },
          afterSnapshot: { status: "pending", generation: rearmed.generation },
        },
        select: { id: true },
      });
      return Object.freeze({
        family: "generic" as const,
        taskId,
        status: "pending" as const,
        generation: rearmed.generation,
        wrote: true,
        auditId: audit.id.toString(),
      });
    }),
    { op: "task-admin.retryCatalogFinalizeTask", itemId: taskId, idempotencyKey: input.requestId },
  );
}

// ---------------------------------------------------------------------
// X10 task control: pause / resume / abort
//
// Ported from CPS's `/api/tasks/[id]/{pause,resume,cancel}` (v8.5.1) — same
// three operations, same core semantics (pause stops leasing but leaves
// pending items alone and lets the in-flight one finish; resume continues
// the same task; abort/cancel is irreversible) — adapted to this repo's
// lock-then-write-inside-one-transaction admin-mutation shape (`lockParent`
// already holds `FOR UPDATE` for the whole mutation, which is a strictly
// stronger safety property than CPS's own unconditional-write hazard, but
// the conditional `updateMany` + affected-row check below is kept anyway,
// matching CPS's own belt-and-suspenders comment on its pause route) rather
// than CPS's own findFirst-then-updateMany-with-no-transaction shape, and
// with two capabilities CPS's version does not have:
//
//  1. Abort actually terminates every still-`pending` item
//     (`terminatePendingTaskItems`) instead of only flipping the parent's
//     own status. CPS's `cancel` route never does this — it is exactly the
//     gap `reference_novel_frozen_task_backlog.md` names as the cause of
//     95,860 orphaned `pending` rows here (a `disabled` parent whose items
//     were never driven to any terminal state by anything).
//  2. Every control action additionally records *who* (an admin identity)
//     acted and why, via `src/lib/tasks/task-control.ts`'s marker — CPS has
//     no such concept.
//
// X10 formal statuses (`20260916090000_x10_task_control_paused_cancelled`,
// Owner-approved): pause writes `status = 'paused'`, abort writes `status =
// 'cancelled'` — real CHECK-enforced column values, same as CPS's own bare
// `paused`/`cancelled` statuses, not the interim `disabled` + JSON-marker
// workaround this feature originally shipped with. Every eligibility check
// below reads `status` directly; the marker is carried along purely as
// audit metadata for the detail page's "who/why" line.
//
// `retryFailedTask` above already establishes this file's idempotency-replay
// shape (a mutation request id that resolves to a prior committed
// `OperationAudit` row replays that row's result instead of re-executing);
// these three functions follow it exactly for the same reason: a client
// retry after a dropped response must never risk applying the same control
// action twice.
// ---------------------------------------------------------------------

export type TaskControlResult = Readonly<{
  family: TaskFamily;
  taskId: string;
  status: "paused" | "pending";
  wrote: boolean;
  auditId: string;
}>;

export type AbortTaskResult = Readonly<{
  family: TaskFamily;
  taskId: string;
  status: "cancelled";
  terminatedPendingItemCount: number;
  wrote: boolean;
  auditId: string;
}>;

/**
 * `resumeTask`'s only known precondition today: a `promo_link.claim.v1`
 * task's credential must still be admissible, re-checked the same way the
 * original enqueue gate did (`resolveClaimCredentialAdmission`,
 * Web-safe/non-secret). Every other taskType has no known precondition and
 * resumes unconditionally — this is intentionally a single `if`, not a
 * registry, because there is exactly one precondition in this codebase
 * today; a second taskType growing one is a deliberate, reviewable addition
 * here, not a silent gap.
 */
async function checkResumePrecondition(
  tx: Prisma.TransactionClient,
  taskType: string,
  channelAccountId: string | null,
  now: Date,
): Promise<void> {
  if (taskType !== PROMO_LINK_CLAIM_TASK_TYPE) return;
  if (!channelAccountId) return;
  const admission = await resolveClaimCredentialAdmission(tx, channelAccountId, now);
  if (admission.status === "not_ready") {
    throw new TaskAdminError("task_admin_precondition_failed", 409);
  }
}

function replayTaskControl(
  audit: AuditRow,
  actorId: string,
  family: TaskFamily,
  taskId: string,
  reason: string | null,
  expectedStatus: "paused" | "pending",
): TaskControlResult {
  const after = jsonObject(audit.afterSnapshot);
  if (
    audit.actorId !== actorId
    || audit.entityId !== taskId
    || audit.taskType !== family
    || audit.reason !== reason
    || after?.status !== expectedStatus
  ) {
    throw new TaskAdminError("task_admin_idempotency_conflict", 409);
  }
  return Object.freeze({ family, taskId, status: expectedStatus, wrote: false, auditId: audit.id.toString() });
}

function replayAbort(
  audit: AuditRow,
  actorId: string,
  family: TaskFamily,
  taskId: string,
  reason: string | null,
): AbortTaskResult {
  const after = jsonObject(audit.afterSnapshot);
  if (
    audit.actorId !== actorId
    || audit.entityId !== taskId
    || audit.taskType !== family
    || audit.reason !== reason
    || after?.status !== "cancelled"
    || typeof after.terminatedPendingItemCount !== "number"
  ) {
    throw new TaskAdminError("task_admin_idempotency_conflict", 409);
  }
  return Object.freeze({
    family,
    taskId,
    status: "cancelled",
    terminatedPendingItemCount: after.terminatedPendingItemCount,
    wrote: false,
    auditId: audit.id.toString(),
  });
}

/**
 * Pause — stop leasing new items; every still-`pending` item is left exactly
 * as `pending`; whichever item is currently `processing` finishes normally
 * (its own `finalizeTaskItem` never consults the parent's status at all, and
 * `recomputeParentTask`'s own `status = 'disabled'` guard,
 * `src/lib/tasks/store.ts`, keeps this pause from being silently reverted
 * the moment that item's finalize runs).
 */
export async function pauseTask(
  input: {
    authorization: AdminServiceAuthorization;
    requestId: string;
    family: unknown;
    taskId: unknown;
    reason?: unknown;
  },
  dependencies: TaskAdminMutationDependencies,
): Promise<TaskControlResult> {
  const context = await requireFreshAdminServiceMutation(input.authorization, "task:manage", {
    identities: dependencies.identities,
    sessions: dependencies.sessions,
    entryId: TASK_PAUSE_ENTRY_ID,
    requestId: input.requestId,
    env: dependencies.env,
    now: dependencies.now,
  });
  const family = oneOf(input.family, TASK_FAMILIES);
  const taskId = uuid(input.taskId);
  const reason = optionalBoundedText(input.reason, 2_000);
  const now = dependencies.now ?? new Date();

  return withDbRetry(
    () =>
      dependencies.db.$transaction(async (tx) => {
        await lockMutationRequest(tx, input.requestId);
        const parent = await lockParent(tx, family, taskId);
        if (!parent) throw new TaskAdminError("task_admin_not_found", 404);

        const prior = await committedAudit(tx, TASK_PAUSE_AUDIT_ACTION, input.requestId);
        if (prior) return replayTaskControl(prior, context.identity.id, family, taskId, reason, "paused");

        if (!["pending", "processing"].includes(parent.status)) {
          throw new TaskAdminError("task_admin_state_conflict", 409);
        }

        const marker: TaskControlMarker = {
          kind: "paused",
          source: "manual",
          at: now.toISOString(),
          actorId: context.identity.id,
          reason,
        };
        // X10 formal statuses: `status = 'paused'` is a real CHECK-enforced
        // value now — the marker above is merged into `result` purely as
        // audit metadata (who/why), never read back to decide state.
        const updateData = { status: "paused" as const, result: mergeTaskControlResult(parent.result, marker) };
        const updated = family === "channel_sync"
          ? await tx.channelSyncTask.updateMany({ where: { id: taskId, status: { in: ["pending", "processing"] } }, data: updateData })
          : await tx.genericTask.updateMany({ where: { id: taskId, status: { in: ["pending", "processing"] } }, data: updateData });
        if (updated.count !== 1) throw new TaskAdminError("task_admin_concurrent_write", 409);

        const audit = await tx.operationAudit.create({
          data: {
            actorType: "admin",
            actorId: context.identity.id,
            action: TASK_PAUSE_AUDIT_ACTION,
            entityType: "Task",
            entityId: taskId,
            requestId: input.requestId,
            taskType: family,
            taskId,
            reason,
            beforeSnapshot: { status: parent.status },
            afterSnapshot: { status: "paused" },
          },
          select: { id: true },
        });
        return Object.freeze({ family, taskId, status: "paused" as const, wrote: true, auditId: audit.id.toString() });
      }),
    { op: "task-admin.pauseTask", itemId: taskId, idempotencyKey: input.requestId },
  );
}

/**
 * Resume — re-validates {@link checkResumePrecondition} first (inside the
 * same locked transaction, so a resume can never race a concurrent
 * pause/abort of the same task), then continues the same task's remaining
 * `pending` items. Only ever accepts `status === "paused"` — checked
 * directly on the real column, never by reading the `taskControl` marker —
 * so a `disabled` row (a legacy out-of-band row, a feature-flag-off row, a
 * catalog-batch double-gate refusal, or the worker's own system hold) and a
 * `cancelled` (aborted) row are both refused, never resumed.
 *
 * Retry-failed is a deliberately separate concern (`retryFailedTask` above,
 * which only ever accepts `failed`/`completed_with_errors`) and is never
 * folded into resume.
 */
export async function resumeTask(
  input: {
    authorization: AdminServiceAuthorization;
    requestId: string;
    family: unknown;
    taskId: unknown;
  },
  dependencies: TaskAdminMutationDependencies,
): Promise<TaskControlResult> {
  const context = await requireFreshAdminServiceMutation(input.authorization, "task:manage", {
    identities: dependencies.identities,
    sessions: dependencies.sessions,
    entryId: TASK_RESUME_ENTRY_ID,
    requestId: input.requestId,
    env: dependencies.env,
    now: dependencies.now,
  });
  const family = oneOf(input.family, TASK_FAMILIES);
  const taskId = uuid(input.taskId);
  const now = dependencies.now ?? new Date();

  return withDbRetry(
    () =>
      dependencies.db.$transaction(async (tx) => {
        await lockMutationRequest(tx, input.requestId);
        const parent = await lockParent(tx, family, taskId);
        if (!parent) throw new TaskAdminError("task_admin_not_found", 404);

        const prior = await committedAudit(tx, TASK_RESUME_AUDIT_ACTION, input.requestId);
        if (prior) return replayTaskControl(prior, context.identity.id, family, taskId, null, "pending");

        // X10 formal statuses: eligibility is decided off `status` alone —
        // `"paused"` is a real CHECK-enforced column value now, so there is
        // no longer any need (and, per this feature's own "never determine
        // state from JSON" rule, no longer any license) to also inspect the
        // `taskControl` marker here. A `disabled` row (system hold, a
        // legacy/flag-off/double-gate reason) is never resumable through
        // this path — only `paused` is.
        if (parent.status !== "paused") {
          throw new TaskAdminError("task_admin_state_conflict", 409);
        }
        // 阶段2 第4步：拒绝对一个生命周期分片的直接单任务恢复——分片一旦被
        // 暂停，只能通过批次级恢复（`resumePromoClaimBatch`）交还成
        // `disabled` + `awaiting_release`，重新交给 scheduler 走 D1/D5/D4
        // 全套前置检查。如果这里放行，运营通过 `/tasks/<shardId>` 上的旧版
        // 通用"恢复"按钮就能直接把分片改回 `pending`，绕开这些检查——见
        // `isLifecycleShardParams` 自己的 doc comment。
        if (parent.task_type === PROMO_LINK_CLAIM_TASK_TYPE && isLifecycleShardParams(parent.params)) {
          throw new TaskAdminError("task_admin_state_conflict", 409);
        }

        await checkResumePrecondition(tx, parent.task_type, parent.channel_account_id, now);

        const updateData = { status: "pending" as const };
        const updated = family === "channel_sync"
          ? await tx.channelSyncTask.updateMany({ where: { id: taskId, status: "paused" }, data: updateData })
          : await tx.genericTask.updateMany({ where: { id: taskId, status: "paused" }, data: updateData });
        if (updated.count !== 1) throw new TaskAdminError("task_admin_concurrent_write", 409);

        const audit = await tx.operationAudit.create({
          data: {
            actorType: "admin",
            actorId: context.identity.id,
            action: TASK_RESUME_AUDIT_ACTION,
            entityType: "Task",
            entityId: taskId,
            requestId: input.requestId,
            taskType: family,
            taskId,
            reason: null,
            beforeSnapshot: { status: "paused" },
            afterSnapshot: { status: "pending" },
          },
          select: { id: true },
        });
        return Object.freeze({ family, taskId, status: "pending" as const, wrote: true, auditId: audit.id.toString() });
      }),
    { op: "task-admin.resumeTask", itemId: taskId, idempotencyKey: input.requestId },
  );
}

/**
 * Abort — irreversible. Stops leasing (every still-`pending` item is
 * terminated via `terminatePendingTaskItems` in the same transaction, so
 * nothing is ever left orphaned the way CPS's own `cancel` route leaves
 * behind); whichever item is currently `processing` finishes normally;
 * history is never deleted or rewritten — every already-`success`/`failed`/
 * `skipped` item keeps its own outcome untouched, and this action never
 * revisits a task it has already aborted (writing `status = "cancelled"` — a
 * real CHECK-enforced value, not a marker — pins that state, and a second
 * abort attempt on the same task is refused by the eligibility check below,
 * not silently accepted as a no-op).
 */
export async function abortTask(
  input: {
    authorization: AdminServiceAuthorization;
    requestId: string;
    family: unknown;
    taskId: unknown;
    reason?: unknown;
  },
  dependencies: TaskAdminMutationDependencies,
): Promise<AbortTaskResult> {
  const context = await requireFreshAdminServiceMutation(input.authorization, "task:manage", {
    identities: dependencies.identities,
    sessions: dependencies.sessions,
    entryId: TASK_ABORT_ENTRY_ID,
    requestId: input.requestId,
    env: dependencies.env,
    now: dependencies.now,
  });
  const family = oneOf(input.family, TASK_FAMILIES);
  const taskId = uuid(input.taskId);
  const reason = optionalBoundedText(input.reason, 2_000);
  const now = dependencies.now ?? new Date();

  return withDbRetry(
    () =>
      dependencies.db.$transaction(async (tx) => {
        await lockMutationRequest(tx, input.requestId);
        const parent = await lockParent(tx, family, taskId);
        if (!parent) throw new TaskAdminError("task_admin_not_found", 404);

        const prior = await committedAudit(tx, TASK_ABORT_AUDIT_ACTION, input.requestId);
        if (prior) return replayAbort(prior, context.identity.id, family, taskId, reason);

        // X10 formal statuses: eligibility is decided off `status` alone —
        // `"paused"` is a real CHECK-enforced column value now, so aborting a
        // paused task no longer needs to also inspect the `taskControl`
        // marker (a `disabled` row — system hold, legacy/flag-off/
        // double-gate — is never eligible here; only pending/processing/
        // paused are).
        const eligible = ["pending", "processing", "paused"].includes(parent.status);
        if (!eligible) throw new TaskAdminError("task_admin_state_conflict", 409);

        const { terminatedCount } = await terminatePendingTaskItems(tx, family, taskId, {
          code: TASK_ABORT_TERMINATION_REASON,
          message: "Task was manually aborted before this item was ever attempted",
        });
        const marker: TaskControlMarker = {
          kind: "aborted",
          source: "manual",
          at: now.toISOString(),
          actorId: context.identity.id,
          reason,
          terminatedPendingItemCount: terminatedCount,
        };
        // X10 formal statuses: `status = 'cancelled'` is a real CHECK-enforced
        // value now — the marker above is merged into `result` purely as
        // audit metadata (who/why), never read back to decide state.
        const updateData = { status: "cancelled" as const, result: mergeTaskControlResult(parent.result, marker) };
        const updated = family === "channel_sync"
          ? await tx.channelSyncTask.updateMany({ where: { id: taskId, status: parent.status }, data: updateData })
          : await tx.genericTask.updateMany({ where: { id: taskId, status: parent.status }, data: updateData });
        if (updated.count !== 1) throw new TaskAdminError("task_admin_concurrent_write", 409);

        const audit = await tx.operationAudit.create({
          data: {
            actorType: "admin",
            actorId: context.identity.id,
            action: TASK_ABORT_AUDIT_ACTION,
            entityType: "Task",
            entityId: taskId,
            requestId: input.requestId,
            taskType: family,
            taskId,
            reason,
            beforeSnapshot: { status: parent.status },
            afterSnapshot: { status: "cancelled", terminatedPendingItemCount: terminatedCount },
          },
          select: { id: true },
        });
        return Object.freeze({
          family,
          taskId,
          status: "cancelled" as const,
          terminatedPendingItemCount: terminatedCount,
          wrote: true,
          auditId: audit.id.toString(),
        });
      }),
    { op: "task-admin.abortTask", itemId: taskId, idempotencyKey: input.requestId },
  );
}

// ---------------------------------------------------------------------
// 阶段2 第4步（施工任务 3.1/3.3）：批次级暂停 / 恢复 / 中止 / 重新批准。
//
// 这四个函数只是薄壳：2FA（`requireFreshAdminServiceMutation`）、幂等重放
// （`committedAudit` + 本文件既有的 `replayTaskControl`/`replayAbort` 同一
// 手法）、把 `@/lib/tasks/promo-claim-batch-control.ts` 返回的判别联合翻译成
// `TaskAdminError`——真正的批次↔分片级联判定与写入全部在那个模块里，这里不
// 重复实现。只对生命周期批次（`lifecycleVersion === 1 && lifecycleRole ===
// "batch"` 的 `batch.materialize.v1` 父任务）生效；对任何其它任务调用，
// `pausePromoClaimBatchTx` 等函数会返回 `not_lifecycle_batch`，翻译成
// `task_admin_invalid_request`（400）——旧路径的单任务 `pauseTask`/
// `resumeTask`/`abortTask` 完全不受影响，行为零变化。
// ---------------------------------------------------------------------

export type PromoClaimBatchControlDto = Readonly<{
  batchId: string;
  status: "paused" | "pending" | "cancelled";
  pausedShardCount?: number;
  releasedShardCount?: number;
  terminatedShardCount?: number;
  terminatedItemCount?: number;
  wrote: boolean;
  auditId: string;
}>;

export type PromoClaimBatchReapproveDto = Readonly<{
  batchId: string;
  status: "pending";
  approvedAt: string;
  approvalValidUntil: string;
  wrote: boolean;
  auditId: string;
}>;

function throwPromoClaimBatchControlError(error: PromoClaimBatchControlError): never {
  if (error === "not_found") throw new TaskAdminError("task_admin_not_found", 404);
  if (error === "not_lifecycle_batch") throw new TaskAdminError("task_admin_invalid_request", 400);
  throw new TaskAdminError("task_admin_state_conflict", 409);
}

function replayPromoClaimBatchPause(audit: AuditRow, actorId: string, batchId: string, reason: string | null): PromoClaimBatchControlDto {
  const after = jsonObject(audit.afterSnapshot);
  if (
    audit.actorId !== actorId || audit.entityId !== batchId || audit.reason !== reason
    || after?.status !== "paused" || !Array.isArray(after.pausedShardIds)
  ) {
    throw new TaskAdminError("task_admin_idempotency_conflict", 409);
  }
  return Object.freeze({
    batchId, status: "paused" as const, pausedShardCount: after.pausedShardIds.length, wrote: false, auditId: audit.id.toString(),
  });
}

function replayPromoClaimBatchResume(audit: AuditRow, actorId: string, batchId: string): PromoClaimBatchControlDto {
  const after = jsonObject(audit.afterSnapshot);
  if (
    audit.actorId !== actorId || audit.entityId !== batchId || audit.reason !== null
    || after?.status !== "pending" || !Array.isArray(after.releasedShardIds)
  ) {
    throw new TaskAdminError("task_admin_idempotency_conflict", 409);
  }
  return Object.freeze({
    batchId, status: "pending" as const, releasedShardCount: after.releasedShardIds.length, wrote: false, auditId: audit.id.toString(),
  });
}

function replayPromoClaimBatchAbort(audit: AuditRow, actorId: string, batchId: string, reason: string | null): PromoClaimBatchControlDto {
  const after = jsonObject(audit.afterSnapshot);
  if (
    audit.actorId !== actorId || audit.entityId !== batchId || audit.reason !== reason
    || after?.status !== "cancelled" || !Array.isArray(after.terminatedShardIds) || typeof after.terminatedItemCount !== "number"
  ) {
    throw new TaskAdminError("task_admin_idempotency_conflict", 409);
  }
  return Object.freeze({
    batchId, status: "cancelled" as const, terminatedShardCount: after.terminatedShardIds.length,
    terminatedItemCount: after.terminatedItemCount, wrote: false, auditId: audit.id.toString(),
  });
}

function replayPromoClaimBatchReapprove(audit: AuditRow, actorId: string, batchId: string): PromoClaimBatchReapproveDto {
  const after = jsonObject(audit.afterSnapshot);
  if (
    audit.actorId !== actorId || audit.entityId !== batchId || audit.reason !== null
    || after?.status !== "pending" || typeof after.approvedAt !== "string" || typeof after.approvalValidUntil !== "string"
  ) {
    throw new TaskAdminError("task_admin_idempotency_conflict", 409);
  }
  return Object.freeze({
    batchId, status: "pending" as const, approvedAt: after.approvedAt, approvalValidUntil: after.approvalValidUntil,
    wrote: false, auditId: audit.id.toString(),
  });
}

export async function pausePromoClaimBatch(
  input: { authorization: AdminServiceAuthorization; requestId: string; taskId: unknown; reason?: unknown },
  dependencies: TaskAdminMutationDependencies,
): Promise<PromoClaimBatchControlDto> {
  const context = await requireFreshAdminServiceMutation(input.authorization, "task:manage", {
    identities: dependencies.identities,
    sessions: dependencies.sessions,
    entryId: PROMO_CLAIM_BATCH_PAUSE_ENTRY_ID,
    requestId: input.requestId,
    env: dependencies.env,
    now: dependencies.now,
  });
  const batchId = uuid(input.taskId);
  const reason = optionalBoundedText(input.reason, 2_000);
  const now = dependencies.now ?? new Date();

  return withDbRetry(
    () =>
      dependencies.db.$transaction(async (tx) => {
        await lockMutationRequest(tx, input.requestId);
        const prior = await committedAudit(tx, PROMO_CLAIM_BATCH_PAUSE_AUDIT_ACTION, input.requestId);
        if (prior) return replayPromoClaimBatchPause(prior, context.identity.id, batchId, reason);

        const result = await pausePromoClaimBatchTx(tx, { batchId, actorId: context.identity.id, reason, requestId: input.requestId, now });
        if (!result.ok) throwPromoClaimBatchControlError(result.error);
        return Object.freeze({
          batchId: result.batchId, status: "paused" as const, pausedShardCount: result.pausedShardIds.length,
          wrote: true, auditId: result.auditId,
        });
      }),
    { op: "task-admin.pausePromoClaimBatch", itemId: batchId, idempotencyKey: input.requestId },
  );
}

export async function resumePromoClaimBatch(
  input: { authorization: AdminServiceAuthorization; requestId: string; taskId: unknown },
  dependencies: TaskAdminMutationDependencies,
): Promise<PromoClaimBatchControlDto> {
  const context = await requireFreshAdminServiceMutation(input.authorization, "task:manage", {
    identities: dependencies.identities,
    sessions: dependencies.sessions,
    entryId: PROMO_CLAIM_BATCH_RESUME_ENTRY_ID,
    requestId: input.requestId,
    env: dependencies.env,
    now: dependencies.now,
  });
  const batchId = uuid(input.taskId);
  const now = dependencies.now ?? new Date();

  return withDbRetry(
    () =>
      dependencies.db.$transaction(async (tx) => {
        await lockMutationRequest(tx, input.requestId);
        const prior = await committedAudit(tx, PROMO_CLAIM_BATCH_RESUME_AUDIT_ACTION, input.requestId);
        if (prior) return replayPromoClaimBatchResume(prior, context.identity.id, batchId);

        const result = await resumePromoClaimBatchTx(tx, { batchId, actorId: context.identity.id, requestId: input.requestId, now });
        if (!result.ok) throwPromoClaimBatchControlError(result.error);
        return Object.freeze({
          batchId: result.batchId, status: "pending" as const, releasedShardCount: result.releasedShardIds.length,
          wrote: true, auditId: result.auditId,
        });
      }),
    { op: "task-admin.resumePromoClaimBatch", itemId: batchId, idempotencyKey: input.requestId },
  );
}

export async function abortPromoClaimBatch(
  input: { authorization: AdminServiceAuthorization; requestId: string; taskId: unknown; reason?: unknown },
  dependencies: TaskAdminMutationDependencies,
): Promise<PromoClaimBatchControlDto> {
  const context = await requireFreshAdminServiceMutation(input.authorization, "task:manage", {
    identities: dependencies.identities,
    sessions: dependencies.sessions,
    entryId: PROMO_CLAIM_BATCH_ABORT_ENTRY_ID,
    requestId: input.requestId,
    env: dependencies.env,
    now: dependencies.now,
  });
  const batchId = uuid(input.taskId);
  const reason = optionalBoundedText(input.reason, 2_000);
  const now = dependencies.now ?? new Date();

  return withDbRetry(
    () =>
      dependencies.db.$transaction(async (tx) => {
        await lockMutationRequest(tx, input.requestId);
        const prior = await committedAudit(tx, PROMO_CLAIM_BATCH_ABORT_AUDIT_ACTION, input.requestId);
        if (prior) return replayPromoClaimBatchAbort(prior, context.identity.id, batchId, reason);

        const result = await abortPromoClaimBatchTx(tx, { batchId, actorId: context.identity.id, reason, requestId: input.requestId, now });
        if (!result.ok) throwPromoClaimBatchControlError(result.error);
        return Object.freeze({
          batchId: result.batchId, status: "cancelled" as const, terminatedShardCount: result.terminatedShardIds.length,
          terminatedItemCount: result.terminatedItemCount, wrote: true, auditId: result.auditId,
        });
      }),
    { op: "task-admin.abortPromoClaimBatch", itemId: batchId, idempotencyKey: input.requestId },
  );
}

/**
 * 3.3：重新批准。仅当批次停在 `system_hold:approval_expired` 且从未放行过
 * 任何分片时允许——见 `reapprovePromoClaimBatchTx` 自己的 doc comment。
 */
export async function reapprovePromoClaimBatch(
  input: { authorization: AdminServiceAuthorization; requestId: string; taskId: unknown },
  dependencies: TaskAdminMutationDependencies,
): Promise<PromoClaimBatchReapproveDto> {
  const context = await requireFreshAdminServiceMutation(input.authorization, "task:manage", {
    identities: dependencies.identities,
    sessions: dependencies.sessions,
    entryId: PROMO_CLAIM_BATCH_REAPPROVE_ENTRY_ID,
    requestId: input.requestId,
    env: dependencies.env,
    now: dependencies.now,
  });
  const batchId = uuid(input.taskId);
  const now = dependencies.now ?? new Date();
  const env = dependencies.env ?? process.env;
  const config = resolvePromoClaimLifecycleConfig(env);

  return withDbRetry(
    () =>
      dependencies.db.$transaction(async (tx) => {
        await lockMutationRequest(tx, input.requestId);
        const prior = await committedAudit(tx, PROMO_CLAIM_BATCH_REAPPROVE_AUDIT_ACTION, input.requestId);
        if (prior) return replayPromoClaimBatchReapprove(prior, context.identity.id, batchId);

        const result = await reapprovePromoClaimBatchTx(tx, { batchId, actorId: context.identity.id, requestId: input.requestId, now, config });
        if (!result.ok) throwPromoClaimBatchControlError(result.error);
        return Object.freeze({
          batchId: result.batchId, status: "pending" as const, approvedAt: result.approvedAt, approvalValidUntil: result.approvalValidUntil,
          wrote: true, auditId: result.auditId,
        });
      }),
    { op: "task-admin.reapprovePromoClaimBatch", itemId: batchId, idempotencyKey: input.requestId },
  );
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
