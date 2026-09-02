// RC-3: `createMoboreaderReadAdapter`'s opt-in CPS-ported rate-limit policy
// (`src/lib/adapters/moboreader.ts`'s `upstreamRateLimitPolicy` option,
// `MoboreaderRateLimitedError` from `src/lib/adapters/moboreader-rate-limit.ts`).
//
// New test file. Deliberately does not modify
// `tests/backend/adapters/moboreader.test.ts` — that file's assertions
// about the *default* (no `upstreamRateLimitPolicy`) behavior stay exactly
// as they were before this port; this file only exercises the new opt-in
// path, activated the same way `worker/handlers/moboreader.ts` activates
// it in production.
import { describe, expect, it, vi } from "vitest";
import {
  createMoboreaderReadAdapter,
  MOBOREADER_READ_ENDPOINTS,
} from "@/lib/adapters/moboreader";
import { MoboreaderAdapterError, MoboreaderRateLimitedError } from "@/lib/adapters";

function fakeClock(startMs = 0) {
  let now = startMs;
  return {
    now: () => now,
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
  };
}

function rateLimited(status: 429 | 503, retryAfter: string | null) {
  return {
    ok: false,
    status,
    headers: { get: (key: string) => (key.toLowerCase() === "retry-after" ? retryAfter : null) },
  } as unknown as Response;
}

function ok(body: unknown = { data: { list: [], totalCount: 0 } }) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    headers: { get: () => null },
  } as unknown as Response;
}

function listRequest() {
  return { name: "", orderType: 0, pageIndex: 61, pageSize: 20, projectType: 1 } as const;
}

describe("createMoboreaderReadAdapter upstreamRateLimitPolicy (opt-in, CPS v8.3.6-ported)", () => {
  it("omitting the option keeps the exact pre-existing default: 3 attempts, no MoboreaderRateLimitedError", async () => {
    // Differential guard: proves the new code path is genuinely inert
    // unless explicitly activated — mirrors what
    // tests/backend/adapters/moboreader.test.ts already pins for the
    // default construction, without duplicating or touching that file.
    const fetchImpl = vi.fn(async () => rateLimited(503, null));
    const adapter = createMoboreaderReadAdapter({ fetchImpl, sleep: async () => undefined });
    await expect(adapter.listBooks(listRequest(), "token")).rejects.not.toBeInstanceOf(MoboreaderRateLimitedError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("[v8.3.1-bug regression] a Retry-After longer than the per-attempt timeout still succeeds, not a timeout failure", async () => {
    const clock = fakeClock();
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1 ? rateLimited(429, "16") : ok();
    });
    const adapter = createMoboreaderReadAdapter({
      fetchImpl,
      timeoutMs: 5_000, // shorter than the 16s Retry-After
      sleep: clock.sleep,
      upstreamRateLimitPolicy: { now: clock.now, random: () => 0 },
    });
    const result = await adapter.listBooks(listRequest(), "token");
    expect(result.totalCount).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(clock.now()).toBe(16_000);
  });

  it("waits out a Retry-After above the pre-existing adapter's old 30s cap, instead of truncating to it", async () => {
    const clock = fakeClock();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(rateLimited(503, "50")) // 50s: above the old 30s cap, below the new 90s budget
      .mockResolvedValueOnce(ok());
    const adapter = createMoboreaderReadAdapter({
      fetchImpl,
      sleep: clock.sleep,
      upstreamRateLimitPolicy: { now: clock.now, random: () => 0 },
    });
    const result = await adapter.listBooks(listRequest(), "token");
    expect(result.totalCount).toBe(0);
    expect(clock.now()).toBe(50_000);
  });

  it("caps an extreme Retry-After at MOBOREADER_RETRY_AFTER_CAP_MS (120_000ms), not the pre-existing adapter's 30_000ms cap", async () => {
    const clock = fakeClock();
    const fetchImpl = vi.fn(async () => rateLimited(503, "9999"));
    const adapter = createMoboreaderReadAdapter({
      fetchImpl,
      sleep: clock.sleep,
      // A large enough budget isolates "what does the cap clamp to" from
      // "does the 90s default budget also reject it" (covered separately
      // below).
      upstreamRateLimitPolicy: { now: clock.now, random: () => 0, totalBudgetMs: 1_000_000 },
    });
    await expect(adapter.listBooks(listRequest(), "token")).rejects.toMatchObject({ retryAfterMs: 120_000 });
  });

  it("stops before sleeping once Retry-After would exceed the total budget, throwing MoboreaderRateLimitedError(budget_exhausted)", async () => {
    const clock = fakeClock();
    const fetchImpl = vi.fn(async () => rateLimited(429, "100")); // 100s > 90s budget
    const adapter = createMoboreaderReadAdapter({
      fetchImpl,
      sleep: clock.sleep,
      upstreamRateLimitPolicy: { now: clock.now, random: () => 0 },
    });
    await expect(adapter.listBooks(listRequest(), "token")).rejects.toMatchObject({
      reason: "budget_exhausted",
      pageIndex: 61,
      endpoint: MOBOREADER_READ_ENDPOINTS.getlistpc,
      retryAfterMs: 100_000,
    });
    expect(clock.now()).toBe(0); // never slept the 100s it couldn't afford
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("exhausts at MOBOREADER_MAX_RATE_LIMIT_RETRIES (4) with no Retry-After, throwing MoboreaderRateLimitedError(max_attempts)", async () => {
    const clock = fakeClock();
    const fetchImpl = vi.fn(async () => rateLimited(429, null));
    const adapter = createMoboreaderReadAdapter({
      fetchImpl,
      sleep: clock.sleep,
      upstreamRateLimitPolicy: { now: clock.now, random: () => 1 }, // full jitter upper bound, deterministic
    });
    await expect(adapter.listBooks(listRequest(), "token")).rejects.toMatchObject({
      reason: "max_attempts",
      pageIndex: 61,
      attempts: 4,
    });
    // 2s + 4s + 8s + 16s = 30s, within the 90s budget, so it's genuinely
    // attempt-exhaustion, not budget-exhaustion.
    expect(clock.now()).toBe(30_000);
    expect(fetchImpl).toHaveBeenCalledTimes(5); // 1 initial + 4 retries
  });

  it("allows a higher rate-limit retry ceiling via policy override, independent of the generic maxAttempts option", async () => {
    const clock = fakeClock();
    const fetchImpl = vi.fn(async () => rateLimited(503, null));
    const adapter = createMoboreaderReadAdapter({
      fetchImpl,
      sleep: clock.sleep,
      maxAttempts: 3, // generic ceiling stays untouched
      upstreamRateLimitPolicy: { now: clock.now, random: () => 0, maxAttempts: 6 },
    });
    await expect(adapter.listBooks(listRequest(), "token")).rejects.toMatchObject({ attempts: 6 });
    expect(fetchImpl).toHaveBeenCalledTimes(7);
  });

  it("still retries a generic 5xx (not in MOBOREADER_RATE_LIMITED_STATUSES) and can recover", async () => {
    const clock = fakeClock();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(rateLimited(500 as never, null))
      .mockResolvedValueOnce(ok());
    const adapter = createMoboreaderReadAdapter({
      fetchImpl,
      sleep: clock.sleep,
      upstreamRateLimitPolicy: { now: clock.now, random: () => 1 },
    });
    const result = await adapter.listBooks(listRequest(), "token");
    expect(result.totalCount).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("folds a generic 5xx's retries into the same elapsed budget as 429/503, throwing the old MoboreaderAdapterError (not a rate-limit error) once the budget is gone", async () => {
    const clock = fakeClock();
    const fetchImpl = vi.fn(async () => rateLimited(500 as never, null));
    const adapter = createMoboreaderReadAdapter({
      fetchImpl,
      sleep: clock.sleep,
      upstreamRateLimitPolicy: { now: clock.now, random: () => 1, totalBudgetMs: 1_000 },
    });
    await expect(adapter.listBooks(listRequest(), "token")).rejects.toBeInstanceOf(MoboreaderAdapterError);
    await expect(adapter.listBooks(listRequest(), "token")).rejects.not.toBeInstanceOf(MoboreaderRateLimitedError);
    // The 2s backoff for attempt 1 already exceeds the 1s budget, so this
    // fails on the very first attempt rather than ever sleeping.
    expect(fetchImpl).toHaveBeenCalledTimes(1 + 1); // both `expect` calls above dispatch once each
  });

  it("still fails immediately (zero retries, zero sleep) for a non-retryable business status", async () => {
    const clock = fakeClock();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, headers: { get: () => null } }) as unknown as Response);
    const adapter = createMoboreaderReadAdapter({
      fetchImpl,
      sleep: clock.sleep,
      upstreamRateLimitPolicy: { now: clock.now },
    });
    await expect(adapter.listBooks(listRequest(), "token")).rejects.toMatchObject({ code: "upstream_http_error", status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(clock.now()).toBe(0);
  });

  it("routes every dispatch attempt (including retries) through the rate gate", async () => {
    const clock = fakeClock();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(rateLimited(429, null))
      .mockResolvedValueOnce(ok());
    const wait = vi.fn(async () => undefined);
    const adapter = createMoboreaderReadAdapter({
      fetchImpl,
      sleep: clock.sleep,
      rateGate: { wait },
      upstreamRateLimitPolicy: { now: clock.now, random: () => 0 },
    });
    await adapter.listBooks(listRequest(), "token");
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("captures pageIndex from the request body for listBooks, and reports null for non-paginated endpoints", async () => {
    const clock = fakeClock();
    const listFetch = vi.fn(async () => rateLimited(429, null));
    const listAdapter = createMoboreaderReadAdapter({
      fetchImpl: listFetch,
      sleep: clock.sleep,
      upstreamRateLimitPolicy: { now: clock.now, random: () => 0, maxAttempts: 1 },
    });
    await expect(listAdapter.listBooks(listRequest(), "token")).rejects.toMatchObject({ pageIndex: 61 });

    const materialFetch = vi.fn(async () => rateLimited(429, null));
    const materialAdapter = createMoboreaderReadAdapter({
      fetchImpl: materialFetch,
      sleep: clock.sleep,
      upstreamRateLimitPolicy: { now: clock.now, random: () => 0, maxAttempts: 1 },
    });
    await expect(materialAdapter.fetchBookMaterial(
      { agencyId: "a", dataId: "d", projectType: 1, language: 2, materialType: 1 },
      "token",
    )).rejects.toMatchObject({ pageIndex: null, endpoint: MOBOREADER_READ_ENDPOINTS.getbydataid });
  });
});
