/**
 * MoboReader novel promo-claim contract.
 *
 * Mutation frozen from the Owner-approved Book A browser probe on
 * 2026-08-31; exact-target readback frozen by
 * `docs/operations/MOBOREADER_PRECISE_READBACK_PROBE_2026-09-02.md`:
 *
 *   POST /api/v1/res/getcode
 *     { agencyId, seriesId, projectType: 1, language }
 *
 * Exact-target readback uses:
 *
 *   POST /api/v1/res/getlistpc
 *     { name: <current catalog title>, orderType: 1, pageIndex: 1,
 *       projectType: 1, pageSize: 100 }
 *
 * `name` is only a mutable locator. A complete candidate set is required,
 * then `{ agencyId, seriesId, language, projectType }` selects the sole
 * authoritative row. There is no fallback page scan.
 *
 * Each adapter method performs one HTTP dispatch. The worker may make
 * bounded, read-only repetitions of getlistpc, but it never repeats
 * getcode. A claim timeout, connection reset, abort after dispatch, HTTP
 * 408/429/5xx, or malformed success response is ambiguous and must enter
 * readback-only recovery. Upstream idempotency remains unverified.
 */

import { NOOP_MOBOREADER_RATE_GATE, type MoboreaderRateGate } from "./moboreader-rate-limit";
import {
  NOOP_UPSTREAM_OBSERVATION,
  NO_GATEWAY_OBSERVATION_HEADERS,
  extractGatewayObservationHeaders,
  safeObserve,
  type OnUpstreamObservation,
} from "./upstream-observation";

const MOBOREADER_ORIGIN = "https://kocserver-cn.cdreader.com";

export const MOBOREADER_PROMO_ENDPOINTS = Object.freeze({
  claim: "/api/v1/res/getcode",
  readback: "/api/v1/res/getlistpc",
});

/**
 * Lookup for observation events: reports the *wire* endpoint name
 * (`"getcode"` / `"getlistpc"`), not this module's internal `claim`/
 * `readback` aliases — the readback call dispatches to the very same
 * `getlistpc` upstream endpoint the catalog/Preview adapter uses
 * (`MOBOREADER_READ_ENDPOINTS.getlistpc` in `./moboreader.ts`), so its
 * observation events must be identifiable as `getlistpc` calls too, not a
 * third, adapter-local name. `post()` allowlists every dispatched path
 * against `MOBOREADER_PROMO_ENDPOINTS`'s values, so this always resolves.
 */
const MOBOREADER_PROMO_ENDPOINT_NAMES_BY_PATH: ReadonlyMap<string, string> = new Map([
  [MOBOREADER_PROMO_ENDPOINTS.claim, "getcode"],
  [MOBOREADER_PROMO_ENDPOINTS.readback, "getlistpc"],
]);

function promoEndpointName(path: string): string {
  return MOBOREADER_PROMO_ENDPOINT_NAMES_BY_PATH.get(path) ?? path;
}

export const MOBOREADER_PROMO_TIMEOUT_MS = 15_000;
/** P-10 proved that getlistpc delivers 100 rows when 100 are requested. */
export const MOBOREADER_PROMO_MAX_CANDIDATES = 100;
export const MOBOREADER_PROMO_READBACK_COORDINATE = Object.freeze({
  orderType: 1,
  pageIndex: 1,
  pageSize: MOBOREADER_PROMO_MAX_CANDIDATES,
});

export type PromoLinkClaimAdapterErrorCode =
  | "transport_error"
  | "request_timeout"
  | "upstream_http_error"
  | "malformed_payload";

export class PromoLinkClaimAdapterError extends Error {
  constructor(
    readonly code: PromoLinkClaimAdapterErrorCode,
    readonly retryable: boolean,
    readonly ambiguous: boolean,
    readonly status: number | null = null,
    /**
     * Non-sensitive business-envelope diagnostics, populated only by
     * `parseClaimResponse` when `getcode`'s `{status, code}` envelope is
     * not the success shape. `null` for every other throw site (HTTP-layer
     * errors, the readback parser, transport/timeout). Never the response
     * `message` field — that may be long, free-text, or sensitive, and is
     * deliberately never captured here or anywhere else in this adapter.
     * A boolean/number value is passed through as-is; any other shape is
     * reduced to a `typeof`-style descriptor by `describeEnvelopeStatus`/
     * `describeEnvelopeCode` so this can never leak an arbitrary upstream
     * value.
     */
    readonly envelopeStatus: boolean | string | null = null,
    readonly envelopeCode: number | string | null = null,
  ) {
    super(`PromoLink claim failed: ${code}${status === null ? "" : ` (${status})`}`);
    this.name = "PromoLinkClaimAdapterError";
  }
}

export interface ClaimPromoRequest {
  agencyId: string | number;
  seriesId: string | number;
  projectType: number;
  language: string | number;
  /** Current catalog title; used only as getlistpc's locating coordinate. */
  name: string;
  /** Local-only persistence dimension; never sent upstream. */
  offerType: string;
}

export interface ClaimPromoResult {
  /** Never write this value to logs, task results, or OperationAudit. */
  upstreamCode: string;
  webUrl: string | null;
  appUrl: string | null;
}

export type ReadPromoAfterClaimResult =
  | { status: "found"; promo: ClaimPromoResult }
  | { status: "missing" }
  | {
    status: "target_not_located";
    reason: "title_unavailable" | "title_no_match" | "locator_stale";
    totalCount: null | 0;
  }
  | { status: "target_missing"; reason: "identity_no_match"; totalCount: number; returnedCount: number }
  | {
    status: "ambiguous";
    reason: "candidate_set_incomplete" | "identity_field_missing" | "identity_not_unique";
    totalCount: number;
    returnedCount: number | null;
  };

export interface PromoLinkClaimAdapter {
  claimPromo(request: ClaimPromoRequest, token: string, signal?: AbortSignal): Promise<ClaimPromoResult>;
  readPromoAfterClaim?(
    request: ClaimPromoRequest,
    token: string,
    signal?: AbortSignal,
  ): Promise<ReadPromoAfterClaimResult>;
}

type Fetch = typeof fetch;

export interface PromoLinkClaimAdapterOptions {
  fetchImpl?: Fetch;
  timeoutMs?: number;
  /**
   * Module-level upstream pacing door (RC-3;
   * `src/lib/adapters/moboreader-rate-limit.ts`). Defaults to a no-op so
   * constructing this adapter with no options — as every existing test
   * does — adds zero latency. Production wiring
   * (`worker/handlers/promo-link-claim.ts`) passes the shared
   * `moboreaderUpstreamRateGate` singleton, the same one the catalog/Preview
   * adapters use, so all MoboReader traffic in this process paces against
   * one shared clock.
   *
   * This gate only makes the dispatch *wait its turn* — it does not retry.
   * The getcode mutation's call/error semantics are frozen (no automatic
   * retry, ambiguous outcomes route to readback-only recovery); this door
   * sits in front of that contract, unchanged.
   */
  rateGate?: MoboreaderRateGate;
  /**
   * Phase 1 upstream-call observation (see `./upstream-observation.ts`).
   * Defaults to a no-op — every pre-existing test/call site that does not
   * pass this is byte-for-byte unaffected. Production wiring
   * (`worker/handlers/promo-link-claim.ts`) passes a structured-log sink.
   * One event per dispatch (claim or readback); never fired for the
   * pre-dispatch `signal.aborted` short-circuit below, since no gate wait
   * or network call happens on that path.
   */
  onUpstreamObservation?: OnUpstreamObservation;
  /** Clock used only for `UpstreamCallObservation.latencyMs`/`gateWaitMs`
   * timestamps. Defaults to `Date.now`. */
  now?: () => number;
}

function asRecord(value: unknown, ambiguous: boolean): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PromoLinkClaimAdapterError("malformed_payload", false, ambiguous);
  }
  return value as Record<string, unknown>;
}

function nonBlank(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

const ENVELOPE_DIAGNOSTIC_MAX_LENGTH = 100;

/** Diagnostic-only, non-sensitive shape of `getcode`'s envelope `status`
 * field: the real value when it is itself already a safe primitive
 * (boolean), otherwise just its type name — see
 * `PromoLinkClaimAdapterError.envelopeStatus`'s doc comment. */
function describeEnvelopeStatus(value: unknown): boolean | string {
  if (typeof value === "boolean") return value;
  if (value === null) return "typeof object (null)";
  if (value === undefined) return "typeof undefined";
  return `typeof ${typeof value}`;
}

/** Diagnostic-only, non-sensitive shape of `getcode`'s envelope `code`
 * field: the real value when it is a finite number or a length-capped
 * string, otherwise just its type name — see
 * `PromoLinkClaimAdapterError.envelopeCode`'s doc comment. */
function describeEnvelopeCode(value: unknown): number | string {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    return value.length > ENVELOPE_DIAGNOSTIC_MAX_LENGTH ? value.slice(0, ENVELOPE_DIAGNOSTIC_MAX_LENGTH) : value;
  }
  if (value === null) return "typeof object (null)";
  if (value === undefined) return "typeof undefined";
  return `typeof ${typeof value}`;
}

function parseClaimResponse(value: unknown): ClaimPromoResult {
  const envelope = asRecord(value, true);
  if (envelope.status !== true || envelope.code !== 200) {
    throw new PromoLinkClaimAdapterError(
      "malformed_payload",
      false,
      true,
      null,
      describeEnvelopeStatus(envelope.status),
      describeEnvelopeCode(envelope.code),
    );
  }
  const data = asRecord(envelope.data, true);
  const upstreamCode = nonBlank(data.kocCode);
  if (!upstreamCode) throw new PromoLinkClaimAdapterError("malformed_payload", false, true);
  return {
    upstreamCode,
    webUrl: nonBlank(data.publicUrl) ?? nonBlank(data.homeLink),
    appUrl: nonBlank(data.homeLink),
  };
}

function sameIdentityValue(actual: unknown, expected: string | number): boolean {
  if ((typeof actual !== "string" || !actual.trim()) && (typeof actual !== "number" || !Number.isFinite(actual))) {
    return false;
  }
  return String(actual) === String(expected);
}

function hasIdentityValue(value: unknown): boolean {
  return (typeof value === "string" && Boolean(value.trim()))
    || (typeof value === "number" && Number.isFinite(value));
}

function candidateRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseReadbackResponse(value: unknown, request: ClaimPromoRequest): ReadPromoAfterClaimResult {
  const envelope = asRecord(value, false);
  if (envelope.status !== true || envelope.code !== 200) {
    throw new PromoLinkClaimAdapterError("malformed_payload", false, false);
  }
  const data = asRecord(envelope.data, false);
  if (!Number.isSafeInteger(data.totalCount) || (data.totalCount as number) < 0) {
    throw new PromoLinkClaimAdapterError("malformed_payload", false, false);
  }
  const totalCount = data.totalCount as number;
  const list = data.list;
  // 2026-09-11 Owner-approved revision (see MOBOREADER_PRECISE_READBACK_PROBE_2026-09-02.md,
  // "2026-09-11 修订" section): getlistpc's `totalCount` counts a title
  // match once, but `list` enumerates every language edition of the same
  // seriesId family (P-7 gap; 3/3 read-only probe evidence, ar/de/es).
  // `totalCount` is therefore no longer a hard completeness condition.
  // Completeness now means "structurally unpaginated": the response was
  // not truncated by pageSize. `totalCount` (declaredTotalCount) and the
  // actual row count (returnedCount) are still recorded on every branch
  // below for audit, regardless of whether they agree.
  const complete = Array.isArray(list) && list.length < MOBOREADER_PROMO_MAX_CANDIDATES;
  if (!complete) {
    return {
      status: "ambiguous",
      reason: "candidate_set_incomplete",
      totalCount,
      returnedCount: Array.isArray(list) ? list.length : null,
    };
  }
  if (totalCount === 0) {
    return { status: "target_not_located", reason: "title_no_match", totalCount: 0 };
  }

  const rows = list.map(candidateRecord);
  if (rows.some((row) => (
    !row
    || !hasIdentityValue(row.agencyId)
    || !hasIdentityValue(row.seriesId)
    || !hasIdentityValue(row.language)
    || !hasIdentityValue(row.projectType)
  ))) {
    return {
      status: "ambiguous",
      reason: "identity_field_missing",
      totalCount,
      returnedCount: list.length,
    };
  }
  const matches = (rows as Array<Record<string, unknown>>).filter((row) => (
    sameIdentityValue(row.agencyId, request.agencyId)
    && sameIdentityValue(row.seriesId, request.seriesId)
    && sameIdentityValue(row.language, request.language)
    && sameIdentityValue(row.projectType, request.projectType)
  ));
  if (matches.length === 0) {
    return { status: "target_missing", reason: "identity_no_match", totalCount, returnedCount: list.length };
  }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      reason: "identity_not_unique",
      totalCount,
      returnedCount: list.length,
    };
  }
  const row = matches[0];
  const upstreamCode = nonBlank(row.kocCode);
  if (!upstreamCode) return { status: "missing" };
  return {
    status: "found",
    promo: {
      upstreamCode,
      webUrl: nonBlank(row.publicUrl) ?? nonBlank(row.homeLink),
      appUrl: nonBlank(row.homeLink),
    },
  };
}

function scopedSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abort = () => controller.abort();
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) controller.abort();
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abort);
    },
  };
}

function ambiguousHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function createPromoLinkClaimAdapter(
  options: PromoLinkClaimAdapterOptions = {},
): PromoLinkClaimAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? MOBOREADER_PROMO_TIMEOUT_MS;
  const rateGate = options.rateGate ?? NOOP_MOBOREADER_RATE_GATE;
  const onUpstreamObservation = options.onUpstreamObservation ?? NOOP_UPSTREAM_OBSERVATION;
  const observationNow = options.now ?? Date.now;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Invalid MoboReader promo timeout");
  }

  async function post(
    path: string,
    body: Record<string, unknown>,
    token: string,
    signal: AbortSignal | undefined,
    mutation: boolean,
  ): Promise<unknown> {
    if (!Object.values(MOBOREADER_PROMO_ENDPOINTS).includes(path as never)) {
      throw new Error("Endpoint is not allowlisted");
    }
    if (!token) throw new Error("MoboReader credential is required");
    if (signal?.aborted) {
      throw new PromoLinkClaimAdapterError("transport_error", false, false);
    }
    const endpoint = promoEndpointName(path);
    // Wait-only pacing door — see `PromoLinkClaimAdapterOptions.rateGate`.
    // No retry semantics live here or below; a single dispatch, exactly as
    // before RC-3.
    const gateWaitStartedAt = observationNow();
    await rateGate.wait();
    const gateWaitMs = observationNow() - gateWaitStartedAt;
    const scoped = scopedSignal(signal, timeoutMs);
    const dispatchStartedAt = observationNow();
    try {
      const response = await fetchImpl(`${MOBOREADER_ORIGIN}${path}`, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          areainterface: "cn",
          browserlang: "cn",
        },
        body: JSON.stringify(body),
        signal: scoped.signal,
      });
      if (!response.ok) {
        safeObserve(onUpstreamObservation, () => ({
          endpoint,
          httpStatus: response.status,
          outcome: "http_error",
          latencyMs: observationNow() - dispatchStartedAt,
          gateWaitMs,
          gatewayHeaders: extractGatewayObservationHeaders(response.headers),
        }));
        const ambiguous = mutation && ambiguousHttpStatus(response.status);
        throw new PromoLinkClaimAdapterError(
          "upstream_http_error",
          !mutation && ambiguousHttpStatus(response.status),
          ambiguous,
          response.status,
        );
      }
      try {
        const json = await response.json();
        // `safeObserve` runs after the response body is already parsed and
        // captured in `json`, so a throwing observation callback below can
        // never turn this success into anything else — see the doc comment
        // on `safeObserve` for why this matters most on `getcode`.
        safeObserve(onUpstreamObservation, () => ({
          endpoint,
          httpStatus: response.status,
          outcome: "ok",
          latencyMs: observationNow() - dispatchStartedAt,
          gateWaitMs,
          gatewayHeaders: extractGatewayObservationHeaders(response.headers),
        }));
        return json;
      } catch {
        // Transport succeeded (2xx); the body just wasn't parsable JSON —
        // still `"ok"` from the wire-protocol perspective this event
        // reports on. The (separate) business-envelope diagnostics for a
        // parsed-but-non-success envelope live on `PromoLinkClaimAdapterError.
        // envelopeStatus/envelopeCode`, not here.
        safeObserve(onUpstreamObservation, () => ({
          endpoint,
          httpStatus: response.status,
          outcome: "ok",
          latencyMs: observationNow() - dispatchStartedAt,
          gateWaitMs,
          gatewayHeaders: extractGatewayObservationHeaders(response.headers),
        }));
        throw new PromoLinkClaimAdapterError("malformed_payload", false, mutation, response.status);
      }
    } catch (error) {
      if (error instanceof PromoLinkClaimAdapterError) throw error;
      const timedOut = scoped.timedOut();
      safeObserve(onUpstreamObservation, () => ({
        endpoint,
        httpStatus: null,
        outcome: timedOut ? "timeout" : "transport_error",
        latencyMs: observationNow() - dispatchStartedAt,
        gateWaitMs,
        gatewayHeaders: NO_GATEWAY_OBSERVATION_HEADERS,
      }));
      throw new PromoLinkClaimAdapterError(
        timedOut ? "request_timeout" : "transport_error",
        !mutation,
        mutation,
      );
    } finally {
      scoped.cleanup();
    }
  }

  const adapter: PromoLinkClaimAdapter = {
    async claimPromo(request, token, signal) {
      const payload = {
        agencyId: request.agencyId,
        seriesId: request.seriesId,
        projectType: request.projectType,
        language: request.language,
      };
      return parseClaimResponse(await post(MOBOREADER_PROMO_ENDPOINTS.claim, payload, token, signal, true));
    },
    async readPromoAfterClaim(request, token, signal) {
      const name = request.name.trim();
      if (!name) {
        return { status: "target_not_located", reason: "title_unavailable", totalCount: null };
      }
      const payload = {
        ...MOBOREADER_PROMO_READBACK_COORDINATE,
        name,
        projectType: request.projectType,
      };
      const response = await post(MOBOREADER_PROMO_ENDPOINTS.readback, payload, token, signal, false);
      return parseReadbackResponse(response, request);
    },
  };
  return Object.freeze(adapter);
}

export interface ClassifiedClaimFailure {
  failureCategory: PromoLinkClaimAdapterErrorCode;
  retryable: boolean;
  ambiguous: boolean;
  /** See `PromoLinkClaimAdapterError.envelopeStatus`. `null` unless the
   * failure was a non-success `getcode` envelope. */
  envelopeStatus: boolean | string | null;
  /** See `PromoLinkClaimAdapterError.envelopeCode`. `null` unless the
   * failure was a non-success `getcode` envelope. */
  envelopeCode: number | string | null;
}

export function classifyClaimPromoFailure(error: unknown): ClassifiedClaimFailure {
  if (error instanceof PromoLinkClaimAdapterError) {
    return {
      failureCategory: error.code,
      retryable: error.retryable,
      ambiguous: error.ambiguous,
      envelopeStatus: error.envelopeStatus,
      envelopeCode: error.envelopeCode,
    };
  }
  return { failureCategory: "transport_error", retryable: false, ambiguous: true, envelopeStatus: null, envelopeCode: null };
}
