import { describe, expect, it } from "vitest";

import {
  isCircuitBreakerEligibleFailureCode,
  maybeTripPromoLinkClaimCircuitBreaker,
  PROMO_LINK_CLAIM_CIRCUIT_BREAKER_REASON,
} from "../../../worker/handlers/promo-link-claim-circuit-breaker";
import { PROMO_LINK_CLAIM_LIMITS } from "@/lib/tasks/promo-link-claim-limits";

/**
 * The breaker exists because the 2026-09-14 batch ground through 43,891 items
 * at ~10ms each, every one failing the same deterministic way, before anyone
 * stopped it. Two properties matter equally: it must halt on a systemic
 * failure, and it must NOT halt on transient ones — those are precisely what
 * per-item retry is for, and a breaker that trips on them would turn a blip
 * into an outage.
 */
const THRESHOLD = PROMO_LINK_CLAIM_LIMITS.breakerConsecutiveFailureThreshold;
const TASK = "22222222-2222-4222-8222-222222222222";
const ITEM = "33333333-3333-4333-8333-333333333333";

type FakeTx = Parameters<typeof maybeTripPromoLinkClaimCircuitBreaker>[0];

function fakeTx(options: {
  siblings: Array<{ status: string; code: string | null }>;
  parentStatus?: string;
}) {
  const calls = { queryRaw: 0, update: 0, updateMany: 0, audit: 0 };
  const tx = {
    $queryRaw: async () => {
      calls.queryRaw += 1;
      // First call: recent finalized sibling outcomes. Second: the FOR UPDATE
      // lock on the parent task row.
      return calls.queryRaw === 1
        ? options.siblings
        : (options.parentStatus === undefined ? [] : [{ status: options.parentStatus }]);
    },
    genericTask: { update: async () => { calls.update += 1; return {}; } },
    genericTaskItem: { updateMany: async () => { calls.updateMany += 1; return { count: 7 }; } },
    channelSyncTaskItem: { updateMany: async () => ({ count: 0 }) },
    operationAudit: { create: async () => { calls.audit += 1; return {}; } },
  } as unknown as FakeTx;
  return { tx, calls };
}

const det = "credential_validation_failed";
const failed = (code: string) => ({ status: "failed", code });

describe("promo-link-claim circuit breaker", () => {
  describe("failure classification", () => {
    it.each(["credential_missing", "credential_expired", "credential_ambiguous", "credential_validation_failed", "credential_invalid"])(
      "counts %s as deterministic", (code) => expect(isCircuitBreakerEligibleFailureCode(code)).toBe(true));

    it.each(["upstream_timeout", "rate_limited", "network_error", "stale_processing", "unknown"])(
      "never counts transient %s", (code) => expect(isCircuitBreakerEligibleFailureCode(code)).toBe(false));
  });

  it("does not trip on a transient failure, and does not even query the database", async () => {
    const { tx, calls } = fakeTx({ siblings: [], parentStatus: "processing" });
    expect(await maybeTripPromoLinkClaimCircuitBreaker(tx, { taskId: TASK, itemId: ITEM, failureCode: "rate_limited" }))
      .toEqual({ tripped: false });
    expect(calls.queryRaw).toBe(0);
    expect(calls.update).toBe(0);
  });

  it("does not trip on isolated deterministic failures below the threshold", async () => {
    // One prior failure when the threshold needs THRESHOLD-1 priors.
    const { tx, calls } = fakeTx({ siblings: [failed(det)], parentStatus: "processing" });
    expect(await maybeTripPromoLinkClaimCircuitBreaker(tx, { taskId: TASK, itemId: ITEM, failureCode: det }))
      .toEqual({ tripped: false });
    expect(calls.update).toBe(0);
  });

  it("does not trip when the streak is broken by a non-failure sibling", async () => {
    const siblings = [failed(det), { status: "success", code: null }].slice(0, THRESHOLD - 1);
    const { tx, calls } = fakeTx({ siblings, parentStatus: "processing" });
    expect(await maybeTripPromoLinkClaimCircuitBreaker(tx, { taskId: TASK, itemId: ITEM, failureCode: det }))
      .toEqual({ tripped: false });
    expect(calls.update).toBe(0);
  });

  it("does not trip when a prior failure was a different, transient class", async () => {
    const siblings = Array.from({ length: THRESHOLD - 1 }, (_, i) => failed(i === 0 ? "rate_limited" : det));
    const { tx, calls } = fakeTx({ siblings, parentStatus: "processing" });
    expect(await maybeTripPromoLinkClaimCircuitBreaker(tx, { taskId: TASK, itemId: ITEM, failureCode: det }))
      .toEqual({ tripped: false });
    expect(calls.update).toBe(0);
  });

  it("trips once the consecutive deterministic streak reaches the threshold", async () => {
    const siblings = Array.from({ length: THRESHOLD - 1 }, () => failed(det));
    const { tx, calls } = fakeTx({ siblings, parentStatus: "processing" });
    const outcome = await maybeTripPromoLinkClaimCircuitBreaker(tx, { taskId: TASK, itemId: ITEM, failureCode: det });
    expect(outcome.tripped).toBe(true);
    expect(calls.update).toBe(1);      // parent driven terminal
    expect(calls.updateMany).toBe(1);  // still-pending children cascaded
    expect(calls.audit).toBe(1);       // trip is auditable, not silent
    expect(PROMO_LINK_CLAIM_CIRCUIT_BREAKER_REASON).toBe("circuit_breaker_tripped");
  });

  it("does not trip a parent that already left the runnable set", async () => {
    const siblings = Array.from({ length: THRESHOLD - 1 }, () => failed(det));
    const { tx, calls } = fakeTx({ siblings, parentStatus: "disabled" });
    expect(await maybeTripPromoLinkClaimCircuitBreaker(tx, { taskId: TASK, itemId: ITEM, failureCode: det }))
      .toEqual({ tripped: false });
    expect(calls.update).toBe(0);
  });
});
