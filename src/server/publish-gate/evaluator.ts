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
import { SITE_LOCALES } from "@/lib/locale/locale-canonical";
import {
  isPromoReady,
  isRightsBlocked,
  type PromoLinkReadinessState,
} from "@/server/publication/visibility";

/**
 * Owner decision (2026-09-08, "移除可发布语种门禁" — CPS parity: "an
 * article's locale is the article's own field ... there is no
 * publishable-locale gate and no article/drama locale consistency
 * assertion"). This supersedes `docs/p2/P2_01_PUBLISH_GATE_CONTRACT.md` §3's
 * old "对应 `isPublishableLocale(novel.locale)` 为 `false`" pin and resolves
 * the "should `novel_article` read `article.locale` too" question
 * `规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §4.4/§六 item 6
 * had registered as pending Owner sign-off: both branches below now read
 * `facts.article.locale` — never `facts.novel.locale` — so
 * `PublishGateNovelFacts` no longer carries a `locale` field at all (see
 * that type below).
 *
 * The gate no longer consults `locale-canonical.ts`'s `PUBLISHABLE_LOCALES`
 * / `isPublishableLocale` either. That whitelist remains a *separate*, still
 * real gate — whether the public site's `[locale]/...` route tree, sitemap,
 * and IndexNow are actually ready to serve a locale (`src/app/[locale]/
 * _guard.ts`; today only `en` clears it, and widening it requires shipping
 * that locale's leaf pages in the same batch) — which is not what "may an
 * admin publish this Article" should gate on. The default `checkLocale`
 * below (see `isRegisteredSiteLocale`) only checks registration against
 * `SITE_LOCALES`, the full 15-entry site registry, matching how CPS accepts
 * any of its registered locales.
 */
export type PublishGateNovelFacts = {
  readonly status: string;
};

export type PublishGateArticleFacts = {
  readonly status: string;
  /** Read by the locale check for every Article, novel_article or not — see this file's header. */
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

/**
 * Default `checkLocale` when no test override is supplied (see this file's
 * header on the 2026-09-08 Owner decision). Only checks registration against
 * `SITE_LOCALES` — the full 15-entry site registry — never the narrower,
 * front-end-readiness `PUBLISHABLE_LOCALES` whitelist. Reads `SITE_LOCALES`
 * directly (same `.includes` shape `_guard.ts` and `content-creation/
 * service.ts` already use) rather than caching it in a second local
 * collection — `tests/ui/locale-canonical.test.ts`'s "没有第二张语种映射表"
 * scan treats any `LOCALE`-named `const`/`let`/`var` collection outside
 * `locale-canonical.ts` itself as exactly that. `src/server/
 * content-creation/service.ts` already rejects any non-registered locale at
 * Article-creation time, so this should be unreachable for a real Article in
 * production; kept as defense-in-depth (same posture `facts.ts` documents
 * for `page_identity_conflict`) since `Article.locale` itself is a free-text
 * `VarChar(16)` column with no DB-level CHECK tying it to `SITE_LOCALES`.
 */
function isRegisteredSiteLocale(locale: unknown): boolean {
  return typeof locale === "string" && (SITE_LOCALES as readonly string[]).includes(locale);
}

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
 * listicle/guide — see this file's header). For that branch, four
 * conditions apply — `locale_not_publishable` (reads `facts.article.locale`,
 * same as the `novel_article` branch does since the 2026-09-08 Owner
 * decision — see this file's header), `required_metadata_missing`,
 * `page_identity_conflict`, and `rights_blocked` (read off
 * `facts.article.status` only — see below) — all
 * Article-level concepts a Novel-less row still has. The other four reasons
 * (`preview_chapter_missing`/`preview_body_missing`/`promo_link_missing`/
 * `promo_link_not_ready`) are entirely Novel-side concepts (试读章节 belongs
 * to the Novel; PromoLink readiness is keyed off the Novel too) that a
 * Novel-less Article cannot fail or pass — they are skipped, not
 * evaluated-and-cleared, for that branch. A `novel_article` (`facts.novel`
 * present) keeps exactly today's eight-reason behavior, byte-for-byte — this
 * fork only ever *narrows* what gets checked, never changes a
 * `novel_article`'s own evaluation.
 *
 * `rights_blocked` specifically: `visibility.ts`'s `isRightsBlocked` is
 * `novel.status === "takedown" || article.status === "takedown"` — an OR of
 * a Novel-side half and an Article-side half. A Novel-less Article has no
 * Novel-side half to read, but it still has its own `status` column and can
 * still be set to `takedown` (an Owner/ops rights-removal action on a blog
 * post is exactly as real as on a novel_article) — a takedown blog must not
 * publish. So this branch keeps the Article-side half of that OR
 * (`facts.article.status === "takedown"`) rather than skipping
 * `rights_blocked` entirely; only the Novel-side half is inapplicable here.
 */
export function evaluatePublishGate(
  facts: PublishGateFacts,
  deps: PublishGateEvaluatorDeps = {},
): PublishGateEvaluation {
  const checkLocale = deps.isPublishableLocale ?? isRegisteredSiteLocale;
  const reasons: PublishGateReason[] = [];
  const novel = facts.novel;

  if (!checkLocale(facts.article.locale)) {
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
  } else if (facts.article.status === "takedown") {
    // Novel-less (non-novel_article) branch: only the Article-side half of
    // `isRightsBlocked`'s OR applies (there is no Novel to read the other
    // half from) — see this function's header. Inlined rather than calling
    // `isRightsBlocked` itself, which requires a `NovelPublicationState`
    // this branch does not have.
    reasons.push("rights_blocked");
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
