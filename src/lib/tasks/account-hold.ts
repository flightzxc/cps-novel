/**
 * Account-level deterministic-failure brake — read side (Owner decision
 * 2026-09-18, 决策 2).
 *
 * What this exists to stop, precisely: on 2026-09-14 one channel account's
 * credential could not be decrypted by the worker, and 79,183
 * `moboreader.preview_refresh.v1` tasks went straight to terminal `failed` in
 * ~70 minutes — one per novel, `maxAttempts: 1`, ~10ms each. The promo-link
 * claim chain was burned by the same credential in the same hour and got a
 * *task-level* halt out of it (`worker/handlers/promo-link-claim-system-hold.ts`).
 * That shape cannot help the preview chain at all: its auto path
 * (`worker/handlers/novel-materialize.ts`) creates one single-item task per
 * novel, so "halt this task" halts exactly the one item that already failed.
 *
 * The brake therefore hangs off the **account**, which is where the evidence
 * actually lives: every code in `DETERMINISTIC_CREDENTIAL_FAILURE_CODES`
 * (`src/lib/credentials/claim-readiness.ts`) is derived purely from
 * `channelAccountId` — which credential rows exist, whether the one usable
 * row decrypts — never from anything about the particular novel being
 * fetched. Such a code is either true for every task of that account or none
 * of them, which is exactly what makes a first-occurrence hold safe and a
 * retry counter pointless. Retrying a broken credential three times does not
 * turn 79,183 failures into fewer failures; it turns them into 237,549.
 *
 * Three layers enforce it, all reading this module's one predicate:
 *
 *   1. **Claim time** (`selectPending`, `./store.ts`) — the structural
 *      guarantee. A held account's `channel_sync` items are simply not
 *      candidates. Nothing is written: items stay `pending`, untouched, with
 *      no lease, no attempt increment, no requeue — so there is no
 *      claim→discover→requeue→claim busy loop to build, and nothing to undo
 *      on release. The worker just finds no work and sleeps its normal poll
 *      interval.
 *   2. **Enqueue time** (`./moboreader.ts`) — new preview work for a held
 *      account is created `disabled` with a `taskControl` marker instead of
 *      `pending`. This is what keeps layer 1 cheap during an incident: the
 *      2026-09-14 backlog was produced *progressively* by a running catalog
 *      materialization, so without this the pending pool would keep growing
 *      under the hold and every claim attempt would scan more of it.
 *   3. **Failure time** (`worker/handlers/preview-account-hold.ts`) — writes
 *      the row, idempotently, inside the failing item's own finalize
 *      transaction.
 *
 * Deliberately **not** scoped by task type. A credential is not per-task-type,
 * and inventing a scope column would only create a second place for "which
 * work is held" to disagree with reality. Enforcement today is wired into the
 * preview path only (the `channel_sync` family has exactly one registered task
 * type — `moboreader.preview_refresh.v1`, see
 * `createMoboreaderWorkerHandlers`), and the promo-link claim chain keeps its
 * own already-shipped protection untouched.
 */
import { Prisma, type PrismaClient } from "@prisma/client";

type HoldReadDb = Pick<PrismaClient, "channelAccountHold"> | Prisma.TransactionClient;

export type ActiveAccountHold = {
  readonly id: string;
  readonly channelAccountId: string;
  readonly reasonCode: string;
  readonly credentialId: string | null;
  readonly heldAt: Date;
};

/**
 * The one definition of "this account is currently held". Everything else —
 * the claim-time SQL pushdown, the enqueue-time refusal, the release CLI's
 * listing — goes through this or through {@link accountHoldExistsSql}, so
 * "active" cannot come to mean two different things in two places.
 */
export async function findActiveAccountHold(
  db: HoldReadDb,
  channelAccountId: string,
): Promise<ActiveAccountHold | null> {
  const row = await db.channelAccountHold.findFirst({
    where: { channelAccountId, releasedAt: null },
    select: { id: true, channelAccountId: true, reasonCode: true, credentialId: true, heldAt: true },
    orderBy: { heldAt: "desc" },
  });
  return row ?? null;
}

/**
 * SQL form of the same predicate, for the claim-time pushdown in
 * `selectPending` — it must live *inside* that query's inner `WHERE`
 * (ahead of its `LIMIT`), so it cannot be expressed by calling
 * {@link findActiveAccountHold} first.
 *
 * `accountColumn` is the already-qualified column reference to test (e.g.
 * `t.channel_account_id`). Returns a `NOT EXISTS (...)` fragment: an account
 * with no hold row at all, and an account whose holds are all released, both
 * read as "runnable" — the common case is a bare index probe that finds
 * nothing.
 */
export function accountHoldExistsSql(accountColumn: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    EXISTS (
      SELECT 1 FROM channel_account_hold h
      WHERE h.channel_account_id = ${accountColumn} AND h.released_at IS NULL
    )
  `;
}
