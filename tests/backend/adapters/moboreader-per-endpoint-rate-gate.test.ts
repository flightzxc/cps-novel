// RC-4 (阶段 4-A，设计《领推广按接口限速与预读集合化》§5): MoboReader
// upstream 按接口分别限速 + 主机级防突发间隔 + 按 `x-ratelimit-remaining`
// 自适应减速。
//
// New test file — does not modify any pre-existing frozen assertion in
// `tests/backend/adapters/moboreader-rate-limit.test.ts` (the pre-RC-4
// single-queue gate's own test file, covering `createMoboreaderRateGate`
// unchanged), `moboreader-upstream-rate-limit-policy.test.ts`, or
// `promo-link-claim-rate-gate.test.ts`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MOBOREADER_PER_ENDPOINT_INTERVAL_FLOOR_MS,
  MOBOREADER_PER_ENDPOINT_RATE_GATE_DEFAULTS,
  MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENV,
  MoboreaderRateLimitConfigError,
  RESET_ABSOLUTE_EPOCH_THRESHOLD_SECONDS,
  createMoboreaderPerEndpointRateGate,
  isMoboreaderPerEndpointRateGateEnabled,
  parseRetryAfterUncapped,
  resolveMoboreaderPerEndpointRateGateConfig,
  type MoboreaderRateGateEvent,
} from "@/lib/adapters/moboreader-rate-limit";

describe("parseRetryAfterUncapped (RC-4 review fix 必改1)", () => {
  it("delta-seconds is never capped, however large", () => {
    expect(parseRetryAfterUncapped("120", 0)).toBe(120_000);
    expect(parseRetryAfterUncapped("999999", 0)).toBe(999_999_000); // far beyond MOBOREADER_RETRY_AFTER_CAP_MS
  });

  it("HTTP-date is never capped, however far in the future", () => {
    const now = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
    expect(parseRetryAfterUncapped("Wed, 21 Oct 2026 07:30:00 GMT", now)).toBe(120_000);
  });

  it("shares the same '-5' shape trap fix as parseRetryAfter: garbage never parses as a past date and never returns a negative/zero-via-clamp trick", () => {
    for (const value of [null, undefined, "", "   ", "soon", "-5"]) {
      expect(parseRetryAfterUncapped(value, 0)).toBeNull();
    }
  });

  it("a past HTTP-date clamps to 0, not negative", () => {
    const now = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
    expect(parseRetryAfterUncapped("Wed, 21 Oct 2026 07:27:00 GMT", now)).toBe(0);
  });
});

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

function baseOptions(clock: ReturnType<typeof fakeClock>, onEvent?: (e: MoboreaderRateGateEvent) => void) {
  return {
    endpointIntervalMs: { getlistpc: 1_200, getcode: 1_200 },
    defaultIntervalMs: 1_100,
    hostMinGapMs: 250,
    remainingFloor: { getlistpc: 8, getcode: 12 },
    rateWindowMaxWaitMs: 60_000,
    cooldownAnomalyThresholdMs: 900_000,
    now: clock.now,
    sleep: clock.sleep,
    onEvent,
  };
}

function headers(values: Record<string, string>): Readonly<Record<string, string>> {
  return Object.freeze({ ...values });
}

describe("createMoboreaderPerEndpointRateGate: per-endpoint spacing", () => {
  it("spaces two calls to the SAME endpoint by that endpoint's own interval", async () => {
    const clock = fakeClock();
    const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock));
    await gate.wait("getlistpc");
    await gate.wait("getlistpc");
    expect(clock.now()).toBe(1_200);
  });

  it("lets two DIFFERENT endpoints run on independent queues (each still respecting the shared host gap)", async () => {
    const clock = fakeClock();
    const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock));
    await gate.wait("getlistpc");
    // getcode's own interval (1200ms) has not been consumed yet — only the
    // host gap (250ms) should apply between an unrelated endpoint pair.
    await gate.wait("getcode");
    expect(clock.now()).toBe(250);
  });

  it("a third call to getlistpc still waits out getlistpc's own 1200ms from ITS last dispatch, not from the getcode call in between", async () => {
    const clock = fakeClock();
    const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock));
    await gate.wait("getlistpc"); // t=0
    await gate.wait("getcode"); // t=250 (host gap)
    await gate.wait("getlistpc"); // must wait until t=1200 (getlistpc's own interval from t=0)
    expect(clock.now()).toBe(1_200);
  });

  it("an untracked endpoint (getbydataid/getchapterinfo) uses defaultIntervalMs, not the tracked endpoints' interval", async () => {
    const clock = fakeClock();
    const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock));
    await gate.wait("getbydataid");
    await gate.wait("getbydataid");
    expect(clock.now()).toBe(1_100); // defaultIntervalMs, not 1200
  });

  it("wait() with no endpoint argument falls back to the untracked-default bucket without throwing", async () => {
    const clock = fakeClock();
    const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock));
    await gate.wait();
    await gate.wait();
    expect(clock.now()).toBe(1_100);
  });

  it("reports endpointGateWaitMs/hostGateWaitMs in the resolved wait info", async () => {
    const clock = fakeClock();
    const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock));
    const first = await gate.wait("getlistpc");
    expect(first).toMatchObject({ endpointGateWaitMs: 0, hostGateWaitMs: 0 });
    const second = await gate.wait("getlistpc");
    // Each figure is that constraint's OWN independently-computed
    // requirement (not "the marginal contribution given the other
    // constraint already applies") — here the host gap (250ms since the
    // first dispatch) is satisfied well before the endpoint interval
    // (1200ms) is, so it is reported even though it isn't the binding one.
    expect(second).toMatchObject({ endpointGateWaitMs: 1_200, hostGateWaitMs: 250 });
  });
});

describe("createMoboreaderPerEndpointRateGate: host-level anti-burst gap (E3)", () => {
  it("[mutation target 2] enforces >=250ms between ANY two dispatches, even across two different endpoints with no floor/cooldown in play", async () => {
    const clock = fakeClock();
    const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock));
    await gate.wait("getlistpc");
    await gate.wait("getcode");
    expect(clock.now()).toBeGreaterThanOrEqual(250);
  });

  it("does not add host-gap delay when the endpoint's own interval already exceeds it", async () => {
    const clock = fakeClock();
    const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock));
    await gate.wait("getlistpc");
    await gate.wait("getlistpc"); // 1200ms >> 250ms host gap, host gap contributes nothing extra
    expect(clock.now()).toBe(1_200);
  });

  it("a hostMinGapMs of 0 disables the cross-endpoint burst guard (legitimate config value, not a bug)", async () => {
    const clock = fakeClock();
    const gate = createMoboreaderPerEndpointRateGate({ ...baseOptions(clock), hostMinGapMs: 0 });
    await gate.wait("getlistpc");
    await gate.wait("getcode");
    expect(clock.now()).toBe(0);
  });
});

describe("createMoboreaderPerEndpointRateGate: remaining-quota floor pause (§5.2 item 1)", () => {
  it("[mutation target 3] pauses an endpoint once observe() reports remaining <= floor, until x-ratelimit-reset", async () => {
    const clock = fakeClock();
    const events: MoboreaderRateGateEvent[] = [];
    const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock, (e) => events.push(e)));
    await gate.wait("getlistpc"); // t=0, dispatch
    gate.observe!("getlistpc", { httpStatus: 200, gatewayHeaders: headers({ "x-ratelimit-remaining": "8", "x-ratelimit-reset": "45" }) });
    // floor is 8 -> remaining <= floor -> next wait() must be held until
    // t=0+45000=45000, not just the plain 1200ms interval.
    await gate.wait("getlistpc");
    expect(clock.now()).toBe(45_000);
    expect(events.some((e) => e.type === "floor_pause" && e.endpoint === "getlistpc")).toBe(true);
  });

  it("does not pause while remaining is comfortably above the floor", async () => {
    const clock = fakeClock();
    const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock));
    await gate.wait("getlistpc");
    gate.observe!("getlistpc", { httpStatus: 200, gatewayHeaders: headers({ "x-ratelimit-remaining": "40" }) });
    await gate.wait("getlistpc");
    expect(clock.now()).toBe(1_200); // just the plain interval, no extra pause
  });

  it("floor pause is capped at rateWindowMaxWaitMs even if x-ratelimit-reset claims a much later time", async () => {
    const clock = fakeClock();
    const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock));
    await gate.wait("getlistpc"); // t=0
    gate.observe!("getlistpc", { httpStatus: 200, gatewayHeaders: headers({ "x-ratelimit-remaining": "3", "x-ratelimit-reset": "999999" }) });
    await gate.wait("getlistpc");
    expect(clock.now()).toBe(60_000); // capped at rateWindowMaxWaitMs, not 999999s
  });

  it("falls back to floorHitAt + rateWindowMaxWaitMs when x-ratelimit-reset is absent/unparsable", async () => {
    const clock = fakeClock();
    const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock));
    await gate.wait("getcode"); // t=0
    gate.observe!("getcode", { httpStatus: 200, gatewayHeaders: headers({ "x-ratelimit-remaining": "5" }) }); // no reset header
    await gate.wait("getcode");
    expect(clock.now()).toBe(60_000);
  });

  // 2026-09-25 Opus 复核：用预生产真实 `upstream_call` 事件与 docker 日志
  // 时间戳核实了 8 个样本（2026-09-24 10:24–11:37 UTC）——`x-ratelimit-reset`
  // 恒等于"日志时刻 + 59～60 秒"的**绝对 Unix 秒级时间戳**（例：日志瞬间
  // 1790245469 → 头值 1790245529），不是"距重置还有几秒"的相对值。以下三组
  // 用真实量级的 fake now（模拟 2023-11-14 附近的 epoch 毫秒）区分两种解读——
  // 用小 now（如 0）会让"绝对"与"相对"的算术结果因为 60s 硬顶而巧合相同，
  // 掩盖这处语义差异，所以必须用大 now。
  describe("[Opus fix] x-ratelimit-reset is an absolute Unix epoch second, not seconds-remaining", () => {
    const REALISTIC_NOW_MS = 1_700_000_000_000; // ~2023-11-14, epoch-scale on purpose

    it("a header >= RESET_ABSOLUTE_EPOCH_THRESHOLD_SECONDS is read as an absolute epoch second", async () => {
      const clock = fakeClock(REALISTIC_NOW_MS);
      const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock));
      const nowSeconds = REALISTIC_NOW_MS / 1_000;
      const resetAtEpochSeconds = nowSeconds + 30; // 30s in the future, absolute
      expect(resetAtEpochSeconds).toBeGreaterThanOrEqual(RESET_ABSOLUTE_EPOCH_THRESHOLD_SECONDS);
      await gate.wait("getlistpc"); // t = REALISTIC_NOW_MS
      gate.observe!("getlistpc", {
        httpStatus: 200,
        gatewayHeaders: headers({ "x-ratelimit-remaining": "3", "x-ratelimit-reset": String(resetAtEpochSeconds) }),
      });
      await gate.wait("getlistpc");
      // Correct (absolute) reading: waits exactly 30s. A buggy "always
      // relative" reading would instead add the whole ~1.7 billion raw
      // value to `now`, get capped at the 60s ceiling, and wait 60s —
      // this is exactly the assertion the "revert to always-relative"
      // mutation must turn red.
      expect(clock.now()).toBe(REALISTIC_NOW_MS + 30_000);
    });

    it("a small header value (< threshold) is still read as relative-seconds-from-now (defensive fallback for an older/different gateway)", async () => {
      const clock = fakeClock(REALISTIC_NOW_MS);
      const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock));
      await gate.wait("getcode");
      gate.observe!("getcode", {
        httpStatus: 200,
        gatewayHeaders: headers({ "x-ratelimit-remaining": "5", "x-ratelimit-reset": "20" }),
      });
      await gate.wait("getcode");
      expect(clock.now()).toBe(REALISTIC_NOW_MS + 20_000);
    });

    it("an absolute epoch second that is already in the past is discarded (null), not treated as 'reset already happened, go now'", async () => {
      const clock = fakeClock(REALISTIC_NOW_MS);
      const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock));
      const nowSeconds = REALISTIC_NOW_MS / 1_000;
      const pastAbsoluteSeconds = nowSeconds - 1; // 1 second in the past, still >= threshold
      await gate.wait("getlistpc"); // t = REALISTIC_NOW_MS, floorHitAt set here on the observe below
      gate.observe!("getlistpc", {
        httpStatus: 200,
        gatewayHeaders: headers({ "x-ratelimit-remaining": "1", "x-ratelimit-reset": String(pastAbsoluteSeconds) }),
      });
      await gate.wait("getlistpc");
      // A past instant must never shorten the wait — falls back to the
      // floorHitAt + rateWindowMaxWaitMs (60s) ceiling, same as an absent
      // header, not to "0 wait because the reset instant already passed".
      expect(clock.now()).toBe(REALISTIC_NOW_MS + 60_000);
    });
  });

  // 2026-09-26 Opus 复核 3rd round，必改3：用响应 Date 头换算重置时刻，防本机
  // 时钟偏差——不直接拿 x-ratelimit-reset 跟本机 now() 比。
  describe("[Opus fix 必改3] x-ratelimit-reset corrected for clock skew using the response's own Date header", () => {
    const REALISTIC_NOW_MS = 1_700_000_000_000;
    const nowSeconds = REALISTIC_NOW_MS / 1_000;

    it("[mutation target] local clock is SLOW (upstream's Date reads 10s ahead) -> pause uses the skew-corrected duration, not the naive one", async () => {
      const clock = fakeClock(REALISTIC_NOW_MS);
      const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock));
      const resetAtEpochSeconds = nowSeconds + 40;
      const dateHeaderMs = REALISTIC_NOW_MS + 10_000; // upstream's own clock is 10s ahead of ours
      await gate.wait("getlistpc");
      gate.observe!("getlistpc", {
        httpStatus: 200,
        gatewayHeaders: headers({
          "x-ratelimit-remaining": "3",
          "x-ratelimit-reset": String(resetAtEpochSeconds),
          date: new Date(dateHeaderMs).toUTCString(),
        }),
      });
      await gate.wait("getlistpc");
      // Skew-corrected: delta (reset − Date, in upstream's own clock) is
      // 30s; +1s rounding margin = 31s from OUR receipt instant. A naive
      // "compare reset straight to local now()" would instead wait the
      // full 40s (the value this mutation target regresses to).
      expect(clock.now()).toBe(REALISTIC_NOW_MS + 31_000);
    });

    it("local clock is FAST (upstream's Date reads 10s behind) -> pause is correspondingly longer, not shorter", async () => {
      const clock = fakeClock(REALISTIC_NOW_MS);
      const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock));
      const resetAtEpochSeconds = nowSeconds + 40;
      const dateHeaderMs = REALISTIC_NOW_MS - 10_000; // upstream's own clock is 10s behind ours
      await gate.wait("getcode");
      gate.observe!("getcode", {
        httpStatus: 200,
        gatewayHeaders: headers({
          "x-ratelimit-remaining": "5",
          "x-ratelimit-reset": String(resetAtEpochSeconds),
          date: new Date(dateHeaderMs).toUTCString(),
        }),
      });
      await gate.wait("getcode");
      // delta (reset − Date) = 50s; +1s margin = 51s.
      expect(clock.now()).toBe(REALISTIC_NOW_MS + 51_000);
    });

    it("skew beyond the suspect threshold falls back to the naive comparison and fires clock_skew_suspected", async () => {
      const clock = fakeClock(REALISTIC_NOW_MS);
      const events: MoboreaderRateGateEvent[] = [];
      const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock, (e) => events.push(e)));
      const resetAtEpochSeconds = nowSeconds + 40;
      const hugeSkewMs = 400_000; // > MOBOREADER_RATE_GATE_CLOCK_SKEW_THRESHOLD_MS (300_000)
      const dateHeaderMs = REALISTIC_NOW_MS - hugeSkewMs;
      await gate.wait("getlistpc");
      gate.observe!("getlistpc", {
        httpStatus: 200,
        gatewayHeaders: headers({
          "x-ratelimit-remaining": "2",
          "x-ratelimit-reset": String(resetAtEpochSeconds),
          date: new Date(dateHeaderMs).toUTCString(),
        }),
      });
      await gate.wait("getlistpc");
      expect(clock.now()).toBe(REALISTIC_NOW_MS + 40_000); // naive fallback, not skew-corrected
      expect(events).toContainEqual({ type: "clock_skew_suspected", endpoint: "getlistpc", skewMs: hugeSkewMs });
    });

    it("a missing Date header falls back to the naive comparison and fires clock_skew_suspected with skewMs: null", async () => {
      const clock = fakeClock(REALISTIC_NOW_MS);
      const events: MoboreaderRateGateEvent[] = [];
      const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock, (e) => events.push(e)));
      const resetAtEpochSeconds = nowSeconds + 40;
      await gate.wait("getcode");
      gate.observe!("getcode", {
        httpStatus: 200,
        gatewayHeaders: headers({ "x-ratelimit-remaining": "1", "x-ratelimit-reset": String(resetAtEpochSeconds) }),
      });
      await gate.wait("getcode");
      expect(clock.now()).toBe(REALISTIC_NOW_MS + 40_000);
      expect(events).toContainEqual({ type: "clock_skew_suspected", endpoint: "getcode", skewMs: null });
    });

    it("an unparsable Date header is treated the same as a missing one", async () => {
      const clock = fakeClock(REALISTIC_NOW_MS);
      const events: MoboreaderRateGateEvent[] = [];
      const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock, (e) => events.push(e)));
      const resetAtEpochSeconds = nowSeconds + 40;
      await gate.wait("getlistpc");
      gate.observe!("getlistpc", {
        httpStatus: 200,
        gatewayHeaders: headers({
          "x-ratelimit-remaining": "1",
          "x-ratelimit-reset": String(resetAtEpochSeconds),
          date: "not a valid http-date",
        }),
      });
      await gate.wait("getlistpc");
      expect(clock.now()).toBe(REALISTIC_NOW_MS + 40_000);
      expect(events).toContainEqual({ type: "clock_skew_suspected", endpoint: "getlistpc", skewMs: null });
    });
  });

  it("clears the floor-pause shadow once satisfied, so a later call doesn't re-pause on stale data", async () => {
    const clock = fakeClock();
    const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock));
    await gate.wait("getlistpc"); // t=0
    gate.observe!("getlistpc", { httpStatus: 200, gatewayHeaders: headers({ "x-ratelimit-remaining": "2" }) });
    await gate.wait("getlistpc"); // pauses to t=60000
    expect(clock.now()).toBe(60_000);
    await gate.wait("getlistpc"); // must NOT pause again — only the plain 1200ms interval
    expect(clock.now()).toBe(61_200);
  });

  it("only the tracked endpoint with a configured floor is throttled by remaining-quota — an untracked endpoint ignores it", async () => {
    const clock = fakeClock();
    const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock));
    await gate.wait("getbydataid");
    gate.observe!("getbydataid", { httpStatus: 200, gatewayHeaders: headers({ "x-ratelimit-remaining": "0" }) });
    await gate.wait("getbydataid");
    expect(clock.now()).toBe(1_100); // defaultIntervalMs only, no floor applies
  });
});

describe("createMoboreaderPerEndpointRateGate: 429 cooldown", () => {
  it("holds the endpoint until retry-after elapses after a 429 observation", async () => {
    const clock = fakeClock();
    const events: MoboreaderRateGateEvent[] = [];
    const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock, (e) => events.push(e)));
    await gate.wait("getcode"); // t=0
    gate.observe!("getcode", { httpStatus: 429, gatewayHeaders: headers({ "retry-after": "10" }) });
    await gate.wait("getcode");
    expect(clock.now()).toBe(10_000);
    expect(events).toContainEqual({ type: "cooldown", endpoint: "getcode", status: 429, waitMs: 10_000 });
  });

  it("uses rateWindowMaxWaitMs only as the DEFAULT when retry-after is absent — not as a cap", async () => {
    const clock = fakeClock();
    const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock));
    await gate.wait("getcode");
    gate.observe!("getcode", { httpStatus: 429, gatewayHeaders: headers({}) });
    await gate.wait("getcode");
    expect(clock.now()).toBe(60_000);
  });

  it("a 429 on one endpoint does not cool down the other endpoint's queue", async () => {
    const clock = fakeClock();
    const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock));
    await gate.wait("getcode"); // t=0
    gate.observe!("getcode", { httpStatus: 429, gatewayHeaders: headers({ "retry-after": "30" }) });
    await gate.wait("getlistpc"); // unaffected by getcode's cooldown
    expect(clock.now()).toBe(250); // just the host gap
  });

  // 2026-09-26 Opus 复核 3rd round，必改1：绝不截短一个合法的上游冷却。
  describe("[Opus fix 必改1] a legitimate upstream Retry-After is never truncated to rateWindowMaxWaitMs", () => {
    it("[mutation target] Retry-After: 120 (> the old 60s cap) -> still NOT released at t=60s, only at t=120s", async () => {
      const clock = fakeClock();
      const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock));
      await gate.wait("getcode"); // t=0
      gate.observe!("getcode", { httpStatus: 429, gatewayHeaders: headers({ "retry-after": "120" }) });
      // A second concurrent call that only needs to wait until t=60000
      // (host gap / interval) must still be held past that instant by the
      // cooldown — probing the boundary this way (rather than manually
      // sleeping 60s in the test) fails loudly if truncation regresses.
      const released = await gate.wait("getcode");
      expect(clock.now()).toBe(120_000); // NOT 60_000
      expect(released?.endpointGateWaitMs).toBe(120_000);
    });

    it("Retry-After as an HTTP-date 120s in the future is honored the same way as the delta-seconds form", async () => {
      const clock = fakeClock();
      const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock, undefined));
      await gate.wait("getcode"); // t=0 -> real epoch 0 = 1970-01-01T00:00:00Z
      gate.observe!("getcode", {
        httpStatus: 429,
        gatewayHeaders: headers({ "retry-after": new Date(120_000).toUTCString() }),
      });
      await gate.wait("getcode");
      expect(clock.now()).toBe(120_000);
    });

    it("[mutation target] an anomalously large Retry-After (e.g. 20 minutes) is honored in FULL, not silently shortened to 60s", async () => {
      const clock = fakeClock();
      const events: MoboreaderRateGateEvent[] = [];
      const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock, (e) => events.push(e)));
      const twentyMinutesSeconds = 20 * 60;
      await gate.wait("getcode"); // t=0
      gate.observe!("getcode", { httpStatus: 429, gatewayHeaders: headers({ "retry-after": String(twentyMinutesSeconds) }) });
      await gate.wait("getcode");
      expect(clock.now()).toBe(twentyMinutesSeconds * 1_000); // full 20 minutes, not capped at 60s
      expect(events).toContainEqual({
        type: "cooldown_anomaly",
        endpoint: "getcode",
        status: 429,
        waitMs: twentyMinutesSeconds * 1_000,
        thresholdMs: 900_000,
      });
    });

    it("does NOT fire cooldown_anomaly for an ordinary Retry-After under the threshold", async () => {
      const clock = fakeClock();
      const events: MoboreaderRateGateEvent[] = [];
      const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock, (e) => events.push(e)));
      await gate.wait("getcode");
      gate.observe!("getcode", { httpStatus: 429, gatewayHeaders: headers({ "retry-after": "30" }) });
      await gate.wait("getcode");
      expect(events.some((e) => e.type === "cooldown_anomaly")).toBe(false);
    });

    it("missing/invalid retry-after still falls back to rateWindowMaxWaitMs as a DEFAULT (unchanged behavior)", async () => {
      const clock = fakeClock();
      const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock));
      await gate.wait("getcode");
      gate.observe!("getcode", { httpStatus: 429, gatewayHeaders: headers({ "retry-after": "not-a-number" }) });
      await gate.wait("getcode");
      expect(clock.now()).toBe(60_000);
    });
  });
});

describe("createMoboreaderPerEndpointRateGate: missing headers never accelerate or stall (§5.2 item 5)", () => {
  it("[mutation target 5 companion] an ok response with no ratelimit headers at all leaves the endpoint's pacing untouched and fires headers_missing", async () => {
    const clock = fakeClock();
    const events: MoboreaderRateGateEvent[] = [];
    const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock, (e) => events.push(e)));
    await gate.wait("getlistpc");
    gate.observe!("getlistpc", { httpStatus: 200, gatewayHeaders: headers({}) });
    await gate.wait("getlistpc");
    expect(clock.now()).toBe(1_200); // unaffected — plain interval only
    expect(events).toContainEqual({ type: "headers_missing", endpoint: "getlistpc" });
  });

  it("does not fire headers_missing for an untracked endpoint (no floor to adapt)", async () => {
    const clock = fakeClock();
    const events: MoboreaderRateGateEvent[] = [];
    const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock, (e) => events.push(e)));
    await gate.wait("getbydataid");
    gate.observe!("getbydataid", { httpStatus: 200, gatewayHeaders: headers({}) });
    expect(events).toHaveLength(0);
  });

  it("a non-numeric remaining value is treated the same as missing (no crash, no acceleration)", async () => {
    const clock = fakeClock();
    const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock));
    await gate.wait("getlistpc");
    gate.observe!("getlistpc", { httpStatus: 200, gatewayHeaders: headers({ "x-ratelimit-remaining": "not-a-number" }) });
    await gate.wait("getlistpc");
    expect(clock.now()).toBe(1_200);
  });
});

describe("createMoboreaderPerEndpointRateGate: FIFO ordering across concurrent callers", () => {
  it("serializes concurrent wait() calls across different endpoints via the single global mutex", async () => {
    const clock = fakeClock();
    const gate = createMoboreaderPerEndpointRateGate(baseOptions(clock));
    const order: string[] = [];
    await Promise.all([
      gate.wait("getlistpc").then(() => order.push("a")),
      gate.wait("getcode").then(() => order.push("b")),
      gate.wait("getlistpc").then(() => order.push("c")),
    ]);
    expect(order).toEqual(["a", "b", "c"]);
  });
});

// ── Config resolution ──────────────────────────────────────────────────

describe("isMoboreaderPerEndpointRateGateEnabled", () => {
  it("defaults to false when unset", () => {
    expect(isMoboreaderPerEndpointRateGateEnabled({ NODE_ENV: "test" })).toBe(false);
  });

  it("is true only for the exact string 'true'", () => {
    expect(isMoboreaderPerEndpointRateGateEnabled({
      NODE_ENV: "test", [MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENV.enabled]: "true",
    })).toBe(true);
    for (const bad of ["TRUE", "1", " true", "true ", "false", ""]) {
      expect(isMoboreaderPerEndpointRateGateEnabled({
        NODE_ENV: "test", [MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENV.enabled]: bad,
      })).toBe(false);
    }
  });
});

describe("resolveMoboreaderPerEndpointRateGateConfig", () => {
  it("defaults to the design's E2-E4 recommended values with no overrides", () => {
    const config = resolveMoboreaderPerEndpointRateGateConfig({ NODE_ENV: "test" });
    expect(config).toEqual({
      enabled: false,
      endpointIntervalMs: { getlistpc: 1_200, getcode: 1_200 },
      defaultIntervalMs: 1_100,
      hostMinGapMs: 250,
      remainingFloor: { getlistpc: 8, getcode: 12 },
      rateWindowMaxWaitMs: 60_000,
      cooldownAnomalyThresholdMs: 900_000,
    });
    expect(MOBOREADER_PER_ENDPOINT_RATE_GATE_DEFAULTS.intervalMs).toBe(1_200);
  });

  it("honors every env override", () => {
    const config = resolveMoboreaderPerEndpointRateGateConfig({
      NODE_ENV: "test",
      MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS__GETLISTPC: "1500",
      MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS__GETCODE: "1500",
      MOBOREADER_UPSTREAM_HOST_MIN_GAP_MS: "300",
      MOBOREADER_UPSTREAM_REMAINING_FLOOR__GETLISTPC: "10",
      MOBOREADER_UPSTREAM_REMAINING_FLOOR__GETCODE: "15",
      MOBOREADER_UPSTREAM_RATE_WINDOW_MAX_WAIT_MS: "45000",
      MOBOREADER_UPSTREAM_RETRY_AFTER_ANOMALY_THRESHOLD_MS: "600000",
    });
    expect(config.endpointIntervalMs).toEqual({ getlistpc: 1_500, getcode: 1_500 });
    expect(config.hostMinGapMs).toBe(300);
    expect(config.remainingFloor).toEqual({ getlistpc: 10, getcode: 15 });
    expect(config.rateWindowMaxWaitMs).toBe(45_000);
    expect(config.cooldownAnomalyThresholdMs).toBe(600_000);
  });

  it("untracked-endpoint default interval reuses the EXISTING shared MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS, not the new per-endpoint default", () => {
    const config = resolveMoboreaderPerEndpointRateGateConfig({
      NODE_ENV: "test",
      MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS: "1500",
    });
    expect(config.defaultIntervalMs).toBe(1_500);
    expect(config.endpointIntervalMs).toEqual({ getlistpc: 1_200, getcode: 1_200 }); // unaffected
  });

  it.each([
    MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENV.intervalGetlistpc,
    MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENV.intervalGetcode,
  ])("fails fast when %s is below the design's 1000ms floor", (key) => {
    expect(() => resolveMoboreaderPerEndpointRateGateConfig({ NODE_ENV: "test", [key]: "999" }))
      .toThrow(MoboreaderRateLimitConfigError);
    expect(() => resolveMoboreaderPerEndpointRateGateConfig({ NODE_ENV: "test", [key]: String(MOBOREADER_PER_ENDPOINT_INTERVAL_FLOOR_MS) }))
      .not.toThrow();
  });

  it.each([
    MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENV.intervalGetlistpc,
    MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENV.intervalGetcode,
    MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENV.hostMinGapMs,
    MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENV.remainingFloorGetlistpc,
    MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENV.remainingFloorGetcode,
    MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENV.rateWindowMaxWaitMs,
    MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENV.cooldownAnomalyThresholdMs,
  ])("fails fast on a non-integer override for %s", (key) => {
    expect(() => resolveMoboreaderPerEndpointRateGateConfig({ NODE_ENV: "test", [key]: "not-a-number" }))
      .toThrow(MoboreaderRateLimitConfigError);
  });

  // 2026-09-25 Opus 复核修正：地板必须是正整数（design §5.6 "地板必须 ≥ 1"），
  // 0 会拒绝——上一版本这里允许 0 是工单交接时的笔误，不是 Owner 改口；地板是
  // getcode 撞 429（=结果不明）之前的主动减速保险，配成 0 等于一个配置就能
  // 把这道保险整体关掉。
  it("[Opus fix] rejects a remaining floor of exactly 0 — floor must be positive, not merely non-negative", () => {
    expect(() => resolveMoboreaderPerEndpointRateGateConfig({
      NODE_ENV: "test",
      MOBOREADER_UPSTREAM_REMAINING_FLOOR__GETLISTPC: "0",
    })).toThrow(MoboreaderRateLimitConfigError);
    expect(() => resolveMoboreaderPerEndpointRateGateConfig({
      NODE_ENV: "test",
      MOBOREADER_UPSTREAM_REMAINING_FLOOR__GETCODE: "0",
    })).toThrow(MoboreaderRateLimitConfigError);
  });

  it("accepts a remaining floor of exactly 1 (the minimum legal value)", () => {
    const config = resolveMoboreaderPerEndpointRateGateConfig({
      NODE_ENV: "test",
      MOBOREADER_UPSTREAM_REMAINING_FLOOR__GETLISTPC: "1",
    });
    expect(config.remainingFloor.getlistpc).toBe(1);
  });

  it("rejects a negative remaining floor", () => {
    expect(() => resolveMoboreaderPerEndpointRateGateConfig({
      NODE_ENV: "test",
      MOBOREADER_UPSTREAM_REMAINING_FLOOR__GETCODE: "-1",
    })).toThrow(MoboreaderRateLimitConfigError);
  });

  it("allows a host min gap of exactly 0", () => {
    const config = resolveMoboreaderPerEndpointRateGateConfig({
      NODE_ENV: "test",
      MOBOREADER_UPSTREAM_HOST_MIN_GAP_MS: "0",
    });
    expect(config.hostMinGapMs).toBe(0);
  });
});

// ── Module-load singleton (switch decides which kind of gate is built) ──

describe("moboreaderUpstreamRateGate singleton: switch decides legacy vs. per-endpoint at module load", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("[design §9.1 item 1] switch off (unset) builds a plain MoboreaderRateGate with no observe() — the pre-RC-4 shape", async () => {
    delete process.env.MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENABLED;
    const mod = await import("@/lib/adapters/moboreader-rate-limit");
    expect(mod.moboreaderUpstreamRateGate.observe).toBeUndefined();
  });

  it("[mutation target 4] switch on builds a per-endpoint gate (exposes observe())", async () => {
    vi.stubEnv("MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENABLED", "true");
    const mod = await import("@/lib/adapters/moboreader-rate-limit");
    expect(typeof mod.moboreaderUpstreamRateGate.observe).toBe("function");
  });

  it("switch on with a malformed per-endpoint value falls back to the legacy gate rather than crashing process startup", async () => {
    vi.stubEnv("MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENABLED", "true");
    vi.stubEnv("MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS__GETLISTPC", "not-a-number");
    const mod = await import("@/lib/adapters/moboreader-rate-limit");
    expect(mod.moboreaderUpstreamRateGate.observe).toBeUndefined();
  });
});
