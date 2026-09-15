import { Prisma } from "@prisma/client";
import { sanitizePersistedTaskError } from "./errors";
import type { TaskFamily } from "./types";

export interface TerminatePendingTaskItemsResult {
  readonly terminatedCount: number;
}

/**
 * Drives every still-`pending` item of `taskId` to a terminal `skipped`
 * status, each carrying the same auditable reason.
 *
 * Exists so a task leaving the runnable set (`pending`/`processing`) — an
 * administrator cancelling it through a future admin-facing mutation (an
 * Owner-gated capability that does not exist yet; see this task family's
 * delivery notes) or a circuit breaker tripping it
 * (`worker/handlers/promo-link-claim-circuit-breaker.ts`) — can never again
 * leave its own still-`pending` items stranded forever. This is the exact
 * shape of the 2026-09-14 incident: an operator (or something acting on
 * their behalf) flipped a `promo_link.claim.v1` task to `disabled`
 * out-of-band, and its ~35,316 still-`pending` items were never driven to
 * any terminal state by anything — `claimPendingItem`'s own claim query
 * (`src/lib/tasks/store.ts`) only ever claims an item whose *parent task* is
 * `pending`/`processing`, so those items simply stopped being reachable,
 * with no code anywhere that would ever touch them again.
 *
 * Deliberately scoped to `status = 'pending'` only. An item currently
 * `processing` under an active lease is left alone; it will reach its own
 * terminal state through the worker's normal finalize/heartbeat/lease-expiry
 * machinery, which already fences correctly against a concurrently-changing
 * parent (`claimPendingItem`'s `FOR UPDATE OF i SKIP LOCKED` join against
 * the parent's status). Forcibly reaping an in-flight lease here would
 * race that machinery for no real benefit — a `pending` item has no lease
 * to race at all (the `generic_task_item_lease_shape_check` /
 * `channel_sync_task_item` CHECK constraints already require a `pending`
 * row's `execution_token`/`locked_by`/`locked_until`/`heartbeat_at` to be
 * NULL), so this is a plain conditional bulk update, not a fenced one.
 *
 * Must be called from inside the SAME transaction that also changes the
 * parent task's own status away from `pending`/`processing` — never on its
 * own — so a reader can never observe the parent already terminal with
 * items still silently `pending`. There is still a narrow, accepted race
 * against a concurrent `claimPendingItem` on a *different* connection: under
 * Postgres's default Read Committed isolation, a claim already in flight
 * when this transaction starts can commit first and pick up one item just
 * before this cascade's `UPDATE ... WHERE status = 'pending'` would have
 * caught it (`claimPendingItem`'s `SKIP LOCKED` means the two never
 * deadlock — the loser simply excludes whatever the winner already holds).
 * That item then runs and finishes normally against a parent that already
 * went terminal moments earlier; it is not orphaned, and this is the same
 * kind of small, non-catastrophic timing window the rest of this codebase's
 * task machinery already tolerates (see e.g. `claimPendingItem`'s own
 * module comment on an ambiguous-commit retry "picking a different pending
 * item"). Never a correctness bug, only a best-effort narrowing of exactly
 * when the cascade takes effect.
 *
 * Never touches a `success`/`failed`/`skipped` item — no rewriting of
 * historical outcomes, ever.
 */
export async function terminatePendingTaskItems(
  tx: Prisma.TransactionClient,
  family: TaskFamily,
  taskId: string,
  reason: { code: string; message: string },
): Promise<TerminatePendingTaskItemsResult> {
  // `PersistedTaskError` is a closed shape with no index signature, so it does
  // not structurally satisfy `InputJsonObject`; it is nonetheless plain JSON
  // data. Cast through `unknown` (what tsc itself suggests) rather than
  // loosening `PersistedTaskError`, which is deliberately closed.
  const error = sanitizePersistedTaskError(reason) as unknown as Prisma.InputJsonObject;
  const data = { status: "skipped" as const, error, finishedAt: new Date() };
  const outcome = family === "channel_sync"
    ? await tx.channelSyncTaskItem.updateMany({ where: { taskId, status: "pending" }, data })
    : await tx.genericTaskItem.updateMany({ where: { taskId, status: "pending" }, data });
  return { terminatedCount: outcome.count };
}
