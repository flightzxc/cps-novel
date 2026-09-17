import { describe, expect, it } from "vitest";

import { PUBLISH_GATE_REASONS, type PublishGateReason } from "@/contracts/publish-gate";
import { evaluatePublishGate, type PublishGateFacts } from "@/server/publish-gate/evaluator";

/**
 * Every registered `PublishGateReason` that is locale-shaped — today that is
 * exactly `locale_not_publishable`, the reason `evaluator.ts` used to emit
 * before L10N P2 (2026-09-10, matrix #8) deleted the check that produced it.
 * Deriving this from the frozen registry rather than hardcoding the one
 * known string means a future reason that is also locale-shaped would still
 * need its own explicit addition here — this constant is documentation of
 * intent, not a scan.
 */
const LOCALE_SHAPED_REASONS: readonly PublishGateReason[] = ["locale_not_publishable"];

function facts(overrides: Partial<PublishGateFacts> = {}): PublishGateFacts {
  return {
    novel: { status: "ready" },
    article: { status: "draft", locale: "en", title: "Title", slug: "slug", body: "Body text" },
    promoLink: { status: "fetched", webUrl: "https://example.com/a", appUrl: null },
    preview: { hasPreviewChapter: true, hasPreviewBody: true },
    pageIdentity: { conflicting: false },
    ...overrides,
  };
}

describe("evaluatePublishGate", () => {
  it("is publishable when every condition passes", () => {
    const result = evaluatePublishGate(facts());
    expect(result).toEqual({ publishable: true, reasons: [], requiredMetadataMissing: null });
  });

  /**
   * L10N P2 (2026-09-10, `施工提示词_Sonnet_L10N_P2_创建链语种强制继承_2026-09-10.md`
   * §1.E, matrix #8 — Owner-explicit exception to this codebase's "evaluator.ts
   * is otherwise untouchable" rule): the registration-against-`SITE_LOCALES`
   * check (`isRegisteredSiteLocale`, added by the 2026-09-08 Owner decision
   * documented in `evaluator.ts`'s header) is now gone entirely, not merely
   * relaxed. `src/server/content-creation/service.ts` derives and hard-blocks
   * an unregistered locale (`missing_locale`/`unsupported_locale`) at
   * Article-*creation* time, so a second, redundant check here at *publish*
   * time is pure CPS parity — "an article's locale is the article's own field
   * ... there is no publishable-locale gate". These four cases (registered
   * locale, `en`, an empty string, and a value that looks nothing like any
   * locale) all assert the same thing: no locale-shaped reason is ever
   * produced, regardless of what `facts.article.locale` holds — this
   * evaluator no longer reads that field for any decision at all.
   */
  it.each([
    ["a registered SITE_LOCALES member other than en", "es"],
    ["en", "en"],
    ["an empty string", ""],
    ["a value that is not a registered SiteLocale at all", "xx-not-real"],
  ])("never emits a locale-shaped reason — %s", (_label, locale) => {
    const result = evaluatePublishGate(facts({ article: { status: "draft", locale, title: "Title", slug: "slug", body: "Body text" } }));
    for (const reason of LOCALE_SHAPED_REASONS) {
      expect(result.reasons).not.toContain(reason);
    }
    // With every other condition held at "passes" (see `facts()`'s defaults),
    // the locale value alone must never be the thing that flips publishable.
    expect(result.publishable).toBe(true);
  });

  describe("required_metadata_missing", () => {
    it("flags a blank title", () => {
      const result = evaluatePublishGate(facts({ article: { status: "draft", locale: "en", title: "  ", slug: "s", body: "b" } }));
      expect(result.reasons).toEqual(["required_metadata_missing"]);
      expect(result.requiredMetadataMissing).toEqual({
        reason: "required_metadata_missing",
        missingFields: ["title"],
      });
    });

    it("flags a blank slug", () => {
      const result = evaluatePublishGate(facts({ article: { status: "draft", locale: "en", title: "t", slug: "\t", body: "b" } }));
      expect(result.requiredMetadataMissing?.missingFields).toEqual(["slug"]);
    });

    it("flags a blank body", () => {
      const result = evaluatePublishGate(facts({ article: { status: "draft", locale: "en", title: "t", slug: "s", body: "" } }));
      expect(result.requiredMetadataMissing?.missingFields).toEqual(["body"]);
    });

    it("accumulates every missing field, not just the first", () => {
      const result = evaluatePublishGate(facts({ article: { status: "draft", locale: "en", title: "", slug: "", body: "" } }));
      expect(result.requiredMetadataMissing?.missingFields).toEqual(["title", "slug", "body"]);
    });

    it("requiredMetadataMissing is null when metadata is complete", () => {
      const result = evaluatePublishGate(facts());
      expect(result.requiredMetadataMissing).toBeNull();
    });
  });

  describe("preview chapter checks", () => {
    it("flags preview_chapter_missing when no preview chapter exists", () => {
      const result = evaluatePublishGate(facts({ preview: { hasPreviewChapter: false, hasPreviewBody: false } }));
      expect(result.reasons).toEqual(["preview_chapter_missing"]);
    });

    it("flags preview_body_missing (not preview_chapter_missing) when a chapter exists but has no body", () => {
      const result = evaluatePublishGate(facts({ preview: { hasPreviewChapter: true, hasPreviewBody: false } }));
      expect(result.reasons).toEqual(["preview_body_missing"]);
    });

    it("never emits both preview reasons for the same evaluation", () => {
      const missingChapter = evaluatePublishGate(facts({ preview: { hasPreviewChapter: false, hasPreviewBody: true } }));
      expect(missingChapter.reasons).toEqual(["preview_chapter_missing"]);
    });
  });

  describe("promo link checks (isPromoReady authority)", () => {
    it("flags promo_link_missing when there is no PromoLink row", () => {
      const result = evaluatePublishGate(facts({ promoLink: null }));
      expect(result.reasons).toEqual(["promo_link_missing"]);
    });

    it("flags promo_link_not_ready when status is not fetched", () => {
      const result = evaluatePublishGate(facts({ promoLink: { status: "pending", webUrl: "https://a", appUrl: null } }));
      expect(result.reasons).toEqual(["promo_link_not_ready"]);
    });

    it("flags promo_link_not_ready when both URLs are blank whitespace — the CPS un-trimmed-filter defect this must not reproduce", () => {
      const result = evaluatePublishGate(facts({ promoLink: { status: "fetched", webUrl: "   ", appUrl: "\t" } }));
      expect(result.reasons).toEqual(["promo_link_not_ready"]);
    });

    it("passes when only appUrl is non-blank", () => {
      const result = evaluatePublishGate(facts({ promoLink: { status: "fetched", webUrl: null, appUrl: "https://app" } }));
      expect(result.publishable).toBe(true);
    });
  });

  it("flags page_identity_conflict when a different live Article holds the same (locale, slug)", () => {
    const result = evaluatePublishGate(facts({ pageIdentity: { conflicting: true } }));
    expect(result.reasons).toEqual(["page_identity_conflict"]);
  });

  describe("rights_blocked", () => {
    it("flags rights_blocked when the Novel is takedown", () => {
      const result = evaluatePublishGate(facts({ novel: { status: "takedown" } }));
      expect(result.reasons).toEqual(["rights_blocked"]);
    });

    it("flags rights_blocked when the Article itself is takedown", () => {
      const result = evaluatePublishGate(facts({ article: { status: "takedown", locale: "en", title: "t", slug: "s", body: "b" } }));
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
    );
    const order = PUBLISH_GATE_REASONS;
    const expected = ["required_metadata_missing", "preview_chapter_missing", "promo_link_missing"];
    expect(result.reasons).toEqual(expected);
    // Sanity: the expected reasons really do appear in registry order.
    expect([...expected].sort((a, b) => order.indexOf(a as never) - order.indexOf(b as never))).toEqual(expected);
    expect(result.publishable).toBe(false);
  });

  it("never returns blocking_sync_exception — that code is createPublishGateResult's own fail-closed hygiene, not something this evaluator decides to emit", () => {
    const result = evaluatePublishGate(facts());
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
   * row. L10N P2 (2026-09-10): the original "语种可发布" quarter of that
   * four-condition list is gone (see this file's other locale-shaped-reason
   * tests above); the fork now applies three conditions to a Novel-less
   * Article, not four.
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
      const result = evaluatePublishGate(blogFacts());
      expect(result).toEqual({ publishable: true, reasons: [], requiredMetadataMissing: null });
    });

    it("never emits a locale-shaped reason for a Novel-less Article, regardless of facts.article.locale", () => {
      const result = evaluatePublishGate(blogFacts({ article: { status: "draft", locale: "es", title: "t", slug: "s", body: "b" } }));
      for (const reason of LOCALE_SHAPED_REASONS) {
        expect(result.reasons).not.toContain(reason);
      }
      expect(result.publishable).toBe(true);
    });

    it("still flags required_metadata_missing", () => {
      const result = evaluatePublishGate(blogFacts({ article: { status: "draft", locale: "en", title: "", slug: "s", body: "b" } }));
      expect(result.reasons).toEqual(["required_metadata_missing"]);
    });

    it("still flags page_identity_conflict", () => {
      const result = evaluatePublishGate(blogFacts({ pageIdentity: { conflicting: true } }));
      expect(result.reasons).toEqual(["page_identity_conflict"]);
    });

    it("never flags preview_chapter_missing/preview_body_missing even though preview facts say both are missing", () => {
      const result = evaluatePublishGate(blogFacts({ preview: { hasPreviewChapter: false, hasPreviewBody: false } }));
      expect(result.reasons).not.toContain("preview_chapter_missing");
      expect(result.reasons).not.toContain("preview_body_missing");
    });

    it("never flags promo_link_missing/promo_link_not_ready even though promoLink is null", () => {
      const result = evaluatePublishGate(blogFacts({ promoLink: null }));
      expect(result.reasons).not.toContain("promo_link_missing");
      expect(result.reasons).not.toContain("promo_link_not_ready");
    });

    it("M-1: still flags rights_blocked when the Article's own status is takedown — the Article-side half of isRightsBlocked's OR is not a Novel-side concept and is not skipped", () => {
      const result = evaluatePublishGate(blogFacts({ article: { status: "takedown", locale: "en", title: "t", slug: "s", body: "b" } }));
      expect(result.reasons).toEqual(["rights_blocked"]);
    });

    it("M-1: does not flag rights_blocked for a non-takedown status — only the Article-side takedown case fires it in this branch", () => {
      const result = evaluatePublishGate(blogFacts({ article: { status: "ready", locale: "en", title: "t", slug: "s", body: "b" } }));
      expect(result.reasons).not.toContain("rights_blocked");
      expect(result.publishable).toBe(true);
    });
  });
});
