/**
 * Operator CLI for the account-level deterministic-failure brake (Owner
 * decision 2026-09-18, 决策 2). Read side and full rationale:
 * `src/lib/tasks/account-hold.ts`.
 *
 * A hold must never become a permanent deadlock, and it must never be
 * released by "try it again and see" — that is how 79,183 tasks burned on
 * 2026-09-14. So release is one explicit command, for the whole account at
 * once (never per task), and it is **gated on the same credential pre-flight
 * the backfill CLI uses**: if the credential still cannot be decrypted, the
 * release is refused and the brake stays on.
 *
 * Run from the worker tier: `channel_account_hold` is granted to `worker_app`,
 * and the pre-flight needs the worker's keyring.
 *
 * List every active hold (read-only, the default):
 *   npx tsx scripts/preview-account-hold.ts --list
 *
 * Release one account after its credential has been fixed:
 *   npx tsx scripts/preview-account-hold.ts --release \
 *     --channel-account-id <uuid> --released-by <operator-id> \
 *     --reason "rotated credential 2026-09-18" \
 *     --confirm RELEASE_PREVIEW_ACCOUNT_HOLD
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

import { Prisma, PrismaClient } from "@prisma/client";

import { PREVIEW_ACCOUNT_HOLD_SCOPE } from "../src/lib/tasks/account-hold";
import { MOBOREADER_TASK_TYPES } from "../src/lib/tasks/moboreader";
import { preflightChannelAccountCredential, type CredentialPreflight } from "./preview-backfill-recovery";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const PREVIEW_ACCOUNT_HOLD_RELEASE_CONFIRM_PHRASE = "RELEASE_PREVIEW_ACCOUNT_HOLD";

/** `OperationAudit.action` written on a successful release. Pairs with `preview.account_hold` from the worker side. */
export const PREVIEW_ACCOUNT_HOLD_RELEASE_AUDIT_ACTION = "preview.account_hold_released" as const;

/**
 * How many parked tasks one UPDATE re-enables. Bounded because the 2026-09-14
 * shape is one task per novel: an account can legitimately have tens of
 * thousands parked, and re-enabling them must not be a single unbounded
 * statement holding row locks across the whole set.
 */
export const RELEASE_REENABLE_CHUNK_SIZE = 500;

export type PreviewAccountHoldArgs =
  | { readonly mode: "list" }
  | {
      readonly mode: "release";
      readonly channelAccountId: string;
      readonly releasedBy: string;
      readonly releaseReason: string | null;
    };

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function parsePreviewAccountHoldArgs(argv: readonly string[]): PreviewAccountHoldArgs {
  if (!argv.includes("--release")) return { mode: "list" };
  const channelAccountId = option(argv, "--channel-account-id") ?? "";
  const releasedBy = (option(argv, "--released-by") ?? "").trim();
  if (!UUID.test(channelAccountId)) throw new Error("channel_account_id_invalid");
  // `released_by` is not decoration: `channel_account_hold_release_shape_check`
  // makes "released with nobody accountable" unrepresentable in the database,
  // and this is the layer that keeps that from being satisfied with an empty
  // string.
  if (!releasedBy || releasedBy.length > 160) throw new Error("released_by_invalid");
  if (option(argv, "--confirm") !== PREVIEW_ACCOUNT_HOLD_RELEASE_CONFIRM_PHRASE) {
    throw new Error("release_confirmation_invalid");
  }
  const reason = option(argv, "--reason")?.trim();
  if (reason !== undefined && reason.length > 300) throw new Error("reason_invalid");
  return {
    mode: "release",
    channelAccountId,
    releasedBy,
    releaseReason: reason && reason.length > 0 ? reason : null,
  };
}

export type ActiveHoldReport = {
  readonly holdId: string;
  readonly channelAccountId: string;
  readonly scope: string;
  readonly reasonCode: string;
  readonly heldAt: string;
  readonly parkedTaskCount: number;
};

/**
 * Every active hold plus how much preview work each one is currently holding
 * back. `parkedTaskCount` counts only tasks this brake parked (the
 * `taskControl` marker), never a task that is `disabled` for one of the older,
 * unrelated reasons — see `src/lib/tasks/task-control.ts` on why an unmarked
 * `disabled` row is never ours to touch.
 */
export async function listActiveHolds(db: PrismaClient): Promise<readonly ActiveHoldReport[]> {
  const holds = await db.channelAccountHold.findMany({
    where: { scope: PREVIEW_ACCOUNT_HOLD_SCOPE, releasedAt: null },
    select: { id: true, channelAccountId: true, scope: true, reasonCode: true, heldAt: true },
    orderBy: { heldAt: "asc" },
  });
  const reports: ActiveHoldReport[] = [];
  for (const hold of holds) {
    const parkedTaskCount = await countParkedTasks(db, hold.channelAccountId);
    reports.push({
      holdId: hold.id,
      channelAccountId: hold.channelAccountId,
      scope: hold.scope,
      reasonCode: hold.reasonCode,
      heldAt: hold.heldAt.toISOString(),
      parkedTaskCount,
    });
  }
  return reports;
}

async function countParkedTasks(db: PrismaClient, channelAccountId: string): Promise<number> {
  const rows = await db.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT COUNT(*)::bigint AS count FROM channel_sync_task
    WHERE channel_account_id = ${channelAccountId}::uuid
      AND task_type = ${MOBOREADER_TASK_TYPES.previewRefresh}
      AND status = 'disabled'
      AND result->'taskControl'->>'kind' = 'system_hold'
  `);
  return Number(rows[0]?.count ?? 0n);
}

export type ReleaseOutcome =
  /** An active hold existed; it was cleared and its parked work was returned to the runnable set. */
  | { readonly status: "released"; readonly holdId: string; readonly reEnabledTaskCount: number }
  /**
   * No active hold, but parked work was still sitting there — the crash-resume
   * path. Re-running `--release` after a process death mid-re-enable lands
   * here and finishes the job; see {@link releaseAccountHold}.
   */
  | { readonly status: "resumed"; readonly reEnabledTaskCount: number }
  /** Nothing to do: no active hold and no parked work left. */
  | { readonly status: "no_active_hold" }
  | { readonly status: "refused"; readonly preflight: CredentialPreflight };

/**
 * Releases the account's active hold, then returns the work it had parked to
 * the runnable set.
 *
 * **Crash-resumable, and that is load-bearing.** The two writes cannot be one
 * transaction (re-enabling tens of thousands of tasks is deliberately chunked,
 * so it spans many transactions), which means a process death can land between
 * "hold cleared" and "all parked tasks re-enabled". An earlier revision keyed
 * the whole function on finding an active hold and returned `no_active_hold`
 * otherwise — so a crash mid-re-enable left the remaining `disabled` tasks
 * permanently orphaned: the brake was off, nothing was holding them, and no
 * command would ever pick them up again. This version instead treats the hold
 * row and the parked tasks as two independently convergent facts:
 *
 *   1. if an active hold exists, clear it;
 *   2. **then, either way**, re-enable whatever parked work remains.
 *
 * So the command is idempotent and re-runnable to completion: run it again
 * after a crash and it reports `resumed` with however many tasks were left.
 * Running it on a fully-converged account is a no-op (`no_active_hold`, zero
 * re-enabled).
 *
 * Order between the two is also deliberate: the hold is cleared *first*. The
 * reverse order would open a window where runnable tasks exist while the
 * claim-time pushdown still rejects them — work that looks live in the admin
 * UI and silently never runs. This way the worst case is the harmless
 * opposite: the brake is off for a moment while some tasks are still
 * `disabled`, and the next chunk (or the next run) re-enables them.
 *
 * Re-enabling only touches rows carrying this brake's `taskControl` marker, so
 * a task that was born `disabled` because the catalog write flag was off stays
 * disabled — releasing a credential hold must not quietly turn a feature flag
 * back on.
 */
export async function releaseAccountHold(
  db: PrismaClient,
  input: {
    readonly channelAccountId: string;
    readonly releasedBy: string;
    readonly releaseReason: string | null;
  },
  now = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReleaseOutcome> {
  const hold = await db.channelAccountHold.findFirst({
    where: {
      channelAccountId: input.channelAccountId,
      scope: PREVIEW_ACCOUNT_HOLD_SCOPE,
      releasedAt: null,
    },
    select: { id: true },
  });
  const parkedTaskCount = await countParkedTasks(db, input.channelAccountId);
  // Genuinely nothing to converge — skip the pre-flight rather than refusing a
  // no-op on a broken credential.
  if (!hold && parkedTaskCount === 0) return { status: "no_active_hold" };

  // Gates both paths: re-enabling parked work is exactly the risky act, so the
  // resume path is no more exempt from proving the credential than the release
  // path is.
  const preflight = await preflightChannelAccountCredential(db, input.channelAccountId, now, env);
  if (preflight.status !== "usable") return { status: "refused", preflight };

  let clearedHoldId: string | null = null;
  if (hold) {
    const released = await db.channelAccountHold.updateMany({
      where: { id: hold.id, releasedAt: null },
      data: { releasedAt: now, releasedBy: input.releasedBy, releaseReason: input.releaseReason },
    });
    // count === 0 means someone else released it between the read and this
    // write. Not an error: fall through to the re-enable below, which is the
    // half that still needs doing either way.
    if (released.count > 0) clearedHoldId = hold.id;
  }

  const reEnabledTaskCount = await reEnableParkedTasks(db, input.channelAccountId);

  await db.operationAudit.create({
    data: {
      actorType: "admin",
      actorId: input.releasedBy,
      action: PREVIEW_ACCOUNT_HOLD_RELEASE_AUDIT_ACTION,
      entityType: "ChannelAccount",
      entityId: input.channelAccountId,
      taskType: MOBOREADER_TASK_TYPES.previewRefresh,
      reason: input.releaseReason,
      afterSnapshot: {
        scope: PREVIEW_ACCOUNT_HOLD_SCOPE,
        holdId: clearedHoldId,
        resumed: clearedHoldId === null,
        credentialId: preflight.credentialId,
        reEnabledTaskCount,
      },
    },
  });

  return clearedHoldId
    ? { status: "released", holdId: clearedHoldId, reEnabledTaskCount }
    : { status: "resumed", reEnabledTaskCount };
}

/**
 * Flips every task this brake parked back to `pending`, in bounded chunks.
 * Each chunk is its own statement, so a crash leaves the already-committed
 * chunks committed and the remainder still selectable by the same predicate —
 * which is what makes {@link releaseAccountHold} resumable.
 */
async function reEnableParkedTasks(db: PrismaClient, channelAccountId: string): Promise<number> {
  let total = 0;
  for (;;) {
    const chunk = await db.$executeRaw(Prisma.sql`
      UPDATE channel_sync_task SET
        status = 'pending',
        result = result - 'taskControl',
        updated_at = transaction_timestamp()
      WHERE id IN (
        SELECT id FROM channel_sync_task
        WHERE channel_account_id = ${channelAccountId}::uuid
          AND task_type = ${MOBOREADER_TASK_TYPES.previewRefresh}
          AND status = 'disabled'
          AND result->'taskControl'->>'kind' = 'system_hold'
        ORDER BY created_at, id
        LIMIT ${RELEASE_REENABLE_CHUNK_SIZE}
      )
    `);
    total += chunk;
    if (chunk < RELEASE_REENABLE_CHUNK_SIZE) return total;
  }
}

export async function runPreviewAccountHoldCli(
  db: PrismaClient,
  args: PreviewAccountHoldArgs,
  now = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ readonly exitCode: number; readonly report: Record<string, unknown> }> {
  if (args.mode === "list") {
    const holds = await listActiveHolds(db);
    return { exitCode: 0, report: { mode: "list", activeHoldCount: holds.length, holds } };
  }
  const outcome = await releaseAccountHold(db, args, now, env);
  if (outcome.status === "refused") {
    return {
      exitCode: 65,
      report: {
        mode: "release",
        refused: "credential_preflight_failed",
        channelAccountId: args.channelAccountId,
        preflight: outcome.preflight,
        hint: "Fix the channel account credential first — releasing now would hand the worker back the exact failure the hold was placed for.",
      },
    };
  }
  return { exitCode: 0, report: { mode: "release", channelAccountId: args.channelAccountId, ...outcome } };
}

async function main(): Promise<void> {
  const args = parsePreviewAccountHoldArgs(process.argv.slice(2));
  const db = new PrismaClient();
  try {
    const { exitCode, report } = await runPreviewAccountHoldCli(db, args);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = exitCode;
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "preview_account_hold_failed");
    process.exitCode = 64;
  });
}
