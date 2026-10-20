/**
 * MoboReader novel promo-claim contract.
 *
 * Mutation frozen from the Owner-approved Book A browser probe on
 * 2026-08-31:
 *
 *   POST /api/v1/res/getcode
 *     { agencyId, seriesId, projectType: 1, language }
 *
 * Exact-target readback (2026-10-20 Owner-approved revision, see
 * `docs/operations/MOBOREADER_PRECISE_READBACK_PROBE_2026-09-02.md` §14)
 * is a point lookup by identity, the same call CPS 短剧 uses:
 *
 *   POST /api/v1/res/getvideoinfo
 *     { agencyId: number, seriesId: string, projectType: number,
 *       language: number }
 *
 * The response `data` object echoes all four identity fields; they must
 * all be present and equal to the request, otherwise the readback is
 * ambiguous. A non-blank `kocCode` is `found` (URLs are optional: the
 * PlotNovel code-only theater has a code and no URL); a blank one is
 * `missing`. There is no title lookup, no candidate set, no page scan and
 * no getlistpc fallback.
 *
 * Each adapter method performs one HTTP dispatch. The worker may make
 * bounded, read-only repetitions of getvideoinfo, but it never repeats
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
  readback: "/api/v1/res/getvideoinfo",
});

/**
 * Lookup for observation events: reports the *wire* endpoint name
 * (`"getcode"` / `"getvideoinfo"`), not this module's internal `claim`/
 * `readback` aliases. `getvideoinfo` is deliberately NOT one of the rate
 * gate's tracked endpoints (`MOBOREADER_RATE_GATE_TRACKED_ENDPOINTS`): it
 * paces on the shared/default interval. `post()` allowlists every
 * dispatched path against `MOBOREADER_PROMO_ENDPOINTS`'s values, so this
 * always resolves.
 */
const MOBOREADER_PROMO_ENDPOINT_NAMES_BY_PATH: ReadonlyMap<string, string> = new Map([
  [MOBOREADER_PROMO_ENDPOINTS.claim, "getcode"],
  [MOBOREADER_PROMO_ENDPOINTS.readback, "getvideoinfo"],
]);

function promoEndpointName(path: string): string {
  return MOBOREADER_PROMO_ENDPOINT_NAMES_BY_PATH.get(path) ?? path;
}

export const MOBOREADER_PROMO_TIMEOUT_MS = 15_000;

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
  | { status: "ambiguous"; reason: "identity_field_missing" | "identity_mismatch" };

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

/**
 * Converts an identity scalar to the safe integer getvideoinfo expects, or
 * `null` when it is not one (blank string, non-integer text, NaN/Infinity,
 * unsafe magnitude). Shared by the worker (to fail before any upstream
 * request) and by the readback request builder below.
 */
export function toSafeIntegerIdentity(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!/^-?\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** `seriesId` is sent as a string; blank text / non-finite numbers are not an identity. */
export function toSeriesIdentity(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? value : null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

type ReadbackRequestBody = {
  agencyId: number;
  seriesId: string;
  projectType: number;
  language: number;
};

function buildReadbackBody(request: ClaimPromoRequest): ReadbackRequestBody {
  const agencyId = toSafeIntegerIdentity(request.agencyId);
  const seriesId = toSeriesIdentity(request.seriesId);
  const language = toSafeIntegerIdentity(request.language);
  const projectType = toSafeIntegerIdentity(request.projectType);
  // The worker rejects these before any upstream request
  // (`claim_source_fields_missing`); reaching here is a caller bug.
  if (agencyId === null || seriesId === null || language === null || projectType === null) {
    throw new Error("Invalid MoboReader readback identity");
  }
  // Exactly these four keys, in this order: the shape verified by the
  // 2026-10-20 read-only retest (and identical to CPS's getvideoinfo call).
  return { agencyId, seriesId, projectType, language };
}

function parseReadbackResponse(value: unknown, body: ReadbackRequestBody): ReadPromoAfterClaimResult {
  const envelope = asRecord(value, false);
  if (envelope.status !== true || envelope.code !== 200) {
    throw new PromoLinkClaimAdapterError("malformed_payload", false, false);
  }
  const data = asRecord(envelope.data, false);
  if (
    !hasIdentityValue(data.agencyId)
    || !hasIdentityValue(data.seriesId)
    || !hasIdentityValue(data.language)
    || !hasIdentityValue(data.projectType)
  ) {
    return { status: "ambiguous", reason: "identity_field_missing" };
  }
  if (
    !sameIdentityValue(data.agencyId, body.agencyId)
    || !sameIdentityValue(data.seriesId, body.seriesId)
    || !sameIdentityValue(data.language, body.language)
    || !sameIdentityValue(data.projectType, body.projectType)
  ) {
    return { status: "ambiguous", reason: "identity_mismatch" };
  }
  const upstreamCode = nonBlank(data.kocCode);
  // Blank kocCode: the code has not been generated yet. URLs are NOT
  // required (PlotNovel code-only theater has a code and no URL) — do not
  // copy CPS's publicUrl requirement.
  if (!upstreamCode) return { status: "missing" };
  return {
    status: "found",
    promo: {
      upstreamCode,
      webUrl: nonBlank(data.publicUrl) ?? nonBlank(data.homeLink),
      appUrl: nonBlank(data.homeLink),
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
    // before RC-3. RC-4: `endpoint` lets a per-endpoint gate queue getcode
    // and the (untracked) getvideoinfo readback separately; the legacy/no-op
    // gates ignore it.
    const gateWaitStartedAt = observationNow();
    const gateWaitInfo = await rateGate.wait(endpoint);
    const gateWaitMs = observationNow() - gateWaitStartedAt;
    const endpointGateWaitMs = gateWaitInfo ? gateWaitInfo.endpointGateWaitMs : null;
    const hostGateWaitMs = gateWaitInfo ? gateWaitInfo.hostGateWaitMs : null;
    const remainingBeforeDispatch = gateWaitInfo ? gateWaitInfo.remainingBeforeDispatch : null;
    // RC-4 review fix (必改2, round 3): re-check the SAME condition as the
    // pre-wait guard above, now that `wait()` — which under the
    // per-endpoint gate can block for tens of seconds (429 cooldown /
    // floor pause), not the sub-2s window this file's original guard was
    // written for — has actually returned. Without this, a lease/request
    // aborted *during* that wait reaches `scopedSignal` with an
    // already-aborted `signal`; `scopedSignal` does check `parent?.aborted`
    // at construction (unlike `composeSignal` in `./moboreader.ts`), so
    // `fetchImpl` is never actually dispatched — but the `catch` block
    // below cannot tell that apart from "aborted mid-flight" and would
    // classify it `ambiguous: true` on getcode: a request that was NEVER
    // SENT would manufacture a false "result unknown, go to manual
    // review". Same error shape as the pre-wait check: never dispatched,
    // not retryable, not ambiguous.
    if (signal?.aborted) {
      throw new PromoLinkClaimAdapterError("transport_error", false, false);
    }
    const scoped = scopedSignal(signal, timeoutMs);
    const dispatchStartedAt = observationNow();
    try {
      const response = await fetchImpl(`${MOBOREADER_ORIGIN}${path}`, {
        method: "POST",
        redirect: "error",
        headers: path === MOBOREADER_PROMO_ENDPOINTS.readback
          // getvideoinfo: exactly the two headers the 2026-10-20 retest and
          // CPS use. getcode keeps its frozen header set below.
          ? {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          }
          : {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            areainterface: "cn",
            browserlang: "cn",
          },
        body: JSON.stringify(body),
        signal: scoped.signal,
      });
      if (!response.ok) {
        const gatewayHeaders = extractGatewayObservationHeaders(response.headers);
        // RC-4: feed the gate back (429 cooldown / remaining shadow)
        // before classifying the failure below. This call cannot change
        // getcode's frozen ambiguous/retryable classification — it only
        // ever affects a *later* dispatch's `wait()`, never this one's
        // return value or the error thrown here.
        rateGate.observe?.(endpoint, { httpStatus: response.status, gatewayHeaders });
        safeObserve(onUpstreamObservation, () => ({
          endpoint,
          httpStatus: response.status,
          outcome: "http_error",
          latencyMs: observationNow() - dispatchStartedAt,
          gateWaitMs,
          endpointGateWaitMs,
          hostGateWaitMs,
          remainingBeforeDispatch,
          gatewayHeaders,
        }));
        const ambiguous = mutation && ambiguousHttpStatus(response.status);
        throw new PromoLinkClaimAdapterError(
          "upstream_http_error",
          !mutation && ambiguousHttpStatus(response.status),
          ambiguous,
          response.status,
        );
      }
      const gatewayHeaders = extractGatewayObservationHeaders(response.headers);
      rateGate.observe?.(endpoint, { httpStatus: response.status, gatewayHeaders });
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
          endpointGateWaitMs,
          hostGateWaitMs,
          remainingBeforeDispatch,
          gatewayHeaders,
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
          endpointGateWaitMs,
          hostGateWaitMs,
          remainingBeforeDispatch,
          gatewayHeaders,
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
        endpointGateWaitMs,
        hostGateWaitMs,
        remainingBeforeDispatch,
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
      const payload = buildReadbackBody(request);
      const response = await post(MOBOREADER_PROMO_ENDPOINTS.readback, payload, token, signal, false);
      return parseReadbackResponse(response, payload);
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
