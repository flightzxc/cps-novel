/**
 * Task-level system hold for the promo-link claim chain.
 *
 * 2026-09-14 incident this exists to prevent: a 79,217-item batch was
 * enqueued against a credential that had never once validated successfully.
 * Every item failed inside `decryptCredentialSecretForWorker` with
 * `credential_validation_failed`; in ~18 minutes the worker burned ~44,000
 * items to permanent `failed` at ~10ms each, because nothing watched for
 * "this task is failing the exact same deterministic way on every single
 * item" and stopped it. `src/app/(admin)/catalog-sync/_actions.ts`'s
 * pre-flight readiness gate (`resolveClaimCredentialReadiness`) closes the
 * *first* half of this — refusing to even start a batch on a credential that
 * cannot be used right now. This module closes the second half: a batch
 * that somehow still starts failing this way (the credential is superseded/
 * revoked moments *after* the gate cleared it, or a scope reused an
 * already-broken credential) must halt on its own, not grind through the
 * rest of the batch.
 *
 * This module replaces an earlier `maybeTripPromoLinkClaimCircuitBreaker`
 * that required 3 *consecutive* deterministic-class failures (checked
 * against the most recently finalized sibling items) before halting. The
 * Owner rejected that shape: `DETERMINISTIC_CREDENTIAL_FAILURE_CODES`
 * (`src/lib/credentials/claim-readiness.ts`) are, by construction, an
 * account-level fact — a task's items all share one `channelAccountId` — so
 * one of these codes is either true for literally every item in the task or
 * none of them. It can never be "a few scattered bad rows" the way a
 * per-item data problem can, so there is nothing to count: the *class* of
 * the failure is the whole justification, not how many times it has
 * happened. Counting to 3 before halting only meant burning up to 2 extra
 * items (and, at scale, an unbounded number if the eligibility window ever
 * missed a beat) for a fact that was already fully known on the first
 * occurrence. This module halts on that first occurrence instead — no
 * counting, no ratio, no threshold constant, and consequently no sibling
 * history query at all.
 *
 * Every transient upstream class (`transport_error`, `request_timeout`,
 * `upstream_http_error`, `malformed_payload` —
 * `src/lib/adapters/promo-link-claim.ts`) and every per-row data-quality
 * class (`claim_source_fields_missing`, `claim_readback_target_missing`,
 * etc.) is deliberately excluded: per-item retry (a fresh explicit task) is
 * already the correct recovery for those, and this module must never stand
 * in for it.
 */
import { Prisma } from "@prisma/client";
import { DETERMINISTIC_CREDENTIAL_FAILURE_CODES } from "../../src/lib/credentials/claim-readiness";
import { PROMO_LINK_CLAIM_TASK_TYPE } from "../../src/lib/tasks/promo-link-claim-limits";
import { terminatePendingTaskItems } from "../../src/lib/tasks/task-termination";
import { mergeTaskControlResult, type TaskControlMarker } from "../../src/lib/tasks/task-control";

/** The terminal `GenericTask.error.code` this module writes — a distinct, greppable value, never folded into a generic `handler_failed`/`upstream_error` bucket. */
export const TASK_SYSTEM_HOLD_REASON = "task_system_hold" as const;

/**
 * Whether `code` belongs to a class that is global to the whole task by
 * construction, rather than a fact about any one item. Currently exactly
 * the credential readiness taxonomy; deliberately a single named predicate
 * (not an inline `.has()` at each call site) so a future systemic class
 * (e.g. an account-level permission/capability revocation, if this handler
 * ever grows one) has exactly one place to be added, and so a reviewer can
 * see at a glance that this list is the *entire* deterministic surface, not
 * an arbitrary subset.
 */
export function isGlobalTaskFailureCode(code: string): boolean {
  return DETERMINISTIC_CREDENTIAL_FAILURE_CODES.has(code);
}

export interface SystemHoldOutcome {
  readonly halted: boolean;
  readonly terminatedPendingItemCount?: number;
}

/**
 * Call from inside a failing item's own `protectedWrite` (the same
 * transaction `finalizeTaskItem` uses to persist that item's terminal
 * `failed` status) whenever the failure code is hold-eligible. Never called
 * for a transient/per-row failure — the caller decides that with
 * {@link isGlobalTaskFailureCode} before even reaching this function.
 *
 * Halts on the very first occurrence: there is no sibling-history read at
 * all (contrast the earlier circuit breaker, which queried the most
 * recently finalized sibling items). The only state this function reads is
 * the parent row itself, locked `FOR UPDATE` — the same idempotent,
 * race-safe shape the old breaker used for its own trip write: two worker
 * replicas racing to finalize two different items of the same task at
 * nearly the same moment each re-check the parent is still
 * `pending`/`processing` before writing, so the second one finds the parent
 * already held and reports `halted: false` as a no-op.
 *
 * Drives the parent out of the runnable set by setting `status = 'disabled'`
 * — `generic_task_status_check` (the real Postgres CHECK constraint from
 * `prisma/migrations/20260803090000_p1_initial_schema`) has no room for a
 * dedicated `'system_hold'` literal; see `src/lib/tasks/task-control.ts`'s
 * module header for why `'disabled'` plus a `result.taskControl` marker is
 * the correct, non-migration-requiring way to make this distinguishable
 * from every other reason a task can be `disabled`. `recomputeParentTask`
 * (`src/lib/tasks/store.ts`) has a matching guard that never recomputes a
 * `disabled` parent's status back out from item counts, so this halt is
 * durable even though this same finalize transaction goes on to also
 * finalize the triggering item and call `recomputeParentTask` afterward.
 */
export async function maybeHaltTaskOnGlobalFailure(
  tx: Prisma.TransactionClient,
  params: { taskId: string; itemId: string; failureCode: string },
): Promise<SystemHoldOutcome> {
  if (!isGlobalTaskFailureCode(params.failureCode)) return { halted: false };

  const locked = await tx.$queryRaw<Array<{ status: string; result: unknown }>>(Prisma.sql`
    SELECT status, result FROM generic_task WHERE id = ${params.taskId}::uuid FOR UPDATE
  `);
  const parent = locked[0];
  if (!parent || !["pending", "processing"].includes(parent.status)) return { halted: false };

  const now = new Date();
  const { terminatedCount } = await terminatePendingTaskItems(tx, "generic", params.taskId, {
    code: TASK_SYSTEM_HOLD_REASON,
    message: `Task halted by the system before this item was ever attempted (${params.failureCode})`,
  });
  const marker: TaskControlMarker = {
    kind: "system_hold",
    source: "system",
    at: now.toISOString(),
    reasonCode: params.failureCode,
    terminatedPendingItemCount: terminatedCount,
  };
  await tx.genericTask.update({
    where: { id: params.taskId },
    data: {
      status: "disabled",
      result: mergeTaskControlResult(parent.result, marker),
      error: {
        code: TASK_SYSTEM_HOLD_REASON,
        message: `Halted immediately: this item's failure (${params.failureCode}) is global to every item in this task by construction`,
      },
    },
  });
  await tx.operationAudit.create({
    data: {
      actorType: "system",
      actorId: null,
      action: "promo_link_claim.system_hold",
      entityType: "GenericTask",
      entityId: params.taskId,
      taskType: PROMO_LINK_CLAIM_TASK_TYPE,
      taskId: params.taskId,
      reason: `first-occurrence global failure: ${params.failureCode}`,
      afterSnapshot: {
        failureCode: params.failureCode,
        triggeringItemId: params.itemId,
        terminatedPendingItemCount: terminatedCount,
      },
    },
  });
  return { halted: true, terminatedPendingItemCount: terminatedCount };
}
