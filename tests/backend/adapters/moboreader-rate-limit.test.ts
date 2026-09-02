// RC-3: MoboReader upstream request-pacing discipline, ported from CPS
// 短剧 v8.3.6 `src/lib/adapters/changdu-rate-limit.ts`
// (`git -C cps-admin show v8.3.6:src/lib/adapters/changdu-rate-limit.ts`).
//
// New test file — does not modify any existing frozen test in this
// directory. See `docs/governance/port-registry.md` for the exact source
// citation and the constant-name mapping (CPS `CHANGDU_*` → `MOBOREADER_*`).
import { describe, expect, it, vi } from "vitest";
import {
  MOBOREADER_BACKOFF_BASE_MS,
  MOBOREADER_BACKOFF_CAP_MS,
  MOBOREADER_MAX_RATE_LIMIT_RETRIES,
  MOBOREADER_MIN_REQUEST_INTERVAL_MS,
  MOBOREADER_RATE_LIMITED_STATUSES,
  MOBOREADER_RATE_LIMIT_TOTAL_BUDGET_MS,
  MOBOREADER_RETRY_AFTER_CAP_MS,
  MoboreaderRateLimitConfigError,
  MoboreaderRateLimitedError,
  canAffordRetry,
  computeRetryDelayMs,
  createMoboreaderRateGate,
  parseRetryAfter,
  resolveMoboreaderUpstreamRateLimitConfig,
} from "@/lib/adapters/moboreader-rate-limit";

describe("MoboReader upstream rate-limit constants (CPS v8.3.6 parity)", () => {
  it("ports CPS's exact default values under MOBOREADER_ names", () => {
    expect(MOBOREADER_MIN_REQUEST_INTERVAL_MS).toBe(1_100);
    expect(MOBOREADER_MAX_RATE_LIMIT_RETRIES).toBe(4);
    expect(MOBOREADER_BACKOFF_BASE_MS).toBe(2_000);
    expect(MOBOREADER_BACKOFF_CAP_MS).toBe(60_000);
    expect(MOBOREADER_RETRY_AFTER_CAP_MS).toBe(120_000);
    expect(MOBOREADER_RATE_LIMIT_TOTAL_BUDGET_MS).toBe(90_000);
    expect(MOBOREADER_RATE_LIMITED_STATUSES.has(429)).toBe(true);
    expect(MOBOREADER_RATE_LIMITED_STATUSES.has(503)).toBe(true);
    expect(MOBOREADER_RATE_LIMITED_STATUSES.has(500)).toBe(false);
  });
});

describe("resolveMoboreaderUpstreamRateLimitConfig", () => {
  it("defaults to the CPS-ported constants with no env overrides", () => {
    expect(resolveMoboreaderUpstreamRateLimitConfig({ NODE_ENV: "test" })).toEqual({
      minRequestIntervalMs: MOBOREADER_MIN_REQUEST_INTERVAL_MS,
      maxRateLimitRetries: MOBOREADER_MAX_RATE_LIMIT_RETRIES,
      backoffBaseMs: MOBOREADER_BACKOFF_BASE_MS,
      backoffCapMs: MOBOREADER_BACKOFF_CAP_MS,
      retryAfterCapMs: MOBOREADER_RETRY_AFTER_CAP_MS,
      totalBudgetMs: MOBOREADER_RATE_LIMIT_TOTAL_BUDGET_MS,
    });
  });

  it("honors every env override", () => {
    expect(resolveMoboreaderUpstreamRateLimitConfig({
      NODE_ENV: "test",
      MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS: "1500",
      MOBOREADER_UPSTREAM_MAX_RATE_LIMIT_RETRIES: "6",
      MOBOREADER_UPSTREAM_BACKOFF_BASE_MS: "3000",
      MOBOREADER_UPSTREAM_BACKOFF_CAP_MS: "70000",
      MOBOREADER_UPSTREAM_RETRY_AFTER_CAP_MS: "150000",
      MOBOREADER_UPSTREAM_RATE_LIMIT_BUDGET_MS: "100000",
    })).toEqual({
      minRequestIntervalMs: 1_500,
      maxRateLimitRetries: 6,
      backoffBaseMs: 3_000,
      backoffCapMs: 70_000,
      retryAfterCapMs: 150_000,
      totalBudgetMs: 100_000,
    });
  });

  it.each([
    "MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS",
    "MOBOREADER_UPSTREAM_MAX_RATE_LIMIT_RETRIES",
    "MOBOREADER_UPSTREAM_BACKOFF_BASE_MS",
    "MOBOREADER_UPSTREAM_BACKOFF_CAP_MS",
    "MOBOREADER_UPSTREAM_RETRY_AFTER_CAP_MS",
    "MOBOREADER_UPSTREAM_RATE_LIMIT_BUDGET_MS",
  ])("fails fast on a non-positive-integer override for %s", (key) => {
    expect(() => resolveMoboreaderUpstreamRateLimitConfig({ NODE_ENV: "test", [key]: "0" }))
      .toThrow(MoboreaderRateLimitConfigError);
    expect(() => resolveMoboreaderUpstreamRateLimitConfig({ NODE_ENV: "test", [key]: "not-a-number" }))
      .toThrow(MoboreaderRateLimitConfigError);
    expect(() => resolveMoboreaderUpstreamRateLimitConfig({ NODE_ENV: "test", [key]: "-5" }))
      .toThrow(MoboreaderRateLimitConfigError);
  });
});

describe("parseRetryAfter", () => {
  it("accepts delta-seconds", () => {
    expect(parseRetryAfter("30", 0)).toBe(30_000);
    expect(parseRetryAfter("  60  ", 0)).toBe(60_000);
    expect(parseRetryAfter("0", 0)).toBe(0);
  });

  it("accepts an HTTP-date", () => {
    const now = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:45 GMT", now)).toBe(45_000);
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:27:00 GMT", now)).toBe(0);
  });

  it("returns null (not 0) for missing/garbage values, including the '-5' shape trap", () => {
    // `Date.parse("-5")` returns a valid (year-interpreted) timestamp in V8,
    // so the HTTP-date branch must check for a letter *before* calling
    // `Date.parse` — otherwise "-5" parses as a date far in the past, the
    // delta clamps to 0, and the caller would retry immediately, which is
    // exactly the one thing a rate-limit response must never trigger.
    for (const value of [null, undefined, "", "   ", "soon", "-5"]) {
      expect(parseRetryAfter(value, 0)).toBeNull();
    }
  });

  it("rejects other letter-bearing garbage that isn't a parseable date either", () => {
    expect(parseRetryAfter("abcXYZ!!not-a-date", 0)).toBeNull();
  });

  it("caps an absurdly large value at the configured ceiling", () => {
    expect(parseRetryAfter("999999", 0)).toBe(MOBOREADER_RETRY_AFTER_CAP_MS);
    expect(parseRetryAfter("999999", 0, 5_000)).toBe(5_000);
  });
});

describe("computeRetryDelayMs", () => {
  it("trusts an upstream Retry-After (plus a little jitter) over local backoff", () => {
    const delay = computeRetryDelayMs({ attempt: 1, retryAfterMs: 30_000, random: () => 0 });
    expect(delay).toBe(30_000);
  });

  it("uses exponential backoff with no Retry-After", () => {
    const at = (attempt: number) => computeRetryDelayMs({ attempt, retryAfterMs: null, random: () => 1 });
    expect(at(1)).toBe(MOBOREADER_BACKOFF_BASE_MS);
    expect(at(2)).toBe(MOBOREADER_BACKOFF_BASE_MS * 2);
    expect(at(3)).toBe(MOBOREADER_BACKOFF_BASE_MS * 4);
  });

  it("caps the backoff instead of doubling forever", () => {
    expect(computeRetryDelayMs({ attempt: 20, retryAfterMs: null, random: () => 1 })).toBe(MOBOREADER_BACKOFF_CAP_MS);
  });

  it("applies full jitter in [cap/2, cap] so concurrent retries don't land on the same instant", () => {
    const lo = computeRetryDelayMs({ attempt: 3, retryAfterMs: null, random: () => 0 });
    const hi = computeRetryDelayMs({ attempt: 3, retryAfterMs: null, random: () => 1 });
    expect(lo).toBeLessThan(hi);
    const expected = MOBOREADER_BACKOFF_BASE_MS * 4;
    expect(lo).toBe(expected / 2);
    expect(hi).toBe(expected);
  });

  it("honors overridden backoff base/cap", () => {
    expect(computeRetryDelayMs({
      attempt: 1, retryAfterMs: null, random: () => 1, backoffBaseMs: 100, backoffCapMs: 100,
    })).toBe(100);
  });
});

describe("canAffordRetry", () => {
  it("allows a retry that fits inside the budget and rejects one that doesn't", () => {
    expect(canAffordRetry({ elapsedMs: 10_000, delayMs: 5_000, budgetMs: 20_000 })).toBe(true);
    expect(canAffordRetry({ elapsedMs: 18_000, delayMs: 5_000, budgetMs: 20_000 })).toBe(false);
  });

  it("defaults to MOBOREADER_RATE_LIMIT_TOTAL_BUDGET_MS", () => {
    expect(canAffordRetry({ elapsedMs: 0, delayMs: MOBOREADER_RATE_LIMIT_TOTAL_BUDGET_MS })).toBe(true);
    expect(canAffordRetry({ elapsedMs: 1, delayMs: MOBOREADER_RATE_LIMIT_TOTAL_BUDGET_MS })).toBe(false);
  });
});

describe("MoboreaderRateLimitedError", () => {
  it("carries pageIndex/endpoint/attempts/elapsed for the caller to resume from", () => {
    const error = new MoboreaderRateLimitedError({
      status: 429,
      retryAfterMs: 30_000,
      pageIndex: 61,
      endpoint: "/api/v1/res/getlistpc",
      attempts: 4,
      elapsedMs: 42_000,
      reason: "max_attempts",
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("MoboreaderRateLimitedError");
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(30_000);
    expect(error.pageIndex).toBe(61);
    expect(error.endpoint).toBe("/api/v1/res/getlistpc");
    expect(error.attempts).toBe(4);
    expect(error.elapsedMs).toBe(42_000);
    expect(error.reason).toBe("max_attempts");
    expect(error.message).toContain("page 61");
  });

  it("omits page-specific wording when pageIndex is null (non-paginated endpoints)", () => {
    const error = new MoboreaderRateLimitedError({
      status: 503,
      retryAfterMs: null,
      pageIndex: null,
      endpoint: "/api/v1/material/getbydataid",
      attempts: 4,
      elapsedMs: 10_000,
      reason: "max_attempts",
    });
    expect(error.pageIndex).toBeNull();
    expect(error.message).not.toContain("page null");
  });
});

// ── Throttle door ──────────────────────────────────────────────────────

function fakeClock(startMs = 0) {
  let now = startMs;
  return {
    now: () => now,
    sleep: (ms: number) => {
      now += ms; // must actually advance the clock, or spacing can't be tested
      return Promise.resolve();
    },
  };
}

describe("createMoboreaderRateGate", () => {
  it("lets the first caller through immediately", async () => {
    const clock = fakeClock();
    const gate = createMoboreaderRateGate({ now: clock.now, sleep: clock.sleep, minIntervalMs: 1_100 });
    await gate.wait();
    expect(clock.now()).toBe(0);
  });

  it("spaces two sequential calls by at least the configured interval, advancing the clock for real (not a no-op sleep)", async () => {
    const clock = fakeClock();
    const sleep = vi.fn(clock.sleep);
    const gate = createMoboreaderRateGate({ now: clock.now, sleep, minIntervalMs: 1_100 });
    await gate.wait();
    await gate.wait();
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1_100);
    expect(clock.now()).toBe(1_100);
  });

  it("does not wait again if the caller already spaced its own calls past the interval", async () => {
    const clock = fakeClock();
    const gate = createMoboreaderRateGate({ now: clock.now, sleep: clock.sleep, minIntervalMs: 1_100 });
    await gate.wait();
    clock.sleep(2_000);
    await gate.wait();
    expect(clock.now()).toBe(2_000);
  });

  it("serializes concurrent callers (mutex queue) instead of letting them both compute the same earliest instant", async () => {
    const clock = fakeClock();
    const gate = createMoboreaderRateGate({ now: clock.now, sleep: clock.sleep, minIntervalMs: 1_100 });
    // Fire three `wait()` calls "at once" (before any of them resolve) —
    // this is the shape of catalog-scan + Preview-refresh + promo-claim
    // dispatching from independent code paths in the same process.
    await Promise.all([gate.wait(), gate.wait(), gate.wait()]);
    // Three dispatches at >=1100ms apart each means the clock must have
    // advanced by at least 2 full intervals (the first is free).
    expect(clock.now()).toBeGreaterThanOrEqual(2_200);
  });

  it("defaults to MOBOREADER_MIN_REQUEST_INTERVAL_MS when minIntervalMs is not given", async () => {
    const clock = fakeClock();
    const sleep = vi.fn(clock.sleep);
    const gate = createMoboreaderRateGate({ now: clock.now, sleep });
    await gate.wait();
    await gate.wait();
    expect(sleep).toHaveBeenCalledWith(MOBOREADER_MIN_REQUEST_INTERVAL_MS);
  });
});
