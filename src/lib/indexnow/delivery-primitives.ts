/**
 * IndexNow HTTP submission primitives (Stream E, P2-11).
 *
 * Ported COPY_AS_IS from CPS `src/lib/indexnow-delivery-service.ts`
 * (`chunkIndexNowDeliveries`/`summarizeIndexNowValue`/`parseRetryAfter`/
 * `computeRetryDelayMs`, ~23 lines total) — pure functions, zero Prisma
 * dependency, IndexNow-protocol knowledge only (`P2-07-12-移植审计-2026-08-12/
 * P2-11.md` §1, §7 "A · COPY_AS_IS"). `docs/governance/port-registry.md` has
 * the per-symbol registration.
 *
 * `classifyIndexNowResult` is ADAPTED, not copied verbatim: CPS's version
 * returns one of its `INDEXNOW_DELIVERY_STATUS` values (a *delivery-row*
 * status). This codebase needs the classification at the *attempt* grain
 * first (`indexnow_outbox_attempt.outcome`, frozen to
 * `INDEXNOW_ATTEMPT_OUTCOMES` in `src/domain/database-statuses.ts`) — the
 * caller (`worker/handlers/indexnow-delivery.ts`) then folds an attempt
 * outcome plus the row's `attemptCount`/`maxAttempts` into the row-level
 * `indexnow_outbox.status` transition (`retryable_failed` → `retry_wait` or
 * `dead_letter` once the budget is exhausted). Keeping the two questions
 * separate mirrors this codebase's `outcome` vs `attemptState` split
 * documented on `IndexNowOutboxAttempt` in the schema.
 *
 * B-41 (batch delivery): `resolveOutboxDeliveryStatus` no longer maps a
 * 400/403/422 attempt to a terminal `permanent_failed` row — see its doc
 * comment. `docs/adr/ADR-B41-INDEXNOW-BATCH-DELIVERY.md` has the decision.
 */
import type { Prisma } from "@prisma/client";

import type { IndexNowAttemptOutcome } from "@/domain/database-statuses";

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/IndexNow";
/**
 * B-41: the protocol-documented ceiling of URLs per HTTP POST (CPS
 * `indexnow-delivery-service.ts:17`), now actually consumed. One
 * `indexnow_delivery` `GenericTaskItem` is one batch of at most this many
 * outbox rows and one HTTP request (bisect probes are the only exception —
 * see `worker/handlers/indexnow-delivery.ts`). It also sizes the backfill
 * apply chunk (`scripts/indexnow-backfill-apply.ts`).
 */
export const INDEXNOW_HTTP_BATCH_SIZE = 500;
export const INDEXNOW_HTTP_TIMEOUT_MS = 10_000;

/**
 * B-41: HTTP statuses that open the delivery breaker. 400/403/422 are
 * request-level / key-level / host-level problems (malformed JSON, key file
 * not found, URL host not matching `host`), not a property of one URL — with
 * 500 URLs per request, one such response says the whole batch (and the
 * configuration behind it) is wrong.
 */
export const INDEXNOW_BREAKER_HTTP_STATUSES = [400, 403, 422] as const;

export function isIndexNowBreakerStatus(httpStatus: number | null | undefined): boolean {
  return httpStatus === 400 || httpStatus === 403 || httpStatus === 422;
}

/**
 * "Due" predicate shared by the minute sweep, the delivery handler's candidate
 * selection and its claim CAS: first-publish rows whose `availableAt` has
 * passed (or never deferred), and `retry_wait` rows whose `nextAttemptAt` has
 * passed. `now` is the DATABASE clock at the call site.
 */
export function indexNowDueWhere(now: Date): Prisma.IndexNowOutboxWhereInput {
  return {
    OR: [
      { status: "pending", OR: [{ availableAt: null }, { availableAt: { lte: now } }] },
      { status: "retry_wait", nextAttemptAt: { lte: now } },
    ],
  };
}

/**
 * Extra attempts a row may need when a held (breaker-blocked) batch is
 * bisected to isolate a bad URL: ⌈log2 500⌉ = 9 more probes at most.
 */
export const INDEXNOW_BISECT_MAX_EXTRA_ATTEMPTS = 9;
/** Backfill apply waits at most this long for one chunk to leave pending/processing. */
export const INDEXNOW_BACKFILL_SETTLE_TIMEOUT_MS = 10 * 60_000;
export const INDEXNOW_BACKFILL_POLL_MS = 10_000;
/** Minimum global wait after an HTTP 429: `waitUntil = db clock + max(Retry-After, this)`. */
export const INDEXNOW_RATE_LIMIT_FALLBACK_WAIT_MS = 5 * 60_000;

export function chunkIndexNowDeliveries<T>(rows: readonly T[], size = INDEXNOW_HTTP_BATCH_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < rows.length; offset += size) {
    chunks.push(rows.slice(offset, offset + size));
  }
  return chunks;
}

/** Redacts key/token/secret/Authorization/Bearer material (no truncation) — for anything that gets printed or persisted, URLs included. */
export function redactIndexNowSecrets(raw: string): string {
  return raw
    .replace(/([?&](?:key|token|secret|authorization)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/("?(?:key|keyLocation|authorization|cookie)"?\s*:\s*")[^"]+/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
}

/** Redacts key/token/secret/Authorization/Bearer material before anything gets persisted to `lastErrorSummary`/`responseSummary`. */
export function summarizeIndexNowValue(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? "");
  return redactIndexNowSecrets(raw).slice(0, 500);
}

/** Parses an HTTP `Retry-After` header: either delta-seconds or an HTTP-date. Unparseable/missing → 0. */
export function parseRetryAfter(value: string | null, nowMs = Date.now()): number {
  if (!value) return 0;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : 0;
}

/** Exponential backoff (5min × 2^n, capped at 6h) + 20% jitter, floored by any server-supplied `Retry-After`. */
export function computeRetryDelayMs(attemptNo: number, jitter = Math.random(), retryAfterMs = 0): number {
  const base = Math.min(5 * 60_000 * 2 ** Math.max(0, attemptNo - 1), 6 * 60 * 60_000);
  const backoff = Math.floor(base * (1 + Math.max(0, Math.min(jitter, 0.999999)) * 0.2));
  return Math.max(backoff, retryAfterMs);
}

/**
 * HTTP result → attempt outcome. 200/202 accepted; 400/403/422 permanent
 * (IndexNow protocol semantics — malformed/unauthorized/unprocessable submissions
 * do not become valid on retry); everything else (429, 5xx, network/timeout —
 * `errorKind` set, `httpStatus` null) is retryable.
 */
export function classifyIndexNowResult(
  httpStatus: number | null,
  errorKind?: string | null,
): IndexNowAttemptOutcome {
  if (httpStatus === 200 || httpStatus === 202) return "accepted";
  if (httpStatus === 400 || httpStatus === 403 || httpStatus === 422) return "permanent_failed";
  // 429/5xx and network/timeout errors (`errorKind` set, `httpStatus` null)
  // both land here — kept as an explicit branch (CPS's original has the same
  // two branches, both returning the retryable status) so the signature's
  // intent stays legible even though the two conditions are not currently
  // distinguished by outcome.
  if (httpStatus === 429 || (httpStatus !== null && httpStatus >= 500) || errorKind) return "retryable_failed";
  return "retryable_failed";
}

export type OutboxDeliveryDecision =
  | { status: "accepted"; nextAttemptAt: null }
  | { status: "permanent_failed"; nextAttemptAt: null }
  | { status: "retry_wait"; nextAttemptAt: Date }
  | { status: "dead_letter"; nextAttemptAt: null };

/**
 * Folds an attempt-grain outcome plus the row's attempt budget into the
 * row-level `indexnow_outbox.status` transition. Ported ADAPT from CPS
 * `applyAttemptResult`'s status-decision half (`indexnow-delivery-service.ts:
 * 83-94`) — the write itself lives at each caller (`worker/handlers/
 * indexnow-delivery.ts` after a live HTTP response, `recovery.ts` when
 * reapplying an already-completed attempt after a crash), this function only
 * decides. `attemptNo` is the just-recorded attempt's 1-based number (i.e.
 * the row's new `attemptCount`), matching CPS's `attemptNo >= maxAttempts`
 * dead-letter check.
 *
 * B-41 semantics change: an attempt outcome of `permanent_failed` (HTTP
 * 400/403/422) is NOT a row verdict any more. With up to 500 URLs per
 * request it says the batch / configuration is wrong, not that every URL in
 * it is bad. The row goes back to `retry_wait` with `nextAttemptAt = now`
 * ("held": immediately due, but it is not claimed while the delivery breaker
 * is open — `delivery-control.ts`), or to `dead_letter` once its attempt
 * budget is spent. A row-level `permanent_failed` now only comes from the
 * bisect step that isolates one bad URL (`lastErrorKind = isolated_bad_url`).
 */
export function resolveOutboxDeliveryStatus(
  outcome: IndexNowAttemptOutcome,
  attemptNo: number,
  maxAttempts: number,
  now: Date,
  retryAfterMs = 0,
): OutboxDeliveryDecision {
  if (outcome === "accepted") return { status: "accepted", nextAttemptAt: null };
  if (attemptNo >= maxAttempts) return { status: "dead_letter", nextAttemptAt: null };
  if (outcome === "permanent_failed") return { status: "retry_wait", nextAttemptAt: new Date(now.getTime()) };
  return {
    status: "retry_wait",
    nextAttemptAt: new Date(now.getTime() + computeRetryDelayMs(attemptNo, Math.random(), retryAfterMs)),
  };
}
