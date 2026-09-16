/**
 * Administrative task-control marker for `GenericTask`/`ChannelSyncTask`.
 *
 * `generic_task_status_check`/`channel_sync_task_status_check` (both from
 * `prisma/migrations/20260803090000_p1_initial_schema/migration.sql`) are
 * real Postgres CHECK constraints — `status` may only ever be one of
 * `'pending' | 'processing' | 'completed' | 'completed_with_errors' |
 * 'failed' | 'disabled'` (pinned again by
 * `tests/integration/tasks/p1-13-postgres-acceptance.test.ts`). There is no
 * room in that closed set for a literal `'paused'`/`'aborted'`/
 * `'system_hold'` value without a schema migration, which this work is
 * explicitly forbidden from adding.
 *
 * `'disabled'` — "Task is retained but execution is administratively
 * prohibited" (`src/domain/database-statuses.ts`) — is already the row's
 * only "administratively pulled out of the runnable set" bucket, and is
 * already reused for three distinct existing meanings before this module
 * ever existed: (1) the 271 legacy rows an operator flipped out-of-band with
 * no product support; (2) a `promo_link.claim.v1` task created directly
 * `disabled` because its write feature flag was off at creation time
 * (`src/lib/tasks/promo-link-claim.ts`); (3) a `catalog_batch`-family child
 * task disabled by the double credential/capability gate. None of the three
 * ever carries this module's marker, so "marker present" is a safe,
 * additive fourth meaning that never collides with the first three — an
 * absent marker on a `disabled` row is exactly one of those three earlier
 * cases and must never be treated as ours (see `reference_novel_..._sop.md`/
 * this task family's own delivery notes for the explicit instruction to
 * never retrofit the 271 legacy rows).
 *
 * This module is deliberately pure (no DB, no Prisma import beyond the
 * `Json` value types) so it can be imported from the worker (system hold),
 * the admin service (pause/resume/abort + DTO projection) and tests alike,
 * the same "Web/worker-safe shared policy" shape as
 * `src/lib/credentials/claim-readiness.ts`'s `classifyCredentialRowsForClaim`.
 */
import type { Prisma } from "@prisma/client";

export const TASK_CONTROL_KINDS = ["paused", "aborted", "system_hold"] as const;
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

/** True exactly when the row's own marker says an operator paused it (resumable). */
export function isPausedByTaskControl(result: unknown): boolean {
  return readTaskControlMarker(result)?.kind === "paused";
}
