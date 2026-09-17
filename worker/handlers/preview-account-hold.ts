/**
 * Account-level deterministic-failure brake — write side (Owner decision
 * 2026-09-18, 决策 2). The read side, and the full rationale for why this
 * brake hangs off the account instead of the task, is
 * `src/lib/tasks/account-hold.ts`.
 *
 * Relationship to `./promo-link-claim-system-hold.ts`: same doctrine, same
 * failure taxonomy (`DETERMINISTIC_CREDENTIAL_FAILURE_CODES`,
 * `src/lib/credentials/claim-readiness.ts`), same "halt on the very first
 * occurrence, no counting, no threshold" Owner ruling — a code that is global
 * to an account *by construction* is fully known the first time it is seen,
 * and counting to three only buys two more burned items. Different mechanism,
 * because the two chains have different task shapes:
 *
 *   - promo claim is one task with many items → halting *that task* stops the
 *     rest of the batch, so its hold writes `generic_task.status = 'disabled'`
 *     and terminates the task's own still-pending items.
 *   - preview is one single-item task per novel
 *     (`worker/handlers/novel-materialize.ts`) → halting that task stops
 *     nothing, because the only item in it is the one that already failed.
 *     79,183 separate tasks is exactly the shape that made 2026-09-14 possible.
 *
 * So this module writes **no task rows at all**. It records one
 * `channel_account_hold` row, and the three enforcement points in
 * `account-hold.ts` read it. Nothing is terminated, nothing is requeued, no
 * item status changes: the already-failing item finalizes as `failed` exactly
 * as it would have anyway (this runs inside that item's own `protectedWrite`
 * transaction), and every *other* item of that account simply stops being
 * claimable while staying `pending`.
 */
import { Prisma } from "@prisma/client";

import { DETERMINISTIC_CREDENTIAL_FAILURE_CODES } from "../../src/lib/credentials/claim-readiness";
import { MOBOREADER_TASK_TYPES } from "../../src/lib/tasks/moboreader";

/** The `OperationAudit.action` this module writes — a distinct, greppable value. */
export const PREVIEW_ACCOUNT_HOLD_AUDIT_ACTION = "preview.account_hold" as const;

/**
 * Whether `code` is a failure that is true for the whole channel account by
 * construction, rather than a fact about the one book being fetched.
 *
 * Delegates outright to the promo chain's existing taxonomy rather than
 * restating it: these codes are derived purely from `channelAccountId` (which
 * credential rows exist, whether the one usable row decrypts), so they cannot
 * be a per-row phenomenon — which is the entire justification for holding on
 * the first occurrence. Re-listing them here would create a second copy free
 * to drift from the first.
 *
 * Everything else the preview handler can fail with stays out, and must:
 * `upstream_material_read_failed` / `upstream_preview_read_failed` (timeouts,
 * connection resets, 5xx, rate limiting), `preview_task_scope_invalid`,
 * `preview_source_binding_missing`, `preview_catalog_identity_mismatch`,
 * `preview_channel_binding_unavailable`, `preview_read_capability_unavailable`,
 * `withdrawn_chapter_requires_manual_review`, `ambiguous_canonical_chapter`.
 * Those are transient or per-book; holding a whole account on one of them
 * would turn one bad book into an account-wide outage. They keep the ordinary
 * per-item failure handling they have today.
 */
export function isAccountLevelPreviewFailure(code: string): boolean {
  return DETERMINISTIC_CREDENTIAL_FAILURE_CODES.has(code);
}

export interface AccountHoldOutcome {
  readonly held: boolean;
  /** Present when this call created the row; absent when a hold was already active (idempotent no-op). */
  readonly holdId?: string;
}

/**
 * Call from inside the failing item's own `protectedWrite`, only when
 * {@link isAccountLevelPreviewFailure} says the code qualifies.
 *
 * Idempotent by construction, not by check-then-insert: `INSERT ... ON
 * CONFLICT DO NOTHING` against the partial unique index
 * `channel_account_hold_active_uidx` (UNIQUE(channel_account_id) WHERE
 * released_at IS NULL). Two worker replicas failing two different books of the
 * same account in the same millisecond both run this; the second one's insert
 * is absorbed by the index and returns `held: false`. A read-first version
 * would have a real race here.
 *
 * `dry_run` never reaches this: `processOneWorkerCycle` strips
 * `protectedWrite` from a dry-run outcome before finalizing, so a rehearsal
 * cannot brake production work.
 */
export async function holdChannelAccountForPreview(
  tx: Prisma.TransactionClient,
  params: {
    readonly channelAccountId: string;
    readonly reasonCode: string;
    readonly credentialId?: string | null;
    readonly taskId: string;
    readonly itemId: string;
  },
): Promise<AccountHoldOutcome> {
  if (!isAccountLevelPreviewFailure(params.reasonCode)) return { held: false };

  const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    INSERT INTO channel_account_hold (
      id, channel_account_id, reason_code, credential_id,
      triggering_task_id, triggering_item_id, held_at, created_at, updated_at
    )
    VALUES (
      gen_random_uuid(), ${params.channelAccountId}::uuid, ${params.reasonCode},
      ${params.credentialId ?? null}::uuid,
      ${params.taskId}::uuid, ${params.itemId}::uuid,
      transaction_timestamp(), transaction_timestamp(), transaction_timestamp()
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  const holdId = inserted[0]?.id;
  if (!holdId) return { held: false };

  await tx.operationAudit.create({
    data: {
      actorType: "worker",
      actorId: null,
      action: PREVIEW_ACCOUNT_HOLD_AUDIT_ACTION,
      entityType: "ChannelAccount",
      entityId: params.channelAccountId,
      taskType: MOBOREADER_TASK_TYPES.previewRefresh,
      taskId: params.taskId,
      reason: `first-occurrence account-level failure: ${params.reasonCode}`,
      afterSnapshot: {
        holdId,
        reasonCode: params.reasonCode,
        triggeringTaskId: params.taskId,
        triggeringItemId: params.itemId,
      },
    },
  });
  return { held: true, holdId };
}
