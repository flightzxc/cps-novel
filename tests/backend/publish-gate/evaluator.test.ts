import { describe, expect, it } from "vitest";

import { PUBLISH_GATE_REASONS } from "@/contracts/publish-gate";
import { evaluatePublishGate, type PublishGateFacts } from "@/server/publish-gate/evaluator";

const ALWAYS_PUBLISHABLE = () => true;
const NEVER_PUBLISHABLE = () => false;

function facts(overrides: Partial<PublishGateFacts> = {}): PublishGateFacts {
  return {
    novel: { status: "ready", locale: "en" },
    article: { status: "draft", title: "Title", slug: "slug", body: "Body text" },
    promoLink: { status: "fetched", webUrl: "https://example.com/a", appUrl: null },
    preview: { hasPreviewChapter: true, hasPreviewBody: true },
    pageIdentity: { conflicting: false },
    ...overrides,
  };
}

describe("evaluatePublishGate", () => {
  it("is publishable when every condition passes", () => {
    const result = evaluatePublishGate(facts(), { isPublishableLocale: ALWAYS_PUBLISHABLE });
    expect(result).toEqual({ publishable: true, reasons: [], requiredMetadataMissing: null });
  });

  it("defaults to the real, fail-closed isPublishableLocale when no override is given", () => {
    // PUBLISHABLE_LOCALES is intentionally empty until D-7 clears — production
    // code must never inject an override, so the default path must reject.
    const result = evaluatePublishGate(facts());
    expect(result.publishable).toBe(false);
    expect(result.reasons).toContain("locale_not_publishable");
  });

  it("flags locale_not_publishable when the locale check rejects", () => {
    const result = evaluatePublishGate(facts(), { isPublishableLocale: NEVER_PUBLISHABLE });
    expect(result.publishable).toBe(false);
    expect(result.reasons).toEqual(["locale_not_publishable"]);
  });

  describe("required_metadata_missing", () => {
    it("flags a blank title", () => {
      const result = evaluatePublishGate(facts({ article: { status: "draft", title: "  ", slug: "s", body: "b" } }), {
        isPublishableLocale: ALWAYS_PUBLISHABLE,
      });
      expect(result.reasons).toEqual(["required_metadata_missing"]);
      expect(result.requiredMetadataMissing).toEqual({
        reason: "required_metadata_missing",
        missingFields: ["title"],
      });
    });

    it("flags a blank slug", () => {
      const result = evaluatePublishGate(facts({ article: { status: "draft", title: "t", slug: "\t", body: "b" } }), {
        isPublishableLocale: ALWAYS_PUBLISHABLE,
      });
      expect(result.requiredMetadataMissing?.missingFields).toEqual(["slug"]);
    });

    it("flags a blank body", () => {
      const result = evaluatePublishGate(facts({ article: { status: "draft", title: "t", slug: "s", body: "" } }), {
        isPublishableLocale: ALWAYS_PUBLISHABLE,
      });
      expect(result.requiredMetadataMissing?.missingFields).toEqual(["body"]);
    });

    it("accumulates every missing field, not just the first", () => {
      const result = evaluatePublishGate(facts({ article: { status: "draft", title: "", slug: "", body: "" } }), {
        isPublishableLocale: ALWAYS_PUBLISHABLE,
      });
      expect(result.requiredMetadataMissing?.missingFields).toEqual(["title", "slug", "body"]);
    });

    it("requiredMetadataMissing is null when metadata is complete", () => {
      const result = evaluatePublishGate(facts(), { isPublishableLocale: ALWAYS_PUBLISHABLE });
      expect(result.requiredMetadataMissing).toBeNull();
    });
  });

  describe("preview chapter checks", () => {
    it("flags preview_chapter_missing when no preview chapter exists", () => {
      const result = evaluatePublishGate(
        facts({ preview: { hasPreviewChapter: false, hasPreviewBody: false } }),
        { isPublishableLocale: ALWAYS_PUBLISHABLE },
      );
      expect(result.reasons).toEqual(["preview_chapter_missing"]);
    });

    it("flags preview_body_missing (not preview_chapter_missing) when a chapter exists but has no body", () => {
      const result = evaluatePublishGate(
        facts({ preview: { hasPreviewChapter: true, hasPreviewBody: false } }),
        { isPublishableLocale: ALWAYS_PUBLISHABLE },
      );
      expect(result.reasons).toEqual(["preview_body_missing"]);
    });

    it("never emits both preview reasons for the same evaluation", () => {
      const missingChapter = evaluatePublishGate(
        facts({ preview: { hasPreviewChapter: false, hasPreviewBody: true } }),
        { isPublishableLocale: ALWAYS_PUBLISHABLE },
      );
      expect(missingChapter.reasons).toEqual(["preview_chapter_missing"]);
    });
  });

  describe("promo link checks (isPromoReady authority)", () => {
    it("flags promo_link_missing when there is no PromoLink row", () => {
      const result = evaluatePublishGate(facts({ promoLink: null }), { isPublishableLocale: ALWAYS_PUBLISHABLE });
      expect(result.reasons).toEqual(["promo_link_missing"]);
    });

    it("flags promo_link_not_ready when status is not fetched", () => {
      const result = evaluatePublishGate(
        facts({ promoLink: { status: "pending", webUrl: "https://a", appUrl: null } }),
        { isPublishableLocale: ALWAYS_PUBLISHABLE },
      );
      expect(result.reasons).toEqual(["promo_link_not_ready"]);
    });

    it("flags promo_link_not_ready when both URLs are blank whitespace — the CPS un-trimmed-filter defect this must not reproduce", () => {
      const result = evaluatePublishGate(
        facts({ promoLink: { status: "fetched", webUrl: "   ", appUrl: "\t" } }),
        { isPublishableLocale: ALWAYS_PUBLISHABLE },
      );
      expect(result.reasons).toEqual(["promo_link_not_ready"]);
    });

    it("passes when only appUrl is non-blank", () => {
      const result = evaluatePublishGate(
        facts({ promoLink: { status: "fetched", webUrl: null, appUrl: "https://app" } }),
        { isPublishableLocale: ALWAYS_PUBLISHABLE },
      );
      expect(result.publishable).toBe(true);
    });
  });

  it("flags page_identity_conflict when a different live Article holds the same (locale, slug)", () => {
    const result = evaluatePublishGate(facts({ pageIdentity: { conflicting: true } }), {
      isPublishableLocale: ALWAYS_PUBLISHABLE,
    });
    expect(result.reasons).toEqual(["page_identity_conflict"]);
  });

  describe("rights_blocked", () => {
    it("flags rights_blocked when the Novel is takedown", () => {
      const result = evaluatePublishGate(facts({ novel: { status: "takedown", locale: "en" } }), {
        isPublishableLocale: ALWAYS_PUBLISHABLE,
      });
      expect(result.reasons).toEqual(["rights_blocked"]);
    });

    it("flags rights_blocked when the Article itself is takedown", () => {
      const result = evaluatePublishGate(
        facts({ article: { status: "takedown", title: "t", slug: "s", body: "b" } }),
        { isPublishableLocale: ALWAYS_PUBLISHABLE },
      );
      expect(result.reasons).toEqual(["rights_blocked"]);
    });
  });

  it("accumulates multiple simultaneous reasons in PUBLISH_GATE_REASONS registry order", () => {
    const result = evaluatePublishGate(
      facts({
        promoLink: null,
        preview: { hasPreviewChapter: false, hasPreviewBody: false },
        article: { status: "draft", title: "", slug: "s", body: "b" },
      }),
      { isPublishableLocale: NEVER_PUBLISHABLE },
    );
    const order = PUBLISH_GATE_REASONS;
    const expected = [
      "locale_not_publishable",
      "required_metadata_missing",
      "preview_chapter_missing",
      "promo_link_missing",
    ];
    expect(result.reasons).toEqual(expected);
    // Sanity: the expected reasons really do appear in registry order.
    expect([...expected].sort((a, b) => order.indexOf(a as never) - order.indexOf(b as never))).toEqual(expected);
    expect(result.publishable).toBe(false);
  });

  it("never returns blocking_sync_exception — that code is createPublishGateResult's own fail-closed hygiene, not something this evaluator decides to emit", () => {
    const result = evaluatePublishGate(facts(), { isPublishableLocale: ALWAYS_PUBLISHABLE });
    expect(result.reasons).not.toContain("blocking_sync_exception");
  });
});
