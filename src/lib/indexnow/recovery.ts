/**
 * Crash recovery for in-flight IndexNow deliveries (Stream E, P2-11).
 *
 * Ported ADAPT from CPS `recoverStaleIndexNowDeliveries`
 * (`indexnow-delivery-service.ts:109-169`). This is deliberately a *second*,
 * independent recovery layer from the `GenericTaskItem` lease/fencing
 * mechanism `worker/handlers/indexnow-delivery.ts` relies on for
 * concurrency safety — the two answer different questions
 * (`DECISION-CHECK.md` 核查1c: CPS's own stale-recovery here has no lease
 * fields at all, it is a plain `status='processing'` + staleness-timeout
 * poll, "更原始" than `GenericTaskItem`'s fencing). `GenericTaskItem.
 * lockedUntil` recovery (`src/lib/tasks/store.ts`'s `recoverExpiredItem`)
 * answers "did the framework's own claim on this unit of work expire" and
 * requeues the *item*; this function answers "did an HTTP attempt get
 * durably recorded as started but never get a durably recorded response",
 * using `indexnow_outbox_attempt.attemptState` (the CPS crash-recovery
 * semantics field the foundation migration froze specifically for this — see
 * `src/domain/database-statuses.ts`'s `INDEXNOW_ATTEMPT_RECOVERY_STATES` doc
 * comment) — and requeues the *outbox row* independent of whichever
 * `GenericTaskItem` happened to own that attempt. A worker crash mid-fetch
 * produces exactly the scenario both layers need to jointly resolve: the
 * item's lease eventually expires and gets recovered by the framework, but
 * that alone does not tell a future worker whether the abandoned attempt's
 * IndexNow submission actually landed — `unknown_outcome` plus "submission
 * is idempotent, safe to retry" is what closes that gap, exactly as CPS
 * documents on its own version.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

import { classifyIndexNowResult, resolveOutboxDeliveryStatus } from "./delivery-primitives";
import { INDEXNOW_PROCESSING_STALE_MS } from "./outbox-contract";

type Db = PrismaClient | Prisma.TransactionClient;

export async function recoverStaleIndexNowDeliveries(db: Db, now: Date = new Date()): Promise<number> {
  const staleBefore = new Date(now.getTime() - INDEXNOW_PROCESSING_STALE_MS);
  const stale = await db.indexNowOutbox.findMany({
    where: { status: "processing", updatedAt: { lt: staleBefore } },
    select: {
      id: true,
      attemptCount: true,
      maxAttempts: true,
      attempts: { orderBy: { attemptNo: "desc" }, take: 1 },
    },
  });

  let recovered = 0;
  for (const row of stale) {
    const attempt = row.attempts[0];

    if (!attempt) {
      // Defensive only — the handler always writes a `started` attempt row
      // before flipping the outbox row to `processing`, so this branch
      // should be unreachable in practice.
      await db.indexNowOutbox.update({ where: { id: row.id }, data: { status: "pending", deliveryTaskId: null } });
      recovered++;
      continue;
    }

    if (attempt.attemptState === "started" && !attempt.responseAt) {
      await db.indexNowOutboxAttempt.update({
        where: { id: attempt.id },
        data: {
          attemptState: "unknown_outcome",
          errorKind: "unknown_outcome",
          responseSummary: "Worker ended after request start; delivery outcome is unknown.",
        },
      });
      // Immediate retry (not exponential backoff, unlike
      // `resolveOutboxDeliveryStatus`'s ordinary retry_wait branch):
      // submission outcome is unknown, not known-failed, and IndexNow
      // submission is idempotent — CPS's `nextRetryAt: now` for this exact
      // branch. Still respects the same attempt-budget dead-letter
      // threshold, so exhausted rows do not retry forever.
      const exhausted = attempt.attemptNo >= row.maxAttempts;
      await db.indexNowOutbox.update({
        where: { id: row.id },
        data: {
          status: exhausted ? "dead_letter" : "retry_wait",
          lastErrorKind: "unknown_outcome",
          lastErrorSummary: "Previous request outcome is unknown; safe idempotent retry allowed.",
          nextAttemptAt: exhausted ? null : now,
        },
      });
      recovered++;
      continue;
    }

    if (attempt.attemptState === "completed") {
      // The attempt row itself was finalized, but the crash happened before
      // the outbox row's own status caught up — reapply the same
      // classification `worker/handlers/indexnow-delivery.ts` would have
      // applied.
      const outcome = classifyIndexNowResult(attempt.httpStatus, attempt.errorKind);
      const decision = resolveOutboxDeliveryStatus(
        outcome,
        attempt.attemptNo,
        row.maxAttempts,
        attempt.responseAt ?? now,
      );
      await db.indexNowOutbox.update({
        where: { id: row.id },
        data: {
          status: decision.status,
          lastHttpStatus: attempt.httpStatus,
          lastErrorKind: outcome === "accepted" ? null : attempt.errorKind,
          lastErrorSummary: outcome === "accepted" ? null : attempt.responseSummary,
          nextAttemptAt: decision.nextAttemptAt,
        },
      });
      recovered++;
    }
  }
  return recovered;
}
