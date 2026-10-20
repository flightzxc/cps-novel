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

/** A well-formed getvideoinfo success envelope echoing the `request` identity. */
function readbackEnvelope(dataOverrides: Record<string, unknown> = {}) {
  return {
    status: true,
    code: 200,
    message: "操作成功",
    data: {
      agencyId: 3366,
      seriesId: "124235322",
      language: 3,
      projectType: 1,
      kocCode: "239FFB",
      publicUrl: "https://eng.moboreader.com/1M4mpB/239FFB",
      homeLink: "https://eng.moboreader.com/book/239FFB",
      onlineUrl: "",
      ...dataOverrides,
    },
  };
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
    // Regression: getcode's frozen header set is unchanged by the
    // getvideoinfo readback migration.
    expect(init.headers).toEqual({
      authorization: "Bearer jwt-token",
      "content-type": "application/json",
      areainterface: "cn",
      browserlang: "cn",
    });
  });

  it("sends exactly the 4-key getvideoinfo body with only the two allowed headers", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(readbackEnvelope())) as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });

    await expect(adapter.readPromoAfterClaim!(request, "jwt-token")).resolves.toMatchObject({ status: "found" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(MOBOREADER_PROMO_ENDPOINTS.readback).toBe("/api/v1/res/getvideoinfo");
    expect(url).toBe("https://kocserver-cn.cdreader.com/api/v1/res/getvideoinfo");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(Object.keys(init.headers).sort()).toEqual(["authorization", "content-type"]);
    expect(init.headers).toEqual({ authorization: "Bearer jwt-token", "content-type": "application/json" });
    const body = JSON.parse(String(init.body));
    expect(Object.keys(body).sort()).toEqual(["agencyId", "language", "projectType", "seriesId"]);
    expect(body).toEqual({ agencyId: 3366, seriesId: "124235322", projectType: 1, language: 3 });
    expect(typeof body.agencyId).toBe("number");
    expect(typeof body.language).toBe("number");
    expect(typeof body.seriesId).toBe("string");
  });

  it("takes projectType from the request, converts string/number scalars, and sends seriesId as a string", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(readbackEnvelope({ projectType: 2, seriesId: "777" }))) as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });
    const loose: ClaimPromoRequest = {
      agencyId: "3366",
      seriesId: 777,
      projectType: 2,
      language: "3",
      offerType: "read",
    };

    await expect(adapter.readPromoAfterClaim!(loose, "jwt-token")).resolves.toMatchObject({ status: "found" });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(String(init.body))).toEqual({ agencyId: 3366, seriesId: "777", projectType: 2, language: 3 });
  });

  it("does not dispatch when an identity scalar cannot be converted", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });

    await expect(adapter.readPromoAfterClaim!({ ...request, agencyId: "abc" }, "jwt-token")).rejects.toThrow();
    await expect(adapter.readPromoAfterClaim!({ ...request, language: 1.5 }, "jwt-token")).rejects.toThrow();
    await expect(adapter.readPromoAfterClaim!({ ...request, seriesId: "  " }, "jwt-token")).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns found with code and links when the four identity echoes match", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(readbackEnvelope())) as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });

    await expect(adapter.readPromoAfterClaim!(request, "jwt-token")).resolves.toEqual({
      status: "found",
      promo: {
        upstreamCode: "239FFB",
        webUrl: "https://eng.moboreader.com/1M4mpB/239FFB",
        appUrl: "https://eng.moboreader.com/book/239FFB",
      },
    });
  });

  it("falls back to homeLink for webUrl when publicUrl is empty", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(readbackEnvelope({ publicUrl: "" }))) as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });

    await expect(adapter.readPromoAfterClaim!(request, "jwt-token")).resolves.toEqual({
      status: "found",
      promo: {
        upstreamCode: "239FFB",
        webUrl: "https://eng.moboreader.com/book/239FFB",
        appUrl: "https://eng.moboreader.com/book/239FFB",
      },
    });
  });

  it("returns found with null URLs for a code-only (PlotNovel-shaped) response — a URL is not required", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(readbackEnvelope({
      kocCode: "123456",
      publicUrl: "",
      homeLink: "",
      onlineUrl: "",
    }))) as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });

    await expect(adapter.readPromoAfterClaim!(request, "jwt-token")).resolves.toEqual({
      status: "found",
      promo: { upstreamCode: "123456", webUrl: null, appUrl: null },
    });
  });

  it("also treats a code-only response with the URL fields absent or null as found", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      status: true,
      code: 200,
      data: { agencyId: 3366, seriesId: "124235322", language: 3, projectType: 1, kocCode: "123456", publicUrl: null },
    })) as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });

    await expect(adapter.readPromoAfterClaim!(request, "jwt-token")).resolves.toEqual({
      status: "found",
      promo: { upstreamCode: "123456", webUrl: null, appUrl: null },
    });
  });

  it.each([
    ["empty string", { kocCode: "" }],
    ["whitespace only", { kocCode: "   " }],
    ["null", { kocCode: null }],
  ] as const)("returns missing when kocCode is %s (code not generated yet)", async (_label, overrides) => {
    const fetchImpl = vi.fn(async () => jsonResponse(readbackEnvelope(overrides))) as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });

    await expect(adapter.readPromoAfterClaim!(request, "jwt-token")).resolves.toEqual({ status: "missing" });
  });

  it("returns missing when kocCode is absent entirely", async () => {
    const envelope = readbackEnvelope();
    delete (envelope.data as Record<string, unknown>).kocCode;
    const fetchImpl = vi.fn(async () => jsonResponse(envelope)) as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });

    await expect(adapter.readPromoAfterClaim!(request, "jwt-token")).resolves.toEqual({ status: "missing" });
  });

  it.each(["agencyId", "seriesId", "language", "projectType"] as const)(
    "reports identity_field_missing when the %s echo is absent",
    async (field) => {
      const envelope = readbackEnvelope();
      delete (envelope.data as Record<string, unknown>)[field];
      const fetchImpl = vi.fn(async () => jsonResponse(envelope)) as unknown as typeof fetch;
      const adapter = createPromoLinkClaimAdapter({ fetchImpl });

      await expect(adapter.readPromoAfterClaim!(request, "jwt-token")).resolves.toEqual({
        status: "ambiguous",
        reason: "identity_field_missing",
      });
    },
  );

  it.each(["agencyId", "seriesId", "language", "projectType"] as const)(
    "reports identity_field_missing when the %s echo is blank or null",
    async (field) => {
      const fetchImpl = vi.fn(async () => jsonResponse(readbackEnvelope({ [field]: field === "seriesId" ? "  " : null }))) as unknown as typeof fetch;
      const adapter = createPromoLinkClaimAdapter({ fetchImpl });

      await expect(adapter.readPromoAfterClaim!(request, "jwt-token")).resolves.toEqual({
        status: "ambiguous",
        reason: "identity_field_missing",
      });
    },
  );

  it.each([
    ["agencyId", 9999],
    ["seriesId", "different-series"],
    ["language", 7],
    ["projectType", 2],
  ] as const)("reports identity_mismatch when the %s echo differs from the request, even with a code present", async (field, value) => {
    const fetchImpl = vi.fn(async () => jsonResponse(readbackEnvelope({ [field]: value }))) as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });

    await expect(adapter.readPromoAfterClaim!(request, "jwt-token")).resolves.toEqual({
      status: "ambiguous",
      reason: "identity_mismatch",
    });
  });

  it("accepts identity echoes whose JSON type differs from the request (string vs number)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(readbackEnvelope({
      agencyId: "3366",
      seriesId: 124235322,
      language: "3",
      projectType: "1",
    }))) as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });

    await expect(adapter.readPromoAfterClaim!(request, "jwt-token")).resolves.toMatchObject({ status: "found" });
  });

  it.each([
    ["status false", { status: false, code: 200, data: readbackEnvelope().data }],
    ["code 500", { status: true, code: 500, data: readbackEnvelope().data }],
    ["status string", { status: "true", code: 200, data: readbackEnvelope().data }],
    ["code string", { status: true, code: "200", data: readbackEnvelope().data }],
    ["status/code missing", { data: readbackEnvelope().data }],
  ] as const)("throws non-ambiguous malformed_payload when the outer envelope is not a success (%s)", async (_label, envelope) => {
    const fetchImpl = vi.fn(async () => jsonResponse(envelope)) as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });

    await expect(adapter.readPromoAfterClaim!(request, "jwt-token")).rejects.toMatchObject({
      code: "malformed_payload",
      retryable: false,
      ambiguous: false,
    } satisfies Partial<PromoLinkClaimAdapterError>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["null", null],
    ["array", [readbackEnvelope().data]],
    ["string", "oops"],
    ["missing", undefined],
  ] as const)("throws non-ambiguous malformed_payload when data is %s", async (_label, data) => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: true, code: 200, data })) as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });

    await expect(adapter.readPromoAfterClaim!(request, "jwt-token")).rejects.toMatchObject({
      code: "malformed_payload",
      retryable: false,
      ambiguous: false,
    } satisfies Partial<PromoLinkClaimAdapterError>);
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

  it("classifies an unparsable readback body as non-ambiguous", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
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
