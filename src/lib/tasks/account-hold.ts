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
 * **Scope.** "Can this credential be decrypted" really is an account-wide
 * fact, but which *pipeline* a given hold row actually stops is a separate
 * question, and leaving it implicit would have made the table's name
 * ("this channel account is held") promise more than its behaviour delivers —
 * only the preview chain is wired to it. So every row carries an explicit
 * `scope`, and every one of the three enforcement points below filters on it.
 * Today the registry has exactly one member, {@link PREVIEW_ACCOUNT_HOLD_SCOPE}:
 * the `channel_sync` family has exactly one registered task type
 * (`moboreader.preview_refresh.v1`, see `createMoboreaderWorkerHandlers`), so
 * "the channel_sync claim path" and "preview work" are the same set. The
 * promo-link claim chain keeps its own already-shipped, task-level protection
 * and is deliberately *not* held by these rows; wiring it up later is a new
 * scope value plus its own enforcement point, not a silent change of meaning
 * for rows written today.
 */
import { Prisma, type PrismaClient } from "@prisma/client";

/**
 * Which pipeline a hold row suppresses. Single source of truth for the value
 * domain; `channel_account_hold_scope_check` in
 * `prisma/migrations/20260918090000_preview_account_hold/migration.sql` is its
 * database-side mirror, and adding a member means changing both.
 */
export const CHANNEL_ACCOUNT_HOLD_SCOPES = Object.freeze(["preview"] as const);
export type ChannelAccountHoldScope = (typeof CHANNEL_ACCOUNT_HOLD_SCOPES)[number];

/** The only scope wired up today — see this module's header, "Scope". */
export const PREVIEW_ACCOUNT_HOLD_SCOPE = "preview" as const satisfies ChannelAccountHoldScope;

type HoldReadDb = Pick<PrismaClient, "channelAccountHold"> | Prisma.TransactionClient;

export type ActiveAccountHold = {
  readonly id: string;
  readonly channelAccountId: string;
  readonly scope: ChannelAccountHoldScope;
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
  scope: ChannelAccountHoldScope = PREVIEW_ACCOUNT_HOLD_SCOPE,
): Promise<ActiveAccountHold | null> {
  const row = await db.channelAccountHold.findFirst({
    where: { channelAccountId, scope, releasedAt: null },
    select: { id: true, channelAccountId: true, scope: true, reasonCode: true, credentialId: true, heldAt: true },
    orderBy: { heldAt: "desc" },
  });
  return row ? { ...row, scope: row.scope as ChannelAccountHoldScope } : null;
}

/**
 * SQL form of the same predicate, for the claim-time pushdown in
 * `selectPending` — it must live *inside* that query's inner `WHERE`
 * (ahead of its `LIMIT`), so it cannot be expressed by calling
 * {@link findActiveAccountHold} first.
 *
 * `accountColumn` is the already-qualified column reference to test (e.g.
 * `t.channel_account_id`); `scope` names the pipeline the caller is claiming
 * for, so a hold placed on one pipeline can never quietly stop another.
 * Returns an `EXISTS (...)` fragment the caller negates: an account with no
 * hold row at all, an account held only on a *different* scope, and an account
 * whose holds are all released all read as "runnable" — the common case is a
 * bare index probe that finds nothing.
 */
export function accountHoldExistsSql(
  accountColumn: Prisma.Sql,
  scope: ChannelAccountHoldScope,
): Prisma.Sql {
  return Prisma.sql`
    EXISTS (
      SELECT 1 FROM channel_account_hold h
      WHERE h.channel_account_id = ${accountColumn}
        AND h.scope = ${scope}
        AND h.released_at IS NULL
    )
  `;
}
