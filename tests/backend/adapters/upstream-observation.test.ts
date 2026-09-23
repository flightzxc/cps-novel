// Phase 1 of the promo-link claim latency investigation
// ("上游请求观测补齐"): observation-only telemetry, added with zero
// behavior change, across both MoboReader adapters
// (`src/lib/adapters/moboreader.ts`, `src/lib/adapters/promo-link-claim.ts`)
// and their shared header-redaction boundary
// (`src/lib/adapters/upstream-observation.ts`). New test file — does not
// modify any pre-existing frozen assertion in
// `tests/backend/adapters/moboreader.test.ts`,
// `tests/backend/adapters/moboreader-upstream-rate-limit-policy.test.ts`,
// or `tests/backend/adapters/promo-link-claim.test.ts`.
import { describe, expect, it, vi } from "vitest";
import {
  MoboreaderAdapterError,
  PromoLinkClaimAdapterError,
  classifyClaimPromoFailure,
  createMoboreaderReadAdapter,
  createPromoLinkClaimAdapter,
  extractGatewayObservationHeaders,
  safeObserve,
  type ClaimPromoRequest,
  type UpstreamCallObservation,
} from "@/lib/adapters";
import { logUpstreamCallObservation } from "../../../worker/observability/upstream-call-log";

function fakeClock(startMs = 0) {
  let now = startMs;
  return {
    now: () => now,
    /** Must actually advance whatever clock `now` reads — a no-op sleep
     * would make gate-wait/latency spacing untestable. */
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
  };
}

/** A rate gate whose `wait()` advances the same fake clock the adapter's
 * `now` option reads, so `gateWaitMs` is exactly this value — not a real
 * timer, and not the production `createMoboreaderRateGate`. */
function fixedWaitRateGate(clock: ReturnType<typeof fakeClock>, waitMs: number) {
  return { wait: () => clock.sleep(waitMs) };
}

function listRequest() {
  return { name: "", orderType: 0, pageIndex: 1, pageSize: 20, projectType: 1 } as const;
}

const claimRequest: ClaimPromoRequest = {
  agencyId: 3366,
  seriesId: "124235322",
  projectType: 1,
  language: 3,
  name: "The Exact Target Title",
  offerType: "read",
};

function listBooksBody() {
  return { data: { totalCount: 0, list: [] } };
}

describe("extractGatewayObservationHeaders (redaction boundary)", () => {
  it("keeps only the ratelimit-pattern and exact-allowlisted headers, dropping everything else", () => {
    const headers = new Headers({
      "x-ratelimit-limit": "60",
      "x-ratelimit-remaining": "59",
      "ratelimit-reset": "30",
      "retry-after": "12",
      "x-kong-upstream-latency": "45",
      "x-kong-proxy-latency": "3",
      authorization: "Bearer top-secret-token",
      "set-cookie": "session=leak-me",
      "content-type": "application/json",
      "content-length": "128",
    });
    expect(extractGatewayObservationHeaders(headers)).toEqual({
      "x-ratelimit-limit": "60",
      "x-ratelimit-remaining": "59",
      "ratelimit-reset": "30",
      "retry-after": "12",
      "x-kong-upstream-latency": "45",
      "x-kong-proxy-latency": "3",
    });
  });

  it("never includes authorization or set-cookie, however they are cased", () => {
    const headers = new Headers({ Authorization: "Bearer x", "Set-Cookie": "a=b" });
    const result = extractGatewayObservationHeaders(headers);
    expect(Object.keys(result)).toHaveLength(0);
    expect(JSON.stringify(result).toLowerCase()).not.toContain("bearer");
    expect(JSON.stringify(result).toLowerCase()).not.toContain("a=b");
  });

  it("truncates an oversized header value instead of passing it through whole", () => {
    const headers = new Headers({ "x-ratelimit-limit": "9".repeat(500) });
    const result = extractGatewayObservationHeaders(headers);
    expect(result["x-ratelimit-limit"].length).toBeLessThan(500);
    expect(result["x-ratelimit-limit"].length).toBeGreaterThan(0);
  });

  it("degrades to an empty set instead of throwing when `headers` lacks forEach (pre-existing test-double shape)", () => {
    const notARealHeaders = { get: () => null } as unknown as Headers;
    expect(extractGatewayObservationHeaders(notARealHeaders)).toEqual({});
  });

  it("returns no headers for a plain object with no matching keys", () => {
    const headers = new Headers({ "content-type": "application/json" });
    expect(extractGatewayObservationHeaders(headers)).toEqual({});
  });
});

describe("createMoboreaderReadAdapter — onUpstreamObservation (legacy default path, no upstreamRateLimitPolicy)", () => {
  it("defaults to no-op: omitting the option changes nothing about the resolved value or attempt count", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(listBooksBody()), { status: 200 }));
    const adapter = createMoboreaderReadAdapter({ fetchImpl });
    await expect(adapter.listBooks(listRequest(), "secret-token")).resolves.toMatchObject({ totalCount: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("emits one ok event with endpoint/httpStatus/gatewayHeaders for a successful getlistpc call", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(listBooksBody()), {
      status: 200,
      headers: { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "59", authorization: "must-not-appear" },
    }));
    const observations: UpstreamCallObservation[] = [];
    const adapter = createMoboreaderReadAdapter({ fetchImpl, onUpstreamObservation: (o) => observations.push(o) });
    await adapter.listBooks(listRequest(), "secret-token");

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      endpoint: "getlistpc",
      httpStatus: 200,
      outcome: "ok",
      gatewayHeaders: { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "59" },
    });
    expect(observations[0].gatewayHeaders).not.toHaveProperty("authorization");
    expect(typeof observations[0].latencyMs).toBe("number");
    expect(observations[0].latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof observations[0].gateWaitMs).toBe("number");
    expect(observations[0].gateWaitMs).toBeGreaterThanOrEqual(0);
  });

  it("reports the correct short endpoint name for getbydataid and getchapterinfo, never a path or URL", async () => {
    const observations: UpstreamCallObservation[] = [];
    const materialFetch = vi.fn(async () => new Response(JSON.stringify({ data: { list: [] } }), { status: 200 }));
    const materialAdapter = createMoboreaderReadAdapter({ fetchImpl: materialFetch, onUpstreamObservation: (o) => observations.push(o) });
    await materialAdapter.fetchBookMaterial(
      { agencyId: "a", dataId: "d", projectType: 1, language: 1, materialType: 1 },
      "token",
    );

    const chapterFetch = vi.fn(async () => new Response(JSON.stringify({ data: { bookId: "b", currentLanguage: 1, chapterList: [] } }), { status: 200 }));
    const chapterAdapter = createMoboreaderReadAdapter({ fetchImpl: chapterFetch, onUpstreamObservation: (o) => observations.push(o) });
    await chapterAdapter.fetchPreviewChapters({ agencyId: "a", seriesId: "s", projectType: 1, language: 1 }, "token");

    expect(observations.map((o) => o.endpoint)).toEqual(["getbydataid", "getchapterinfo"]);
    for (const observation of observations) {
      expect(observation.endpoint).not.toContain("/");
      expect(observation.endpoint).not.toContain("http");
    }
  });

  it("emits an http_error event with the response status on a non-retryable HTTP failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("unlogged", { status: 401 }));
    const observations: UpstreamCallObservation[] = [];
    const adapter = createMoboreaderReadAdapter({ fetchImpl, maxAttempts: 1, onUpstreamObservation: (o) => observations.push(o) });
    await expect(adapter.listBooks(listRequest(), "token")).rejects.toBeInstanceOf(MoboreaderAdapterError);

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ endpoint: "getlistpc", httpStatus: 401, outcome: "http_error" });
  });

  it("emits one http_error event per retried attempt, not just the final one", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("unlogged", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(listBooksBody()), { status: 200 }));
    const observations: UpstreamCallObservation[] = [];
    const adapter = createMoboreaderReadAdapter({
      fetchImpl,
      sleep: async () => undefined,
      onUpstreamObservation: (o) => observations.push(o),
    });
    await adapter.listBooks(listRequest(), "token");

    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({ outcome: "http_error", httpStatus: 503 });
    expect(observations[1]).toMatchObject({ outcome: "ok", httpStatus: 200 });
  });

  it("emits a timeout event (httpStatus null) when the per-attempt deadline fires", async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const observations: UpstreamCallObservation[] = [];
    const adapter = createMoboreaderReadAdapter({
      fetchImpl: fetchImpl as typeof fetch,
      timeoutMs: 5,
      maxAttempts: 1,
      onUpstreamObservation: (o) => observations.push(o),
    });
    await expect(adapter.listBooks(listRequest(), "token")).rejects.toMatchObject({ code: "request_timeout" });

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ endpoint: "getlistpc", httpStatus: null, outcome: "timeout" });
    expect(observations[0].gatewayHeaders).toEqual({});
  });

  it("emits a transport_error event (httpStatus null) for a raw fetch failure that isn't a timeout", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("network reset"); });
    const observations: UpstreamCallObservation[] = [];
    const adapter = createMoboreaderReadAdapter({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxAttempts: 1,
      sleep: async () => undefined,
      onUpstreamObservation: (o) => observations.push(o),
    });
    await expect(adapter.listBooks(listRequest(), "token")).rejects.toMatchObject({ code: "transport_error" });

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ httpStatus: null, outcome: "transport_error" });
  });

  it("still reports outcome 'ok' for a 200 response whose body fails to parse as JSON (wire-protocol succeeded)", async () => {
    const fetchImpl = vi.fn(async () => new Response("not-json", { status: 200 }));
    const observations: UpstreamCallObservation[] = [];
    const adapter = createMoboreaderReadAdapter({ fetchImpl, onUpstreamObservation: (o) => observations.push(o) });
    await expect(adapter.listBooks(listRequest(), "token")).rejects.toMatchObject({ code: "malformed_payload" });

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ httpStatus: 200, outcome: "ok" });
  });

  it("measures gateWaitMs from the injected rate gate and latencyMs from the dispatch itself, independently", async () => {
    const clock = fakeClock();
    const fetchImpl = vi.fn(async () => {
      await clock.sleep(700);
      return new Response(JSON.stringify(listBooksBody()), { status: 200 });
    });
    const observations: UpstreamCallObservation[] = [];
    const adapter = createMoboreaderReadAdapter({
      fetchImpl,
      rateGate: fixedWaitRateGate(clock, 300),
      now: clock.now,
      onUpstreamObservation: (o) => observations.push(o),
    });
    await adapter.listBooks(listRequest(), "token");

    expect(observations).toHaveLength(1);
    expect(observations[0].gateWaitMs).toBe(300);
    expect(observations[0].latencyMs).toBe(700);
  });

  it("never includes the credential token, the request body, or the response body in the observation", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: {
        totalCount: 1,
        list: [{
          id: "book", seriesId: "s", seriesName: "Sensitive Title",
          language: 1, kocCode: "SECRET-CODE",
        }],
      },
    }), { status: 200 }));
    const observations: UpstreamCallObservation[] = [];
    const adapter = createMoboreaderReadAdapter({ fetchImpl, onUpstreamObservation: (o) => observations.push(o) });
    await adapter.listBooks({ ...listRequest(), name: "Sensitive Title" }, "eyJ.super.secret");

    const serialized = JSON.stringify(observations);
    expect(serialized).not.toContain("eyJ.super.secret");
    expect(serialized).not.toContain("Sensitive Title");
    expect(serialized).not.toContain("SECRET-CODE");
  });
});

describe("createMoboreaderReadAdapter — onUpstreamObservation (RC-3 rate-limit-aware path, upstreamRateLimitPolicy supplied)", () => {
  it("emits ok/http_error/timeout/transport_error identically to the legacy path once activated", async () => {
    const observations: UpstreamCallObservation[] = [];
    const okFetch = vi.fn(async () => new Response(JSON.stringify(listBooksBody()), { status: 200 }));
    const okAdapter = createMoboreaderReadAdapter({
      fetchImpl: okFetch,
      upstreamRateLimitPolicy: {},
      onUpstreamObservation: (o) => observations.push(o),
    });
    await okAdapter.listBooks(listRequest(), "token");
    expect(observations.at(-1)).toMatchObject({ outcome: "ok", httpStatus: 200, endpoint: "getlistpc" });

    const httpErrorFetch = vi.fn(async () => new Response("nope", { status: 401 }));
    const httpErrorAdapter = createMoboreaderReadAdapter({
      fetchImpl: httpErrorFetch,
      upstreamRateLimitPolicy: {},
      onUpstreamObservation: (o) => observations.push(o),
    });
    await expect(httpErrorAdapter.listBooks(listRequest(), "token")).rejects.toBeInstanceOf(MoboreaderAdapterError);
    expect(observations.at(-1)).toMatchObject({ outcome: "http_error", httpStatus: 401 });

    const timeoutFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const timeoutAdapter = createMoboreaderReadAdapter({
      fetchImpl: timeoutFetch as typeof fetch,
      timeoutMs: 5,
      upstreamRateLimitPolicy: { maxAttempts: 1, totalBudgetMs: 1 },
      onUpstreamObservation: (o) => observations.push(o),
    });
    await expect(timeoutAdapter.listBooks(listRequest(), "token")).rejects.toBeTruthy();
    expect(observations.at(-1)).toMatchObject({ outcome: "timeout", httpStatus: null });

    const transportFetch = vi.fn(async () => { throw new TypeError("reset"); });
    const transportAdapter = createMoboreaderReadAdapter({
      fetchImpl: transportFetch as unknown as typeof fetch,
      upstreamRateLimitPolicy: { maxAttempts: 1, totalBudgetMs: 1 },
      onUpstreamObservation: (o) => observations.push(o),
    });
    await expect(transportAdapter.listBooks(listRequest(), "token")).rejects.toBeTruthy();
    expect(observations.at(-1)).toMatchObject({ outcome: "transport_error", httpStatus: null });
  });

  it("still measures gateWaitMs via the injected rate gate under the rate-limit-aware path", async () => {
    const clock = fakeClock();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(listBooksBody()), { status: 200 }));
    const observations: UpstreamCallObservation[] = [];
    const adapter = createMoboreaderReadAdapter({
      fetchImpl,
      rateGate: fixedWaitRateGate(clock, 1_100),
      now: clock.now,
      upstreamRateLimitPolicy: {},
      onUpstreamObservation: (o) => observations.push(o),
    });
    await adapter.listBooks(listRequest(), "token");
    expect(observations[0].gateWaitMs).toBe(1_100);
  });
});

describe("createPromoLinkClaimAdapter — onUpstreamObservation", () => {
  function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  }

  it("defaults to no-op: omitting the option changes nothing about the resolved value", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      status: true, code: 200, data: { kocCode: "239FFB", publicUrl: null, homeLink: null },
    })) as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });
    await expect(adapter.claimPromo(claimRequest, "jwt-token")).resolves.toMatchObject({ upstreamCode: "239FFB" });
  });

  it("reports endpoint 'getcode' for claimPromo and 'getlistpc' for readPromoAfterClaim, with real gateway headers", async () => {
    const observations: UpstreamCallObservation[] = [];
    // Attach a gateway header to prove it survives claimPromo's dispatch too.
    const claimFetchWithHeaders = vi.fn(async () => new Response(JSON.stringify({
      status: true, code: 200, data: { kocCode: "239FFB", publicUrl: null, homeLink: null },
    }), { status: 200, headers: { "x-ratelimit-limit": "30" } })) as unknown as typeof fetch;
    const claimAdapter = createPromoLinkClaimAdapter({ fetchImpl: claimFetchWithHeaders, onUpstreamObservation: (o) => observations.push(o) });
    await claimAdapter.claimPromo(claimRequest, "jwt-token");

    const readbackFetch = vi.fn(async () => jsonResponse({
      status: true, code: 200, data: { totalCount: 0, list: [] },
    })) as unknown as typeof fetch;
    const readbackAdapter = createPromoLinkClaimAdapter({ fetchImpl: readbackFetch, onUpstreamObservation: (o) => observations.push(o) });
    await readbackAdapter.readPromoAfterClaim!(claimRequest, "jwt-token");

    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({ endpoint: "getcode", outcome: "ok", gatewayHeaders: { "x-ratelimit-limit": "30" } });
    expect(observations[1]).toMatchObject({ endpoint: "getlistpc", outcome: "ok" });
  });

  it("emits http_error/timeout/transport_error for claimPromo, matching the frozen no-retry contract", async () => {
    const observations: UpstreamCallObservation[] = [];

    const httpErrorFetch = vi.fn(async () => jsonResponse({ message: "err" }, 503)) as unknown as typeof fetch;
    const httpErrorAdapter = createPromoLinkClaimAdapter({ fetchImpl: httpErrorFetch, onUpstreamObservation: (o) => observations.push(o) });
    await expect(httpErrorAdapter.claimPromo(claimRequest, "jwt-token")).rejects.toBeInstanceOf(PromoLinkClaimAdapterError);
    expect(observations.at(-1)).toMatchObject({ endpoint: "getcode", outcome: "http_error", httpStatus: 503 });

    const timeoutFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })) as unknown as typeof fetch;
    const timeoutAdapter = createPromoLinkClaimAdapter({ fetchImpl: timeoutFetch, timeoutMs: 5, onUpstreamObservation: (o) => observations.push(o) });
    await expect(timeoutAdapter.claimPromo(claimRequest, "jwt-token")).rejects.toMatchObject({ code: "request_timeout" });
    expect(observations.at(-1)).toMatchObject({ outcome: "timeout", httpStatus: null });

    const transportFetch = vi.fn(async () => { throw new TypeError("reset"); }) as unknown as typeof fetch;
    const transportAdapter = createPromoLinkClaimAdapter({ fetchImpl: transportFetch, onUpstreamObservation: (o) => observations.push(o) });
    await expect(transportAdapter.claimPromo(claimRequest, "jwt-token")).rejects.toMatchObject({ code: "transport_error" });
    expect(observations.at(-1)).toMatchObject({ outcome: "transport_error", httpStatus: null });
  });

  it("never emits an observation for the pre-dispatch signal.aborted short-circuit (no gate wait, no network call happened)", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const observations: UpstreamCallObservation[] = [];
    const adapter = createPromoLinkClaimAdapter({ fetchImpl, onUpstreamObservation: (o) => observations.push(o) });
    const controller = new AbortController();
    controller.abort();

    await expect(adapter.claimPromo(claimRequest, "jwt-token", controller.signal)).rejects.toBeInstanceOf(PromoLinkClaimAdapterError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(observations).toHaveLength(0);
  });

  it("measures gateWaitMs from the injected rate gate for the claim dispatch", async () => {
    const clock = fakeClock();
    const fetchImpl = vi.fn(async () => jsonResponse({
      status: true, code: 200, data: { kocCode: "239FFB", publicUrl: null, homeLink: null },
    })) as unknown as typeof fetch;
    const observations: UpstreamCallObservation[] = [];
    const adapter = createPromoLinkClaimAdapter({
      fetchImpl,
      rateGate: fixedWaitRateGate(clock, 1_100),
      now: clock.now,
      onUpstreamObservation: (o) => observations.push(o),
    });
    await adapter.claimPromo(claimRequest, "jwt-token");
    expect(observations[0].gateWaitMs).toBe(1_100);
  });

  it("never includes the token or the promo code in the observation", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      status: true, code: 200, data: { kocCode: "MUST-NOT-LEAK", publicUrl: "https://example/MUST-NOT-LEAK", homeLink: null },
    })) as unknown as typeof fetch;
    const observations: UpstreamCallObservation[] = [];
    const adapter = createPromoLinkClaimAdapter({ fetchImpl, onUpstreamObservation: (o) => observations.push(o) });
    await adapter.claimPromo(claimRequest, "eyJ.claim.jwt");

    const serialized = JSON.stringify(observations);
    expect(serialized).not.toContain("eyJ.claim.jwt");
    expect(serialized).not.toContain("MUST-NOT-LEAK");
  });
});

describe("parseClaimResponse envelope diagnostics (PromoLinkClaimAdapterError.envelopeStatus/envelopeCode)", () => {
  function claimAdapterWithBody(body: unknown) {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    return createPromoLinkClaimAdapter({ fetchImpl });
  }

  it("captures a boolean envelopeStatus and numeric envelopeCode verbatim for a non-success envelope", async () => {
    const adapter = claimAdapterWithBody({ status: false, code: 500, message: "internal error, do not surface", data: null });
    let error: unknown;
    try {
      await adapter.claimPromo(claimRequest, "jwt-token");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PromoLinkClaimAdapterError);
    const claimError = error as PromoLinkClaimAdapterError;
    expect(claimError.envelopeStatus).toBe(false);
    expect(claimError.envelopeCode).toBe(500);
    expect(claimError.message).not.toContain("internal error");

    const classified = classifyClaimPromoFailure(error);
    expect(classified).toMatchObject({ failureCategory: "malformed_payload", ambiguous: true, envelopeStatus: false, envelopeCode: 500 });
  });

  it("reduces a non-primitive envelope status/code to a type descriptor instead of passing the raw value through", async () => {
    const adapter = claimAdapterWithBody({ status: { nested: "object" }, code: ["array"], data: null });
    let error: unknown;
    try {
      await adapter.claimPromo(claimRequest, "jwt-token");
    } catch (caught) {
      error = caught;
    }
    const claimError = error as PromoLinkClaimAdapterError;
    expect(claimError.envelopeStatus).toBe("typeof object");
    expect(claimError.envelopeCode).toBe("typeof object");
    expect(JSON.stringify(claimError)).not.toContain("nested");
  });

  it("truncates an oversized string envelope code instead of passing it through whole", async () => {
    const longCode = "E".repeat(1_000);
    const adapter = claimAdapterWithBody({ status: true, code: longCode, data: null });
    let error: unknown;
    try {
      await adapter.claimPromo(claimRequest, "jwt-token");
    } catch (caught) {
      error = caught;
    }
    const claimError = error as PromoLinkClaimAdapterError;
    expect(typeof claimError.envelopeCode).toBe("string");
    expect((claimError.envelopeCode as string).length).toBeLessThan(1_000);
  });

  it("leaves envelopeStatus/envelopeCode null for every non-envelope failure (HTTP error, timeout, transport, readback)", async () => {
    const httpErrorAdapter = createPromoLinkClaimAdapter({
      fetchImpl: vi.fn(async () => new Response("err", { status: 503 })) as unknown as typeof fetch,
    });
    let error: unknown;
    try {
      await httpErrorAdapter.claimPromo(claimRequest, "jwt-token");
    } catch (caught) {
      error = caught;
    }
    const classified = classifyClaimPromoFailure(error);
    expect(classified.envelopeStatus).toBeNull();
    expect(classified.envelopeCode).toBeNull();

    // A non-PromoLinkClaimAdapterError (defensive branch) also reports null,
    // never `undefined`, keeping the shape stable for JSON storage.
    const genericClassified = classifyClaimPromoFailure(new Error("unexpected"));
    expect(genericClassified.envelopeStatus).toBeNull();
    expect(genericClassified.envelopeCode).toBeNull();
  });

  it("does not populate envelope diagnostics for the readback parser's malformed-envelope error (claim-only diagnostic)", async () => {
    const readbackAdapter = createPromoLinkClaimAdapter({
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ status: false, code: 500, data: null }), { status: 200 })) as unknown as typeof fetch,
    });
    let error: unknown;
    try {
      await readbackAdapter.readPromoAfterClaim!(claimRequest, "jwt-token");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PromoLinkClaimAdapterError);
    expect((error as PromoLinkClaimAdapterError).envelopeStatus).toBeNull();
    expect((error as PromoLinkClaimAdapterError).envelopeCode).toBeNull();
  });
});

describe("safeObserve (a throwing onUpstreamObservation must never change the adapter's own result or error)", () => {
  // Opus review of b6b5fe9: before this fix, every emission site called
  // `onUpstreamObservation(...)` directly inside the request's own try
  // block. Today's production sink already guards itself, so nothing
  // breaks today — but a *future* callback that throws would have its
  // exception land in the surrounding `catch`, which cannot tell a
  // telemetry failure apart from a real transport failure. On `getcode` —
  // a non-idempotent mutation whose ambiguous-error path means "never call
  // getcode again, go to readback-only recovery" — that would turn
  // "upstream already issued a code, the callback just threw" into "result
  // unknown" → manual review. `safeObserve` is the fix; these tests prove
  // it holds under a callback engineered to throw on every single call.

  function throwingObservation(): never {
    throw new Error("observation callback exploded");
  }

  it("safeObserve itself swallows a throwing callback and still lets a non-throwing one see the built event", () => {
    expect(() => safeObserve(throwingObservation, () => ({
      endpoint: "getcode",
      httpStatus: 200,
      outcome: "ok",
      latencyMs: 0,
      gateWaitMs: 0,
      gatewayHeaders: {},
    }))).not.toThrow();

    const seen: UpstreamCallObservation[] = [];
    safeObserve((o) => seen.push(o), () => ({
      endpoint: "getlistpc",
      httpStatus: 200,
      outcome: "ok",
      latencyMs: 1,
      gateWaitMs: 2,
      gatewayHeaders: {},
    }));
    expect(seen).toHaveLength(1);
    expect(seen[0].endpoint).toBe("getlistpc");
  });

  it("safeObserve also swallows an exception thrown while building the event (e.g. from header extraction)", () => {
    const callback = vi.fn();
    expect(() => safeObserve(callback, () => { throw new Error("boom while building"); })).not.toThrow();
    expect(callback).not.toHaveBeenCalled();
  });

  it("getcode success still resolves with the parsed kocCode result — not an ambiguous/manual-review error — when the observation callback throws", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      status: true, code: 200, data: { kocCode: "239FFB", publicUrl: null, homeLink: null },
    }), { status: 200 })) as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl, onUpstreamObservation: throwingObservation });

    await expect(adapter.claimPromo(claimRequest, "jwt-token")).resolves.toEqual({
      upstreamCode: "239FFB",
      webUrl: null,
      appUrl: null,
    });
  });

  it("getlistpc (readback) success still resolves normally when the observation callback throws", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      status: true, code: 200, data: { totalCount: 0, list: [] },
    }), { status: 200 })) as unknown as typeof fetch;
    const adapter = createPromoLinkClaimAdapter({ fetchImpl, onUpstreamObservation: throwingObservation });

    await expect(adapter.readPromoAfterClaim!(claimRequest, "jwt-token")).resolves.toEqual({
      status: "target_not_located",
      reason: "title_no_match",
      totalCount: 0,
    });
  });

  it("a getcode HTTP error still throws the original error type/classification (ambiguous flag unchanged) when the observation callback throws", async () => {
    const fetchImpl = vi.fn(async () => new Response("err", { status: 503 })) as unknown as typeof fetch;
    const withoutObservation = createPromoLinkClaimAdapter({ fetchImpl });
    const withThrowingObservation = createPromoLinkClaimAdapter({ fetchImpl, onUpstreamObservation: throwingObservation });

    const [baseline, mutated] = await Promise.all([
      withoutObservation.claimPromo(claimRequest, "jwt-token").catch((e) => e),
      withThrowingObservation.claimPromo(claimRequest, "jwt-token").catch((e) => e),
    ]);
    expect(baseline).toBeInstanceOf(PromoLinkClaimAdapterError);
    expect(mutated).toBeInstanceOf(PromoLinkClaimAdapterError);
    expect({ code: mutated.code, status: mutated.status, retryable: mutated.retryable, ambiguous: mutated.ambiguous })
      .toEqual({ code: baseline.code, status: baseline.status, retryable: baseline.retryable, ambiguous: baseline.ambiguous });
    expect(mutated).toMatchObject({ code: "upstream_http_error", status: 503, retryable: false, ambiguous: true });
  });

  it("a getcode timeout still throws request_timeout with the same ambiguous flag when the observation callback throws", async () => {
    function hangingFetch(): typeof fetch {
      return (async (_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      })) as unknown as typeof fetch;
    }
    const withoutObservation = createPromoLinkClaimAdapter({ fetchImpl: hangingFetch(), timeoutMs: 5 });
    const withThrowingObservation = createPromoLinkClaimAdapter({
      fetchImpl: hangingFetch(), timeoutMs: 5, onUpstreamObservation: throwingObservation,
    });

    const [baseline, mutated] = await Promise.all([
      withoutObservation.claimPromo(claimRequest, "jwt-token").catch((e) => e),
      withThrowingObservation.claimPromo(claimRequest, "jwt-token").catch((e) => e),
    ]);
    expect(baseline).toBeInstanceOf(PromoLinkClaimAdapterError);
    expect(mutated).toBeInstanceOf(PromoLinkClaimAdapterError);
    expect({ code: mutated.code, retryable: mutated.retryable, ambiguous: mutated.ambiguous })
      .toEqual({ code: baseline.code, retryable: baseline.retryable, ambiguous: baseline.ambiguous });
    expect(mutated).toMatchObject({ code: "request_timeout", retryable: false, ambiguous: true });
  });

  it("MoboReader getlistpc success still resolves normally when the observation callback throws (legacy path)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(listBooksBody()), { status: 200 }));
    const adapter = createMoboreaderReadAdapter({ fetchImpl, onUpstreamObservation: throwingObservation });
    await expect(adapter.listBooks(listRequest(), "token")).resolves.toMatchObject({ totalCount: 0 });
  });

  it("MoboReader getlistpc HTTP error still throws the same classification when the observation callback throws (legacy path)", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    const withoutObservation = createMoboreaderReadAdapter({ fetchImpl, maxAttempts: 1 });
    const withThrowingObservation = createMoboreaderReadAdapter({ fetchImpl, maxAttempts: 1, onUpstreamObservation: throwingObservation });

    const [baseline, mutated] = await Promise.all([
      withoutObservation.listBooks(listRequest(), "token").catch((e) => e),
      withThrowingObservation.listBooks(listRequest(), "token").catch((e) => e),
    ]);
    expect(baseline).toBeInstanceOf(MoboreaderAdapterError);
    expect(mutated).toBeInstanceOf(MoboreaderAdapterError);
    expect({ code: mutated.code, status: mutated.status, retryable: mutated.retryable })
      .toEqual({ code: baseline.code, status: baseline.status, retryable: baseline.retryable });
  });
});

describe("logUpstreamCallObservation (production sink wired at worker/handlers/moboreader.ts and worker/handlers/promo-link-claim.ts)", () => {
  it("writes exactly one structured JSON line with the frozen schemaVersion/event shape", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      logUpstreamCallObservation({
        endpoint: "getcode",
        httpStatus: 200,
        outcome: "ok",
        latencyMs: 123,
        gateWaitMs: 456,
        gatewayHeaders: { "x-ratelimit-limit": "60" },
      });
      expect(logSpy).toHaveBeenCalledTimes(1);
      const line = logSpy.mock.calls[0][0] as string;
      expect(JSON.parse(line)).toEqual({
        schemaVersion: 1,
        event: "upstream_call",
        endpoint: "getcode",
        httpStatus: 200,
        outcome: "ok",
        latencyMs: 123,
        gateWaitMs: 456,
        gatewayHeaders: { "x-ratelimit-limit": "60" },
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("never throws even if console.log itself fails", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => { throw new Error("stdout closed"); });
    try {
      expect(() => logUpstreamCallObservation({
        endpoint: "getlistpc",
        httpStatus: null,
        outcome: "transport_error",
        latencyMs: 1,
        gateWaitMs: 0,
        gatewayHeaders: {},
      })).not.toThrow();
    } finally {
      logSpy.mockRestore();
    }
  });
});
