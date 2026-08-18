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
 */
import type { IndexNowAttemptOutcome } from "@/domain/database-statuses";

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/IndexNow";
/**
 * CPS batches up to 500 URLs per HTTP POST to conserve request count against
 * IndexNow's daily submission quota. This codebase's V1 worker handler
 * submits exactly one URL per `GenericTaskItem` (one delivery attempt = one
 * fenced, independently-leasable unit of work — see
 * `worker/handlers/indexnow-delivery.ts`'s header for why), so this constant
 * is not consumed by the handler today. It is kept as the protocol-documented
 * ceiling and exported for `chunkIndexNowDeliveries`, which the backfill
 * manifest tooling uses to size candidate pages; a future batched-HTTP
 * optimization (submitting several `GenericTaskItem`s' URLs in one POST) can
 * reuse it without redefining the ceiling.
 */
export const INDEXNOW_HTTP_BATCH_SIZE = 500;
export const INDEXNOW_HTTP_TIMEOUT_MS = 10_000;

export function chunkIndexNowDeliveries<T>(rows: readonly T[], size = INDEXNOW_HTTP_BATCH_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < rows.length; offset += size) {
    chunks.push(rows.slice(offset, offset + size));
  }
  return chunks;
}

/** Redacts key/token/secret/Authorization/Bearer material before anything gets persisted to `lastErrorSummary`/`responseSummary`. */
export function summarizeIndexNowValue(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? "");
  return raw
    .replace(/([?&](?:key|token|secret|authorization)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/("?(?:key|keyLocation|authorization|cookie)"?\s*:\s*")[^"]+/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .slice(0, 500);
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
 */
export function resolveOutboxDeliveryStatus(
  outcome: IndexNowAttemptOutcome,
  attemptNo: number,
  maxAttempts: number,
  now: Date,
  retryAfterMs = 0,
): OutboxDeliveryDecision {
  if (outcome === "accepted") return { status: "accepted", nextAttemptAt: null };
  if (outcome === "permanent_failed") return { status: "permanent_failed", nextAttemptAt: null };
  if (attemptNo >= maxAttempts) return { status: "dead_letter", nextAttemptAt: null };
  return {
    status: "retry_wait",
    nextAttemptAt: new Date(now.getTime() + computeRetryDelayMs(attemptNo, Math.random(), retryAfterMs)),
  };
}
