/**
 * Phase B entity fix — shared core for the Channel/SourceApp code+name swap.
 *
 * 施工工单_PhaseB_实体订正与运营表单Parity_2026-09-06.md §二 (Owner-approved,
 * no further sign-off required to run against a target database):
 *
 *   entity      | current (wrong)        | target
 *   ----------- | ----------------------- | -----------------------
 *   Channel     | moboreader / MoboReader | changdu / Changdu
 *   SourceApp   | changdu / Changdu       | moboreader / MoboReader
 *   ChannelApp.externalAppId stays "moboreader" -- untouched by this module.
 *
 * Hard constraints from the work order, enforced here (not left to callers):
 *   - id never changes; only `code`/`name` on the two rows.
 *   - no other table's foreign keys are written -- only `channel` and
 *     `source_app` rows are ever UPDATEd.
 *   - the row to update is resolved by CURRENT `code`, but the actual
 *     UPDATE statement is `WHERE id = $resolvedId` (never `WHERE code =
 *     ...` alone) -- see `applyFoundationSwap`'s `updateMany` calls.
 *   - resolution rejects unless it finds EXACTLY one row; 0 or >1 aborts
 *     with no write attempted.
 *   - a full snapshot (row identity, every listed foreign-key table's row
 *     count, `channelApp.externalAppId`, and the exact set of
 *     `ChannelAccount` ids under this channel) is taken before and after,
 *     inside the same transaction, and compared -- anything other than the
 *     two rows' `code`/`name` differing throws (which rolls back the
 *     transaction).
 *
 * `applyFoundationSwap` and `rollbackFoundationSwap` are the same function
 * with the direction flipped (`"apply"` swaps moboreader/changdu -> the
 * corrected values; `"rollback"` swaps them back) -- both go through
 * `runFoundationSwap`, so the guard logic can never drift between the two
 * directions.
 *
 * This module performs no writes at import time and has no CLI of its own;
 * see the three sibling scripts (`dry-run.ts`, `apply.ts`, `rollback.ts`)
 * for the operator-facing entry points, and
 * `tests/integration/entity-fix/moboreader-foundation-swap.test.ts` for the
 * Postgres-gated integration coverage.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

export class FoundationSwapError extends Error {
  constructor(
    readonly code:
      | "row_not_found"
      | "multiple_rows_found"
      | "unexpected_current_state"
      | "update_row_count_unexpected"
      | "post_update_verification_failed",
    message: string,
  ) {
    super(message);
    this.name = "FoundationSwapError";
  }
}

export type FoundationSwapDirection = "apply" | "rollback";

/** Both known values, in both directions -- resolution never assumes which one is "current". */
const CANDIDATE_CODES = Object.freeze(["moboreader", "changdu"]);

type SwapTarget = { readonly code: string; readonly name: string; readonly expectedCurrentCode: string };

const CHANNEL_TARGET: Readonly<Record<FoundationSwapDirection, SwapTarget>> = Object.freeze({
  apply: Object.freeze({ code: "changdu", name: "Changdu", expectedCurrentCode: "moboreader" }),
  rollback: Object.freeze({ code: "moboreader", name: "MoboReader", expectedCurrentCode: "changdu" }),
});

const SOURCE_APP_TARGET: Readonly<Record<FoundationSwapDirection, SwapTarget>> = Object.freeze({
  apply: Object.freeze({ code: "moboreader", name: "MoboReader", expectedCurrentCode: "changdu" }),
  rollback: Object.freeze({ code: "changdu", name: "Changdu", expectedCurrentCode: "moboreader" }),
});

export type FoundationRow = { readonly id: string; readonly code: string; readonly name: string };

export type ForeignKeyCounts = {
  readonly channelAccounts: number;
  readonly channelApps: number;
  readonly novelSourceItems: number;
  readonly promoLinks: number;
  readonly channelSyncTasks: number;
  /**
   * Phase C (`施工工单_PhaseC_任务模型迁移与ImportProgress_2026-09-06.md`):
   * CatalogScanTask folded into GenericTask (taskType = "catalog_scan"), so
   * this count naturally includes what used to be a separate
   * `catalogScanTasks` field -- there is no longer a distinct table to count.
   */
  readonly genericTasks: number;
};

export type FoundationSnapshot = {
  readonly channel: FoundationRow;
  readonly sourceApp: FoundationRow;
  /** Sorted, de-duplicated `ChannelApp.externalAppId` values under this channel+sourceApp binding. */
  readonly channelAppExternalAppIds: readonly string[];
  /** Sorted `ChannelAccount.id`s under `channel.id` -- the "three accounts still hang off channel_id" check. */
  readonly channelAccountIds: readonly string[];
  readonly counts: ForeignKeyCounts;
};

type FoundationDb = {
  channel: {
    findMany(args: unknown): Promise<FoundationRow[]>;
    findUniqueOrThrow(args: unknown): Promise<FoundationRow>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  sourceApp: {
    findMany(args: unknown): Promise<FoundationRow[]>;
    findUniqueOrThrow(args: unknown): Promise<FoundationRow>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  channelAccount: { findMany(args: unknown): Promise<Array<{ id: string }>> };
  channelApp: { findMany(args: unknown): Promise<Array<{ id: string; externalAppId: string }>> };
  novelSourceItem: { count(args: unknown): Promise<number> };
  promoLink: { count(args: unknown): Promise<number> };
  channelSyncTask: { count(args: unknown): Promise<number> };
  genericTask: { count(args: unknown): Promise<number> };
};

/**
 * Finds the single row in `channel`/`sourceApp` whose code is one of the two
 * known values. Throws `row_not_found` (0 rows) or `multiple_rows_found`
 * (>1 row) -- the work order's "拒绝在找到多行或零行时执行" -- rather than
 * ever guessing which row to touch.
 */
async function resolveSingleFoundationRow(
  db: FoundationDb,
  table: "channel" | "sourceApp",
): Promise<FoundationRow> {
  const rows = await db[table].findMany({
    where: { code: { in: CANDIDATE_CODES as unknown as string[] } },
    select: { id: true, code: true, name: true },
  });
  if (rows.length === 0) {
    throw new FoundationSwapError(
      "row_not_found",
      `expected exactly one "${table}" row with code in [${CANDIDATE_CODES.join(", ")}], found 0`,
    );
  }
  if (rows.length > 1) {
    throw new FoundationSwapError(
      "multiple_rows_found",
      `expected exactly one "${table}" row with code in [${CANDIDATE_CODES.join(", ")}], found ${rows.length}: ${rows
        .map((row) => `${row.id}(${row.code})`)
        .join(", ")}`,
    );
  }
  return rows[0]!;
}

async function loadFoundationSnapshot(
  db: FoundationDb,
  channelId: string,
  sourceAppId: string,
): Promise<FoundationSnapshot> {
  const channel = await db.channel.findUniqueOrThrow({ where: { id: channelId } });
  const sourceApp = await db.sourceApp.findUniqueOrThrow({ where: { id: sourceAppId } });
  const channelAccounts = await db.channelAccount.findMany({
    where: { channelId },
    select: { id: true },
  });
  const channelApps = await db.channelApp.findMany({
    where: { channelId, sourceAppId },
    select: { id: true, externalAppId: true },
  });
  const channelAppIds = channelApps.map((row) => row.id);
  const channelAccountIds = channelAccounts.map((row) => row.id).sort();

  const [novelSourceItems, promoLinks, channelSyncTasks, genericTasks] = await Promise.all([
    db.novelSourceItem.count({ where: { channelAppId: { in: channelAppIds } } }),
    db.promoLink.count({ where: { channelAppId: { in: channelAppIds } } }),
    db.channelSyncTask.count({ where: { channelAccountId: { in: channelAccountIds } } }),
    db.genericTask.count({ where: { channelAccountId: { in: channelAccountIds } } }),
  ]);

  return {
    channel,
    sourceApp,
    channelAppExternalAppIds: Array.from(new Set(channelApps.map((row) => row.externalAppId))).sort(),
    channelAccountIds,
    counts: {
      channelAccounts: channelAccountIds.length,
      channelApps: channelAppIds.length,
      novelSourceItems,
      promoLinks,
      channelSyncTasks,
      genericTasks,
    },
  };
}

function countsEqual(a: ForeignKeyCounts, b: ForeignKeyCounts): boolean {
  return (
    a.channelAccounts === b.channelAccounts &&
    a.channelApps === b.channelApps &&
    a.novelSourceItems === b.novelSourceItems &&
    a.promoLinks === b.promoLinks &&
    a.channelSyncTasks === b.channelSyncTasks &&
    a.genericTasks === b.genericTasks
  );
}

function idSetsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * The work order's "前后快照比对" -- everything that must be identical
 * before and after, aside from the two rows' own `code`/`name`. Throws
 * `post_update_verification_failed` (never returns false) so a caller
 * inside a transaction gets an automatic rollback for free.
 */
export function assertFoundationInvariantsPreserved(before: FoundationSnapshot, after: FoundationSnapshot): void {
  const problems: string[] = [];
  if (before.channel.id !== after.channel.id) problems.push("channel.id changed");
  if (before.sourceApp.id !== after.sourceApp.id) problems.push("sourceApp.id changed");
  if (!idSetsEqual(before.channelAccountIds, after.channelAccountIds)) {
    problems.push(
      `channelAccountIds set changed: before=[${before.channelAccountIds.join(",")}] after=[${after.channelAccountIds.join(",")}]`,
    );
  }
  if (!countsEqual(before.counts, after.counts)) {
    problems.push(`foreign-key counts changed: before=${JSON.stringify(before.counts)} after=${JSON.stringify(after.counts)}`);
  }
  if (!after.channelAppExternalAppIds.every((id) => id === "moboreader")) {
    problems.push(`channelApp.externalAppId drifted: [${after.channelAppExternalAppIds.join(",")}]`);
  }
  if (problems.length > 0) {
    throw new FoundationSwapError("post_update_verification_failed", problems.join("; "));
  }
}

export type FoundationSwapPlan = {
  readonly direction: FoundationSwapDirection;
  readonly channel: FoundationRow & { readonly target: { readonly code: string; readonly name: string } };
  readonly sourceApp: FoundationRow & { readonly target: { readonly code: string; readonly name: string } };
  readonly snapshot: FoundationSnapshot;
  /** True only when both rows are exactly in the pre-state this direction expects. */
  readonly readyToRun: boolean;
};

/**
 * Read-only. Resolves both rows (rejecting on 0/>1 matches, same as the
 * write path), loads the full snapshot, and reports whether the database is
 * in the expected pre-state for `direction`. Never writes.
 */
export async function planFoundationSwap(
  db: FoundationDb,
  direction: FoundationSwapDirection,
): Promise<FoundationSwapPlan> {
  const channelRow = await resolveSingleFoundationRow(db, "channel");
  const sourceAppRow = await resolveSingleFoundationRow(db, "sourceApp");
  const channelTarget = CHANNEL_TARGET[direction];
  const sourceAppTarget = SOURCE_APP_TARGET[direction];
  const snapshot = await loadFoundationSnapshot(db, channelRow.id, sourceAppRow.id);
  return {
    direction,
    channel: { ...channelRow, target: { code: channelTarget.code, name: channelTarget.name } },
    sourceApp: { ...sourceAppRow, target: { code: sourceAppTarget.code, name: sourceAppTarget.name } },
    snapshot,
    readyToRun:
      channelRow.code === channelTarget.expectedCurrentCode && sourceAppRow.code === sourceAppTarget.expectedCurrentCode,
  };
}

export type FoundationSwapReport = {
  readonly direction: FoundationSwapDirection;
  readonly channelId: string;
  readonly sourceAppId: string;
  readonly before: FoundationSnapshot;
  readonly after: FoundationSnapshot;
};

type FoundationTransactionalDb = FoundationDb & {
  $transaction<T>(callback: (tx: FoundationDb) => Promise<T>): Promise<T>;
};

/**
 * The single-transaction write path shared by both `apply` and `rollback`
 * (only `direction` differs). Steps, all inside one `$transaction`:
 *
 *   1. Resolve both rows by current code (0/>1 matches abort, no write).
 *   2. Assert each row's CURRENT code is exactly what this direction
 *      expects to find (`unexpected_current_state` otherwise) -- this is
 *      what makes a second, accidental run of the same direction a no-op
 *      failure instead of a silent double-swap.
 *   3. Snapshot "before".
 *   4. `UPDATE ... WHERE id = $id AND code = $expectedCurrentCode` on both
 *      tables via `updateMany`, asserting `count === 1` each time
 *      (`update_row_count_unexpected` otherwise -- covers a concurrent
 *      writer racing this same row between steps 2 and 4).
 *   5. Snapshot "after" and run `assertFoundationInvariantsPreserved`.
 *
 * No separate "does some other row already hold the target code" pre-check:
 * with exactly two known candidate codes swapping places, any row that
 * already held either target value would necessarily have been caught by
 * step 1's own "resolve by candidate code, reject on >1 match" -- a second
 * check for the same condition would be unreachable dead code, not defense
 * in depth. The `code` column's own UNIQUE constraint remains the backstop
 * against a same-transaction race no application-level check here could see
 * anyway.
 *
 * Any thrown error rolls back the whole transaction -- nothing is left
 * half-swapped.
 */
export async function runFoundationSwap(
  db: FoundationTransactionalDb,
  direction: FoundationSwapDirection,
): Promise<FoundationSwapReport> {
  return db.$transaction(async (tx) => {
    const channelRow = await resolveSingleFoundationRow(tx, "channel");
    const sourceAppRow = await resolveSingleFoundationRow(tx, "sourceApp");
    const channelTarget = CHANNEL_TARGET[direction];
    const sourceAppTarget = SOURCE_APP_TARGET[direction];

    if (channelRow.code !== channelTarget.expectedCurrentCode) {
      throw new FoundationSwapError(
        "unexpected_current_state",
        `channel ${channelRow.id} has code "${channelRow.code}", expected "${channelTarget.expectedCurrentCode}" before a ${direction}`,
      );
    }
    if (sourceAppRow.code !== sourceAppTarget.expectedCurrentCode) {
      throw new FoundationSwapError(
        "unexpected_current_state",
        `sourceApp ${sourceAppRow.id} has code "${sourceAppRow.code}", expected "${sourceAppTarget.expectedCurrentCode}" before a ${direction}`,
      );
    }

    const before = await loadFoundationSnapshot(tx, channelRow.id, sourceAppRow.id);

    const channelUpdate = await tx.channel.updateMany({
      where: { id: channelRow.id, code: channelTarget.expectedCurrentCode },
      data: { code: channelTarget.code, name: channelTarget.name },
    });
    if (channelUpdate.count !== 1) {
      throw new FoundationSwapError(
        "update_row_count_unexpected",
        `channel UPDATE by id=${channelRow.id} affected ${channelUpdate.count} rows, expected exactly 1`,
      );
    }
    const sourceAppUpdate = await tx.sourceApp.updateMany({
      where: { id: sourceAppRow.id, code: sourceAppTarget.expectedCurrentCode },
      data: { code: sourceAppTarget.code, name: sourceAppTarget.name },
    });
    if (sourceAppUpdate.count !== 1) {
      throw new FoundationSwapError(
        "update_row_count_unexpected",
        `sourceApp UPDATE by id=${sourceAppRow.id} affected ${sourceAppUpdate.count} rows, expected exactly 1`,
      );
    }

    const after = await loadFoundationSnapshot(tx, channelRow.id, sourceAppRow.id);
    assertFoundationInvariantsPreserved(before, after);
    if (after.channel.code !== channelTarget.code || after.channel.name !== channelTarget.name) {
      throw new FoundationSwapError(
        "post_update_verification_failed",
        `channel ended at code="${after.channel.code}" name="${after.channel.name}", expected code="${channelTarget.code}" name="${channelTarget.name}"`,
      );
    }
    if (after.sourceApp.code !== sourceAppTarget.code || after.sourceApp.name !== sourceAppTarget.name) {
      throw new FoundationSwapError(
        "post_update_verification_failed",
        `sourceApp ended at code="${after.sourceApp.code}" name="${after.sourceApp.name}", expected code="${sourceAppTarget.code}" name="${sourceAppTarget.name}"`,
      );
    }

    return { direction, channelId: channelRow.id, sourceAppId: sourceAppRow.id, before, after };
  });
}

export async function applyFoundationSwap(db: FoundationTransactionalDb): Promise<FoundationSwapReport> {
  return runFoundationSwap(db, "apply");
}

export async function rollbackFoundationSwap(db: FoundationTransactionalDb): Promise<FoundationSwapReport> {
  return runFoundationSwap(db, "rollback");
}

/** Real-`PrismaClient` shape check, exercised by the CLI wrappers -- kept separate so the core logic above never imports `PrismaClient` as a value (only as a type), keeping it trivially unit-testable against hand-rolled fakes. */
export type RealFoundationDb = PrismaClient;
export type RealFoundationTx = Prisma.TransactionClient;
