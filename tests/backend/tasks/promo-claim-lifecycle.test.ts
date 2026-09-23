import { describe, expect, it } from "vitest";

import {
  computeEffectiveDeadlineWithGrace,
  computeShardDeadline,
  computeShardSize,
  evaluateCredentialReadiness,
  isApprovalExpired,
  isPastDeadlineWithGrace,
  isPromoClaimLifecycleEnabled,
  isPromoClaimSystemHoldReasonCode,
  PROMO_CLAIM_LIFECYCLE_DEFAULTS,
  PROMO_CLAIM_LIFECYCLE_ENV,
  PROMO_CLAIM_LIFECYCLE_VERSION,
  PROMO_CLAIM_SHARD_LIFECYCLE_TAG,
  PROMO_CLAIM_SYSTEM_HOLD_REASON_CODES,
  PromoClaimLifecycleConfigError,
  resolvePromoClaimLifecycleConfig,
} from "@/lib/tasks/promo-claim-lifecycle";

/**
 * 领推广链接生命周期，正式修复第 2 阶段第 1 步（`docs/adr/ADR-PROMO-CLAIM-
 * BATCH-LIFECYCLE.md`）——本模块是纯逻辑（不访问数据库、不读密钥），这里覆盖
 * 分片大小 / 批准时钟 / 凭据就绪 / 截止时间与宽限 / 配置解析五组判定的边界。
 */

describe("promo-claim-lifecycle: constants", () => {
  it("pins the lifecycle version and shard payload tag", () => {
    expect(PROMO_CLAIM_LIFECYCLE_VERSION).toBe(1);
    expect(PROMO_CLAIM_SHARD_LIFECYCLE_TAG).toBe("shard_v1");
  });

  it("recognizes exactly the five frozen system_hold reason codes", () => {
    expect(PROMO_CLAIM_SYSTEM_HOLD_REASON_CODES).toEqual([
      "approval_expired",
      "credential_not_ready",
      "deadline_missed",
      "deadline_missed_twice",
      "lifecycle_disabled",
    ]);
    for (const code of PROMO_CLAIM_SYSTEM_HOLD_REASON_CODES) {
      expect(isPromoClaimSystemHoldReasonCode(code)).toBe(true);
    }
    expect(isPromoClaimSystemHoldReasonCode("credential_validation_failed")).toBe(false);
    expect(isPromoClaimSystemHoldReasonCode(123)).toBe(false);
  });
});

/** `NodeJS.ProcessEnv` (this repo's global augmentation) requires `NODE_ENV`; every fixture below merges it in so the object literal can stay focused on the variable(s) under test. */
function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides };
}

describe("promo-claim-lifecycle: feature flag (default false, exact 'true')", () => {
  it("is disabled when the env var is absent", () => {
    expect(isPromoClaimLifecycleEnabled(env())).toBe(false);
  });

  it("is enabled only for the exact string 'true'", () => {
    expect(isPromoClaimLifecycleEnabled(env({ [PROMO_CLAIM_LIFECYCLE_ENV.enabled]: "true" }))).toBe(true);
    for (const value of ["TRUE", "1", "yes", "on", " true", "true "]) {
      expect(isPromoClaimLifecycleEnabled(env({ [PROMO_CLAIM_LIFECYCLE_ENV.enabled]: value }))).toBe(false);
    }
  });
});

describe("promo-claim-lifecycle: config resolution (fail-closed on bad values)", () => {
  it("resolves the documented defaults when nothing is set", () => {
    expect(resolvePromoClaimLifecycleConfig(env())).toEqual({
      enabled: false,
      approvalTtlMinutes: 1_440,
      shardWindowMinutes: 90,
      shardSizeMin: 50,
      shardSizeMax: 1_000,
      credentialSafetyMarginMinutes: 30,
      deadlineGraceMinutes: 10,
    });
  });

  it("reads every override", () => {
    expect(resolvePromoClaimLifecycleConfig(env({
      [PROMO_CLAIM_LIFECYCLE_ENV.enabled]: "true",
      [PROMO_CLAIM_LIFECYCLE_ENV.approvalTtlMinutes]: "60",
      [PROMO_CLAIM_LIFECYCLE_ENV.shardWindowMinutes]: "30",
      [PROMO_CLAIM_LIFECYCLE_ENV.shardSizeMin]: "10",
      [PROMO_CLAIM_LIFECYCLE_ENV.shardSizeMax]: "200",
      [PROMO_CLAIM_LIFECYCLE_ENV.credentialSafetyMarginMinutes]: "5",
      [PROMO_CLAIM_LIFECYCLE_ENV.deadlineGraceMinutes]: "1",
    }))).toEqual({
      enabled: true,
      approvalTtlMinutes: 60,
      shardWindowMinutes: 30,
      shardSizeMin: 10,
      shardSizeMax: 200,
      credentialSafetyMarginMinutes: 5,
      deadlineGraceMinutes: 1,
    });
  });

  it("allows a zero safety margin / grace (non-negative, not strictly positive)", () => {
    const config = resolvePromoClaimLifecycleConfig(env({
      [PROMO_CLAIM_LIFECYCLE_ENV.credentialSafetyMarginMinutes]: "0",
      [PROMO_CLAIM_LIFECYCLE_ENV.deadlineGraceMinutes]: "0",
    }));
    expect(config.credentialSafetyMarginMinutes).toBe(0);
    expect(config.deadlineGraceMinutes).toBe(0);
  });

  it("throws PromoClaimLifecycleConfigError, not a silent fallback, for a non-integer positive-only field", () => {
    for (const variable of [
      PROMO_CLAIM_LIFECYCLE_ENV.approvalTtlMinutes,
      PROMO_CLAIM_LIFECYCLE_ENV.shardWindowMinutes,
      PROMO_CLAIM_LIFECYCLE_ENV.shardSizeMin,
      PROMO_CLAIM_LIFECYCLE_ENV.shardSizeMax,
    ]) {
      expect(() => resolvePromoClaimLifecycleConfig(env({ [variable]: "0" }))).toThrow(PromoClaimLifecycleConfigError);
      expect(() => resolvePromoClaimLifecycleConfig(env({ [variable]: "-1" }))).toThrow(PromoClaimLifecycleConfigError);
      expect(() => resolvePromoClaimLifecycleConfig(env({ [variable]: "3.5" }))).toThrow(PromoClaimLifecycleConfigError);
      expect(() => resolvePromoClaimLifecycleConfig(env({ [variable]: "not-a-number" }))).toThrow(PromoClaimLifecycleConfigError);
    }
  });

  it("throws for a negative non-negative-only field but allows zero", () => {
    expect(() => resolvePromoClaimLifecycleConfig(env({
      [PROMO_CLAIM_LIFECYCLE_ENV.credentialSafetyMarginMinutes]: "-1",
    }))).toThrow(PromoClaimLifecycleConfigError);
    expect(() => resolvePromoClaimLifecycleConfig(env({
      [PROMO_CLAIM_LIFECYCLE_ENV.deadlineGraceMinutes]: "-1",
    }))).toThrow(PromoClaimLifecycleConfigError);
  });

  it("fails closed when shardSizeMin exceeds shardSizeMax", () => {
    expect(() => resolvePromoClaimLifecycleConfig(env({
      [PROMO_CLAIM_LIFECYCLE_ENV.shardSizeMin]: "2000",
      [PROMO_CLAIM_LIFECYCLE_ENV.shardSizeMax]: "1000",
    }))).toThrow(PromoClaimLifecycleConfigError);
  });
});

describe("computeShardSize (D3): S = clamp(floor(0.7 * windowMinutes * 60 / p90), min, max)", () => {
  const bounds = { min: PROMO_CLAIM_LIFECYCLE_DEFAULTS.shardSizeMin, max: PROMO_CLAIM_LIFECYCLE_DEFAULTS.shardSizeMax };

  // fallback p90 = 5s (PROMO_CLAIM_LIFECYCLE_DEFAULTS.fallbackP90ItemSeconds);
  // floor(0.7 * 90 * 60 / 5) = floor(3780 / 5) = 756, comfortably inside [50, 1000].
  it("uses the 5-second fallback when p90 is missing", () => {
    expect(computeShardSize({ p90ItemSeconds: undefined, windowMinutes: 90, ...bounds })).toBe(756);
    expect(computeShardSize({ p90ItemSeconds: null, windowMinutes: 90, ...bounds })).toBe(756);
  });

  it("uses the 5-second fallback for a non-positive or non-finite p90", () => {
    expect(computeShardSize({ p90ItemSeconds: 0, windowMinutes: 90, ...bounds })).toBe(756);
    expect(computeShardSize({ p90ItemSeconds: -3, windowMinutes: 90, ...bounds })).toBe(756);
    expect(computeShardSize({ p90ItemSeconds: Number.NaN, windowMinutes: 90, ...bounds })).toBe(756);
    expect(computeShardSize({ p90ItemSeconds: Number.POSITIVE_INFINITY, windowMinutes: 90, ...bounds })).toBe(756);
  });

  it("computes the real-world-shaped figure the design cites (~840 at ~4.5s/item, 90-minute window)", () => {
    expect(computeShardSize({ p90ItemSeconds: 4.5, windowMinutes: 90, ...bounds })).toBe(840);
  });

  it("clamps a tiny result up to the floor (large p90 -> shard would round to 0)", () => {
    expect(computeShardSize({ p90ItemSeconds: 100_000, windowMinutes: 90, ...bounds })).toBe(50);
  });

  it("clamps an oversized result down to the ceiling (tiny p90 -> shard would be huge)", () => {
    expect(computeShardSize({ p90ItemSeconds: 0.01, windowMinutes: 90, ...bounds })).toBe(1_000);
  });

  it("respects a custom min/max window distinct from the documented defaults", () => {
    expect(computeShardSize({ p90ItemSeconds: 5, windowMinutes: 30, min: 5, max: 100 })).toBe(100);
    expect(computeShardSize({ p90ItemSeconds: 5, windowMinutes: 30, min: 5, max: 1_000 })).toBe(252);
  });
});

describe("isApprovalExpired (D1): only the pre-first-release approval window", () => {
  const now = new Date("2026-09-23T12:00:00.000Z");

  it("returns false forever once a first shard has been released, regardless of approvalValidUntil", () => {
    expect(isApprovalExpired({
      firstReleasedAt: "2026-01-01T00:00:00.000Z",
      approvalValidUntil: "2020-01-01T00:00:00.000Z", // long past, but must not matter
      now,
    })).toBe(false);
  });

  it("returns false before the approval deadline when never released", () => {
    expect(isApprovalExpired({
      firstReleasedAt: null,
      approvalValidUntil: "2026-09-23T12:00:00.001Z",
      now,
    })).toBe(false);
  });

  it("returns true once the approval deadline has passed and nothing was ever released", () => {
    expect(isApprovalExpired({
      firstReleasedAt: null,
      approvalValidUntil: "2026-09-23T11:59:59.999Z",
      now,
    })).toBe(true);
  });

  it("treats the exact boundary instant as expired (>=, not >)", () => {
    expect(isApprovalExpired({ firstReleasedAt: null, approvalValidUntil: now.toISOString(), now })).toBe(true);
  });

  it("fails closed (treated as expired) when approvalValidUntil is missing or unparsable and nothing was released", () => {
    expect(isApprovalExpired({ firstReleasedAt: undefined, approvalValidUntil: null, now })).toBe(true);
    expect(isApprovalExpired({ firstReleasedAt: undefined, approvalValidUntil: "not-a-date", now })).toBe(true);
  });
});

describe("evaluateCredentialReadiness (D5): all three conditions independently checked", () => {
  const now = new Date("2026-09-23T12:00:00.000Z");
  const createdAt = new Date("2026-09-01T00:00:00.000Z");
  const windowMinutes = 90;
  const safetyMarginMinutes = 30;
  const exactlyReadyExpiresAt = new Date(now.valueOf() + (windowMinutes + safetyMarginMinutes) * 60_000);

  function baseInput(overrides: Partial<Parameters<typeof evaluateCredentialReadiness>[0]> = {}) {
    return {
      status: "active",
      lastValidatedAt: new Date("2026-09-02T00:00:00.000Z"),
      expiresAt: exactlyReadyExpiresAt,
      createdAt,
      now,
      windowMinutes,
      safetyMarginMinutes,
      ...overrides,
    };
  }

  it("is ready when all three conditions are satisfied", () => {
    expect(evaluateCredentialReadiness(baseInput())).toEqual({ ready: true, reasons: [] });
  });

  it("fails on status alone", () => {
    expect(evaluateCredentialReadiness(baseInput({ status: "revoked" }))).toEqual({
      ready: false,
      reasons: ["status_not_active"],
    });
  });

  it("fails when lastValidatedAt is absent", () => {
    expect(evaluateCredentialReadiness(baseInput({ lastValidatedAt: null }))).toEqual({
      ready: false,
      reasons: ["not_validated"],
    });
  });

  it("fails when lastValidatedAt predates createdAt (stale validation carried over from a superseded row)", () => {
    expect(evaluateCredentialReadiness(baseInput({ lastValidatedAt: new Date("2026-08-31T23:59:59.999Z") }))).toEqual({
      ready: false,
      reasons: ["validated_before_creation"],
    });
  });

  it("treats lastValidatedAt exactly equal to createdAt as valid (>=, not >)", () => {
    expect(evaluateCredentialReadiness(baseInput({ lastValidatedAt: createdAt }))).toEqual({ ready: true, reasons: [] });
  });

  it("fails when expiresAt is absent", () => {
    expect(evaluateCredentialReadiness(baseInput({ expiresAt: null }))).toEqual({
      ready: false,
      reasons: ["expires_at_missing"],
    });
  });

  it("fails when expiresAt is one millisecond short of window + safety margin", () => {
    expect(evaluateCredentialReadiness(baseInput({
      expiresAt: new Date(exactlyReadyExpiresAt.valueOf() - 1),
    }))).toEqual({ ready: false, reasons: ["expires_too_soon"] });
  });

  it("treats expiresAt exactly at the window + safety margin boundary as ready (>=, not >)", () => {
    expect(evaluateCredentialReadiness(baseInput({ expiresAt: exactlyReadyExpiresAt }))).toEqual({
      ready: true,
      reasons: [],
    });
  });

  it("reports every failing reason at once, not just the first", () => {
    const result = evaluateCredentialReadiness(baseInput({
      status: "revoked",
      lastValidatedAt: null,
      expiresAt: null,
    }));
    expect(result.ready).toBe(false);
    expect(result.reasons).toEqual(["status_not_active", "not_validated", "expires_at_missing"]);
  });
});

describe("deadline + grace (§5.6/§5.7 second line of defense)", () => {
  it("computeShardDeadline adds the window to the release instant", () => {
    const releasedAt = new Date("2026-09-23T00:00:00.000Z");
    expect(computeShardDeadline(releasedAt, 90).toISOString()).toBe("2026-09-23T01:30:00.000Z");
  });

  it("computeEffectiveDeadlineWithGrace adds the grace period to the deadline", () => {
    const deadlineAt = new Date("2026-09-23T01:30:00.000Z");
    expect(computeEffectiveDeadlineWithGrace(deadlineAt, 10).toISOString()).toBe("2026-09-23T01:40:00.000Z");
  });

  it("is not past deadline+grace before the effective instant", () => {
    const deadlineAt = "2026-09-23T01:30:00.000Z";
    const now = new Date("2026-09-23T01:39:59.999Z"); // 1ms before deadline+10min grace
    expect(isPastDeadlineWithGrace(deadlineAt, 10, now)).toBe(false);
  });

  it("treats the exact deadline+grace instant as past (>=, not >)", () => {
    const deadlineAt = "2026-09-23T01:30:00.000Z";
    const now = new Date("2026-09-23T01:40:00.000Z");
    expect(isPastDeadlineWithGrace(deadlineAt, 10, now)).toBe(true);
  });

  it("is past deadline+grace well after the effective instant", () => {
    const deadlineAt = "2026-09-23T01:30:00.000Z";
    const now = new Date("2026-09-23T02:00:00.000Z");
    expect(isPastDeadlineWithGrace(deadlineAt, 10, now)).toBe(true);
  });

  it("fails closed (treated as expired) when deadlineAt is missing or unparsable", () => {
    const now = new Date("2026-09-23T00:00:00.000Z");
    expect(isPastDeadlineWithGrace(null, 10, now)).toBe(true);
    expect(isPastDeadlineWithGrace(undefined, 10, now)).toBe(true);
    expect(isPastDeadlineWithGrace("not-a-date", 10, now)).toBe(true);
  });
});
