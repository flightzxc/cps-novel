import { describe, expect, it } from "vitest";

import { PUBLISH_GATE_REASONS } from "@/contracts/publish-gate";
import { evaluatePublishGate, type PublishGateFacts } from "@/server/publish-gate/evaluator";

const ALWAYS_PUBLISHABLE = () => true;
const NEVER_PUBLISHABLE = () => false;

function facts(overrides: Partial<PublishGateFacts> = {}): PublishGateFacts {
  return {
    novel: { status: "ready", locale: "en" },
    article: { status: "draft", locale: "en", title: "Title", slug: "slug", body: "Body text" },
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

  it("defaults to the real isPublishableLocale when no override is given", () => {
    // U6 admitted `en`. The default path must not inject an override, so
    // locale-en facts that otherwise pass the gate are now publishable.
    const result = evaluatePublishGate(facts());
    expect(result.publishable).toBe(true);
    expect(result.reasons).not.toContain("locale_not_publishable");
  });

  it("still fail-closes locales that have not cleared D-7", () => {
    const result = evaluatePublishGate(facts({ novel: { status: "ready", locale: "es" } }));
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
      const result = evaluatePublishGate(facts({ article: { status: "draft", locale: "en", title: "  ", slug: "s", body: "b" } }), {
        isPublishableLocale: ALWAYS_PUBLISHABLE,
      });
      expect(result.reasons).toEqual(["required_metadata_missing"]);
      expect(result.requiredMetadataMissing).toEqual({
        reason: "required_metadata_missing",
        missingFields: ["title"],
      });
    });

    it("flags a blank slug", () => {
      const result = evaluatePublishGate(facts({ article: { status: "draft", locale: "en", title: "t", slug: "\t", body: "b" } }), {
        isPublishableLocale: ALWAYS_PUBLISHABLE,
      });
      expect(result.requiredMetadataMissing?.missingFields).toEqual(["slug"]);
    });

    it("flags a blank body", () => {
      const result = evaluatePublishGate(facts({ article: { status: "draft", locale: "en", title: "t", slug: "s", body: "" } }), {
        isPublishableLocale: ALWAYS_PUBLISHABLE,
      });
      expect(result.requiredMetadataMissing?.missingFields).toEqual(["body"]);
    });

    it("accumulates every missing field, not just the first", () => {
      const result = evaluatePublishGate(facts({ article: { status: "draft", locale: "en", title: "", slug: "", body: "" } }), {
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
        facts({ article: { status: "takedown", locale: "en", title: "t", slug: "s", body: "b" } }),
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
        article: { status: "draft", locale: "en", title: "", slug: "s", body: "b" },
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

  /**
   * C-27 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-27):
   * "判定器按文章类型分叉——novel_article 走今天这六条；非 novel_article 走
   * '语种可发布 + 必要元数据齐全 + 页面身份不冲突 + 权利阻断(仅 Article 侧)'
   * 四条，跳过 '推广链接缺失 / 推广链接未就绪 / 试读章节缺失 / 试读正文缺失'
   * 四条". `facts.novel === null` is this evaluator's fork signal (guaranteed
   * equivalent to "article_type <> 'novel_article'" by
   * `article_novel_id_by_type_check`, see `evaluator.ts`'s header) — these
   * tests exercise that branch directly without needing a real blog Article
   * row.
   *
   * M-1 (C-27 review closure): an earlier version of the `rights_blocked`
   * test below asserted the reason is skipped entirely in this branch —
   * that enshrined the wrong premise. `isRightsBlocked` (`visibility.ts`) is
   * `novel.status === "takedown" || article.status === "takedown"`; a
   * Novel-less Article has no Novel-side half to evaluate, but it still has
   * its own `status`, and a takedown blog must not publish. See both
   * `rights_blocked` tests below (fires on Article takedown; stays silent
   * otherwise).
   */
  describe("C-27: non-novel_article fork (facts.novel === null)", () => {
    function blogFacts(overrides: Partial<PublishGateFacts> = {}): PublishGateFacts {
      return facts({
        novel: null,
        // A blog Article has no PromoLink/preview chapters by construction
        // (C-28 always writes `promoLinkId: null`, and preview chapters
        // belong to a Novel this Article does not have) — modeled here as
        // absent/empty so these tests assert the fork skips them rather
        // than happening to pass them.
        promoLink: null,
        preview: { hasPreviewChapter: false, hasPreviewBody: false },
        ...overrides,
      });
    }

    it("is publishable with no Novel, no PromoLink, no preview chapters, and a non-takedown status — every skipped/inapplicable condition stays silent", () => {
      const result = evaluatePublishGate(blogFacts(), { isPublishableLocale: ALWAYS_PUBLISHABLE });
      expect(result).toEqual({ publishable: true, reasons: [], requiredMetadataMissing: null });
    });

    it("reads locale off facts.article.locale, not facts.novel.locale, when there is no Novel", () => {
      const result = evaluatePublishGate(
        blogFacts({ article: { status: "draft", locale: "es", title: "t", slug: "s", body: "b" } }),
        { isPublishableLocale: (locale) => locale === "en" },
      );
      expect(result.reasons).toEqual(["locale_not_publishable"]);
    });

    it("still flags required_metadata_missing", () => {
      const result = evaluatePublishGate(
        blogFacts({ article: { status: "draft", locale: "en", title: "", slug: "s", body: "b" } }),
        { isPublishableLocale: ALWAYS_PUBLISHABLE },
      );
      expect(result.reasons).toEqual(["required_metadata_missing"]);
    });

    it("still flags page_identity_conflict", () => {
      const result = evaluatePublishGate(blogFacts({ pageIdentity: { conflicting: true } }), {
        isPublishableLocale: ALWAYS_PUBLISHABLE,
      });
      expect(result.reasons).toEqual(["page_identity_conflict"]);
    });

    it("never flags preview_chapter_missing/preview_body_missing even though preview facts say both are missing", () => {
      const result = evaluatePublishGate(
        blogFacts({ preview: { hasPreviewChapter: false, hasPreviewBody: false } }),
        { isPublishableLocale: ALWAYS_PUBLISHABLE },
      );
      expect(result.reasons).not.toContain("preview_chapter_missing");
      expect(result.reasons).not.toContain("preview_body_missing");
    });

    it("never flags promo_link_missing/promo_link_not_ready even though promoLink is null", () => {
      const result = evaluatePublishGate(blogFacts({ promoLink: null }), { isPublishableLocale: ALWAYS_PUBLISHABLE });
      expect(result.reasons).not.toContain("promo_link_missing");
      expect(result.reasons).not.toContain("promo_link_not_ready");
    });

    it("M-1: still flags rights_blocked when the Article's own status is takedown — the Article-side half of isRightsBlocked's OR is not a Novel-side concept and is not skipped", () => {
      const result = evaluatePublishGate(
        blogFacts({ article: { status: "takedown", locale: "en", title: "t", slug: "s", body: "b" } }),
        { isPublishableLocale: ALWAYS_PUBLISHABLE },
      );
      expect(result.reasons).toEqual(["rights_blocked"]);
    });

    it("M-1: does not flag rights_blocked for a non-takedown status — only the Article-side takedown case fires it in this branch", () => {
      const result = evaluatePublishGate(
        blogFacts({ article: { status: "ready", locale: "en", title: "t", slug: "s", body: "b" } }),
        { isPublishableLocale: ALWAYS_PUBLISHABLE },
      );
      expect(result.reasons).not.toContain("rights_blocked");
      expect(result.publishable).toBe(true);
    });
  });
});
