import { describe, expect, it } from "vitest";

import {
  chunkIndexNowDeliveries,
  classifyIndexNowResult,
  computeRetryDelayMs,
  parseRetryAfter,
  resolveOutboxDeliveryStatus,
  summarizeIndexNowValue,
  INDEXNOW_HTTP_BATCH_SIZE,
} from "@/lib/indexnow/delivery-primitives";

describe("chunkIndexNowDeliveries", () => {
  it("splits into batches of the given size", () => {
    const rows = Array.from({ length: 12 }, (_, i) => i);
    expect(chunkIndexNowDeliveries(rows, 5)).toEqual([[0, 1, 2, 3, 4], [5, 6, 7, 8, 9], [10, 11]]);
  });

  it("defaults to the protocol batch size ceiling", () => {
    expect(chunkIndexNowDeliveries([1, 2, 3])).toEqual([[1, 2, 3]]);
    expect(INDEXNOW_HTTP_BATCH_SIZE).toBe(500);
  });

  it("returns an empty array for an empty input", () => {
    expect(chunkIndexNowDeliveries([])).toEqual([]);
  });
});

describe("summarizeIndexNowValue", () => {
  it("redacts key/token/secret query params", () => {
    expect(summarizeIndexNowValue("failed at ?key=abc123&other=1")).toContain("key=[REDACTED]");
    expect(summarizeIndexNowValue("failed at ?key=abc123&other=1")).not.toContain("abc123");
  });

  it("redacts JSON-shaped key/keyLocation/authorization/cookie fields", () => {
    const value = '{"key":"super-secret","keyLocation":"https://x/key.txt"}';
    const summary = summarizeIndexNowValue(value);
    expect(summary).not.toContain("super-secret");
  });

  it("redacts Bearer tokens", () => {
    expect(summarizeIndexNowValue("Authorization: Bearer abc.def-123")).toContain("Bearer [REDACTED]");
  });

  it("truncates to 500 characters", () => {
    expect(summarizeIndexNowValue("x".repeat(1000)).length).toBe(500);
  });

  it("stringifies an Error's message", () => {
    expect(summarizeIndexNowValue(new Error("boom"))).toBe("boom");
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfter("120")).toBe(120_000);
  });

  it("parses an HTTP-date relative to now", () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const future = new Date(now + 60_000).toUTCString();
    expect(parseRetryAfter(future, now)).toBe(60_000);
  });

  it("returns 0 for missing or unparseable input", () => {
    expect(parseRetryAfter(null)).toBe(0);
    expect(parseRetryAfter("not-a-date-or-number")).toBe(0);
  });
});

describe("computeRetryDelayMs", () => {
  it("grows exponentially and caps at 6 hours", () => {
    const delay1 = computeRetryDelayMs(1, 0, 0);
    const delay2 = computeRetryDelayMs(2, 0, 0);
    expect(delay1).toBe(5 * 60_000);
    expect(delay2).toBe(10 * 60_000);
    expect(computeRetryDelayMs(20, 0, 0)).toBe(6 * 60 * 60_000);
  });

  it("adds up to 20% jitter (clamped just under the full 1.2x ceiling)", () => {
    // jitter is clamped to 0.999999, not 1, so the max multiplier is
    // (1 + 0.999999 * 0.2) rather than exactly 1.2 — assert against the
    // same computation the implementation performs, not a rounded constant.
    const base = 5 * 60_000;
    expect(computeRetryDelayMs(1, 1, 0)).toBe(Math.floor(base * (1 + 0.999999 * 0.2)));
    expect(computeRetryDelayMs(1, 1, 0)).toBeLessThan(Math.floor(base * 1.2));
  });

  it("is floored by a server-supplied Retry-After", () => {
    expect(computeRetryDelayMs(1, 0, 999_999)).toBe(999_999);
  });
});

describe("classifyIndexNowResult", () => {
  it("classifies 200/202 as accepted", () => {
    expect(classifyIndexNowResult(200)).toBe("accepted");
    expect(classifyIndexNowResult(202)).toBe("accepted");
  });

  it("classifies 400/403/422 as permanent_failed", () => {
    expect(classifyIndexNowResult(400)).toBe("permanent_failed");
    expect(classifyIndexNowResult(403)).toBe("permanent_failed");
    expect(classifyIndexNowResult(422)).toBe("permanent_failed");
  });

  it("classifies 429/5xx/network errors as retryable_failed", () => {
    expect(classifyIndexNowResult(429)).toBe("retryable_failed");
    expect(classifyIndexNowResult(500)).toBe("retryable_failed");
    expect(classifyIndexNowResult(null, "timeout")).toBe("retryable_failed");
    expect(classifyIndexNowResult(null, "network")).toBe("retryable_failed");
  });
});

describe("resolveOutboxDeliveryStatus", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");

  it("accepted -> terminal accepted, no next attempt", () => {
    expect(resolveOutboxDeliveryStatus("accepted", 1, 5, now)).toEqual({ status: "accepted", nextAttemptAt: null });
  });

  it("permanent_failed -> terminal permanent_failed, no next attempt", () => {
    expect(resolveOutboxDeliveryStatus("permanent_failed", 1, 5, now)).toEqual({
      status: "permanent_failed",
      nextAttemptAt: null,
    });
  });

  it("retryable_failed under budget -> retry_wait with a future nextAttemptAt", () => {
    const decision = resolveOutboxDeliveryStatus("retryable_failed", 2, 5, now, 0);
    expect(decision.status).toBe("retry_wait");
    expect(decision.nextAttemptAt).not.toBeNull();
    expect((decision.nextAttemptAt as Date).getTime()).toBeGreaterThan(now.getTime());
  });

  it("retryable_failed at attempt budget -> dead_letter, no next attempt", () => {
    expect(resolveOutboxDeliveryStatus("retryable_failed", 5, 5, now)).toEqual({
      status: "dead_letter",
      nextAttemptAt: null,
    });
  });

  it("retryable_failed beyond budget -> still dead_letter (defensive)", () => {
    expect(resolveOutboxDeliveryStatus("retryable_failed", 6, 5, now).status).toBe("dead_letter");
  });
});
