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
  createMoboreaderPerEndpointRateGate,
  isMoboreaderPerEndpointRateGateEnabled,
  resolveMoboreaderPerEndpointRateGateConfig,
  type MoboreaderRateGateEvent,
} from "@/lib/adapters/moboreader-rate-limit";

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

  it("caps the cooldown at rateWindowMaxWaitMs when retry-after is absent/huge", async () => {
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
    });
    expect(config.endpointIntervalMs).toEqual({ getlistpc: 1_500, getcode: 1_500 });
    expect(config.hostMinGapMs).toBe(300);
    expect(config.remainingFloor).toEqual({ getlistpc: 10, getcode: 15 });
    expect(config.rateWindowMaxWaitMs).toBe(45_000);
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
  ])("fails fast on a non-integer override for %s", (key) => {
    expect(() => resolveMoboreaderPerEndpointRateGateConfig({ NODE_ENV: "test", [key]: "not-a-number" }))
      .toThrow(MoboreaderRateLimitConfigError);
  });

  it("allows a remaining floor of exactly 0 (non-negative, not positive)", () => {
    const config = resolveMoboreaderPerEndpointRateGateConfig({
      NODE_ENV: "test",
      MOBOREADER_UPSTREAM_REMAINING_FLOOR__GETLISTPC: "0",
    });
    expect(config.remainingFloor.getlistpc).toBe(0);
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
