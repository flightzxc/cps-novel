/**
 * Preview backfill recovery — the missing return edge of the preview chain.
 *
 * 2026-09-14 incident this exists for: during a ~79k-novel catalog
 * materialization the worker could not decrypt the channel account's active
 * credential, and every `moboreader.preview_refresh.v1` task raised
 * `credential_validation_failed` inside `loadMoboreaderPreviewScope`
 * (`worker/handlers/moboreader.ts`). That task type is registered with
 * `maxAttempts: 1`, so each one went straight to terminal `failed`. The
 * promo-link claim chain was burned by the same credential in the same hour
 * and got two fixes out of it (`worker/handlers/promo-link-claim-system-hold.ts`
 * plus the pre-flight readiness gate in `src/app/(admin)/catalog-sync/_actions.ts`).
 * The preview chain got neither, and — unlike the claim chain, whose failed
 * items an operator can retry from the task detail page — it had no recovery
 * path at all:
 *
 *   - `worker/handlers/novel-materialize.ts`, `src/server/content-creation/service.ts`
 *     and `src/server/content-creation/batch.ts` are the only three callers of
 *     `enqueueContentCreationPreview`, and every one of them is gated on
 *     `outcome === "created"` — i.e. on the Novel row not having existed a
 *     moment ago. A Novel that already exists can never have another preview
 *     refresh enqueued through any of them.
 *   - The auto path creates one single-item task per Novel, so the
 *     `retryFailedTask` admin operation (`src/server/task-admin/service.ts`)
 *     is per-task and would need one operator click per Novel.
 *   - `scheduler/index.ts` only schedules `home_carousel.compute.v1`; nothing
 *     periodically re-checks Novels that have no preview.
 *
 * The visible symptom is a publish-gate rejection: `preview_chapter_missing`
 * ("没有可信试读章节") from `src/server/publish-gate/evaluator.ts` on every
 * Article generated for one of those Novels. That gate is correct and is not
 * touched by this module — a Novel with no readable chapter genuinely must not
 * be published. This module repairs the *data chain* instead, by re-entering
 * the exact production enqueue path (`enqueueContentCreationPreview` →
 * `enqueueMoboreaderPreviewRefreshTask` → the worker's preview handler →
 * `materializeChangduPreview`) for Novels that are missing a readable preview
 * chapter. It writes no NovelChapter/NovelChapterContent row itself and knows
 * nothing about upstream MoboReader; everything it enqueues is executed by the
 * ordinary worker under the ordinary feature/write gates.
 *
 * Credential handling deliberately lives *outside* this module: the Web/Server
 * tier may not so much as name the Worker's credential-decryption helper
 * (`tests/backend/auth/credential-contracts.test.ts` greps every `src/server`
 * and `src/lib/credentials` source for it), so the "is this account's
 * credential usable before we enqueue tens of thousands of items again"
 * pre-flight belongs to the CLI in `scripts/preview-backfill-recovery.ts`.
 */
import { Prisma, type PrismaClient } from "@prisma/client";

import { enqueueContentCreationPreview, type ContentCreationPreviewEnqueueResult } from "@/server/content-creation";
import { MOBOREADER_TASK_TYPES } from "@/lib/tasks/moboreader";

/**
 * Per-task item cap for a backfill run. `enqueueMoboreaderPreviewRefreshTask`
 * itself will happily build a task spanning a whole catalog, but a backfill is
 * re-driving work that has already failed once at catalog scale: smaller tasks
 * keep an operator's blast radius, and the `channel_sync_active_scope_uidx`
 * "one active task per (type, account, app, scope)" constraint, workable.
 */
export const PREVIEW_BACKFILL_MAX_BATCH_SIZE = 500;
export const PREVIEW_BACKFILL_DEFAULT_BATCH_SIZE = 200;

/** Hard ceiling on one run, so a typo in `--limit` cannot re-enqueue an entire catalog in one command. */
export const PREVIEW_BACKFILL_MAX_LIMIT = 20_000;

/** Statuses that mean "a preview attempt for this source item is still in flight" — such an item is not a backfill candidate. */
const IN_FLIGHT_STATUSES = ["pending", "processing"] as const;

export type PreviewBackfillCandidate = {
  readonly novelSourceItemId: string;
  readonly novelId: string;
  readonly novelTitle: string;
  /** Status of the most recent preview task item for this source item, or `null` when one was never created. */
  readonly lastPreviewItemStatus: string | null;
  /** `error.message` of that same item — the field that carried `credential_validation_failed` for the 2026-09-14 batch. */
  readonly lastPreviewFailureMessage: string | null;
};

export type PreviewBackfillSurvey = {
  readonly channelAppId: string;
  readonly candidates: readonly PreviewBackfillCandidate[];
  /** `true` when `limit` cut the result off — there are more candidates than were returned. */
  readonly truncated: boolean;
  /** Candidates grouped by `lastPreviewFailureMessage` (`"__never_attempted__"` when there was no task), for the operator's dry-run report. */
  readonly failureBreakdown: Readonly<Record<string, number>>;
};

type SurveyRow = {
  novelSourceItemId: string;
  novelId: string;
  novelTitle: string;
  lastPreviewItemStatus: string | null;
  lastPreviewFailureMessage: string | null;
};

export const NEVER_ATTEMPTED_KEY = "__never_attempted__";

function clampLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("preview_backfill_limit_invalid");
  return Math.min(limit, PREVIEW_BACKFILL_MAX_LIMIT);
}

/**
 * Every Novel of `channelAppId` that currently has **no readable preview
 * chapter** and no preview attempt in flight.
 *
 * "No readable preview chapter" is deliberately the union of the publish
 * gate's two preview reasons rather than just the first: a Novel with a
 * `status = "preview"` NovelChapter whose NovelChapterContent is missing or
 * blank fails the gate with `preview_body_missing` and is exactly as
 * unpublishable, and re-running the same materialization is exactly as much
 * the fix. Mirrors `src/server/publish-gate/facts.ts`'s own predicate
 * (`deletedAt: null, status: "preview"` + non-blank `content.body`) so a Novel
 * this survey calls a candidate is precisely a Novel the gate is rejecting.
 *
 * Novels carrying a `withdrawn` chapter are excluded: `materializeChangduPreview`
 * throws `withdrawn_chapter_requires_manual_review` on them by design, so
 * enqueuing one could only burn another task while overriding nothing — those
 * need the manual rights review that status is asking for.
 *
 * Freshness is *not* re-implemented here. `enqueueMoboreaderPreviewRefreshTask`
 * already skips a source item whose `NovelPreviewPolicy.lastRefreshedAt` is
 * inside the runtime freshness window and reports it as `fresh_preview` in
 * `skipReasonCounts`; duplicating that rule in the candidate query would make
 * two places able to disagree about it.
 */
export async function surveyPreviewBackfillCandidates(
  db: PrismaClient,
  input: {
    readonly channelAppId: string;
    readonly limit: number;
    /**
     * Optional narrowing to specific `NovelSourceItem` ids — the "retry this
     * one book" shape an operator needs when chasing a single stuck Article,
     * and the shape used to rehearse a run before turning it loose on the
     * whole catalog. It only ever *intersects* with the candidate predicate
     * below: naming an id here can never publish-enable a Novel that already
     * has a readable preview, that carries a `withdrawn` chapter, or that has
     * a preview attempt in flight.
     */
    readonly onlySourceItemIds?: readonly string[];
  },
): Promise<PreviewBackfillSurvey> {
  const limit = clampLimit(input.limit);
  const onlySourceItemIds = [...(input.onlySourceItemIds ?? [])];
  const rows = await db.$queryRaw<SurveyRow[]>(Prisma.sql`
    SELECT s.id AS "novelSourceItemId",
           s.novel_id AS "novelId",
           n.title AS "novelTitle",
           last_item.status AS "lastPreviewItemStatus",
           last_item.error->>'message' AS "lastPreviewFailureMessage"
    FROM novel_source_item s
    JOIN novel n ON n.id = s.novel_id
    LEFT JOIN LATERAL (
      SELECT i.status, i.error
      FROM channel_sync_task_item i
      JOIN channel_sync_task t ON t.id = i.task_id
      WHERE i.novel_source_item_id = s.id
        AND t.task_type = ${MOBOREADER_TASK_TYPES.previewRefresh}
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT 1
    ) AS last_item ON TRUE
    WHERE s.channel_app_id = ${input.channelAppId}::uuid
      AND (cardinality(${onlySourceItemIds}::uuid[]) = 0 OR s.id = ANY(${onlySourceItemIds}::uuid[]))
      AND s.deleted_at IS NULL
      AND s.novel_id IS NOT NULL
      AND n.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM novel_chapter c
        JOIN novel_chapter_content cc ON cc.novel_chapter_id = c.id
        WHERE c.novel_id = n.id
          AND c.deleted_at IS NULL
          AND c.status = 'preview'
          AND btrim(cc.body) <> ''
      )
      AND NOT EXISTS (
        SELECT 1
        FROM novel_chapter c
        WHERE c.novel_id = n.id AND c.status = 'withdrawn'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM channel_sync_task_item i
        JOIN channel_sync_task t ON t.id = i.task_id
        WHERE i.novel_source_item_id = s.id
          AND t.task_type = ${MOBOREADER_TASK_TYPES.previewRefresh}
          AND (i.status = ANY(${[...IN_FLIGHT_STATUSES]}::text[]) OR t.status = ANY(${[...IN_FLIGHT_STATUSES]}::text[]))
      )
    ORDER BY s.created_at ASC, s.id ASC
    LIMIT ${limit + 1}
  `);
  const truncated = rows.length > limit;
  const candidates = (truncated ? rows.slice(0, limit) : rows).map((row) => ({
    novelSourceItemId: row.novelSourceItemId,
    novelId: row.novelId,
    novelTitle: row.novelTitle,
    lastPreviewItemStatus: row.lastPreviewItemStatus,
    lastPreviewFailureMessage: row.lastPreviewFailureMessage,
  }));
  const failureBreakdown: Record<string, number> = {};
  for (const candidate of candidates) {
    const key = candidate.lastPreviewItemStatus === null
      ? NEVER_ATTEMPTED_KEY
      : candidate.lastPreviewFailureMessage ?? candidate.lastPreviewItemStatus;
    failureBreakdown[key] = (failureBreakdown[key] ?? 0) + 1;
  }
  return { channelAppId: input.channelAppId, candidates, truncated, failureBreakdown: Object.freeze(failureBreakdown) };
}

export function chunkCandidates(
  candidates: readonly PreviewBackfillCandidate[],
  batchSize: number,
): readonly (readonly PreviewBackfillCandidate[])[] {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > PREVIEW_BACKFILL_MAX_BATCH_SIZE) {
    throw new Error("preview_backfill_batch_size_invalid");
  }
  const batches: PreviewBackfillCandidate[][] = [];
  for (let index = 0; index < candidates.length; index += batchSize) {
    batches.push([...candidates.slice(index, index + batchSize)]);
  }
  return batches;
}

/**
 * Deterministic per-batch `requestToken`. `channel_sync_task.request_token` is
 * `UNIQUE`, so re-running the same `requestId` after a partial failure re-uses
 * the same tokens and the already-created tasks are rejected rather than
 * duplicated — the same idempotency shape
 * `moboreader.preview_refresh.v1:content_create_batch:<requestId>` already has.
 */
export function previewBackfillRequestToken(requestId: string, batchIndex: number): string {
  return `preview_backfill:${requestId}:${batchIndex}`;
}

export type PreviewBackfillBatchOutcome = {
  readonly batchIndex: number;
  readonly requestToken: string;
  readonly novelSourceItemIds: readonly string[];
  readonly enqueue: ContentCreationPreviewEnqueueResult;
};

export type PreviewBackfillRunResult = {
  readonly survey: PreviewBackfillSurvey;
  readonly applied: boolean;
  readonly batches: readonly PreviewBackfillBatchOutcome[];
};

/**
 * Surveys, and — only when `apply` is `true` — re-enqueues preview refresh for
 * each batch through the production `enqueueContentCreationPreview` path.
 * Never writes anything itself: task creation, audit rows and the
 * feature/write-gate decision all stay inside that helper.
 */
export async function runPreviewBackfill(
  db: PrismaClient,
  input: {
    readonly channelAppId: string;
    readonly requestId: string;
    readonly actorId: string;
    readonly limit: number;
    readonly batchSize?: number;
    readonly onlySourceItemIds?: readonly string[];
    readonly apply: boolean;
  },
): Promise<PreviewBackfillRunResult> {
  const survey = await surveyPreviewBackfillCandidates(db, {
    channelAppId: input.channelAppId,
    limit: input.limit,
    onlySourceItemIds: input.onlySourceItemIds,
  });
  const batches = chunkCandidates(survey.candidates, input.batchSize ?? PREVIEW_BACKFILL_DEFAULT_BATCH_SIZE);
  if (!input.apply) return { survey, applied: false, batches: [] };

  const outcomes: PreviewBackfillBatchOutcome[] = [];
  for (const [batchIndex, batch] of batches.entries()) {
    const requestToken = previewBackfillRequestToken(input.requestId, batchIndex);
    const enqueue = await enqueueContentCreationPreview(db, {
      novelSourceItemIds: batch.map((candidate) => candidate.novelSourceItemId),
      requestToken,
      requestId: `${input.requestId}:${batchIndex}`,
      actorId: input.actorId,
    });
    outcomes.push({
      batchIndex,
      requestToken,
      novelSourceItemIds: batch.map((candidate) => candidate.novelSourceItemId),
      enqueue,
    });
  }
  return { survey, applied: true, batches: outcomes };
}
