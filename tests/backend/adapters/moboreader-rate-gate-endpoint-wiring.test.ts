// RC-4 (阶段 4-A): proves BOTH adapters (`src/lib/adapters/moboreader.ts`,
// `src/lib/adapters/promo-link-claim.ts`) actually thread a per-endpoint
// rate gate correctly — pass the short logical endpoint name to
// `rateGate.wait(endpoint)`, call `rateGate.observe?.(endpoint, {...})`
// with the SAME allowlisted headers the observation event carries, and
// surface the gate's wait-info breakdown on the `upstream_call`
// observation event.
//
// New test file — does not modify any pre-existing frozen assertion in
// `tests/backend/adapters/moboreader.test.ts`,
// `tests/backend/adapters/promo-link-claim.test.ts`,
// `tests/backend/adapters/moboreader-upstream-rate-limit-policy.test.ts`,
// or `tests/backend/adapters/promo-link-claim-rate-gate.test.ts`.
import { describe, expect, it, vi } from "vitest";
import {
  createMoboreaderReadAdapter,
  createPromoLinkClaimAdapter,
  type ClaimPromoRequest,
  type MoboreaderRateGate,
  type MoboreaderRateGateObserveInfo,
  type UpstreamCallObservation,
} from "@/lib/adapters";

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

function recordingGate(): {
  gate: MoboreaderRateGate;
  waits: Array<string | undefined>;
  observations: Array<{ endpoint: string; info: MoboreaderRateGateObserveInfo }>;
} {
  const waits: Array<string | undefined> = [];
  const observations: Array<{ endpoint: string; info: MoboreaderRateGateObserveInfo }> = [];
  const gate: MoboreaderRateGate = {
    wait: async (endpoint?: string) => {
      waits.push(endpoint);
      return { endpointGateWaitMs: 111, hostGateWaitMs: 22, remainingBeforeDispatch: 33 };
    },
    observe: (endpoint, info) => {
      observations.push({ endpoint, info });
    },
  };
  return { gate, waits, observations };
}

describe("createMoboreaderReadAdapter: RC-4 endpoint wiring", () => {
  it("passes the short logical endpoint name (not the raw path) to rateGate.wait()", async () => {
    const { gate, waits } = recordingGate();
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { list: [], totalCount: 0 } }));
    const adapter = createMoboreaderReadAdapter({ fetchImpl, rateGate: gate });
    await adapter.listBooks({ name: "", orderType: 0, pageIndex: 1, pageSize: 100, projectType: 1 }, "token");
    expect(waits).toEqual(["getlistpc"]);
  });

  it("calls observe() with the response status and the SAME allowlisted headers the observation event carries", async () => {
    const { gate, observations } = recordingGate();
    const seen: UpstreamCallObservation[] = [];
    const fetchImpl = vi.fn(async () => jsonResponse(
      { data: { list: [], totalCount: 0 } }, 200, { "x-ratelimit-remaining": "42", authorization: "should-never-appear" },
    ));
    const adapter = createMoboreaderReadAdapter({
      fetchImpl, rateGate: gate, onUpstreamObservation: (o) => seen.push(o),
    });
    await adapter.listBooks({ name: "", orderType: 0, pageIndex: 1, pageSize: 100, projectType: 1 }, "token");
    expect(observations).toHaveLength(1);
    expect(observations[0].endpoint).toBe("getlistpc");
    expect(observations[0].info.httpStatus).toBe(200);
    expect(observations[0].info.gatewayHeaders).toEqual(seen[0].gatewayHeaders);
    expect(observations[0].info.gatewayHeaders).toEqual({ "x-ratelimit-remaining": "42" });
    expect(observations[0].info.gatewayHeaders).not.toHaveProperty("authorization");
  });

  it("surfaces the gate's wait-info breakdown on the observation event's new fields", async () => {
    const { gate } = recordingGate();
    const seen: UpstreamCallObservation[] = [];
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { list: [], totalCount: 0 } }));
    const adapter = createMoboreaderReadAdapter({ fetchImpl, rateGate: gate, onUpstreamObservation: (o) => seen.push(o) });
    await adapter.listBooks({ name: "", orderType: 0, pageIndex: 1, pageSize: 100, projectType: 1 }, "token");
    expect(seen[0]).toMatchObject({ endpointGateWaitMs: 111, hostGateWaitMs: 22, remainingBeforeDispatch: 33 });
  });

  it("a gate whose wait() resolves to undefined (legacy/no-op shape) reports null for the new fields, not a crash", async () => {
    const seen: UpstreamCallObservation[] = [];
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { list: [], totalCount: 0 } }));
    const legacyShapedGate: MoboreaderRateGate = { wait: async () => undefined };
    const adapter = createMoboreaderReadAdapter({ fetchImpl, rateGate: legacyShapedGate, onUpstreamObservation: (o) => seen.push(o) });
    await adapter.listBooks({ name: "", orderType: 0, pageIndex: 1, pageSize: 100, projectType: 1 }, "token");
    expect(seen[0]).toMatchObject({ endpointGateWaitMs: null, hostGateWaitMs: null, remainingBeforeDispatch: null });
  });

  it("calls observe() for an http_error response too (needed for 429 cooldown / remaining shadow to update)", async () => {
    const { gate, observations } = recordingGate();
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 429, headers: { "retry-after": "5" } }));
    const adapter = createMoboreaderReadAdapter({ fetchImpl, rateGate: gate, maxAttempts: 1 });
    await expect(adapter.listBooks({ name: "", orderType: 0, pageIndex: 1, pageSize: 100, projectType: 1 }, "token")).rejects.toThrow();
    expect(observations).toHaveLength(1);
    expect(observations[0].info.httpStatus).toBe(429);
  });

  it("does NOT call observe() on a transport error / timeout (no response, nothing to feed the gate)", async () => {
    const { gate, observations } = recordingGate();
    const fetchImpl = vi.fn(async () => { throw new Error("network down"); });
    const adapter = createMoboreaderReadAdapter({ fetchImpl, rateGate: gate, maxAttempts: 1 });
    await expect(adapter.listBooks({ name: "", orderType: 0, pageIndex: 1, pageSize: 100, projectType: 1 }, "token")).rejects.toThrow();
    expect(observations).toHaveLength(0);
  });

  it("fetchBookMaterial/fetchPreviewChapters pass their own short endpoint names, not getlistpc's", async () => {
    const materialGate = recordingGate();
    const materialFetch = vi.fn(async () => jsonResponse({ data: { list: [{ dataId: "d", seriesId: "s" }] } }));
    const materialAdapter = createMoboreaderReadAdapter({ fetchImpl: materialFetch, rateGate: materialGate.gate });
    await materialAdapter.fetchBookMaterial({ agencyId: "a", dataId: "d", projectType: 1, language: 2, materialType: 1 }, "token");
    expect(materialGate.waits).toEqual(["getbydataid"]);

    const chapterGate = recordingGate();
    const chapterFetch = vi.fn(async () => jsonResponse({ data: { bookId: "b", currentLanguage: "en", chapterList: [] } }));
    const chapterAdapter = createMoboreaderReadAdapter({ fetchImpl: chapterFetch, rateGate: chapterGate.gate });
    await chapterAdapter.fetchPreviewChapters({ agencyId: "a", seriesId: "s", projectType: 1, language: 2 }, "token");
    expect(chapterGate.waits).toEqual(["getchapterinfo"]);
  });

  it("under the RC-3 rate-limit-aware retry path, every retry attempt also passes the endpoint to wait()", async () => {
    const { gate, waits } = recordingGate();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("err", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ data: { list: [], totalCount: 0 } }));
    const adapter = createMoboreaderReadAdapter({
      fetchImpl, rateGate: gate, sleep: async () => undefined,
      upstreamRateLimitPolicy: { now: () => 0, random: () => 0 },
    });
    await adapter.listBooks({ name: "", orderType: 0, pageIndex: 1, pageSize: 100, projectType: 1 }, "token");
    expect(waits).toEqual(["getlistpc", "getlistpc"]);
  });

  // 2026-09-26 Opus 复核 3rd round，必改2：闸门等待结束后必须再检查一次中止
  // 信号，不能只在等待前查一次——RC-4 后冷却可达数十秒，等待窗口远大于
  // pre-RC-4 的 1.5 秒。
  describe("[Opus fix 必改2] re-checks the abort signal after wait() resolves, before ever dispatching fetch", () => {
    it("[mutation target] legacy retry path: abort fired DURING the gate wait -> fetch never called, non-retryable, non-ambiguous-shaped error", async () => {
      const controller = new AbortController();
      const fetchImpl = vi.fn(async () => jsonResponse({ data: { list: [], totalCount: 0 } }));
      const abortDuringWaitGate: MoboreaderRateGate = {
        wait: async () => { controller.abort(); return undefined; },
      };
      const adapter = createMoboreaderReadAdapter({ fetchImpl, rateGate: abortDuringWaitGate });
      await expect(
        adapter.listBooks({ name: "", orderType: 0, pageIndex: 1, pageSize: 100, projectType: 1 }, "token", controller.signal),
      ).rejects.toMatchObject({ code: "transport_error", retryable: false });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("[mutation target] RC-3 rate-limit-aware path: abort fired DURING the gate wait -> fetch never called", async () => {
      const controller = new AbortController();
      const fetchImpl = vi.fn(async () => jsonResponse({ data: { list: [], totalCount: 0 } }));
      const abortDuringWaitGate: MoboreaderRateGate = {
        wait: async () => { controller.abort(); return undefined; },
      };
      const adapter = createMoboreaderReadAdapter({
        fetchImpl, rateGate: abortDuringWaitGate,
        upstreamRateLimitPolicy: { now: () => 0, random: () => 0 },
      });
      await expect(
        adapter.listBooks({ name: "", orderType: 0, pageIndex: 1, pageSize: 100, projectType: 1 }, "token", controller.signal),
      ).rejects.toMatchObject({ code: "transport_error", retryable: false });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("an abort that happens BEFORE wait() is called (pre-existing behavior) still never dispatches fetch", async () => {
      const controller = new AbortController();
      controller.abort();
      const fetchImpl = vi.fn(async () => jsonResponse({ data: { list: [], totalCount: 0 } }));
      const adapter = createMoboreaderReadAdapter({ fetchImpl });
      const result = await adapter.listBooks(
        { name: "", orderType: 0, pageIndex: 1, pageSize: 100, projectType: 1 }, "token", controller.signal,
      ).catch((e) => e);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(result).toMatchObject({ code: "transport_error" });
    });
  });
});

describe("createPromoLinkClaimAdapter: RC-4 endpoint wiring", () => {
  const claimRequest: ClaimPromoRequest = {
    agencyId: 3366, seriesId: "124235322", projectType: 1, language: 3, name: "Title", offerType: "read",
  };

  function successBody() {
    return { data: { kocCode: "239FFB", publicUrl: null, homeLink: null }, code: 200, message: "ok", status: true };
  }

  it("claimPromo passes 'getcode' (not the raw path) to wait()", async () => {
    const { gate, waits } = recordingGate();
    const fetchImpl = vi.fn(async () => jsonResponse(successBody()));
    const adapter = createPromoLinkClaimAdapter({ fetchImpl, rateGate: gate });
    await adapter.claimPromo(claimRequest, "jwt-token");
    expect(waits).toEqual(["getcode"]);
  });

  it("readPromoAfterClaim passes 'getlistpc' — the SAME wire endpoint name the catalog adapter uses for its own getlistpc calls", async () => {
    const { gate, waits } = recordingGate();
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { totalCount: 0, list: [] }, code: 200, message: "ok", status: true }));
    const adapter = createPromoLinkClaimAdapter({ fetchImpl, rateGate: gate });
    await adapter.readPromoAfterClaim!(claimRequest, "jwt-token");
    expect(waits).toEqual(["getlistpc"]);
  });

  it("calls observe() with getcode's response status/headers, even when getcode's own error classification stays ambiguous", async () => {
    const { gate, observations } = recordingGate();
    const fetchImpl = vi.fn(async () => new Response("rate limited", { status: 429, headers: { "retry-after": "3" } }));
    const adapter = createPromoLinkClaimAdapter({ fetchImpl, rateGate: gate });
    await expect(adapter.claimPromo(claimRequest, "jwt-token")).rejects.toMatchObject({
      code: "upstream_http_error", status: 429, ambiguous: true, // frozen classification, unchanged by RC-4
    });
    expect(observations).toEqual([{ endpoint: "getcode", info: { httpStatus: 429, gatewayHeaders: { "retry-after": "3" } } }]);
  });

  it("surfaces the gate's wait-info breakdown on the observation event's new fields for getcode", async () => {
    const { gate } = recordingGate();
    const seen: UpstreamCallObservation[] = [];
    const fetchImpl = vi.fn(async () => jsonResponse(successBody()));
    const adapter = createPromoLinkClaimAdapter({ fetchImpl, rateGate: gate, onUpstreamObservation: (o) => seen.push(o) });
    await adapter.claimPromo(claimRequest, "jwt-token");
    expect(seen[0]).toMatchObject({ endpointGateWaitMs: 111, hostGateWaitMs: 22, remainingBeforeDispatch: 33 });
  });

  it("does NOT call observe() on a transport error / timeout for getcode", async () => {
    const { gate, observations } = recordingGate();
    const fetchImpl = vi.fn(async () => { throw new Error("network down"); });
    const adapter = createPromoLinkClaimAdapter({ fetchImpl, rateGate: gate });
    await expect(adapter.claimPromo(claimRequest, "jwt-token")).rejects.toThrow();
    expect(observations).toHaveLength(0);
  });

  // 2026-09-26 Opus 复核 3rd round，必改2。
  describe("[Opus fix 必改2] re-checks the abort signal after wait() resolves, before ever dispatching fetch", () => {
    it("[mutation target] getcode: abort fired DURING the gate wait -> fetch never called, and the error is NOT ambiguous (never dispatched, not 'result unknown')", async () => {
      const controller = new AbortController();
      const fetchImpl = vi.fn(async () => jsonResponse(successBody()));
      const abortDuringWaitGate: MoboreaderRateGate = {
        wait: async () => { controller.abort(); return undefined; },
      };
      const adapter = createPromoLinkClaimAdapter({ fetchImpl, rateGate: abortDuringWaitGate });
      await expect(adapter.claimPromo(claimRequest, "jwt-token", controller.signal)).rejects.toMatchObject({
        code: "transport_error",
        retryable: false,
        ambiguous: false, // the load-bearing assertion: NOT "result unknown"
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("[mutation target] readback (getlistpc): abort fired DURING the gate wait -> fetch never called", async () => {
      const controller = new AbortController();
      const fetchImpl = vi.fn(async () => jsonResponse({ data: { totalCount: 0, list: [] }, code: 200, message: "ok", status: true }));
      const abortDuringWaitGate: MoboreaderRateGate = {
        wait: async () => { controller.abort(); return undefined; },
      };
      const adapter = createPromoLinkClaimAdapter({ fetchImpl, rateGate: abortDuringWaitGate });
      await expect(adapter.readPromoAfterClaim!(claimRequest, "jwt-token", controller.signal)).rejects.toMatchObject({
        code: "transport_error",
        retryable: false,
        ambiguous: false,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
});
