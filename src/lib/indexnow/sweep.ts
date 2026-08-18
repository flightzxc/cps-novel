/**
 * Periodic due-delivery sweep (Stream E, P2-11).
 *
 * CPS's `deliverDueIndexNow` (`indexnow-delivery-service.ts:207-368`) is one
 * monolithic function: find due rows, hand-rolled per-row `updateMany` CAS
 * claim, then HTTP-deliver them all in the same call. This codebase splits
 * that into two responsibilities on purpose, per the audit's direction to
 * replace the hand-rolled claim loop with the real `GenericTaskItem` lease
 * (`P2-07-12-移植审计-2026-08-12/P2-11.md` §3):
 *
 *   1. **This file** — find rows that just became due (first enqueue,
 *      elapsed `nextAttemptAt`, or a manual release) and are not already
 *      covered by a live `GenericTaskItem`, and create exactly one fresh
 *      item per row (`outbox.ts`'s `createIndexNowDeliveryTaskItem`).
 *   2. **`worker/handlers/indexnow-delivery.ts`** — claims one such item at
 *      a time via the framework's real lease/fencing and does the actual
 *      HTTP submission.
 *
 * One row never has two live items open at once: `enqueueIndexNowFirstPublish`
 * creates the row's first item immediately (a first-publish row is due the
 * moment it is written, unless deferred), and this sweep only considers rows
 * with no existing `pending`/`processing` `GenericTaskItem` — so a row
 * already covered by an in-flight item is skipped until that item reaches a
 * terminal state (success/skipped/failed) and, if the outcome was
 * retryable, `nextAttemptAt` puts it back in this sweep's due set for a
 * *new* item next time. This means "same row, second attempt" is always a
 * different `GenericTaskItem` id than the first — a deliberate simplicity
 * trade versus CPS's single long-lived delivery row that gets re-claimed by
 * the same worker-task machinery; the tradeoff and its correctness argument
 * are documented in this Stream's report to the round's coordinator.
 *
 * Wiring a periodic trigger (cron/`ScheduleRun`) onto this function is out of
 * this PR's scope, matching the precedent
 * `src/server/publish-gate/service.ts`'s `publishDueScheduledArticles` sets
 * for its own "the gated primitive a future trigger calls" scheduled-publish
 * sweep — this function is directly callable today (a script, a test, or a
 * future scheduler handler).
 */
import type { Prisma, PrismaClient } from "@prisma/client";

import { isIndexNowDeliveryEnabled, isIndexNowDeliveryWriteAllowed } from "@/lib/flags";

import { createIndexNowDeliveryTaskItem } from "./outbox";
import { recoverStaleIndexNowDeliveries } from "./recovery";

type Db = PrismaClient | Prisma.TransactionClient;

export type SweepDueIndexNowDeliveriesResult = Readonly<{
  recovered: number;
  swept: number;
  skippedAlreadyLive: number;
}>;

const DEFAULT_MAX_DELIVERIES = 2000;
const MAX_DELIVERIES_CEILING = 10_000;

export async function sweepDueIndexNowDeliveries(
  db: Db,
  options: { now?: Date; maxDeliveries?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<SweepDueIndexNowDeliveriesResult> {
  if (!isIndexNowDeliveryEnabled(env) || !isIndexNowDeliveryWriteAllowed(env)) {
    return { recovered: 0, swept: 0, skippedAlreadyLive: 0 };
  }
  const now = options.now ?? new Date();
  const recovered = await recoverStaleIndexNowDeliveries(db, now);

  const maxDeliveries = Math.max(1, Math.min(options.maxDeliveries ?? DEFAULT_MAX_DELIVERIES, MAX_DELIVERIES_CEILING));
  const due = await db.indexNowOutbox.findMany({
    where: {
      OR: [
        { status: "pending", OR: [{ availableAt: null }, { availableAt: { lte: now } }] },
        { status: "retry_wait", nextAttemptAt: { lte: now } },
      ],
    },
    orderBy: { id: "asc" },
    take: maxDeliveries,
    select: { id: true },
  });
  if (due.length === 0) return { recovered, swept: 0, skippedAlreadyLive: 0 };

  const liveItems = await db.genericTaskItem.findMany({
    where: {
      targetType: "indexnow_outbox",
      targetId: { in: due.map((row) => row.id) },
      status: { in: ["pending", "processing"] },
    },
    select: { targetId: true },
  });
  const alreadyLive = new Set(liveItems.map((item) => item.targetId));

  let swept = 0;
  let skippedAlreadyLive = 0;
  for (const row of due) {
    if (alreadyLive.has(row.id)) {
      skippedAlreadyLive++;
      continue;
    }
    await createIndexNowDeliveryTaskItem(db, row.id, { reason: "sweep_due", triggeredBy: "indexnow_delivery_sweep" });
    swept++;
  }
  return { recovered, swept, skippedAlreadyLive };
}
