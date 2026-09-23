/**
 * Phase 1 of the promo-link claim latency investigation
 * ("上游请求观测补齐"): observation-only telemetry shared by every
 * MoboReader upstream call site (`./moboreader.ts`'s catalog/Preview reads
 * and `./promo-link-claim.ts`'s claim/readback). This module makes **zero**
 * behavior change on its own — it only defines the event shape and the
 * header-redaction boundary; nothing here retries, delays, or alters what
 * either adapter throws or returns.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 * A preproduction measurement found every promo claim costs ~4.45s = 3
 * upstream requests × the shared rate gate (`./moboreader-rate-limit.ts`;
 * `MOBOREADER_MIN_REQUEST_INTERVAL_MS` defaults to 1100ms in code, but the
 * preproduction environment that produced the 4.45s figure had it
 * configured to 1500ms via `MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS` —
 * 3 × 1500ms, not 3 × the code default. Do not use 1100ms to re-derive or
 * sanity-check that figure). Unknown until now: whether `getcode` (the
 * claim mutation) has its own gateway rate limit distinct from the
 * `x-ratelimit-limit: 60` observed only on `getlistpc`; each endpoint's
 * real latency; how much of the 4.45s is gate wait vs. actual transit. This
 * module's events are the raw material for that later analysis — they do
 * not themselves change any throttling or retry decision.
 *
 * ── Redaction contract (load-bearing) ───────────────────────────────────
 * An `UpstreamCallObservation` must never carry: Authorization/token
 * values, request or response bodies, book titles, promo codes, or links.
 * `extractGatewayObservationHeaders` is the *only* place upstream response
 * headers may be read for this purpose, and it is allowlist-based (drop by
 * default), not a blocklist — an unrecognized header (including
 * `authorization` and `set-cookie`) is silently omitted, never merely
 * masked.
 */

/** One HTTP attempt's outcome, independent of any later business-envelope
 * parsing (`parseClaimResponse` etc.) done by the caller once JSON is back.
 * A 200 response with an unparsable/malformed JSON body is still `"ok"`
 * here — this classification is about the wire protocol, not the payload
 * shape. */
export type UpstreamCallOutcome = "ok" | "http_error" | "timeout" | "transport_error";

export interface UpstreamCallObservation {
  /** Short logical name (`"getlistpc"` / `"getcode"` / `"getbydataid"` /
   * `"getchapterinfo"`), never the full URL. */
  endpoint: string;
  /** `null` when no HTTP response was ever received (timeout / transport
   * error). */
  httpStatus: number | null;
  outcome: UpstreamCallOutcome;
  /** Client-measured wall-clock time from dispatching the request to
   * receiving a response or failure. Excludes `gateWaitMs`. */
  latencyMs: number;
  /** Wall-clock time spent inside `rateGate.wait()` immediately before this
   * attempt was dispatched. */
  gateWaitMs: number;
  /** Allowlisted response headers only — see module header. Empty when no
   * HTTP response was received. */
  gatewayHeaders: Readonly<Record<string, string>>;
}

export type OnUpstreamObservation = (observation: UpstreamCallObservation) => void;

/** Default for every adapter factory's `onUpstreamObservation` option, so
 * constructing an adapter without it — as every pre-existing test and call
 * site does — adds no work beyond one no-op function call. */
export const NOOP_UPSTREAM_OBSERVATION: OnUpstreamObservation = () => {};

/**
 * The only place either adapter (`./moboreader.ts`, `./promo-link-claim.ts`)
 * may invoke `onUpstreamObservation`. Builds the event with `buildObservation`
 * (which typically calls `extractGatewayObservationHeaders`) and calls the
 * callback, all inside one try/catch that swallows any exception from
 * either step.
 *
 * This is not defensive-for-its-own-sake: today's production sink
 * (`worker/observability/upstream-call-log.ts`) already guards itself, so
 * this mostly protects against a *future* callback that doesn't. But
 * without this wrapper, an exception here lands in the same `try` block
 * that dispatched the request, and the surrounding `catch` cannot tell a
 * telemetry failure apart from a real transport failure — it would
 * misclassify the request as `transport_error`/`malformed_payload`. On
 * `getcode` specifically — a non-idempotent mutation whose ambiguous-error
 * path always means "never call getcode again, go to readback-only
 * recovery" — that misclassification would turn "upstream already issued a
 * code, the callback just threw" into "result unknown" → manual review.
 * Observation is supposed to have zero effect on behavior; this is the
 * boundary that guarantees it, no matter what a future callback does.
 */
export function safeObserve(
  onUpstreamObservation: OnUpstreamObservation,
  buildObservation: () => UpstreamCallObservation,
): void {
  try {
    onUpstreamObservation(buildObservation());
  } catch {
    // Deliberately silent — see doc comment above. The request's own
    // result/error, already determined by the caller, is unaffected.
  }
}

/** Header names matched verbatim (case-insensitive) in addition to the
 * `/^(x-)?ratelimit/i` pattern below. Kong's own latency-breakdown headers
 * are included because they are the one thing that can attribute latency
 * to "gateway" vs. "origin" without guessing. */
const GATEWAY_HEADER_EXACT_ALLOWLIST = new Set([
  "retry-after",
  "x-kong-upstream-latency",
  "x-kong-proxy-latency",
]);

const GATEWAY_HEADER_PATTERN_ALLOWLIST = /^(x-)?ratelimit/i;

/** Response header values observed so far are short (integers, ISO dates).
 * This cap exists only to stop a misbehaving upstream from smuggling a
 * large value into a log line, not to accommodate any known legitimate
 * value. */
const GATEWAY_HEADER_VALUE_MAX_LENGTH = 200;

function truncateHeaderValue(value: string): string {
  return value.length > GATEWAY_HEADER_VALUE_MAX_LENGTH
    ? value.slice(0, GATEWAY_HEADER_VALUE_MAX_LENGTH)
    : value;
}

function isAllowlistedGatewayHeaderName(lowerCaseName: string): boolean {
  return GATEWAY_HEADER_EXACT_ALLOWLIST.has(lowerCaseName) || GATEWAY_HEADER_PATTERN_ALLOWLIST.test(lowerCaseName);
}

/**
 * The only place an upstream HTTP response's headers may be read for
 * observation. Everything not matching the allowlist above —
 * `authorization`, `set-cookie`, `content-type`, or any other header —
 * is dropped, never merely masked, so this can never regress into
 * carrying a credential by accident.
 *
 * Several pre-existing adapter tests construct a minimal
 * `{ ok, status, headers: { get: () => ... } }` fixture cast to `Response`
 * — a real fetch `Response.headers` (what production always passes) is a
 * full `Headers` with `forEach`, but that partial fixture is not. Since
 * this function is invoked unconditionally (observation is meant to add
 * no cost beyond one no-op call when disabled, not to require every
 * existing test fixture to grow a full `Headers` implementation), it
 * degrades to "no headers observed" rather than throwing when `forEach`
 * is unavailable — never a crash, only ever an empty allowlisted set.
 */
export function extractGatewayObservationHeaders(headers: Headers): Readonly<Record<string, string>> {
  if (typeof headers?.forEach !== "function") return NO_GATEWAY_OBSERVATION_HEADERS;
  const output: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lowerCaseName = key.toLowerCase();
    if (isAllowlistedGatewayHeaderName(lowerCaseName)) {
      output[lowerCaseName] = truncateHeaderValue(value);
    }
  });
  return Object.freeze(output);
}

/** Empty allowlisted-header set, for observations with no HTTP response
 * (timeout / transport error). A single frozen constant, not a per-call
 * allocation. */
export const NO_GATEWAY_OBSERVATION_HEADERS: Readonly<Record<string, string>> = Object.freeze({});
