/**
 * Administrative task-control marker for `GenericTask`/`ChannelSyncTask`.
 *
 * X10 formal statuses (`20260916090000_x10_task_control_paused_cancelled`,
 * Owner-approved): `generic_task_status_check`/`channel_sync_task_status_check`
 * now allow `'paused'`/`'cancelled'` as real values alongside the original
 * six (pinned by `tests/integration/tasks/p1-13-postgres-acceptance.test.ts`).
 * Manual pause writes `status = 'paused'`; manual abort writes `status =
 * 'cancelled'`. **State is always read off that column, never off this
 * module's marker** — the admin service's `resumeTask`/`abortTask`
 * eligibility checks, the tasks-list/detail UI, and
 * `recomputeParentTask`'s guard (`src/lib/tasks/store.ts`) all key on
 * `status` directly.
 *
 * This module's marker is retained purely as **audit metadata** — who
 * (`actorId`) did what and why (`reason`), and when (`at`) — for display on
 * the task-detail page. It must never again be the thing that decides *what
 * state* a row is in for pause/abort; see `readTaskControlMarker`'s own doc
 * comment on why it is still useful to read (system hold's own
 * disambiguation, described next), not for deciding pause/abort eligibility.
 *
 * One case still relies on the pre-migration `'disabled'` + marker shape,
 * unchanged and deliberately out of this migration's scope: the worker's own
 * first-occurrence system hold (`worker/handlers/promo-link-claim-system-hold.ts`)
 * still writes `status = 'disabled'` with `kind: 'system_hold'`, because
 * `'disabled'` is *also* reused for three older, unrelated meanings that
 * predate this module: (1) the 271 legacy rows an operator flipped
 * out-of-band with no product support; (2) a `promo_link.claim.v1` task
 * created directly `disabled` because its write feature flag was off at
 * creation time (`src/lib/tasks/promo-link-claim.ts`); (3) a
 * `catalog_batch`-family child task disabled by the double
 * credential/capability gate. None of those three ever carries this
 * module's marker, so "marker present with `kind: 'system_hold'`" stays a
 * safe, additive fourth meaning on `disabled` rows that never collides with
 * the first three — an absent marker on a `disabled` row is exactly one of
 * those three earlier cases and must never be treated as ours (see
 * `reference_novel_..._sop.md`/this task family's own delivery notes for the
 * explicit instruction to never retrofit the 271 legacy rows).
 *
 * This module is deliberately pure (no DB, no Prisma import beyond the
 * `Json` value types) so it can be imported from the worker (system hold),
 * the admin service (pause/resume/abort + DTO projection) and tests alike,
 * the same "Web/worker-safe shared policy" shape as
 * `src/lib/credentials/claim-readiness.ts`'s `classifyCredentialRowsForClaim`.
 *
 * Promo-claim lifecycle (阶段2 第 1 步, `docs/adr/ADR-PROMO-CLAIM-BATCH-
 * LIFECYCLE.md`) adds a fifth meaning to a `disabled` row's marker, additive
 * next to the fourth (`kind: "system_hold"`, described above) and never
 * colliding with the three pre-existing unmarked meanings: `kind:
 * "awaiting_release"` — a lifecycle shard (`promo_link.claim.v1` child task)
 * created `disabled` by `worker/handlers/catalog-batch.ts`'s enumeration
 * (step 2, not yet built) *before* the scheduler (step 3, not yet built) has
 * ever released it. Same rule as every other kind here: `status ===
 * "disabled"` is what makes the row non-runnable; this marker is audit/
 * display metadata (which of the five reasons), never itself consulted by
 * the admin mutation service's `resumeTask`/`abortTask`/`retryFailedTask`
 * (the task-admin module under `src/server`) to decide eligibility — those already
 * key on `status` alone (`"paused"` for resume, `{"pending","processing",
 * "paused"}` for abort, `{"failed","completed_with_errors"}` for retry), so
 * a `disabled` "awaiting_release" row is structurally refused by all three
 * without needing a new check: only the scheduler is meant to move a shard
 * out of `awaiting_release` (D7), never a manual resume/retry.
 *
 * The lifecycle's five `system_hold` `reasonCode` values
 * (`approval_expired`/`credential_not_ready`/`deadline_missed`/
 * `deadline_missed_twice`/`lifecycle_disabled`) are free-form strings under
 * the existing `kind: "system_hold"`, exactly like every other reasonCode
 * this module already carries (e.g. `credential_validation_failed` from
 * `worker/handlers/promo-link-claim-system-hold.ts`) — they are not enums
 * enforced here. The literal set lives in `src/lib/tasks/promo-claim-
 * lifecycle.ts`'s `PROMO_CLAIM_SYSTEM_HOLD_REASON_CODES`, not in this module,
 * so this file stays the generic (kind, source, reasonCode) shape and the
 * lifecycle's own vocabulary stays in its own domain module.
 */
import type { Prisma } from "@prisma/client";

export const TASK_CONTROL_KINDS = ["paused", "aborted", "system_hold", "awaiting_release"] as const;
export type TaskControlKind = (typeof TASK_CONTROL_KINDS)[number];

export const TASK_CONTROL_SOURCES = ["manual", "system"] as const;
export type TaskControlSource = (typeof TASK_CONTROL_SOURCES)[number];

/**
 * The key this module owns inside `GenericTask.result`/`ChannelSyncTask.result`.
 * Every write merges under this one key (`mergeTaskControlResult` below) so a
 * taskType's own legitimate `result` fields (`stopReason`,
 * `blockedReasonCounts`, `enumerationStatus`, ...) are never clobbered.
 */
const RESULT_KEY = "taskControl" as const;

export interface TaskControlMarker {
  readonly kind: TaskControlKind;
  readonly source: TaskControlSource;
  /** ISO-8601 instant the control action took effect. */
  readonly at: string;
  /** Admin identity id. Manual actions only (`source === "manual"`); absent/null for a system hold. */
  readonly actorId?: string | null;
  /** Free-text operator-supplied reason. Manual actions only. */
  readonly reason?: string | null;
  /** Stable failure-class code. `system_hold` only — the deterministic failure code that triggered the halt. */
  readonly reasonCode?: string;
  /** How many still-`pending` items were terminated as part of this control action (abort/system_hold only). */
  readonly terminatedPendingItemCount?: number;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isTaskControlKind(value: unknown): value is TaskControlKind {
  return typeof value === "string" && (TASK_CONTROL_KINDS as readonly string[]).includes(value);
}

function isTaskControlSource(value: unknown): value is TaskControlSource {
  return typeof value === "string" && (TASK_CONTROL_SOURCES as readonly string[]).includes(value);
}

/**
 * Reads and validates the marker out of a `result` blob (already parsed
 * JSON, e.g. `GenericTask.result`). Returns `undefined` for anything that
 * does not match the exact shape — a `disabled` row with no marker (one of
 * the three pre-existing meanings above) or a malformed/foreign value both
 * read the same way: "not ours".
 */
export function readTaskControlMarker(result: unknown): TaskControlMarker | undefined {
  const object = plainObject(result);
  const marker = object ? plainObject(object[RESULT_KEY]) : null;
  if (!marker) return undefined;
  if (!isTaskControlKind(marker.kind) || !isTaskControlSource(marker.source) || typeof marker.at !== "string") {
    return undefined;
  }
  const actorId = typeof marker.actorId === "string" ? marker.actorId : null;
  const reason = typeof marker.reason === "string" ? marker.reason : null;
  const reasonCode = typeof marker.reasonCode === "string" ? marker.reasonCode : undefined;
  const terminatedPendingItemCount = typeof marker.terminatedPendingItemCount === "number"
    && Number.isSafeInteger(marker.terminatedPendingItemCount)
    ? marker.terminatedPendingItemCount
    : undefined;
  return Object.freeze({
    kind: marker.kind,
    source: marker.source,
    at: marker.at,
    actorId,
    reason,
    ...(reasonCode !== undefined ? { reasonCode } : {}),
    ...(terminatedPendingItemCount !== undefined ? { terminatedPendingItemCount } : {}),
  });
}

/**
 * Merges `marker` into `existingResult` under {@link RESULT_KEY}, preserving
 * every other field already on the row's `result` (e.g. a `catalog_scan`
 * task's `stopReason`). Never a blind overwrite — a control action must
 * never destroy a taskType's own business-result fields.
 */
export function mergeTaskControlResult(
  existingResult: unknown,
  marker: TaskControlMarker,
): Prisma.InputJsonObject {
  const base = plainObject(existingResult) ?? {};
  return { ...base, [RESULT_KEY]: { ...marker } } as unknown as Prisma.InputJsonObject;
}

/**
 * True exactly when the row's own marker says `kind: "paused"`. Audit/display
 * only — as of X10's formal statuses, nothing in this codebase uses this to
 * decide whether a row is actually resumable; that question is `status ===
 * "paused"` (a real CHECK-enforced column value), checked directly by the
 * admin service's `resumeTask`/`abortTask` and never by reading this marker.
 * Kept for the one case where the marker is still the
 * only way to disambiguate a `disabled` row's meaning — this reads the same
 * way for a `disabled` row the worker's system hold marked `kind:
 * "system_hold"`, so callers wanting "specifically an operator's pause" over
 * "any disabled reason" still have this available — never as a substitute
 * for the `status` column.
 */
export function isPausedByTaskControl(result: unknown): boolean {
  return readTaskControlMarker(result)?.kind === "paused";
}
