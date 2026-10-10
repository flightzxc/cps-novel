/**
 * Periodic due-delivery sweep (Stream E, P2-11; batch delivery B-41).
 *
 * CPS's `deliverDueIndexNow` (`indexnow-delivery-service.ts:207-368`) is one
 * monolithic function: find due rows, hand-rolled per-row `updateMany` CAS
 * claim, then HTTP-deliver them all in the same call. This codebase splits
 * that into two responsibilities on purpose, per the audit's direction to
 * replace the hand-rolled claim loop with the real `GenericTaskItem` lease
 * (`P2-07-12-移植审计-2026-08-12/P2-11.md` §3):
 *
 *   1. **This file** — once a minute, decide whether a batch delivery is
 *      worth starting, and if so create ONE batch task
 *      (`outbox.ts`'s `ensureIndexNowBatchDeliveryTask`).
 *   2. **`worker/handlers/indexnow-delivery.ts`** — claims that task's single
 *      item with the framework's real lease/fencing and sends one batch of up
 *      to 500 URLs in one HTTP request.
 *
 * ## Order of checks (any miss creates no task and says why)
 *
 *   1. delivery switches off → nothing at all (not even crash recovery);
 *   2. `recoverStaleIndexNowDeliveries` (rows stuck `processing` > 35 min);
 *   3. IndexNow host/key/keyLocation not all configured → `config_missing`;
 *   4. configured host ≠ `SITE_URL` host → `host_mismatch` (a 422 waiting to
 *      happen — caught locally for free, trips no breaker);
 *   5. breaker open → `breaker_open`; global 429 wait active → `rate_limited`;
 *   6. nothing due → `nothing_due`;
 *   7. a batch task is already in flight → `already_live`;
 *   8. otherwise create the task → `created: 1`.
 *
 * At most one task per minute is created and one task sends one request, so
 * the steady-state ceiling is 500 URLs/minute. Concurrency safety is the
 * database's (`generic_task_active_scope_uidx`), see `ensureIndexNowBatchDeliveryTask`.
 *
 * `indexnow.sweep.v1` runs this on worker-light via the minute schedule,
 * inside the scan item's `protectedWrite` transaction.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

import { isIndexNowDeliveryEnabled, isIndexNowDeliveryWriteAllowed } from "@/lib/flags";
import { getIndexNowDeliveryConfig, isIndexNowConfigured } from "@/server/site-settings/service";

import { getIndexNowDeliveryControlState, isIndexNowHostConsistent } from "./delivery-control";
import { indexNowDueWhere } from "./delivery-primitives";
import { ensureIndexNowBatchDeliveryTask } from "./outbox";
import { recoverStaleIndexNowDeliveries } from "./recovery";

type Db = PrismaClient | Prisma.TransactionClient;

export type SweepDueIndexNowDeliveriesReason =
  | "config_missing"
  | "host_mismatch"
  | "breaker_open"
  | "rate_limited"
  | "nothing_due"
  | "already_live";

export type SweepDueIndexNowDeliveriesResult = Readonly<{
  /** Rows crash-recovered this run. */
  recovered: number;
  /** Batch tasks created this run (0 or 1). */
  created: 0 | 1;
  reason?: SweepDueIndexNowDeliveriesReason;
  configMissing?: true;
  hostMismatch?: true;
  breakerOpen?: true;
  /** ISO timestamp; present when the 429 wait is what stopped the sweep. */
  rateLimitedUntil?: string;
}>;

export async function sweepDueIndexNowDeliveries(
  db: Db,
  options: { now?: Date } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<SweepDueIndexNowDeliveriesResult> {
  if (!isIndexNowDeliveryEnabled(env) || !isIndexNowDeliveryWriteAllowed(env)) {
    return { recovered: 0, created: 0 };
  }
  const now = options.now ?? new Date();
  const recovered = await recoverStaleIndexNowDeliveries(db, now);

  const config = await getIndexNowDeliveryConfig(db);
  if (!isIndexNowConfigured(config)) {
    return { recovered, created: 0, reason: "config_missing", configMissing: true };
  }
  if (!isIndexNowHostConsistent(config)) {
    return { recovered, created: 0, reason: "host_mismatch", hostMismatch: true };
  }

  const control = await getIndexNowDeliveryControlState(db);
  if (control.breaker.open) {
    return { recovered, created: 0, reason: "breaker_open", breakerOpen: true };
  }
  if (control.rateLimit.waiting) {
    return { recovered, created: 0, reason: "rate_limited", rateLimitedUntil: control.rateLimit.until.toISOString() };
  }

  const due = await db.indexNowOutbox.findFirst({ where: indexNowDueWhere(now), select: { id: true } });
  if (!due) return { recovered, created: 0, reason: "nothing_due" };

  const ensured = await ensureIndexNowBatchDeliveryTask(db, {
    reason: "sweep_due",
    triggeredBy: "indexnow_delivery_sweep",
  });
  if (!ensured.created) return { recovered, created: 0, reason: "already_live" };
  return { recovered, created: 1 };
}
