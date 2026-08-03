import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
  MAX_SHUTDOWN_DRAIN_TIMEOUT_MS,
  ShutdownDrainTimeoutConfigError,
  parseShutdownDrainTimeoutEnv,
  processOneWorkerCycle,
} from "../../../worker/runtime";

describe("P1-07R shutdown drain timeout bounds", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [undefined, DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS],
    ["1", 1],
    ["30000", 30_000],
    ["600000", MAX_SHUTDOWN_DRAIN_TIMEOUT_MS],
  ])("strictly parses env value %s", (value, expected) => {
    expect(parseShutdownDrainTimeoutEnv(value)).toBe(expected);
  });

  it.each([
    "",
    "0",
    "-1",
    "1.5",
    "NaN",
    "Infinity",
    "600001",
    String(Number.MAX_SAFE_INTEGER),
    "1e3",
    "1000ms",
    " 1000",
    "1000 ",
  ])("rejects ambiguous or out-of-range env value %s", (value) => {
    expect(() => parseShutdownDrainTimeoutEnv(value)).toThrow(ShutdownDrainTimeoutConfigError);
  });

  function runtimeCycle(timeoutMs: number) {
    return processOneWorkerCycle({
      prisma: {} as PrismaClient,
      workerId: "timeout-bound-test",
      handlers: {},
      allowlist: { requested: [], effective: [], invalid: [], willConsume: false },
      signal: new AbortController().signal,
      shutdownDrainTimeoutMs: timeoutMs,
    });
  }

  it.each([1, DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS, MAX_SHUTDOWN_DRAIN_TIMEOUT_MS])(
    "accepts bounded runtime option %s before consumption",
    async (value) => {
      await expect(runtimeCycle(value)).resolves.toBe(false);
    },
  );

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    MAX_SHUTDOWN_DRAIN_TIMEOUT_MS + 1,
    Number.MAX_SAFE_INTEGER,
  ])("rejects invalid runtime option %s before timers", async (value) => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const warnings: Error[] = [];
    const onWarning = (warning: Error) => warnings.push(warning);
    process.on("warning", onWarning);
    try {
      await expect(runtimeCycle(value)).rejects.toBeInstanceOf(ShutdownDrainTimeoutConfigError);
      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect(warnings.some((warning) => warning.name === "TimeoutOverflowWarning")).toBe(false);
    } finally {
      process.removeListener("warning", onWarning);
    }
  });
});
