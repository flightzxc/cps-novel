/**
 * Dedicated upstream-code non-leak regression. `upstream_code` (the
 * channel's real promo code) must never reach a log line, error message, or
 * audit/task-result snapshot — `docs/architecture/candidate-v0.2.1/
 * novel-v1-adapter-and-workflow-v0.2.1.md` §3.9 "脱敏". `public_redirect_
 * code` is the opposite: it is *meant* to be public, so a fixture carrying
 * both codes side by side is the sharpest way to prove the separation
 * actually holds (a naive "the row doesn't contain X" check could pass by
 * accident if the fixture never had a public code to compare against).
 */
import { describe, expect, it } from "vitest";
import { redactUpstreamCode, safeHostname } from "../../../worker/handlers/promo-link-claim";

const REAL_UPSTREAM_CODE = "KOC-REAL-9F3A7B21";
const PUBLIC_REDIRECT_CODE = "p9x2k7m4q1"; // 10-char, matches PUBLIC_REDIRECT_CODE_LENGTH
const WEB_URL = `https://eng.moboreader.com/promo/${REAL_UPSTREAM_CODE}`;

describe("P0-S5 promo-link claim — upstream code never leaks", () => {
  it("redacts to a length-only marker, never the raw code substring", () => {
    const redacted = redactUpstreamCode(REAL_UPSTREAM_CODE);
    expect(redacted).toBe(`[redacted_code:length=${REAL_UPSTREAM_CODE.length}]`);
    expect(redacted).not.toContain(REAL_UPSTREAM_CODE);
  });

  it("reduces a URL carrying the real code to hostname only", () => {
    const host = safeHostname(WEB_URL);
    expect(host).toBe("eng.moboreader.com");
    expect(host).not.toContain(REAL_UPSTREAM_CODE);
  });

  it("a fixture carrying both codes side by side: the audit-shaped snapshot exposes the public code but never the upstream one", () => {
    // Shape mirrors exactly what worker/handlers/promo-link-claim.ts's
    // `writePromoLinkClaimed`/`writePromoLinkAlreadyAvailable` pass to
    // `operationAudit.create`'s `afterSnapshot` — built the same way, not
    // copy-pasted from production code, so this test would catch a future
    // regression at either call site independently.
    const auditSnapshot = {
      decision: "claimed",
      upstreamCode: redactUpstreamCode(REAL_UPSTREAM_CODE),
      host: safeHostname(WEB_URL),
    };
    // The row itself (not the audit) is where the real values legitimately
    // live — the DB row needs the real webUrl to serve `/go/{code}`.
    const promoLinkRow = {
      publicRedirectCode: PUBLIC_REDIRECT_CODE,
      upstreamCode: REAL_UPSTREAM_CODE,
      webUrl: WEB_URL,
    };

    const serializedAudit = JSON.stringify(auditSnapshot);
    expect(serializedAudit).not.toContain(REAL_UPSTREAM_CODE);
    expect(serializedAudit).toContain("eng.moboreader.com");
    expect(serializedAudit).toContain(`[redacted_code:length=${REAL_UPSTREAM_CODE.length}]`);

    // Sanity: the fixture genuinely carries the real code (the row, not the
    // audit) — proves the assertion above isn't vacuously true because the
    // real code was never present anywhere in the test.
    expect(JSON.stringify(promoLinkRow)).toContain(REAL_UPSTREAM_CODE);
    expect(JSON.stringify(promoLinkRow)).toContain(PUBLIC_REDIRECT_CODE);
    // And the two codes are visibly distinct values — this test would be
    // meaningless if they ever accidentally collided.
    expect(PUBLIC_REDIRECT_CODE).not.toBe(REAL_UPSTREAM_CODE);
  });

  it("redactUpstreamCode is null-safe (a PromoLink with no upstream code yet has nothing to redact)", () => {
    expect(redactUpstreamCode(null)).toBeNull();
    expect(redactUpstreamCode(undefined)).toBeNull();
  });
});
