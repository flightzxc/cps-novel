import { describe, expect, it, vi } from "vitest";

import {
  MOBOREADER_PROMO_ENDPOINTS,
  PromoLinkClaimAdapterError,
  createPromoLinkClaimAdapter,
  type ClaimPromoRequest,
} from "@/lib/adapters";

const request: ClaimPromoRequest = {
  agencyId: 3366,
  seriesId: "124235322",
  projectType: 1,
  language: 3,
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

  it("uses the evidenced getlistpc coordinate for readback and selects the matching series", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      status: true,
      code: 200,
      data: {
        totalCount: 2,
        list: [
          { seriesId: "other", kocCode: null },
          {
            seriesId: "124235322",
            kocCode: "239FFB",
            publicUrl: "https://eng.moboreader.com/1M4mpB/239FFB",
            homeLink: "https://eng.moboreader.com/book/239FFB",
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
      name: "",
      orderType: 1,
      pageIndex: 1,
      pageSize: 10,
      projectType: 1,
    });
  });

  it("distinguishes no promo on the target row from a target absent from the evidenced page", async () => {
    const responses = [
      { status: true, code: 200, data: { list: [{ seriesId: "124235322", kocCode: null }] } },
      { status: true, code: 200, data: { list: [{ seriesId: "different-series", kocCode: null }] } },
    ];
    const fetchImpl = vi.fn(async () => jsonResponse(responses.shift())) as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });

    await expect(adapter.readPromoAfterClaim!(request, "jwt-token")).resolves.toEqual({ status: "missing" });
    await expect(adapter.readPromoAfterClaim!(request, "jwt-token")).resolves.toEqual({ status: "target_not_in_coordinate" });
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
