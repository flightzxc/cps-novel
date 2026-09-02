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

const MOBOREADER_ORIGIN = "https://kocserver-cn.cdreader.com";

export const MOBOREADER_PROMO_ENDPOINTS = Object.freeze({
  claim: "/api/v1/res/getcode",
  readback: "/api/v1/res/getlistpc",
});

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

function parseClaimResponse(value: unknown): ClaimPromoResult {
  const envelope = asRecord(value, true);
  if (envelope.status !== true || envelope.code !== 200) {
    throw new PromoLinkClaimAdapterError("malformed_payload", false, true);
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
  const complete = Array.isArray(list)
    && list.length === totalCount
    && totalCount <= MOBOREADER_PROMO_MAX_CANDIDATES;
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
    const scoped = scopedSignal(signal, timeoutMs);
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
        const ambiguous = mutation && ambiguousHttpStatus(response.status);
        throw new PromoLinkClaimAdapterError(
          "upstream_http_error",
          !mutation && ambiguousHttpStatus(response.status),
          ambiguous,
          response.status,
        );
      }
      try {
        return await response.json();
      } catch {
        throw new PromoLinkClaimAdapterError("malformed_payload", false, mutation, response.status);
      }
    } catch (error) {
      if (error instanceof PromoLinkClaimAdapterError) throw error;
      throw new PromoLinkClaimAdapterError(
        scoped.timedOut() ? "request_timeout" : "transport_error",
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
}

export function classifyClaimPromoFailure(error: unknown): ClassifiedClaimFailure {
  if (error instanceof PromoLinkClaimAdapterError) {
    return { failureCategory: error.code, retryable: error.retryable, ambiguous: error.ambiguous };
  }
  return { failureCategory: "transport_error", retryable: false, ambiguous: true };
}
