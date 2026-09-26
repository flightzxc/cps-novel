/**
 * Operator CLI for opening up "试读正式开放" (v0.4.5, `enqueuePublicationPreviews`
 * / `src/server/publication/preview-enqueue.ts`): preview refresh is now
 * triggered when an article is published, grouped by the promo link's own
 * channel account + application, skipping a book that is already fresh, is
 * already in flight, or whose account is under a preview hold.
 *
 * Two problems have to be solved once, in this exact order (see this
 * command's own delivery report for why the order matters — the worker
 * drains `channel_sync` ahead of `generic` on every cycle, so opening the
 * publish-triggered write path before the backlog is cleared lets the
 * backlog dominate every claim round):
 *
 *  1. `cancel-backlog` — v0.4.5's predecessor left ~80k
 *     `moboreader.preview_refresh.v1` `channel_sync_task` rows `pending`
 *     with `params.trigger = "auto"`, created before this task type was ever
 *     added to the worker's allowlist. They were never attempted. Left
 *     alone, every one of them is "in flight" from
 *     `enqueueMoboreaderPreviewRefreshTaskInDb`'s own point of view (its
 *     `busyNovels` check matches on `taskType`+`mode`+`status IN (pending,
 *     processing, paused, disabled)`, `preview_in_flight` (`src/lib/tasks/
 *     moboreader.ts`) — not on whether anything has ever executed), so a
 *     freshly published book whose backlog task exists would silently never
 *     get a real preview.
 *
 *  2. `enqueue-published` — once the backlog is gone, every `novel_article`
 *     that reached `published` before this capability existed still needs
 *     its preview materialized once; nothing re-triggers it automatically
 *     for an already-published row.
 *
 * Both problems are handled with the exact machinery the running system
 * already trusts, never a parallel ad hoc implementation:
 *
 *  - `cancel-backlog` mirrors `abortTask` (`src/server/task-admin/
 *    service.ts`): parent task locked `FOR UPDATE`, `terminatePendingTaskItems`
 *    (`src/lib/tasks/task-termination.ts`, unmodified, imported) drives every
 *    still-`pending` item to `skipped` in the SAME transaction that flips the
 *    parent to `cancelled`, and an `operation_audit` row records it — same
 *    shape `abortTask` itself writes,见 this file's own delivery report for
 *    the field-by-field equivalence proof. The one deliberate difference:
 *    this is a system batch tool, not an interactive 2FA-gated admin mutation
 *    — `abortTask`'s own `requireFreshAdminServiceMutation` call has no
 *    meaning here (there is no admin session), so every write below goes in
 *    under `operation_audit.actor_type = "system"`, never `"admin"` — and a
 *    distinct action name (`CANCEL_BACKLOG_AUDIT_ACTION`) and termination
 *    reason code so an operator reading the audit trail can always tell a
 *    bulk backlog sweep apart from someone clicking "abort" in the admin UI.
 *
 *  - `enqueue-published` calls `enqueuePublicationPreviews`
 *    (`src/server/publication/preview-enqueue.ts`) completely unmodified, in
 *    ≤200-article chunks (that module's own comment: "mixed local adapter
 *    load ... legal <=200 publish batches" —
 *    `tests/integration/tasks/publication-preview-postgres.test.ts`). No
 *    parallel grouping/eligibility logic is written for the *execute* path —
 *    only the *stats* path (which must never write) recomputes a read-only
 *    approximation; see `planPublicationPreviews`'s own doc comment for
 *    exactly what that approximation can and cannot predict.
 *
 * Both subcommands refuse to run against anything but the `web_app` database
 * role (`SELECT current_user`) — the same role every production caller of
 * `abortTask`/`enqueuePublicationPreviews` already runs under (the admin
 * service and the publish path both execute inside the Web tier's
 * connection), so this tool never needs, and is never granted, more than
 * `web_app` already has.
 *
 * Designed to run unmodified inside the already-built v0.4.5 image: only
 * relative imports (`../src/...`), exactly like every other file in this
 * directory (`scripts/preview-account-hold.ts`, `scripts/x8-preview-one.ts`,
 * ...) — never the `@/*` tsconfig path alias, which `tsx` resolves against
 * the nearest `tsconfig.json` *above the entry file's own directory*, so it
 * silently stops working the moment this file is copied somewhere that is
 * not a descendant of the project root (e.g. `/tmp` inside the deployed
 * container). See this command's delivery report for the exact `docker cp`
 * placement this was verified against.
 *
 * Statistics (the default, no `--apply`): read-only, JSON to stdout, safe to
 * run anytime. Execution (`--apply`): requires an explicit, exact
 * `--expect-count`/`--confirm` plus a `--request-id`/`--reason` audit trail,
 * and refuses outright (zero writes) if the matched scope contains even one
 * `processing` item.
 *
 * cancel-backlog stats:
 *   npx tsx scripts/preview-opening.ts cancel-backlog \
 *     --task-type moboreader.preview_refresh.v1 --status pending --trigger auto \
 *     --created-from 2026-09-23T00:00:00.000Z --created-to 2026-09-23T06:00:00.000Z
 *
 * cancel-backlog execute:
 *   npx tsx scripts/preview-opening.ts cancel-backlog \
 *     --task-type moboreader.preview_refresh.v1 --status pending --trigger auto \
 *     --created-from 2026-09-23T00:00:00.000Z --created-to 2026-09-23T06:00:00.000Z \
 *     --apply --expect-count 80006 --confirm CANCEL-PREVIEW-BACKLOG \
 *     --request-id <uuid> --reason "clear pre-v0.4.5 preview backlog" --limit 500
 *
 * enqueue-published stats:
 *   npx tsx scripts/preview-opening.ts enqueue-published
 *
 * enqueue-published execute:
 *   npx tsx scripts/preview-opening.ts enqueue-published \
 *     --apply --confirm ENQUEUE-PUBLISHED-PREVIEWS \
 *     --request-id <uuid> --reason "backfill previews for already-published novel_article"
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

import { Prisma, PrismaClient } from "@prisma/client";

import { withDbRetry } from "../src/lib/db/db-retry";
import { terminatePendingTaskItems } from "../src/lib/tasks/task-termination";
import { mergeTaskControlResult, type TaskControlMarker } from "../src/lib/tasks/task-control";
import { enqueuePublicationPreviews } from "../src/server/publication/preview-enqueue";
import { buildPublicArticleWhere, isPromoReady } from "../src/server/publication/visibility";
import { SITE_LOCALES } from "../src/lib/locale/locale-canonical";

export const CANCEL_BACKLOG_CONFIRM_PHRASE = "CANCEL-PREVIEW-BACKLOG";
export const ENQUEUE_PUBLISHED_CONFIRM_PHRASE = "ENQUEUE-PUBLISHED-PREVIEWS";

/** No human actor is behind this tool — `operation_audit.actor_id` is left null for every write it makes (same convention `src/lib/tasks/promo-claim-release.ts`'s `auditSystemAction` already uses for `actorType: "system"`). This string is only ever the `actorId` handed to `enqueuePublicationPreviews` (which threads it into `channel_sync_task_item.payload.actorId` and, for a newly created task, that task's own `moboreader.preview_refresh.queued*` audit row — never into `operation_audit.actor_id` for this script's own rows). */
export const PREVIEW_OPENING_SYSTEM_ACTOR = "system:preview-opening";

/**
 * `operation_audit.action` for a bulk backlog cancellation. Deliberately
 * distinct from `TASK_ABORT_AUDIT_ACTION` ("task.abort",
 * `src/server/task-admin/service.ts`) even though the outward effect is the
 * same (task -> cancelled, pending items -> skipped) — this write always
 * carries `actor_type = "system"`, never goes through the 2FA-gated admin
 * mutation path, and an operator reading `operation_audit` must be able to
 * tell "someone clicked abort" apart from "the backlog-clearing script ran"
 * at a glance.
 */
export const CANCEL_BACKLOG_AUDIT_ACTION = "preview_opening.cancel_backlog";

/**
 * `terminatePendingTaskItems`'s per-item error code, again deliberately
 * distinct from `TASK_ABORT_TERMINATION_REASON` ("task_manually_aborted") —
 * these items were never manually aborted by anyone; they were cancelled by
 * this script before v0.4.5's publish-triggered preview path existed to ever
 * attempt them.
 */
export const CANCEL_BACKLOG_TERMINATION_REASON_CODE = "preview_opening_backlog_cancelled";
const CANCEL_BACKLOG_TERMINATION_REASON_MESSAGE =
  "Preview backlog task cancelled by scripts/preview-opening.ts (cancel-backlog) before v0.4.5's "
  + "publish-triggered previews existed; this item was never attempted";

const ENQUEUE_CHUNK_SIZE = 200;

export class PreviewOpeningError extends Error {
  readonly code: string;
  readonly detail: Record<string, unknown> | null;
  constructor(code: string, detail: Record<string, unknown> | null = null) {
    super(code);
    this.name = "PreviewOpeningError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Both subcommands run under exactly the database role production already
 * trusts for this work (`abortTask` and `enqueuePublicationPreviews` both
 * execute inside the Web tier's own `web_app` connection) — never a
 * broader one. Checked unconditionally, in both statistics and execute mode.
 */
export async function assertWebAppRole(db: PrismaClient): Promise<void> {
  const rows = await db.$queryRaw<Array<{ current_user: string }>>(Prisma.sql`SELECT current_user`);
  const role = rows[0]?.current_user ?? null;
  if (role !== "web_app") {
    throw new PreviewOpeningError("wrong_database_role", { role, expected: "web_app" });
  }
}

// ---------------------------------------------------------------------------
// Small, dependency-free argv helpers (same style as `scripts/preview-account
// -hold.ts`'s `option()` — this repo's `scripts/` directory deliberately
// carries no CLI-parsing library dependency).
// ---------------------------------------------------------------------------

function option(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function requireOption(argv: readonly string[], flag: string): string {
  const value = option(argv, flag);
  if (value === undefined) throw new PreviewOpeningError("missing_argument", { flag });
  return value;
}

function requireIsoDate(argv: readonly string[], flag: string): Date {
  const raw = requireOption(argv, flag);
  const date = new Date(raw);
  if (Number.isNaN(date.valueOf())) throw new PreviewOpeningError("invalid_argument", { flag, value: raw });
  return date;
}

function requirePositiveInt(argv: readonly string[], flag: string): number {
  const raw = requireOption(argv, flag);
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0 || String(value) !== raw.trim()) {
    throw new PreviewOpeningError("invalid_argument", { flag, value: raw });
  }
  return value;
}

function requireNonNegativeInt(argv: readonly string[], flag: string): number {
  const raw = requireOption(argv, flag);
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 0 || String(value) !== raw.trim()) {
    throw new PreviewOpeningError("invalid_argument", { flag, value: raw });
  }
  return value;
}

function requireConfirm(argv: readonly string[], phrase: string): void {
  if (option(argv, "--confirm") !== phrase) {
    throw new PreviewOpeningError("confirmation_invalid", { flag: "--confirm", expected: phrase });
  }
}

// ---------------------------------------------------------------------------
// cancel-backlog
// ---------------------------------------------------------------------------

export type CancelBacklogFilters = {
  readonly taskType: string;
  readonly status: string;
  readonly trigger: string;
  readonly createdFrom: Date;
  readonly createdTo: Date;
};

/** Every filter is mandatory — a partially-scoped bulk cancellation against 80k rows is exactly the shape of mistake this tool exists to make impossible. */
export function parseCancelBacklogFilters(argv: readonly string[]): CancelBacklogFilters {
  return {
    taskType: requireOption(argv, "--task-type"),
    status: requireOption(argv, "--status"),
    trigger: requireOption(argv, "--trigger"),
    createdFrom: requireIsoDate(argv, "--created-from"),
    createdTo: requireIsoDate(argv, "--created-to"),
  };
}

export type CancelBacklogStats = {
  readonly filters: {
    readonly taskType: string; readonly status: string; readonly trigger: string;
    readonly createdFrom: string; readonly createdTo: string;
  };
  readonly taskCount: number;
  readonly itemStatusCounts: Record<string, number>;
  readonly processingItemCount: number;
  readonly byAccountApp: ReadonlyArray<{ channelAccountId: string; channelAppId: string; taskCount: number }>;
  readonly earliestCreatedAt: string | null;
  readonly latestCreatedAt: string | null;
};

/**
 * Pure read (three `SELECT`s, no transaction needed — nothing here writes).
 * `--created-to` is inclusive, matching `--created-from`: both bounds are
 * `created_at >= from AND created_at <= to`.
 */
export async function computeCancelBacklogStats(
  db: PrismaClient,
  filters: CancelBacklogFilters,
): Promise<CancelBacklogStats> {
  const [summary] = await db.$queryRaw<Array<{ task_count: bigint; earliest: Date | null; latest: Date | null }>>(Prisma.sql`
    SELECT count(*)::bigint AS task_count, min(created_at) AS earliest, max(created_at) AS latest
    FROM channel_sync_task
    WHERE task_type = ${filters.taskType} AND status = ${filters.status}
      AND params ->> 'trigger' = ${filters.trigger}
      AND created_at >= ${filters.createdFrom} AND created_at <= ${filters.createdTo}
  `);
  const byAccountAppRows = await db.$queryRaw<Array<{ channel_account_id: string; channel_app_id: string; task_count: bigint }>>(Prisma.sql`
    SELECT channel_account_id, channel_app_id, count(*)::bigint AS task_count
    FROM channel_sync_task
    WHERE task_type = ${filters.taskType} AND status = ${filters.status}
      AND params ->> 'trigger' = ${filters.trigger}
      AND created_at >= ${filters.createdFrom} AND created_at <= ${filters.createdTo}
    GROUP BY channel_account_id, channel_app_id
    ORDER BY task_count DESC, channel_account_id, channel_app_id
  `);
  const itemRows = await db.$queryRaw<Array<{ status: string; item_count: bigint }>>(Prisma.sql`
    SELECT i.status AS status, count(*)::bigint AS item_count
    FROM channel_sync_task_item i
    JOIN channel_sync_task t ON t.id = i.task_id
    WHERE t.task_type = ${filters.taskType} AND t.status = ${filters.status}
      AND t.params ->> 'trigger' = ${filters.trigger}
      AND t.created_at >= ${filters.createdFrom} AND t.created_at <= ${filters.createdTo}
    GROUP BY i.status
  `);
  const itemStatusCounts: Record<string, number> = {};
  for (const row of itemRows) itemStatusCounts[row.status] = Number(row.item_count);
  return {
    filters: {
      taskType: filters.taskType, status: filters.status, trigger: filters.trigger,
      createdFrom: filters.createdFrom.toISOString(), createdTo: filters.createdTo.toISOString(),
    },
    taskCount: Number(summary?.task_count ?? 0n),
    itemStatusCounts,
    processingItemCount: itemStatusCounts.processing ?? 0,
    byAccountApp: byAccountAppRows.map((row) => ({
      channelAccountId: row.channel_account_id, channelAppId: row.channel_app_id, taskCount: Number(row.task_count),
    })),
    earliestCreatedAt: summary?.earliest ? summary.earliest.toISOString() : null,
    latestCreatedAt: summary?.latest ? summary.latest.toISOString() : null,
  };
}

/** Statistics entry point: role check + the read-only computation above. Never writes. */
export async function runCancelBacklogStats(db: PrismaClient, filters: CancelBacklogFilters): Promise<CancelBacklogStats> {
  await assertWebAppRole(db);
  return computeCancelBacklogStats(db, filters);
}

async function fetchCancelBacklogCandidateIds(
  db: PrismaClient,
  filters: CancelBacklogFilters,
  limit: number,
): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM channel_sync_task
    WHERE task_type = ${filters.taskType} AND status = ${filters.status}
      AND params ->> 'trigger' = ${filters.trigger}
      AND created_at >= ${filters.createdFrom} AND created_at <= ${filters.createdTo}
    ORDER BY created_at, id
    LIMIT ${limit}
  `);
  return rows.map((row) => row.id);
}

type LockedBacklogTaskRow = { id: string; status: string; result: Prisma.JsonValue | null };

type CancelOneOutcome =
  | { readonly taskId: string; readonly outcome: "cancelled"; readonly terminatedItemCount: number; readonly auditId: string }
  | { readonly taskId: string; readonly outcome: "skipped_not_pending"; readonly terminatedItemCount: 0 };

/**
 * Mirrors `abortTask`'s own transaction body (`src/server/task-admin/
 * service.ts`, `lockParent` + `terminatePendingTaskItems` + the `cancelled`
 * `updateMany` guarded on the status it just locked + one `operation_audit`
 * row) — same lock, same termination call, same guarded update, same single
 * audit row per task. The two differences are exactly the ones this file's
 * header documents: no 2FA/admin-authorization wrapper (there is no admin
 * session here), and `actor_type = "system"` / a distinct action + reason
 * code so the audit trail stays honestly labeled.
 *
 * One task, one transaction — never a multi-task transaction — so a crash or
 * Ctrl-C mid-run leaves every already-committed task exactly `cancelled` and
 * every not-yet-reached task exactly as it was, and the *outer* loop
 * (`runCancelBacklogApply`) naturally only ever re-selects tasks still
 * `status = 'pending'` on any rerun.
 */
async function cancelOneBacklogTask(
  db: PrismaClient,
  taskId: string,
  ctx: { readonly requestId: string; readonly reason: string; readonly now: Date },
): Promise<CancelOneOutcome> {
  const derivedRequestId = `${ctx.requestId}:${taskId}`;
  return withDbRetry(
    () => db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<LockedBacklogTaskRow[]>(Prisma.sql`
        SELECT id, status, result FROM channel_sync_task WHERE id = ${taskId}::uuid FOR UPDATE
      `);
      const parent = rows[0];
      // Not found, or already moved off `pending` (a prior interrupted run
      // already cancelled it, or something else changed it) -- never treated
      // as an error; the outer loop's own candidate query already scopes to
      // `status = 'pending'`, so this is only ever a narrow, harmless race.
      if (!parent || parent.status !== "pending") {
        return { taskId, outcome: "skipped_not_pending" as const, terminatedItemCount: 0 as const };
      }
      const { terminatedCount } = await terminatePendingTaskItems(tx, "channel_sync", taskId, {
        code: CANCEL_BACKLOG_TERMINATION_REASON_CODE,
        message: CANCEL_BACKLOG_TERMINATION_REASON_MESSAGE,
      });
      const marker: TaskControlMarker = {
        kind: "aborted", source: "system", at: ctx.now.toISOString(), actorId: null,
        reason: ctx.reason, terminatedPendingItemCount: terminatedCount,
      };
      const updated = await tx.channelSyncTask.updateMany({
        where: { id: taskId, status: "pending" },
        data: { status: "cancelled", result: mergeTaskControlResult(parent.result, marker) },
      });
      if (updated.count !== 1) throw new PreviewOpeningError("concurrent_write", { taskId });
      const audit = await tx.operationAudit.create({
        data: {
          actorType: "system", actorId: null, action: CANCEL_BACKLOG_AUDIT_ACTION,
          entityType: "Task", entityId: taskId, requestId: derivedRequestId,
          taskType: "channel_sync", taskId, reason: ctx.reason,
          beforeSnapshot: { status: parent.status },
          afterSnapshot: { status: "cancelled", terminatedPendingItemCount: terminatedCount },
        },
        select: { id: true },
      });
      return {
        taskId, outcome: "cancelled" as const,
        terminatedItemCount: terminatedCount, auditId: audit.id.toString(),
      };
    }),
    { op: "preview-opening.cancel-backlog", itemId: taskId, idempotencyKey: derivedRequestId },
  );
}

export type CancelBacklogApplyOptions = {
  readonly filters: CancelBacklogFilters;
  readonly expectCount: number;
  readonly requestId: string;
  readonly reason: string;
  readonly limit: number;
};

export function parseCancelBacklogApplyOptions(argv: readonly string[]): CancelBacklogApplyOptions {
  const filters = parseCancelBacklogFilters(argv);
  const expectCount = requireNonNegativeInt(argv, "--expect-count");
  requireConfirm(argv, CANCEL_BACKLOG_CONFIRM_PHRASE);
  const requestId = requireOption(argv, "--request-id");
  const reason = requireOption(argv, "--reason");
  const limit = requirePositiveInt(argv, "--limit");
  return { filters, expectCount, requestId, reason, limit };
}

export type CancelBacklogApplyResult = {
  readonly refused: string | null;
  readonly stats: CancelBacklogStats;
  readonly cancelledTaskCount: number;
  readonly terminatedItemCount: number;
  readonly skippedNotPendingCount: number;
  readonly batches: number;
};

/**
 * Execute entry point. Refuses (zero writes -- the refusal check runs before
 * any transaction is opened) when the freshly recomputed scope contains a
 * `processing` item, or when its task count does not exactly equal
 * `--expect-count`. Otherwise processes the scope in `--limit`-sized pages,
 * one task per transaction (see `cancelOneBacklogTask`), and is safe to
 * re-run to completion after an interruption.
 */
export async function runCancelBacklogApply(
  db: PrismaClient,
  options: CancelBacklogApplyOptions,
  now: Date = new Date(),
): Promise<CancelBacklogApplyResult> {
  await assertWebAppRole(db);
  const stats = await computeCancelBacklogStats(db, options.filters);
  if (stats.processingItemCount > 0) {
    return {
      refused: "processing_items_present", stats,
      cancelledTaskCount: 0, terminatedItemCount: 0, skippedNotPendingCount: 0, batches: 0,
    };
  }
  if (stats.taskCount !== options.expectCount) {
    return {
      refused: "expect_count_mismatch", stats,
      cancelledTaskCount: 0, terminatedItemCount: 0, skippedNotPendingCount: 0, batches: 0,
    };
  }
  let cancelledTaskCount = 0;
  let terminatedItemCount = 0;
  let skippedNotPendingCount = 0;
  let batches = 0;
  for (;;) {
    const ids = await fetchCancelBacklogCandidateIds(db, options.filters, options.limit);
    if (ids.length === 0) break;
    batches += 1;
    for (const taskId of ids) {
      const outcome = await cancelOneBacklogTask(db, taskId, {
        requestId: options.requestId, reason: options.reason, now,
      });
      if (outcome.outcome === "cancelled") {
        cancelledTaskCount += 1;
        terminatedItemCount += outcome.terminatedItemCount;
      } else {
        skippedNotPendingCount += 1;
      }
    }
    console.error(
      `[preview-opening] cancel-backlog progress: batches=${batches} `
      + `cancelled=${cancelledTaskCount} terminatedItems=${terminatedItemCount} `
      + `skippedNotPending=${skippedNotPendingCount}`,
    );
  }
  return { refused: null, stats, cancelledTaskCount, terminatedItemCount, skippedNotPendingCount, batches };
}

// ---------------------------------------------------------------------------
// enqueue-published
// ---------------------------------------------------------------------------

type CandidateArticleRow = {
  id: string;
  novelId: string | null;
  promoLink: {
    status: string; webUrl: string | null; appUrl: string | null; deletedAt: Date | null;
    channelAccountId: string; channelAppId: string; novelSourceItemId: string;
    novelSourceItem: { novelId: string | null; channelAppId: string; deletedAt: Date | null };
  } | null;
};

/** Same candidate universe `enqueuePublicationPreviews` itself would accept: every currently-public `novel_article` in a site locale. Both the stats path and the execute path gather this exact same set — the only difference is what they do with it afterward. */
async function fetchCandidateArticles(db: PrismaClient, env: NodeJS.ProcessEnv): Promise<CandidateArticleRow[]> {
  return db.article.findMany({
    where: buildPublicArticleWhere({ articleType: "novel_article", locale: { in: [...SITE_LOCALES] } }, env),
    select: {
      id: true, novelId: true,
      promoLink: { select: {
        status: true, webUrl: true, appUrl: true, deletedAt: true,
        channelAccountId: true, channelAppId: true, novelSourceItemId: true,
        novelSourceItem: { select: { novelId: true, channelAppId: true, deletedAt: true } },
      } },
    },
    orderBy: { id: "asc" },
  });
}

export type EnqueuePublishedPlanGroup = {
  readonly channelAccountId: string; readonly channelAppId: string; readonly novelCount: number;
};

export type EnqueuePublishedPlan = {
  readonly articleCount: number;
  readonly distinctNovelCount: number;
  readonly groups: ReadonlyArray<EnqueuePublishedPlanGroup>;
  /** Article-level skips only (`promo_not_ready` / `source_binding_invalid` / `duplicate_novel`) -- see this function's doc comment for what it deliberately does not predict. */
  readonly skipReasonCounts: Record<string, number>;
};

/**
 * Read-only twin of `enqueuePublicationPreviews`'s own per-article grouping
 * loop (`src/server/publication/preview-enqueue.ts`) -- promo readiness,
 * source-binding validity, "one book once" dedupe, group key = channel
 * account + application. Reproduced here, not imported, because that
 * function has no side-effect-free half to call and the stats path must
 * never write (`enqueueMoboreaderPreviewRefreshTask` — reached from inside
 * it — always creates/updates rows).
 *
 * What this CANNOT predict, and the execute path's actual result can
 * therefore differ from this plan on: every check
 * `enqueueMoboreaderPreviewRefreshTaskInDb` (`src/lib/tasks/moboreader.ts`)
 * applies at the *group* level, after this function's own article-level
 * admission -- channel/application/source-app active + allowlisted, the
 * account having exactly one active+unexpired credential, the book's own
 * preview freshness policy, another in-flight task already covering the
 * same book, and an active `channel_account_hold`. None of those are
 * reproduced here; they are only ever answered by actually calling
 * `enqueuePublicationPreviews`, which is exactly what `runEnqueuePublished
 * Apply` below does. Treat `groups`/`skipReasonCounts` here as an upper
 * bound on what execute will actually enqueue, not a forecast of it.
 */
function planPublicationPreviews(articles: readonly CandidateArticleRow[]): EnqueuePublishedPlan {
  const skipReasonCounts: Record<string, number> = {};
  const skip = (reason: string) => { skipReasonCounts[reason] = (skipReasonCounts[reason] ?? 0) + 1; };
  const groups = new Map<string, { channelAccountId: string; channelAppId: string; novelIds: Set<string> }>();
  const books = new Set<string>();
  for (const article of articles) {
    const promo = article.promoLink;
    if (!promo || promo.deletedAt || !isPromoReady(promo)) { skip("promo_not_ready"); continue; }
    if (!article.novelId || promo.novelSourceItem.deletedAt
      || promo.novelSourceItem.novelId !== article.novelId
      || promo.novelSourceItem.channelAppId !== promo.channelAppId) { skip("source_binding_invalid"); continue; }
    if (books.has(article.novelId)) { skip("duplicate_novel"); continue; }
    books.add(article.novelId);
    const key = `${promo.channelAccountId}:${promo.channelAppId}`;
    const group = groups.get(key) ?? { channelAccountId: promo.channelAccountId, channelAppId: promo.channelAppId, novelIds: new Set<string>() };
    group.novelIds.add(article.novelId);
    groups.set(key, group);
  }
  return {
    articleCount: articles.length,
    distinctNovelCount: books.size,
    groups: [...groups.values()].map((group) => ({
      channelAccountId: group.channelAccountId, channelAppId: group.channelAppId, novelCount: group.novelIds.size,
    })),
    skipReasonCounts,
  };
}

/** Statistics entry point: role check + the read-only plan above. Never calls `enqueuePublicationPreviews` (which writes) -- this is what makes the stats path zero-write. */
export async function computeEnqueuePublishedStats(
  db: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EnqueuePublishedPlan> {
  await assertWebAppRole(db);
  const articles = await fetchCandidateArticles(db, env);
  return planPublicationPreviews(articles);
}

export type EnqueuePublishedApplyOptions = { readonly requestId: string; readonly reason: string };

export function parseEnqueuePublishedApplyOptions(argv: readonly string[]): EnqueuePublishedApplyOptions {
  requireConfirm(argv, ENQUEUE_PUBLISHED_CONFIRM_PHRASE);
  const requestId = requireOption(argv, "--request-id");
  const reason = requireOption(argv, "--reason");
  return { requestId, reason };
}

export type EnqueuePublishedApplyResult = {
  readonly plan: EnqueuePublishedPlan;
  readonly chunks: number;
  readonly groupsQueued: number;
  readonly skipReasonCounts: Record<string, number>;
  readonly results: ReadonlyArray<{ channelAccountId: string; channelAppId: string; result: unknown }>;
};

/**
 * Execute entry point. Gathers the exact same candidate universe the stats
 * path plans over, then calls `enqueuePublicationPreviews` — completely
 * unmodified — in ≤200-article chunks, exactly like a real
 * `publishArticlesBatch` call already does
 * (`tests/integration/tasks/publication-preview-postgres.test.ts`'s own
 * "legal <=200 publish batches" case). `--reason` is recorded by this
 * script's caller for its own audit trail only —
 * `enqueuePublicationPreviews`/`enqueueMoboreaderPreviewRefreshTask` accept
 * no reason field of their own; the same `--request-id` is reused across
 * every chunk, which is safe (their own per-group `requestToken` hash
 * already folds in the group's article-id set, not just the request id —
 * see `preview-enqueue.ts`'s own comment on retried partially-committed
 * batches).
 */
export async function runEnqueuePublishedApply(
  db: PrismaClient,
  options: EnqueuePublishedApplyOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EnqueuePublishedApplyResult> {
  await assertWebAppRole(db);
  const articles = await fetchCandidateArticles(db, env);
  const plan = planPublicationPreviews(articles);
  const ids = articles.map((article) => article.id);
  const skipReasonCounts: Record<string, number> = {};
  const results: Array<{ channelAccountId: string; channelAppId: string; result: unknown }> = [];
  let chunks = 0;
  for (let offset = 0; offset < ids.length; offset += ENQUEUE_CHUNK_SIZE) {
    chunks += 1;
    const chunk = ids.slice(offset, offset + ENQUEUE_CHUNK_SIZE);
    const outcome = await enqueuePublicationPreviews(
      db, { articleIds: chunk, requestId: options.requestId, actorId: PREVIEW_OPENING_SYSTEM_ACTOR }, env,
    );
    for (const [reason, count] of Object.entries(outcome.skipReasonCounts)) {
      skipReasonCounts[reason] = (skipReasonCounts[reason] ?? 0) + count;
    }
    for (const group of outcome.groups) results.push(group);
    console.error(
      `[preview-opening] enqueue-published progress: chunk=${chunks} articles=${chunk.length} groups=${outcome.groups.length}`,
    );
  }
  return { plan, chunks, groupsQueued: results.length, skipReasonCounts, results };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const rest = argv.slice(1);
  const db = new PrismaClient();
  try {
    if (command === "cancel-backlog") {
      if (rest.includes("--apply")) {
        const options = parseCancelBacklogApplyOptions(rest);
        const result = await runCancelBacklogApply(db, options);
        console.log(JSON.stringify(result, null, 2));
        process.exitCode = result.refused ? 1 : 0;
      } else {
        const filters = parseCancelBacklogFilters(rest);
        const stats = await runCancelBacklogStats(db, filters);
        console.log(JSON.stringify(stats, null, 2));
      }
    } else if (command === "enqueue-published") {
      if (rest.includes("--apply")) {
        const options = parseEnqueuePublishedApplyOptions(rest);
        const result = await runEnqueuePublishedApply(db, options);
        console.log(JSON.stringify(result, null, 2));
      } else {
        const stats = await computeEnqueuePublishedStats(db);
        console.log(JSON.stringify(stats, null, 2));
      }
    } else {
      throw new PreviewOpeningError("unknown_command", { command: command ?? null });
    }
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    if (error instanceof PreviewOpeningError) {
      console.error(JSON.stringify({ error: error.code, detail: error.detail }));
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 64;
  });
}
