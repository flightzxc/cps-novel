/**
 * Shared IndexNow constants (Stream E, P2-11).
 *
 * Ported ADAPT from CPS `src/lib/indexnow-outbox-contract.ts` (93 lines).
 * The review-defer *state machine* (`INDEXNOW_DEFER_REASON` two-stage
 * `await_review_schedule`/`await_review` progression, `resolveIndexNow
 * ReviewMaxWaitMs`, the terminal-source-task watchdog) is CPS's AI-generation
 * "wait for human review before submitting" workflow — this codebase has no
 * equivalent generation-review pipeline to hang a watchdog off of
 * (`P2-07-12-移植审计-2026-08-12/P2-11.md` §6 第 4 条判定 E·DROP). The task
 * book for this PR nonetheless asks for the `deferReason`/`releasedAt`/
 * `releaseReason` *fields* to have a working read/write path (the foundation
 * migration already shipped the columns) — so `outbox.ts` exposes a single
 * generic manual defer/release pair (`deferReason` is a free-form registered
 * code, not the two CPS-specific stage codes) instead of porting the
 * automatic watchdog transition.
 *
 * `SITEMAP_REFRESH_TASK_TYPE`/`INDEXNOW_SITEMAP_STALE_MS` are
 * SHARED_PORT_CANDIDATE — P2-11 confirmed as the owning implementation
 * (`P2-11.md` §9); Stream D's sitemap-refresh enqueue handler imports these
 * two constants from here rather than redefining them.
 */

export const INDEXNOW_DELIVERY_TASK_TYPE = "indexnow_delivery";
export const SITEMAP_REFRESH_TASK_TYPE = "sitemap_refresh";
export const INDEXNOW_SITEMAP_STALE_MS = 35 * 60 * 1000;

/**
 * How stale an `indexnow_outbox.status = 'processing'` row must be before
 * `recoverStaleIndexNowDeliveries` treats it as an abandoned attempt. Reused
 * from CPS's `INDEXNOW_PROCESSING_STALE_MS` (itself an alias of the sitemap
 * staleness constant) — same order of magnitude as a `GenericTaskItem`
 * lease, comfortably longer than `INDEXNOW_HTTP_TIMEOUT_MS`.
 */
export const INDEXNOW_PROCESSING_STALE_MS = INDEXNOW_SITEMAP_STALE_MS;

export const INDEXNOW_EVENT_TYPE_DEFAULT = "article_first_publish";

export type EnqueueIndexNowFirstPublishInput = Readonly<{
  articleId: string;
  source: string;
  sourceTaskId?: string;
  eventType?: string;
  /** Both or neither — see `outbox.ts`'s `enqueueIndexNowFirstPublish`. */
  deferUntil?: Date;
  deferReason?: string;
}>;

export type EnqueueIndexNowFirstPublishOutcome =
  | "enqueued"
  | "deferred"
  | "duplicate"
  | "ineligible"
  | "disabled";

export type EnqueueIndexNowFirstPublishResult = Readonly<{
  outcome: EnqueueIndexNowFirstPublishOutcome;
  outboxId?: string;
}>;
