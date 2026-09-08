/**
 * The Hard Gate evaluator (P2-07). Frozen contract:
 * `src/contracts/publish-gate.ts` (read-only in this PR — not modified).
 *
 * `P2-07-12-移植审计-2026-08-12/P2-07.md`'s headline finding is that CPS never
 * had a single evaluator function: the same `promo_url` trim check was
 * copy-pasted across three write paths (`drama-publish-actions.ts:110-114`,
 * `article-actions.ts:563-567`, `batch-actions-core.ts:188-197`) while three
 * *other* write paths that flip `status` straight to `published`
 * (`changeArticleStatus`/`changeArticlesStatus`/`changeArticlesStatusByFilter`)
 * ran zero checks at all, and the cron flip (`instrumentation.ts:18-72`) never
 * rechecked anything either. This module is the fix: **the only function in
 * this codebase allowed to decide whether an Article may become `published`.**
 * `src/server/publish-gate/service.ts` is in turn the only module allowed to
 * call it and the only module allowed to write `status: "published"` — see
 * that module's header and `tests/backend/publish-gate/no-bypass.test.ts`.
 *
 * This function is a pure, DB-free classifier over an already-assembled
 * `PublishGateFacts` snapshot (see `facts.ts` for how that snapshot is
 * loaded) — deliberately mirroring `visibility.ts`'s "predicates take
 * structural data, I/O lives elsewhere" split. Every reason is funneled
 * through the frozen `createPublishGateResult` DTO helper (dedup + registry
 * order + fail-closed hygiene), per `publish-gate.ts` §6: this function
 * decides *which* candidate reasons apply, `createPublishGateResult` is only
 * ever the last step, never reimplemented.
 */
import {
  createPublishGateResult,
  type PublishGateReason,
  type PublishGateResult,
  type PublishRequiredMetadataField,
  type RequiredMetadataMissingDetail,
} from "@/contracts/publish-gate";
import { isPublishableLocale as isPublishableLocaleDefault } from "@/lib/locale/locale-canonical";
import {
  isPromoReady,
  isRightsBlocked,
  type PromoLinkReadinessState,
} from "@/server/publication/visibility";

/**
 * `locale_not_publishable` reads `novel.locale`, not `article.locale` for a
 * `novel_article` — this is not a shortcut, it is what
 * `docs/p2/P2_01_PUBLISH_GATE_CONTRACT.md` §3 pins verbatim ("对应
 * `isPublishableLocale(novel.locale)` 为 `false`"). `Novel.locale` is the
 * work's own canonical source language (`docs/governance/
 * database-governance.md` §4: "locale 必须是站点 canonical locale");
 * `Article.locale` identifies which localized SEO page a given Article row
 * *is* (it is what makes `(novelId, locale)` and `(locale, slug)` unique).
 * Today the two always match for `novel_article` (`SITE_LOCALES` has exactly
 * one publishable member), so this distinction is currently unobservable for
 * that type — do not "simplify" the `novel_article` branch to
 * `article.locale` without an Owner sign-off, since the contract text is
 * what is frozen, not today's single-locale coincidence
 * (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §4.4/§六 item 6
 * registers this exact simplification as still pending that sign-off).
 *
 * C-27: a non-`novel_article` (blog/listicle/guide) has no Novel at all —
 * `facts.novel` is `null` for it, guaranteed by the new
 * `article_novel_id_by_type_check` CHECK (`article_type <> 'novel_article'`
 * rows have `novel_id IS NULL`, so `loadPublishGateFacts` has nothing to read
 * `.locale` off). For that branch only, `evaluatePublishGate` below reads
 * `facts.article.locale` instead — there being no Novel to read from is a
 * different situation than the still-pending "should `novel_article` read
 * `article.locale` too" question above, not that question answered.
 */
export type PublishGateNovelFacts = {
  readonly status: string;
  readonly locale: string;
};

export type PublishGateArticleFacts = {
  readonly status: string;
  /** C-27: read by the locale check only when `facts.novel` is `null` — see this file's header. */
  readonly locale: string;
  readonly title: string;
  readonly slug: string;
  readonly body: string;
};

export type PublishGatePreviewFacts = {
  /** At least one non-deleted `NovelChapter` with `status === "preview"` exists. */
  readonly hasPreviewChapter: boolean;
  /** At least one such chapter has a materialized, non-blank `NovelChapterContent.body`. */
  readonly hasPreviewBody: boolean;
};

export type PublishGatePageIdentityFacts = {
  /**
   * A different, non-deleted Article already occupies this (locale, slug)
   * pair. Currently always `false` in V1 — `facts.ts` explains why
   * (`article_locale_slug_active_uidx` makes the underlying row
   * unreachable) and why this defense-in-depth check is kept anyway.
   */
  readonly conflicting: boolean;
};

export type PublishGateFacts = {
  /**
   * C-27: `null` for a non-`novel_article` (blog/listicle/guide) — see this
   * file's header. `null` here is exactly equivalent to "this Article's
   * `article_type` is not `novel_article`" (the CHECK enforces the two never
   * disagree), so the evaluator below forks on this field rather than
   * threading `articleType` through as a second fact.
   */
  readonly novel: PublishGateNovelFacts | null;
  readonly article: PublishGateArticleFacts;
  readonly promoLink: PromoLinkReadinessState;
  readonly preview: PublishGatePreviewFacts;
  readonly pageIdentity: PublishGatePageIdentityFacts;
};

export type PublishGateEvaluatorDeps = {
  /** Injectable for tests only — production callers must not override this. */
  readonly isPublishableLocale?: (locale: unknown) => boolean;
};

export type PublishGateEvaluation = PublishGateResult & {
  readonly requiredMetadataMissing: RequiredMetadataMissingDetail | null;
};

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

function requiredMetadataMissingFields(article: PublishGateArticleFacts): PublishRequiredMetadataField[] {
  const missing: PublishRequiredMetadataField[] = [];
  if (isBlank(article.title)) missing.push("title");
  if (isBlank(article.slug)) missing.push("slug");
  if (isBlank(article.body)) missing.push("body");
  return missing;
}

/**
 * Evaluates every P2-01 Hard Gate condition against an already-loaded fact
 * snapshot and returns a frozen `PublishGateResult` (plus the optional
 * `required_metadata_missing` detail the contract explicitly keeps out of
 * that DTO's shape — see `publish-gate.ts`'s `RequiredMetadataMissingDetail`
 * doc comment). Never throws on bad input: an impossible/malformed facts
 * object simply produces whichever reasons its fields legitimately fail,
 * same fail-closed posture as the rest of this codebase's gates.
 *
 * C-27 fork: `facts.novel` is `null` for a non-`novel_article` (blog/
 * listicle/guide — see this file's header). For that branch, only three
 * conditions apply — `locale_not_publishable` (read off `facts.article.locale`
 * instead), `required_metadata_missing`, `page_identity_conflict` — all
 * Article-level concepts a Novel-less row still has. The other five reasons
 * (`preview_chapter_missing`/`preview_body_missing`/`promo_link_missing`/
 * `promo_link_not_ready`/`rights_blocked`) are entirely Novel-side concepts
 * (试读章节 belongs to the Novel; PromoLink readiness and rights removal are
 * both keyed off the Novel too) that a Novel-less Article cannot fail or
 * pass — they are skipped, not evaluated-and-cleared, for that branch. A
 * `novel_article` (`facts.novel` present) keeps exactly today's eight-reason
 * behavior, byte-for-byte — this fork only ever *narrows* what gets checked,
 * never changes a `novel_article`'s own evaluation.
 */
export function evaluatePublishGate(
  facts: PublishGateFacts,
  deps: PublishGateEvaluatorDeps = {},
): PublishGateEvaluation {
  const checkLocale = deps.isPublishableLocale ?? isPublishableLocaleDefault;
  const reasons: PublishGateReason[] = [];
  const novel = facts.novel;

  if (!checkLocale(novel ? novel.locale : facts.article.locale)) {
    reasons.push("locale_not_publishable");
  }

  const missingFields = requiredMetadataMissingFields(facts.article);
  if (missingFields.length > 0) {
    reasons.push("required_metadata_missing");
  }

  if (novel) {
    // Novel-side conditions — see this function's header on why these do
    // not apply to a Novel-less (non-novel_article) Article at all.
    if (!facts.preview.hasPreviewChapter) {
      reasons.push("preview_chapter_missing");
    } else if (!facts.preview.hasPreviewBody) {
      reasons.push("preview_body_missing");
    }

    if (!facts.promoLink) {
      reasons.push("promo_link_missing");
    } else if (!isPromoReady(facts.promoLink)) {
      reasons.push("promo_link_not_ready");
    }

    if (isRightsBlocked(novel, { status: facts.article.status })) {
      reasons.push("rights_blocked");
    }
  }

  if (facts.pageIdentity.conflicting) {
    reasons.push("page_identity_conflict");
  }

  const result = createPublishGateResult(reasons);
  return {
    ...result,
    requiredMetadataMissing:
      missingFields.length > 0
        ? Object.freeze({ reason: "required_metadata_missing", missingFields: Object.freeze(missingFields) })
        : null,
  };
}
