/**
 * MoboReader novel promo-claim contract.
 *
 * Frozen from the Owner-approved Book A browser probe on 2026-08-31:
 *
 *   POST /api/v1/res/getcode
 *     { agencyId, seriesId, projectType: 1, language }
 *
 * The page then performs a readback with:
 *
 *   POST /api/v1/res/getlistpc
 *     { name: "", orderType: 1, pageIndex: 1, projectType: 1, pageSize: 10 }
 *
 * Both operations are deliberately single-attempt. A claim timeout,
 * connection reset, abort after dispatch, HTTP 408/429/5xx, or malformed
 * success response is ambiguous: callers must read back and must never
 * automatically repeat getcode. Upstream idempotency remains unverified.
 */

const MOBOREADER_ORIGIN = "https://kocserver-cn.cdreader.com";

export const MOBOREADER_PROMO_ENDPOINTS = Object.freeze({
  claim: "/api/v1/res/getcode",
  readback: "/api/v1/res/getlistpc",
});

export const MOBOREADER_PROMO_TIMEOUT_MS = 15_000;
export const MOBOREADER_PROMO_READBACK_COORDINATE = Object.freeze({
  name: "",
  orderType: 1,
  pageIndex: 1,
  pageSize: 10,
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
  | { status: "target_not_in_coordinate" };

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

function parseReadbackResponse(value: unknown, seriesId: string | number): ReadPromoAfterClaimResult {
  const envelope = asRecord(value, false);
  if (envelope.status !== true || envelope.code !== 200) {
    throw new PromoLinkClaimAdapterError("malformed_payload", false, false);
  }
  const data = asRecord(envelope.data, false);
  if (!Array.isArray(data.list)) throw new PromoLinkClaimAdapterError("malformed_payload", false, false);
  const expected = String(seriesId);
  const matching = data.list.find((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const row = candidate as Record<string, unknown>;
    return String(row.seriesId ?? "") === expected;
  });
  if (!matching) return { status: "target_not_in_coordinate" };
  const row = matching as Record<string, unknown>;
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
      const payload = {
        ...MOBOREADER_PROMO_READBACK_COORDINATE,
        projectType: request.projectType,
      };
      const response = await post(MOBOREADER_PROMO_ENDPOINTS.readback, payload, token, signal, false);
      return parseReadbackResponse(response, request.seriesId);
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
