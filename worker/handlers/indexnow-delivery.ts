/**
 * IndexNow batch delivery `TaskHandler` (Stream E, P2-11; batch delivery B-41).
 *
 * Ported COPY_THEN_ADAPT from CPS `deliverDueIndexNow`
 * (`indexnow-delivery-service.ts:207-368`). One `GenericTaskItem`
 * (`targetType = indexnow_batch`, `payload = { mode: "batch" }`) is one batch
 * of at most `INDEXNOW_HTTP_BATCH_SIZE` (500) `indexnow_outbox` rows and ONE
 * IndexNow HTTP POST whose `urlList` is that batch — bisecting a held batch
 * (below) is the only thing that sends more. The minute sweep
 * (`src/lib/indexnow/sweep.ts`) creates at most one such task per minute.
 *
 * ## Flow (every step that skips writes NOTHING)
 *
 *   1. delivery switches off → `skipped`.
 *   2. payload: legacy `{ outboxId }` item from the single-URL era → `skipped`
 *      `legacy_single_row_item` (no table touched; its row is simply picked up
 *      by the next batch); `{ mode: "batch" }` → continue; anything else →
 *      throw `indexnow_delivery_payload_invalid`.
 *   3. config missing / configured host ≠ `SITE_URL` host → `skipped`.
 *   4. control state: breaker open → `skipped`; global 429 wait → `skipped`.
 *   5. pick up to 500 candidates, FIFO (`createdAt, id`). Rows held by a
 *      breaker trip (`retry_wait`, last status 400/403/422, now due) go FIRST
 *      and ALONE — a "held retry" batch is never mixed with new rows, so a
 *      failure of it is attributable to those rows.
 *   6. per-row pre-flight, in batch: URL format, URL host = configured host,
 *      article still eligible with an unchanged canonical URL. A failing row
 *      becomes `cancelled` (`url_invalid` / `url_host_mismatch` /
 *      `eligibility_failed`, redacted diagnosis in `lastErrorSummary`) and
 *      does not enter the batch.
 *   7. claim — ONE interactive transaction (30 s): control advisory lock,
 *      control state re-derived inside the lock (breaker/429 → claim nothing),
 *      per-row CAS `processing` (`attemptCount` + due predicate), then a
 *      single `createMany` of `started` attempt rows sharing one
 *      `requestBatchId`.
 *   8. ONE HTTP POST. Abort = 10 s timeout OR the task lease's signal.
 *   9. write-back — ONE transaction: attempt rows → `completed`; outbox rows
 *      → status via `resolveOutboxDeliveryStatus` (conditional on
 *      `status = 'processing'` and the attempt number); and, under the control
 *      lock, a `breaker_trip` event for 400/403/422 or a `rate_limited` event
 *      (`waitUntil = db clock + max(Retry-After, 5 min)`) for 429.
 *  10. bisect (only when this was a held-retry batch AND it failed with
 *      400/403/422 — i.e. it failed again after a manual resume): see
 *      `bisectHeldBatch`. The breaker stays open; a human resumes it after
 *      reading `indexnow-status`.
 *
 * ## Why the claim/response writes are not a `protectedWrite`
 *
 * The `started` attempt rows and the flip to `processing` commit BEFORE the
 * HTTP call and are plain interactive transactions, not this item's
 * `protectedWrite` — the same "durable intent before the external call"
 * discipline `docs/p1/P1_OWNER_MINIMUM_CORRECTIONS.md` 修正4 requires of
 * `side_effect_intent`. If the worker dies between the claim and the response,
 * `src/lib/indexnow/recovery.ts` (35 minutes) — not `GenericTaskItem` fencing
 * — notices the batch stuck in `processing` and safely re-pushes it (IndexNow
 * submission is idempotent). The argument is unchanged for a whole batch: all
 * rows of the batch share the fate of the one request. The race between two
 * claimants of the same row is closed by the row CAS plus the attempt table's
 * `@@unique([outboxId, attemptNo])`; because the claim commits before the
 * request, the loser never reaches `fetchImpl`.
 */
import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

// `worker/**` runs under plain `tsx` (`docker-compose.yml`'s worker service
// command), not the Next.js bundler — every existing worker handler
// (`worker/handlers/credential.ts`, `worker/handlers/moboreader.ts`) reaches
// into `src/` with relative paths rather than the `@/*` tsconfig alias, so
// this file follows the same convention rather than risking an alias that
// only `tsc --noEmit` resolves.
import { createHandlerRegistry, type TaskHandler } from "../../src/lib/tasks";
import { isIndexNowDeliveryEnabled, isIndexNowDeliveryWriteAllowed } from "../../src/lib/flags";
import { getIndexNowDeliveryConfig, isIndexNowConfigured } from "../../src/server/site-settings/service";

import {
  INDEXNOW_CONTROL_ACTIONS,
  INDEXNOW_CONTROL_ENTITY_TYPE,
  INDEXNOW_CONTROL_STREAMS,
  getIndexNowDeliveryControlState,
  isIndexNowHostConsistent,
  lockIndexNowControl,
  readIndexNowDbNow,
  recordIndexNowBreakerTrip,
  recordIndexNowRateLimited,
} from "../../src/lib/indexnow/delivery-control";
import {
  buildBlogIndexNowCanonicalUrl,
  buildIndexNowCanonicalUrl,
  isBlogIndexNowEligible,
  isNovelIndexNowEligible,
  loadIndexNowCandidateArticles,
  normalizeCanonicalUrl,
  type IndexNowEligibilityOptions,
} from "../../src/lib/indexnow/eligibility";
import {
  classifyIndexNowResult,
  indexNowDueWhere,
  isIndexNowBreakerStatus,
  parseRetryAfter,
  resolveOutboxDeliveryStatus,
  summarizeIndexNowValue,
  INDEXNOW_BISECT_MAX_EXTRA_ATTEMPTS,
  INDEXNOW_ENDPOINT,
  INDEXNOW_HTTP_BATCH_SIZE,
  INDEXNOW_HTTP_TIMEOUT_MS,
  type OutboxDeliveryDecision,
} from "../../src/lib/indexnow/delivery-primitives";
import {
  INDEXNOW_BATCH_PAYLOAD_MODE,
  INDEXNOW_DELIVERY_TASK_TYPE,
} from "../../src/lib/indexnow/outbox-contract";

type FetchLike = typeof fetch;

const DUE_STATUSES = ["pending", "retry_wait"] as const;
const MAX_URL_LENGTH = 2048;
const TX_TIMEOUT_MS = 30_000;
/** `errorKind` recorded on an attempt that carries an HTTP 202 ("accepted for processing, key validation pending"). The attempt's `outcome` is still `accepted`. */
export const INDEXNOW_KEY_VALIDATION_PENDING_ERROR_KIND = "key_validation_pending";

type BatchPayload = { mode: typeof INDEXNOW_BATCH_PAYLOAD_MODE };

type ParsedPayload = { kind: "batch"; payload: BatchPayload } | { kind: "legacy"; outboxId: string };

function parsePayload(value: unknown): ParsedPayload {
  const item = (value ?? {}) as { outboxId?: unknown; mode?: unknown };
  if (typeof item.outboxId === "string" && item.outboxId) return { kind: "legacy", outboxId: item.outboxId };
  if (item.mode === INDEXNOW_BATCH_PAYLOAD_MODE) return { kind: "batch", payload: { mode: INDEXNOW_BATCH_PAYLOAD_MODE } };
  throw new Error("indexnow_delivery_payload_invalid");
}

type BatchRow = {
  id: string;
  articleId: string | null;
  url: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  createdAt: Date;
};

type ClaimedRow = BatchRow & { attemptNo: number };

const ROW_SELECT = {
  id: true,
  articleId: true,
  url: true,
  status: true,
  attemptCount: true,
  maxAttempts: true,
  createdAt: true,
} as const;

const FIFO_ORDER = [{ createdAt: "asc" }, { id: "asc" }] as const;

type DeliveryConfig = { host: string; key: string; keyLocation: string };

type DeliveryContext = {
  db: PrismaClient;
  fetchImpl: FetchLike;
  config: DeliveryConfig;
  taskId: string;
  signal: AbortSignal;
  eligibilityOptions?: IndexNowEligibilityOptions;
};

// ---------------------------------------------------------------------------
// Candidate selection and per-row pre-flight
// ---------------------------------------------------------------------------

async function selectCandidates(
  db: PrismaClient,
  now: Date,
): Promise<{ heldRetry: boolean; rows: BatchRow[] }> {
  // Held rows first and alone: retry_wait + now due + last response 400/403/422.
  const held = await db.indexNowOutbox.findMany({
    where: { status: "retry_wait", nextAttemptAt: { lte: now }, lastHttpStatus: { in: [400, 403, 422] } },
    orderBy: [...FIFO_ORDER],
    take: INDEXNOW_HTTP_BATCH_SIZE,
    select: ROW_SELECT,
  });
  if (held.length > 0) return { heldRetry: true, rows: held };
  const rows = await db.indexNowOutbox.findMany({
    where: indexNowDueWhere(now),
    orderBy: [...FIFO_ORDER],
    take: INDEXNOW_HTTP_BATCH_SIZE,
    select: ROW_SELECT,
  });
  return { heldRetry: false, rows };
}

/** Why `url` is not an acceptable IndexNow URL, or null. */
function urlFormatProblem(url: string): string | null {
  if (url.length > MAX_URL_LENGTH) return `url is longer than ${MAX_URL_LENGTH} characters`;
  let normalized: string;
  try {
    normalized = normalizeCanonicalUrl(url);
  } catch (error) {
    return error instanceof Error ? error.message : "url cannot be normalized";
  }
  if (normalized !== url) {
    return "url is not in normalized canonical form (https, lowercase host, no default port, no query or fragment)";
  }
  return null;
}

function urlHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

type PreflightResult = {
  valid: BatchRow[];
  cancelled: number;
  cancelledByKind: Record<string, number>;
};

async function preflightRows(ctx: DeliveryContext, rows: BatchRow[]): Promise<PreflightResult> {
  const { db, config, eligibilityOptions } = ctx;
  const articles = await loadIndexNowCandidateArticles(
    db,
    rows.flatMap((row) => (row.articleId ? [row.articleId] : [])),
  );
  const configuredHost = config.host.toLowerCase();
  const valid: BatchRow[] = [];
  const cancelledByKind: Record<string, number> = {};
  let cancelled = 0;

  for (const row of rows) {
    let kind: "url_invalid" | "url_host_mismatch" | "eligibility_failed" | null = null;
    let summary = "";

    const formatProblem = urlFormatProblem(row.url);
    if (formatProblem) {
      kind = "url_invalid";
      summary = `url_invalid: ${formatProblem}: ${row.url}`;
    } else if (urlHost(row.url) !== configuredHost) {
      kind = "url_host_mismatch";
      summary = `url_host_mismatch: url host does not equal the configured IndexNow host (${configuredHost}): ${row.url}`;
    } else {
      // Eligibility-drift recheck (CPS's `cancelEligibilityDrift`): the row may
      // have been due for a while — reverify the Article is still eligible and
      // its canonical URL has not changed (e.g. a slug edit) before spending a
      // submission on it. Branch by article family (C-29b): a blog Article has
      // no Novel, so `isNovelIndexNowEligible` must never see one.
      const article = row.articleId ? articles.get(row.articleId) : undefined;
      let stillEligible = false;
      let currentCanonical: string | null = null;
      if (article) {
        if (article.articleType === "novel_article") {
          stillEligible = isNovelIndexNowEligible(article, article.novel, article.promoLink, eligibilityOptions);
          currentCanonical = stillEligible ? buildIndexNowCanonicalUrl(article) : null;
        } else {
          stillEligible = isBlogIndexNowEligible(article, eligibilityOptions);
          currentCanonical = stillEligible ? buildBlogIndexNowCanonicalUrl(article) : null;
        }
      }
      if (!stillEligible || currentCanonical !== row.url) {
        kind = "eligibility_failed";
        summary = article
          ? "Canonical URL changed or the page no longer satisfies publish eligibility."
          : "Article is no longer available.";
      }
    }

    if (kind === null) {
      valid.push(row);
      continue;
    }
    const result = await db.indexNowOutbox.updateMany({
      where: { id: row.id, status: { in: [...DUE_STATUSES] } },
      data: {
        status: "cancelled",
        lastErrorKind: kind,
        lastErrorSummary: summarizeIndexNowValue(summary),
        nextAttemptAt: null,
      },
    });
    if (result.count === 1) {
      cancelled++;
      cancelledByKind[kind] = (cancelledByKind[kind] ?? 0) + 1;
    }
  }
  return { valid, cancelled, cancelledByKind };
}

// ---------------------------------------------------------------------------
// One request: claim → HTTP → write-back
// ---------------------------------------------------------------------------

type SendOptions = {
  /** Bisect probes run while the breaker is open by construction; they still take the lock. */
  bypassControl: boolean;
  heldRetry: boolean;
};

type SendResult =
  | { kind: "blocked"; reason: "breaker_open" | "rate_limited" }
  | { kind: "empty" }
  | {
      kind: "sent";
      requestBatchId: string;
      claimed: ClaimedRow[];
      httpStatus: number | null;
      outcome: ReturnType<typeof classifyIndexNowResult>;
      errorKind: string | null;
      decisions: Map<string, OutboxDeliveryDecision>;
    };

type HttpResult = {
  httpStatus: number | null;
  errorKind: string | null;
  responseSummary: string;
  retryAfterMs: number;
};

async function postBatch(ctx: DeliveryContext, urls: string[], requestAtMs: number): Promise<HttpResult> {
  const result: HttpResult = { httpStatus: null, errorKind: null, responseSummary: "", retryAfterMs: 0 };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INDEXNOW_HTTP_TIMEOUT_MS);
  try {
    const response = await ctx.fetchImpl(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host: ctx.config.host,
        key: ctx.config.key,
        keyLocation: ctx.config.keyLocation,
        urlList: urls,
      }),
      // The 10 s timeout OR the task lease's signal (shutdown / lease lost).
      signal: AbortSignal.any([controller.signal, ctx.signal]),
    });
    result.httpStatus = response.status;
    result.retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), requestAtMs);
    result.responseSummary = summarizeIndexNowValue(await response.text());
    if (result.httpStatus === 202) result.errorKind = INDEXNOW_KEY_VALIDATION_PENDING_ERROR_KIND;
    else if (result.httpStatus === 429) result.errorKind = "http_429";
    else if (result.httpStatus >= 500) result.errorKind = "http_5xx";
    else if (result.httpStatus !== 200) result.errorKind = "http_4xx";
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    result.errorKind = name === "AbortError" || name === "TimeoutError" ? "timeout" : "network";
    result.responseSummary = summarizeIndexNowValue(error);
  } finally {
    clearTimeout(timeout);
  }
  return result;
}

async function claimAndSend(ctx: DeliveryContext, rows: BatchRow[], options: SendOptions): Promise<SendResult> {
  const { db, taskId } = ctx;
  const requestBatchId = randomUUID();

  if (ctx.signal.aborted) return { kind: "empty" };

  // ---- claim: one interactive transaction -------------------------------
  type ClaimOutcome =
    | { blocked: "breaker_open" | "rate_limited" }
    | { blocked: null; claimed: ClaimedRow[]; now: Date };
  const claim = await db.$transaction(
    async (tx): Promise<ClaimOutcome> => {
      // Lock first, then read the control state inside the lock, then take
      // row locks: every control-state writer takes the same lock first, so
      // nothing here acts on a state that a concurrent trip / resume / 429
      // is about to change.
      await lockIndexNowControl(tx);
      if (!options.bypassControl) {
        const control = await getIndexNowDeliveryControlState(tx);
        if (control.breaker.open) return { blocked: "breaker_open" };
        if (control.rateLimit.waiting) return { blocked: "rate_limited" };
      }
      const now = await readIndexNowDbNow(tx);
      const claimed: ClaimedRow[] = [];
      for (const row of rows) {
        const result = await tx.indexNowOutbox.updateMany({
          where: { id: row.id, attemptCount: row.attemptCount, ...indexNowDueWhere(now) },
          data: {
            status: "processing",
            attemptCount: { increment: 1 },
            lastRequestAt: now,
            payloadHost: ctx.config.host,
            deliveryTaskId: taskId,
          },
        });
        // Returned rows carry the POST-claim attempt count, which is what the
        // row holds from here on (bisect re-claims use it as the CAS value).
        if (result.count === 1) {
          claimed.push({ ...row, attemptCount: row.attemptCount + 1, attemptNo: row.attemptCount + 1 });
        }
      }
      if (claimed.length > 0) {
        await tx.indexNowOutboxAttempt.createMany({
          data: claimed.map((row) => ({
            outboxId: row.id,
            attemptNo: row.attemptNo,
            outcome: "started",
            attemptState: "started",
            requestBatchId,
            startedAt: now,
            requestAt: now,
            batchSize: claimed.length,
            workerTaskId: taskId,
          })),
        });
      }
      return { blocked: null, claimed, now };
    },
    { timeout: TX_TIMEOUT_MS },
  );
  if (claim.blocked) return { kind: "blocked", reason: claim.blocked };
  const { claimed, now: requestAt } = claim;
  if (claimed.length === 0) return { kind: "empty" };

  // ---- one HTTP POST -----------------------------------------------------
  const http = await postBatch(
    ctx,
    claimed.map((row) => row.url),
    requestAt.getTime(),
  );
  const outcome = classifyIndexNowResult(http.httpStatus, http.errorKind);

  // ---- write-back: one transaction --------------------------------------
  const needsControlEvent = isIndexNowBreakerStatus(http.httpStatus) || http.httpStatus === 429;
  const decisions = new Map<string, OutboxDeliveryDecision>();
  await db.$transaction(
    async (tx) => {
      // Lock BEFORE any row write (same order as the claim transaction), only
      // when this response has to append a control event.
      if (needsControlEvent) await lockIndexNowControl(tx);
      const responseAt = await readIndexNowDbNow(tx);

      await tx.indexNowOutboxAttempt.updateMany({
        where: { requestBatchId },
        data: {
          attemptState: "completed",
          outcome,
          responseAt,
          httpStatus: http.httpStatus,
          errorKind: http.errorKind,
          responseSummary: http.responseSummary,
        },
      });

      // Rows with the same new state, next attempt time and attempt number
      // share one `updateMany`; retry_wait rows after a 5xx/429 carry a
      // per-row random jitter and therefore end up one write each.
      const groups = new Map<
        string,
        { ids: string[]; attemptNo: number; decision: OutboxDeliveryDecision }
      >();
      for (const row of claimed) {
        const decision = resolveOutboxDeliveryStatus(outcome, row.attemptNo, row.maxAttempts, responseAt, http.retryAfterMs);
        decisions.set(row.id, decision);
        const key = `${decision.status}|${decision.nextAttemptAt?.getTime() ?? "null"}|${row.attemptNo}`;
        const group = groups.get(key);
        if (group) group.ids.push(row.id);
        else groups.set(key, { ids: [row.id], attemptNo: row.attemptNo, decision });
      }
      for (const group of groups.values()) {
        await tx.indexNowOutbox.updateMany({
          where: { id: { in: group.ids }, status: "processing", attemptCount: group.attemptNo },
          data: {
            status: group.decision.status,
            lastHttpStatus: http.httpStatus,
            lastErrorKind: outcome === "accepted" ? null : http.errorKind,
            lastErrorSummary: outcome === "accepted" ? null : http.responseSummary,
            lastResponseAt: responseAt,
            nextAttemptAt: group.decision.nextAttemptAt,
          },
        });
      }

      if (isIndexNowBreakerStatus(http.httpStatus)) {
        await recordIndexNowBreakerTrip(tx, {
          requestBatchId,
          httpStatus: http.httpStatus as number,
          urlCount: claimed.length,
          heldRetry: options.heldRetry,
          dbNow: responseAt,
          taskId,
        });
      } else if (http.httpStatus === 429) {
        await recordIndexNowRateLimited(tx, { requestBatchId, retryAfterMs: http.retryAfterMs, dbNow: responseAt, taskId });
      }
    },
    { timeout: TX_TIMEOUT_MS },
  );

  return {
    kind: "sent",
    requestBatchId,
    claimed,
    httpStatus: http.httpStatus,
    outcome,
    errorKind: http.errorKind,
    decisions,
  };
}

// ---------------------------------------------------------------------------
// Bisect (held batch failed again after a manual resume)
// ---------------------------------------------------------------------------

/**
 * - `local`        — bad URL(s) isolated (or none reproduced), everything else accepted;
 * - `global`       — a configuration problem: HTTP 403 (invalid key) anywhere, or both halves of the
 *                    first split rejected. Nothing is marked, every row stays held;
 * - `inconclusive` — a held batch of ONE row failed again with 400/422: one URL cannot tell "this
 *                    URL is bad" from "the configuration is bad". Nothing is marked, the row stays held;
 * - `interrupted`  — a sub-request got 429/5xx/timeout/network error, or the lease was lost;
 * - `probe_cap`    — the sub-request budget `2 + 4⌈log2 n⌉` ran out.
 */
export type IndexNowBisectConclusion = "local" | "global" | "inconclusive" | "interrupted" | "probe_cap";

export const INDEXNOW_BISECT_INCONCLUSIVE_NOTE = "single url cannot distinguish a bad url from a configuration problem";
export const INDEXNOW_BISECT_FORBIDDEN_NOTE = "HTTP 403 means the key is invalid: a configuration problem, not a URL problem; no bisect, nothing marked";

export type IndexNowBisectSummary = {
  conclusion: IndexNowBisectConclusion;
  /** HTTP sub-requests sent (the original batch is not counted). */
  probes: number;
  acceptedCount: number;
  culprits: Array<{ outboxId: string; url: string }>;
  /** 9 when the bisect raised the suspects' attempt limit; 0 when it ended before any probe was needed. */
  raisedMaxAttemptsBy: number;
  /** Human-readable reason for the conclusions that need a person to judge (`inconclusive`, `global`). */
  note?: string;
};

/** `2 + 4 × ⌈log2 n⌉` sub-requests at most: 38 for n = 500. */
export function indexNowBisectProbeCap(rowCount: number): number {
  return 2 + 4 * Math.ceil(Math.log2(Math.max(2, rowCount)));
}

async function raiseMaxAttempts(db: PrismaClient, rows: ClaimedRow[]): Promise<void> {
  // `GREATEST(max_attempts, attempt_count + 9)`, written as grouped updates so
  // the `attempt_count <= max_attempts` CHECK can never be violated (the value
  // only ever goes up).
  const groups = new Map<string, { ids: string[]; attemptNo: number; maxAttempts: number }>();
  for (const row of rows) {
    const maxAttempts = Math.max(row.maxAttempts, row.attemptNo + INDEXNOW_BISECT_MAX_EXTRA_ATTEMPTS);
    if (maxAttempts === row.maxAttempts) continue;
    const key = `${row.attemptNo}|${maxAttempts}`;
    const group = groups.get(key);
    if (group) group.ids.push(row.id);
    else groups.set(key, { ids: [row.id], attemptNo: row.attemptNo, maxAttempts });
    row.maxAttempts = maxAttempts;
  }
  for (const group of groups.values()) {
    await db.indexNowOutbox.updateMany({
      where: { id: { in: group.ids }, status: "retry_wait", attemptCount: group.attemptNo },
      data: { maxAttempts: group.maxAttempts },
    });
  }
}

/**
 * The batch was held by a breaker trip, a human resumed, and the SAME rows
 * failed again with 400/403/422. Find out whether one bad URL is the cause.
 *
 * Two cases are decided WITHOUT sending anything and without touching a row:
 *   - the repeat failure was HTTP 403 → `global`. 403 means the key is
 *     invalid; that is never one URL's fault and splitting cannot help;
 *   - only ONE row is left → `inconclusive` (400/422). With a single URL there
 *     is no way to tell "this URL is bad" from "the key/host/configuration is
 *     bad" (e.g. a key outage that happened to hold back one fresh
 *     publication). Marking it permanently failed would kill it for good, so
 *     the row stays held and a person judges it from `indexnow-status`.
 *
 * Otherwise split the rows in half and send each half as its own sub-request:
 *   - layer 1, both halves rejected → `global`: it is the configuration, not a
 *     URL; stop after those 2 requests, every row stays held;
 *   - any sub-request that returns 403 → `global`, stop at once;
 *   - a half accepted → its rows are `accepted` (written by the normal
 *     write-back);
 *   - a half rejected with more than one row → split that half the same way;
 *   - a single row rejected at a DEEPER layer → bad URL. This is sound because
 *     reaching a deeper layer needs at least one accepted half at layer 1, i.e.
 *     the configuration demonstrably works. Such rows are marked
 *     `permanent_failed`/`isolated_bad_url` (never auto-pushed again), but only
 *     AFTER the whole bisect ended, and not at all if it ended `global`;
 *   - a sub-request that gets 429 / 5xx / timeout / network error, a lost
 *     lease, or the probe budget (`2 + 4⌈log2 n⌉`) → stop (`interrupted` /
 *     `probe_cap`), leave the rest to a human.
 *
 * Sub-requests bypass the breaker check (they run while it is open by
 * construction) but still take the control lock; their 4xx responses append
 * further trip events, so the breaker stays open and ONLY a manual resume
 * (after the operator read `indexnow-status`) closes it.
 *
 * Because a URL may be probed ~9 more times, the rows' `maxAttempts` is first
 * raised to `attemptCount + 9` (never lowered); the audit record says so. The
 * two short-circuit cases above do not raise it.
 */
async function bisectHeldBatch(
  ctx: DeliveryContext,
  suspects: ClaimedRow[],
  originalRequestBatchId: string,
  originalHttpStatus: number | null,
  heartbeat: () => Promise<boolean>,
): Promise<IndexNowBisectSummary> {
  const { db } = ctx;
  const summary: IndexNowBisectSummary = {
    conclusion: "local",
    probes: 0,
    acceptedCount: 0,
    culprits: [],
    raisedMaxAttemptsBy: 0,
  };

  // Decided without a single request and without touching a row.
  const shortCircuit: { conclusion: IndexNowBisectConclusion; note: string } | null =
    originalHttpStatus === 403
      ? { conclusion: "global", note: INDEXNOW_BISECT_FORBIDDEN_NOTE }
      : suspects.length === 1
        ? { conclusion: "inconclusive", note: INDEXNOW_BISECT_INCONCLUSIVE_NOTE }
        : null;

  let stop: IndexNowBisectConclusion | null = null;
  const pendingCulprits: ClaimedRow[] = [];

  if (shortCircuit) {
    summary.conclusion = shortCircuit.conclusion;
    summary.note = shortCircuit.note;
  } else {
    await raiseMaxAttempts(db, suspects);
    summary.raisedMaxAttemptsBy = INDEXNOW_BISECT_MAX_EXTRA_ATTEMPTS;
  }
  const cap = indexNowBisectProbeCap(suspects.length);

  const markCulprit = async (row: ClaimedRow) => {
    await db.indexNowOutbox.updateMany({
      where: { id: row.id, status: "retry_wait" },
      data: { status: "permanent_failed", lastErrorKind: "isolated_bad_url", nextAttemptAt: null },
    });
    summary.culprits.push({ outboxId: row.id, url: row.url });
  };

  const probe = async (rows: ClaimedRow[]): Promise<{ result: "accepted" | "rejected" | "stop"; rows: ClaimedRow[] }> => {
    if (ctx.signal.aborted || !(await heartbeat())) {
      stop = "interrupted";
      return { result: "stop", rows };
    }
    if (summary.probes >= cap) {
      stop = "probe_cap";
      return { result: "stop", rows };
    }
    summary.probes++;
    const sent = await claimAndSend(ctx, rows, { bypassControl: true, heldRetry: true });
    if (sent.kind !== "sent") {
      stop = "interrupted";
      return { result: "stop", rows };
    }
    if (sent.outcome === "accepted") {
      summary.acceptedCount += sent.claimed.length;
      return { result: "accepted", rows: sent.claimed };
    }
    if (sent.httpStatus === 403) {
      // An invalid key explains every rejection seen so far: stop, mark nothing.
      stop = "global";
      summary.note = INDEXNOW_BISECT_FORBIDDEN_NOTE;
      return { result: "stop", rows: sent.claimed };
    }
    if (isIndexNowBreakerStatus(sent.httpStatus)) return { result: "rejected", rows: sent.claimed };
    stop = "interrupted";
    return { result: "stop", rows };
  };

  const resolveRejected = async (rows: ClaimedRow[], depth: number): Promise<void> => {
    if (rows.length === 1) {
      // Only reachable at depth >= 1 (the single-row batch was short-circuited above), i.e. after
      // a sibling half was accepted. Marking is deferred until the bisect ended without `global`.
      pendingCulprits.push(rows[0]!);
      return;
    }
    const middle = Math.ceil(rows.length / 2);
    const first = await probe(rows.slice(0, middle));
    if (first.result === "stop") return;
    const second = await probe(rows.slice(middle));
    if (second.result === "stop") return;
    if (depth === 0 && first.result === "rejected" && second.result === "rejected") {
      stop = "global";
      summary.note = "both halves of the first split were rejected: a configuration problem, not a URL problem; nothing marked";
      return;
    }
    if (first.result === "rejected") {
      await resolveRejected(first.rows, depth + 1);
      if (stop) return;
    }
    if (second.result === "rejected") await resolveRejected(second.rows, depth + 1);
  };

  if (!shortCircuit) {
    await resolveRejected(suspects, 0);
    // `stop` is assigned inside the closures above; read it back through its declared type.
    const concluded: IndexNowBisectConclusion = (stop as IndexNowBisectConclusion | null) ?? "local";
    summary.conclusion = concluded;
    // A `global` conclusion (403 mid-bisect, or both halves rejected) means the configuration is at
    // fault: whatever looked like a culprit earlier is not one. Otherwise mark them now.
    if (concluded !== "global") for (const row of pendingCulprits) await markCulprit(row);
  }

  await db.$transaction(
    async (tx) => {
      await tx.operationAudit.create({
        data: {
          actorType: "worker",
          action: INDEXNOW_CONTROL_ACTIONS.bisect,
          entityType: INDEXNOW_CONTROL_ENTITY_TYPE,
          entityId: INDEXNOW_CONTROL_STREAMS.bisect,
          taskType: INDEXNOW_DELIVERY_TASK_TYPE,
          taskId: ctx.taskId,
          reason: summary.conclusion,
          afterSnapshot: {
            conclusion: summary.conclusion,
            probes: summary.probes,
            acceptedCount: summary.acceptedCount,
            culprits: summary.culprits,
            raisedMaxAttemptsBy: summary.raisedMaxAttemptsBy,
            originalRequestBatchId,
            urlCount: suspects.length,
            ...(summary.note ? { note: summary.note } : {}),
          },
        },
      });
    },
    { timeout: TX_TIMEOUT_MS },
  );
  return summary;
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

export function createIndexNowDeliveryHandler(
  db: PrismaClient,
  fetchImpl: FetchLike = fetch,
  env: NodeJS.ProcessEnv = process.env,
  // Same test-injectability escape hatch as `outbox.ts`'s
  // `enqueueIndexNowFirstPublish` — see that function's doc comment.
  eligibilityOptions?: IndexNowEligibilityOptions,
): TaskHandler {
  return async ({ lease, signal, heartbeat }) => {
    if (!isIndexNowDeliveryEnabled(env) || !isIndexNowDeliveryWriteAllowed(env)) {
      return { status: "skipped", result: { reason: "delivery_disabled" } };
    }

    const parsed = parsePayload(lease.payload);
    if (parsed.kind === "legacy") {
      // Item created by the single-URL era (v0.5.14). Touch nothing: the row it
      // pointed at is a normal due row and goes out in the next batch.
      return { status: "skipped", result: { reason: "legacy_single_row_item", outboxId: parsed.outboxId } };
    }

    const rawConfig = await getIndexNowDeliveryConfig(db);
    if (!isIndexNowConfigured(rawConfig)) return { status: "skipped", result: { reason: "config_missing" } };
    // `isIndexNowConfigured` is trim-authoritative but does not itself mutate
    // — trim here before use, same as CPS's `settings.indexNowHost.trim()`
    // at each read site.
    const config: DeliveryConfig = {
      host: rawConfig.host.trim(),
      key: rawConfig.key.trim(),
      keyLocation: rawConfig.keyLocation.trim(),
    };
    if (!isIndexNowHostConsistent(config)) return { status: "skipped", result: { reason: "host_mismatch" } };

    const control = await getIndexNowDeliveryControlState(db);
    if (control.breaker.open) return { status: "skipped", result: { reason: "breaker_open" } };
    if (control.rateLimit.waiting) return { status: "skipped", result: { reason: "rate_limited" } };

    const ctx: DeliveryContext = { db, fetchImpl, config, taskId: lease.taskId, signal, eligibilityOptions };

    const { heldRetry, rows } = await selectCandidates(db, control.dbNow);
    if (rows.length === 0) return { status: "success", result: { mode: heldRetry ? "held_retry" : "batch", claimed: 0, cancelled: 0 } };

    // Rows whose budget is already spent cannot be claimed (attempt_count <=
    // max_attempts CHECK): retire them instead of letting them be selected
    // every minute forever.
    const spent = rows.filter((row) => row.attemptCount >= row.maxAttempts);
    if (spent.length > 0) {
      await db.indexNowOutbox.updateMany({
        where: { id: { in: spent.map((row) => row.id) }, status: { in: [...DUE_STATUSES] } },
        data: { status: "dead_letter", nextAttemptAt: null, lastErrorKind: "attempts_exhausted" },
      });
    }
    const candidates = rows.filter((row) => row.attemptCount < row.maxAttempts);

    const preflight = await preflightRows(ctx, candidates);
    const mode = heldRetry ? "held_retry" : "batch";
    if (preflight.valid.length === 0) {
      return { status: "success", result: { mode, claimed: 0, cancelled: preflight.cancelled } };
    }

    const sent = await claimAndSend(ctx, preflight.valid, { bypassControl: false, heldRetry });
    if (sent.kind === "blocked") {
      // The control state changed between the unlocked read above and the
      // locked re-check in the claim transaction. Nothing was claimed.
      return { status: "skipped", result: { reason: sent.reason } };
    }
    if (sent.kind === "empty") {
      return { status: "success", result: { mode, claimed: 0, cancelled: preflight.cancelled } };
    }

    let bisect: IndexNowBisectSummary | undefined;
    if (heldRetry && isIndexNowBreakerStatus(sent.httpStatus)) {
      const suspects = sent.claimed.filter((row) => sent.decisions.get(row.id)?.status === "retry_wait");
      if (suspects.length > 0) {
        bisect = await bisectHeldBatch(ctx, suspects, sent.requestBatchId, sent.httpStatus, heartbeat);
      }
    }

    return {
      status: "success",
      result: {
        mode,
        requestBatchId: sent.requestBatchId,
        claimed: sent.claimed.length,
        cancelled: preflight.cancelled,
        httpStatus: sent.httpStatus,
        outcome: sent.outcome,
        ...(bisect ? { bisect } : {}),
      },
    };
  };
}

export function createIndexNowWorkerHandlers(
  db: PrismaClient,
  fetchImpl: FetchLike = fetch,
  env: NodeJS.ProcessEnv = process.env,
) {
  return createHandlerRegistry({
    [INDEXNOW_DELIVERY_TASK_TYPE]: { family: "generic" as const, maxAttempts: 3, handler: createIndexNowDeliveryHandler(db, fetchImpl, env) },
  });
}
