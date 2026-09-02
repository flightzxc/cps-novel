// RC-3: `createPromoLinkClaimAdapter`'s upstream pacing door
// (`src/lib/adapters/promo-link-claim.ts`'s `rateGate` option, sharing the
// `MoboreaderRateGate` contract from `src/lib/adapters/moboreader-rate-limit.ts`).
//
// New test file — `tests/backend/adapters/promo-link-claim.test.ts` (the
// frozen Book A contract tests) is not modified. The one thing this file
// exists to prove alongside "the gate is wired in": getcode's call/error
// semantics — one dispatch, no automatic retry, ambiguous outcomes route to
// readback-only recovery — are completely unchanged by RC-3. The gate only
// makes the dispatch wait its turn.
import { describe, expect, it, vi } from "vitest";
import {
  MOBOREADER_PROMO_ENDPOINTS,
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

function successBody() {
  return {
    data: { kocCode: "239FFB", publicUrl: "https://eng.moboreader.com/1M4mpB/239FFB", homeLink: "https://eng.moboreader.com/book/239FFB" },
    code: 200,
    message: "操作成功",
    status: true,
  };
}

describe("createPromoLinkClaimAdapter rateGate (RC-3, wait-only)", () => {
  it("defaults to a no-op gate: constructing with no rateGate adds no call and no delay", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(successBody()));
    const adapter = createPromoLinkClaimAdapter({ fetchImpl });
    await adapter.claimPromo(request, "jwt-token");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("awaits the gate before dispatching claimPromo (getcode)", async () => {
    const calls: string[] = [];
    const wait = vi.fn(async () => { calls.push("gate"); });
    const fetchImpl = vi.fn(async () => {
      calls.push("fetch");
      return jsonResponse(successBody());
    });
    const adapter = createPromoLinkClaimAdapter({ fetchImpl, rateGate: { wait } });
    await adapter.claimPromo(request, "jwt-token");
    expect(wait).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["gate", "fetch"]); // gate resolves strictly before dispatch
  });

  it("awaits the gate before dispatching readPromoAfterClaim (getlistpc readback)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: { totalCount: 0, list: [] },
      code: 200,
      message: "ok",
      status: true,
    }));
    const wait = vi.fn(async () => undefined);
    const adapter = createPromoLinkClaimAdapter({ fetchImpl, rateGate: { wait } });
    await adapter.readPromoAfterClaim!(request, "jwt-token");
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("getcode still dispatches exactly once on a retryable-shaped upstream status — the gate adds no retry", async () => {
    const fetchImpl = vi.fn(async () => new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "1" },
    }));
    const wait = vi.fn(async () => undefined);
    const adapter = createPromoLinkClaimAdapter({ fetchImpl, rateGate: { wait } });
    await expect(adapter.claimPromo(request, "jwt-token")).rejects.toMatchObject({
      code: "upstream_http_error",
      status: 429,
      ambiguous: true, // a 429 on the mutation is ambiguous, not "safe to retry"
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledTimes(1); // one gate wait for the one dispatch — never a second
  });

  it("routes both dispatches (claim then readback) through the same gate instance, in call order", async () => {
    const order: string[] = [];
    const wait = vi.fn(async () => { order.push("wait"); });
    const adapter = createPromoLinkClaimAdapter({
      fetchImpl: async (url) => {
        const isClaim = String(url).includes(MOBOREADER_PROMO_ENDPOINTS.claim);
        order.push(isClaim ? "claim" : "readback");
        return jsonResponse(isClaim ? successBody() : { data: { totalCount: 0, list: [] }, code: 200, message: "ok", status: true });
      },
      rateGate: { wait },
    });
    await adapter.claimPromo(request, "jwt-token");
    await adapter.readPromoAfterClaim!(request, "jwt-token");
    expect(order).toEqual(["wait", "claim", "wait", "readback"]);
  });
});
