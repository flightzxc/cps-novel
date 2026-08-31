import { describe, expect, it } from "vitest";
import { isAllowedSideEffectTransition } from "@/lib/tasks";

describe("P1-07 side-effect intent state boundary", () => {
  it("routes unknown outcomes to a blocked state and permits confirmation only after readback", () => {
    expect(isAllowedSideEffectTransition("prepared", "claim_retry_blocked")).toBe(true);
    expect(isAllowedSideEffectTransition("claim_retry_blocked", "confirmed")).toBe(true);
    expect(isAllowedSideEffectTransition("claim_retry_blocked", "failed")).toBe(false);
    expect(isAllowedSideEffectTransition("claim_retry_blocked", "manual_review_required")).toBe(true);
    expect(isAllowedSideEffectTransition("manual_review_required", "confirmed")).toBe(false);
    expect(isAllowedSideEffectTransition("manual_review_required", "failed")).toBe(false);
  });
});
