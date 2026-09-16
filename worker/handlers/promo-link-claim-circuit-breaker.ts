/**
 * Batch-level circuit breaker for the promo-link claim chain.
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
 * already-broken credential) must halt on its own after a small, bounded
 * number of consecutive failures, not grind through the rest of the batch.
 *
 * Only the credential-decrypt/validate failure classes trip this —
 * `DETERMINISTIC_CREDENTIAL_FAILURE_CODES`
 * (`src/lib/credentials/claim-readiness.ts`), each one an account-level
 * fact, never a per-row one (see that module's doc comment). Every transient
 * upstream class (`transport_error`, `request_timeout`,
 * `upstream_http_error`, `malformed_payload` —
 * `src/lib/adapters/promo-link-claim.ts`) and every per-row data-quality
 * class (`claim_source_fields_missing`, `claim_readback_target_missing`,
 * etc.) is deliberately excluded: per-item retry (a fresh explicit task) is
 * already the correct recovery for those, and this breaker must never stand
 * in for it.
 */
import { Prisma } from "@prisma/client";
import { DETERMINISTIC_CREDENTIAL_FAILURE_CODES } from "../../src/lib/credentials/claim-readiness";
import { PROMO_LINK_CLAIM_LIMITS, PROMO_LINK_CLAIM_TASK_TYPE } from "../../src/lib/tasks/promo-link-claim-limits";
import { terminatePendingTaskItems } from "../../src/lib/tasks/task-termination";

/** The terminal `GenericTask.result.reason` / `.error.code` this breaker writes — a distinct, greppable value, never folded into a generic `handler_failed`/`upstream_error` bucket. */
export const PROMO_LINK_CLAIM_CIRCUIT_BREAKER_REASON = "circuit_breaker_tripped" as const;

/**
 * Whether `code` belongs to a class this breaker is allowed to count
 * towards its consecutive-failure streak. Currently exactly the credential
 * readiness taxonomy; deliberately a single named predicate (not an inline
 * `.has()` at each call site) so a future systemic class (e.g. an
 * account-level permission/capability revocation, if this handler ever
 * grows one) has exactly one place to be added, and so a reviewer can see
 * at a glance that this list is the *entire* deterministic surface, not an
 * arbitrary subset.
 */
export function isCircuitBreakerEligibleFailureCode(code: string): boolean {
  return DETERMINISTIC_CREDENTIAL_FAILURE_CODES.has(code);
}

type SiblingOutcomeRow = { status: string; code: string | null };

async function recentFinalizedSiblingOutcomes(
  tx: Prisma.TransactionClient,
  taskId: string,
  excludeItemId: string,
  limit: number,
): Promise<SiblingOutcomeRow[]> {
  if (limit <= 0) return [];
  return tx.$queryRaw<SiblingOutcomeRow[]>(Prisma.sql`
    SELECT status, error->>'code' AS code
    FROM generic_task_item
    WHERE task_id = ${taskId}::uuid
      AND id <> ${excludeItemId}::uuid
      AND status IN ('success', 'failed')
    ORDER BY finished_at DESC NULLS LAST, id DESC
    LIMIT ${limit}
  `);
}

export interface CircuitBreakerTripOutcome {
  readonly tripped: boolean;
  readonly terminatedPendingItemCount?: number;
}

/**
 * Call from inside a failing item's own `protectedWrite` (the same
 * transaction `finalizeTaskItem` uses to persist that item's terminal
 * `failed` status) whenever the failure code is breaker-eligible. Never
 * called for a transient/per-row failure — the caller decides that with
 * {@link isCircuitBreakerEligibleFailureCode} before even reaching this
 * function.
 *
 * State lives entirely in the database (the most recently finalized sibling
 * items of the same task), never in an in-process counter: multiple worker
 * replicas can be claiming and finalizing items of the same task
 * concurrently, and only the shared row history is visible to all of them.
 *
 * Idempotent and safe to race: this function re-locks the parent
 * `generic_task` row (`FOR UPDATE`) and re-checks it is still
 * `pending`/`processing` before writing anything, so two replicas that
 * independently reach the trip threshold at nearly the same moment each
 * still commit a well-formed, single transition — the second one finds the
 * parent already terminal and reports `tripped: false` as a no-op.
 */
export async function maybeTripPromoLinkClaimCircuitBreaker(
  tx: Prisma.TransactionClient,
  params: { taskId: string; itemId: string; failureCode: string },
): Promise<CircuitBreakerTripOutcome> {
  if (!isCircuitBreakerEligibleFailureCode(params.failureCode)) return { tripped: false };

  const threshold = PROMO_LINK_CLAIM_LIMITS.breakerConsecutiveFailureThreshold;
  const priorNeeded = threshold - 1;
  const priorRows = await recentFinalizedSiblingOutcomes(tx, params.taskId, params.itemId, priorNeeded);
  const allPriorDeterministicFailures = priorRows.length === priorNeeded
    && priorRows.every((row) => row.status === "failed" && row.code !== null && isCircuitBreakerEligibleFailureCode(row.code));
  if (!allPriorDeterministicFailures) return { tripped: false };

  const locked = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
    SELECT status FROM generic_task WHERE id = ${params.taskId}::uuid FOR UPDATE
  `);
  if (!locked[0] || !["pending", "processing"].includes(locked[0].status)) return { tripped: false };

  const now = new Date();
  await tx.genericTask.update({
    where: { id: params.taskId },
    data: {
      status: "failed",
      completedAt: now,
      result: {
        reason: PROMO_LINK_CLAIM_CIRCUIT_BREAKER_REASON,
        breakerFailureCode: params.failureCode,
        consecutiveFailureThreshold: threshold,
        trippedAt: now.toISOString(),
      },
      error: {
        code: PROMO_LINK_CLAIM_CIRCUIT_BREAKER_REASON,
        message: `Halted after ${threshold} consecutive ${params.failureCode} failures`,
      },
    },
  });
  const { terminatedCount } = await terminatePendingTaskItems(tx, "generic", params.taskId, {
    code: PROMO_LINK_CLAIM_CIRCUIT_BREAKER_REASON,
    message: `Task halted by the circuit breaker before this item was ever attempted (${params.failureCode})`,
  });
  await tx.operationAudit.create({
    data: {
      actorType: "worker",
      actorId: "system",
      action: "promo_link_claim.circuit_breaker_tripped",
      entityType: "GenericTask",
      entityId: params.taskId,
      taskType: PROMO_LINK_CLAIM_TASK_TYPE,
      taskId: params.taskId,
      afterSnapshot: {
        breakerFailureCode: params.failureCode,
        consecutiveFailureThreshold: threshold,
        triggeringItemId: params.itemId,
        terminatedPendingItemCount: terminatedCount,
      },
    },
  });
  return { tripped: true, terminatedPendingItemCount: terminatedCount };
}
