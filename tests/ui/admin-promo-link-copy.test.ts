import { describe, expect, it } from "vitest";

import { promoLinkErrorKindCopy, promoLinkStatusLabel } from "@/app/(admin)/promo-links/_lib/promo-link-copy";

/**
 * `errorKind` human-copy mapping — traced to `worker/handlers/promo-link-claim.ts`'s
 * write paths (this task's brief specifically calls out
 * `existing_evidence_redacted` and `claim_manual_review_required` as the two
 * that most need a plain-language explanation).
 */
describe("promo-link-copy · errorKind mapping", () => {
  it("explains existing_evidence_redacted as local evidence being redacted, not a real absence", () => {
    const copy = promoLinkErrorKindCopy("pending", "existing_evidence_redacted");
    expect(copy.label).toContain("脱敏");
    expect(copy.explanation).toContain("脱敏");
    expect(copy.actionable).toBe(false);
  });

  it("explains claim_manual_review_required as needing a trip to the task center's manual-review queue, and marks it actionable", () => {
    const copy = promoLinkErrorKindCopy("pending", "claim_manual_review_required");
    expect(copy.explanation).toContain("人工审查");
    expect(copy.actionable).toBe(true);
  });

  it("distinguishes a `pending` row with no error (never attempted) from a `fetched` row with no error (succeeded)", () => {
    const pending = promoLinkErrorKindCopy("pending", null);
    const fetched = promoLinkErrorKindCopy("fetched", null);
    expect(pending.label).not.toBe(fetched.label);
    expect(pending.label).toContain("尚未");
    expect(fetched.label).toContain("成功");
  });

  it("gives every known errorKind its own label — none silently collapse to the same text", () => {
    const kinds = [
      "existing_evidence_redacted",
      "claim_manual_review_required",
      "capability_disabled",
      "endpoint_not_evidenced",
      "transport_error",
      "request_timeout",
      "upstream_http_error",
      "malformed_payload",
    ];
    const labels = kinds.map((kind) => promoLinkErrorKindCopy("failed", kind).label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("falls back to a visible, non-crashing label for an unregistered errorKind rather than throwing", () => {
    const copy = promoLinkErrorKindCopy("failed", "some_future_code");
    expect(copy.label).toBe("some_future_code");
    expect(copy.actionable).toBe(false);
  });
});

describe("promo-link-copy · status labels", () => {
  it("labels all four known statuses", () => {
    expect(promoLinkStatusLabel("pending")).toBe("待处理");
    expect(promoLinkStatusLabel("fetched")).toBe("已获取");
    expect(promoLinkStatusLabel("failed")).toBe("失败");
    expect(promoLinkStatusLabel("registered_disabled")).toBe("能力已冻结");
  });
});
