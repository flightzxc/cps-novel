import { describe, expect, it, vi } from "vitest";

import {
  MOBOREADER_PROMO_ENDPOINTS,
  MOBOREADER_PROMO_MAX_CANDIDATES,
  PromoLinkClaimAdapterError,
  createPromoLinkClaimAdapter,
  type ClaimPromoRequest,
} from "@/lib/adapters";

const request: ClaimPromoRequest = {
  agencyId: 3366,
  seriesId: "124235322",
  projectType: 1,
  language: 3,
  name: "The Exact Target Title",
  offerType: "read",
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("MoboReader promo claim adapter — frozen Book A contract", () => {
  it("sends exactly the evidenced getcode body and parses the success envelope", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: {
        kocCode: "239FFB",
        publicUrl: "https://eng.moboreader.com/1M4mpB/239FFB",
        homeLink: "https://eng.moboreader.com/book/239FFB",
      },
      code: 200,
      message: "操作成功",
      status: true,
    })) as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });

    await expect(adapter.claimPromo(request, "jwt-token")).resolves.toEqual({
      upstreamCode: "239FFB",
      webUrl: "https://eng.moboreader.com/1M4mpB/239FFB",
      appUrl: "https://eng.moboreader.com/book/239FFB",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`https://kocserver-cn.cdreader.com${MOBOREADER_PROMO_ENDPOINTS.claim}`);
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(String(init.body))).toEqual({
      agencyId: 3366,
      seriesId: "124235322",
      projectType: 1,
      language: 3,
    });
    expect(String(init.body)).not.toContain("offerType");
  });

  it("uses title only to locate and selects one four-dimensional match from a complete multi-row candidate set", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      status: true,
      code: 200,
      data: {
        totalCount: 3,
        list: [
          {
            agencyId: 3366,
            seriesId: "other-series",
            language: 3,
            projectType: 1,
            kocCode: null,
          },
          {
            agencyId: 3366,
            seriesId: "124235322",
            language: 3,
            projectType: 1,
            title: "A renamed title is not authority",
            kocCode: "239FFB",
            publicUrl: "https://eng.moboreader.com/1M4mpB/239FFB",
            homeLink: "https://eng.moboreader.com/book/239FFB",
          },
          {
            agencyId: 9999,
            seriesId: "124235322",
            language: 3,
            projectType: 1,
            kocCode: null,
          },
        ],
      },
    })) as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });

    await expect(adapter.readPromoAfterClaim!(request, "jwt-token")).resolves.toMatchObject({
      status: "found",
      promo: { upstreamCode: "239FFB" },
    });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`https://kocserver-cn.cdreader.com${MOBOREADER_PROMO_ENDPOINTS.readback}`);
    expect(JSON.parse(String(init.body))).toEqual({
      name: "The Exact Target Title",
      orderType: 1,
      pageIndex: 1,
      pageSize: 100,
      projectType: 1,
    });
    expect(MOBOREADER_PROMO_MAX_CANDIDATES).toBe(100);
  });

  it("strictly distinguishes a located row with no promo from title lookup failure", async () => {
    const responses = [
      {
        status: true,
        code: 200,
        data: {
          totalCount: 1,
          list: [{ agencyId: 3366, seriesId: "124235322", language: 3, projectType: 1, kocCode: null }],
        },
      },
      { status: true, code: 200, data: { totalCount: 0, list: [] } },
    ];
    const fetchImpl = vi.fn(async () => jsonResponse(responses.shift())) as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });

    await expect(adapter.readPromoAfterClaim!(request, "jwt-token")).resolves.toEqual({ status: "missing" });
    await expect(adapter.readPromoAfterClaim!(request, "jwt-token")).resolves.toEqual({
      status: "target_not_located",
      reason: "title_no_match",
      totalCount: 0,
    });
  });

  it("fails closed when the response is truncated and never scans another page", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      status: true,
      code: 200,
      data: {
        totalCount: 4,
        list: Array.from({ length: 3 }, (_, index) => ({
          agencyId: 3366,
          seriesId: `other-${index}`,
          language: 3,
          projectType: 1,
          kocCode: null,
        })),
      },
    })) as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });

    await expect(adapter.readPromoAfterClaim!(request, "jwt-token")).resolves.toEqual({
      status: "ambiguous",
      reason: "candidate_set_incomplete",
      totalCount: 4,
      returnedCount: 3,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(String(init.body)).pageIndex).toBe(1);
  });

  it("fails closed above MAX_CANDIDATES even if an upstream payload over-delivers every row", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      status: true,
      code: 200,
      data: {
        totalCount: 101,
        list: Array.from({ length: 101 }, (_, index) => ({
          agencyId: 3366,
          seriesId: `other-${index}`,
          language: 3,
          projectType: 1,
          kocCode: null,
        })),
      },
    })) as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });

    await expect(adapter.readPromoAfterClaim!(request, "jwt-token")).resolves.toEqual({
      status: "ambiguous",
      reason: "candidate_set_incomplete",
      totalCount: 101,
      returnedCount: 101,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("applies the completeness assertion to a non-array list", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      status: true,
      code: 200,
      data: { totalCount: 1, list: null },
    })) as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });

    await expect(adapter.readPromoAfterClaim!(request, "jwt-token")).resolves.toEqual({
      status: "ambiguous",
      reason: "candidate_set_incomplete",
      totalCount: 1,
      returnedCount: null,
    });
  });

  it.each([
    ["agencyId", 9999],
    ["seriesId", "different-series"],
    ["language", 7],
    ["projectType", 2],
  ] as const)("reports target missing when a complete candidate set has no %s identity match", async (field, value) => {
    const row = {
      agencyId: 3366,
      seriesId: "124235322",
      language: 3,
      projectType: 1,
      kocCode: "239FFB",
      [field]: value,
    };
    const fetchImpl = vi.fn(async () => jsonResponse({
      status: true,
      code: 200,
      data: { totalCount: 1, list: [row] },
    })) as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });

    await expect(adapter.readPromoAfterClaim!(request, "jwt-token")).resolves.toEqual({
      status: "target_missing",
      reason: "identity_no_match",
      totalCount: 1,
      returnedCount: 1,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["agencyId", "seriesId", "language", "projectType"] as const)(
    "fails closed when any candidate row omits %s",
    async (field) => {
      const row: Record<string, unknown> = {
        agencyId: 3366,
        seriesId: "124235322",
        language: 3,
        projectType: 1,
        kocCode: "239FFB",
      };
      delete row[field];
      const fetchImpl = vi.fn(async () => jsonResponse({
        status: true,
        code: 200,
        data: { totalCount: 1, list: [row] },
      })) as unknown as typeof fetch;
      const adapter = createPromoLinkClaimAdapter({ fetchImpl });

      await expect(adapter.readPromoAfterClaim!(request, "jwt-token")).resolves.toEqual({
        status: "ambiguous",
        reason: "identity_field_missing",
        totalCount: 1,
        returnedCount: 1,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("fails closed when more than one row has the authoritative identity", async () => {
    const matchingRow = {
      agencyId: 3366,
      seriesId: "124235322",
      language: 3,
      projectType: 1,
      kocCode: "239FFB",
    };
    const fetchImpl = vi.fn(async () => jsonResponse({
      status: true,
      code: 200,
      data: { totalCount: 2, list: [matchingRow, { ...matchingRow }] },
    })) as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });

    await expect(adapter.readPromoAfterClaim!(request, "jwt-token")).resolves.toEqual({
      status: "ambiguous",
      reason: "identity_not_unique",
      totalCount: 2,
      returnedCount: 2,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch when the locating title is unavailable", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });

    await expect(adapter.readPromoAfterClaim!({ ...request, name: "   " }, "jwt-token")).resolves.toEqual({
      status: "target_not_located",
      reason: "title_unavailable",
      totalCount: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([408, 429, 503])(
    "classifies read-only HTTP %i as retryable and non-ambiguous after one adapter dispatch",
    async (status) => {
      const fetchImpl = vi.fn(async () => jsonResponse({ message: "transient" }, status)) as unknown as typeof fetch;
      const adapter = createPromoLinkClaimAdapter({ fetchImpl });

      await expect(adapter.readPromoAfterClaim!(request, "jwt-token")).rejects.toMatchObject({
        code: "upstream_http_error",
        status,
        retryable: true,
        ambiguous: false,
      } satisfies Partial<PromoLinkClaimAdapterError>);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("classifies a read-only deadline as retryable without retrying inside the adapter", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })) as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl, timeoutMs: 1 });

    await expect(adapter.readPromoAfterClaim!(request, "jwt-token")).rejects.toMatchObject({
      code: "request_timeout",
      retryable: true,
      ambiguous: false,
    } satisfies Partial<PromoLinkClaimAdapterError>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("classifies a malformed readback as non-ambiguous and never mutates", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: false, code: 500, data: null })) as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });

    await expect(adapter.readPromoAfterClaim!(request, "jwt-token")).rejects.toMatchObject({
      code: "malformed_payload",
      ambiguous: false,
    } satisfies Partial<PromoLinkClaimAdapterError>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never retries a transport-ambiguous getcode call", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("connection reset"); }) as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });

    await expect(adapter.claimPromo(request, "jwt-token")).rejects.toMatchObject({
      code: "transport_error",
      retryable: false,
      ambiguous: true,
    } satisfies Partial<PromoLinkClaimAdapterError>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats a getcode 5xx as ambiguous and still makes only one request", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "error" }, 503)) as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });

    await expect(adapter.claimPromo(request, "jwt-token")).rejects.toMatchObject({
      code: "upstream_http_error",
      status: 503,
      retryable: false,
      ambiguous: true,
    } satisfies Partial<PromoLinkClaimAdapterError>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch getcode when the lease signal is already aborted", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });
    const controller = new AbortController();
    controller.abort();

    await expect(adapter.claimPromo(request, "jwt-token", controller.signal)).rejects.toMatchObject({
      code: "transport_error",
      ambiguous: false,
    } satisfies Partial<PromoLinkClaimAdapterError>);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
