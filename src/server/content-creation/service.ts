/**
 * P0-S4 content creation pipeline: `Novel` (draft) + its same-locale
 * `Article` (draft) from a `NovelSourceItem`'s mirrored fields. This is the
 * first write path in the codebase that ever calls `novel.create`/
 * `article.create` — until now there was no way to get a `Novel`/`Article`
 * row into existence at all, which is the "整站不可发布" deadlock this
 * unblocks (creation is a hard prerequisite for `src/server/publish-gate/`
 * to ever have anything to evaluate).
 *
 * ## Scope boundaries (read before extending)
 *
 * - **Locale is derived from the source item, never caller-supplied.**
 *   L10N P2 (`施工提示词_Sonnet_L10N_P2_创建链语种强制继承_2026-09-10.md` §1.A)
 *   closes the S7a TODO this comment used to carry: `loadPlan` reads
 *   `NovelSourceItem.sourceLocale` — already a resolved BCP-47 locale or
 *   `NULL` (L10N P1's worker write path,
 *   `src/lib/locale/channel-language.ts`'s `resolveChannelLanguage`) — and
 *   derives `Novel.locale`/`Article.locale` from it directly. This module
 *   does not re-resolve it from a raw upstream code/name itself; doing so
 *   would be a second, forbidden mapping implementation (see
 *   `src/lib/locale/README.md`, "全项目唯一的语种映射实现"). A `NULL`
 *   `sourceLocale` fails closed with `ContentCreationInputError
 *   ("missing_locale")`; a resolved value that is not a `SITE_LOCALES`
 *   member (mapped successfully but not a registered site locale — e.g.
 *   `it`/`fil`/`ms`/`tr`) fails closed with `ContentCreationInputError
 *   ("unsupported_locale")`. There is no caller override —
 *   `CreateContentFromSourceItemInput` has no `locale` field at all. CPS
 *   parity: an article's locale comes from the source item, never from an
 *   operator's pick (`3a76877:src/lib/changdu-promote-drama.ts:360-361,
 *   674-677`, `changdu-promote-drama-dry-run.ts:514-534`, both read-only
 *   references) — a caller-supplied override here would reopen exactly the
 *   wrong-locale-content risk this module's TODO used to flag.
 * - **`Article.body`/`title`/`seoMetadata` are rendered by the P2-02
 *   Template Engine (`@/lib/seo/template`), not hand-assembled here.**
 *   P0-S9 wires the engine in against a single code-literal
 *   `DEFAULT_ARTICLE_TEMPLATE` (`./default-article-template.ts`) — see that
 *   module's header for why a `templateKey`-driven `ArticleTemplate` DB
 *   lookup is deferred rather than built now. `Article.templateId` is left
 *   `null`: nothing here creates or references an `ArticleTemplate` row.
 *   The rendered `body` is non-blank for every row this service creates
 *   (the four optional template fields — `cover_url`, `total_chapter_count`,
 *   `preview_chapter_count`, `promo_redirect_url` — are each wrapped in
 *   their own `{if}` block, so a still-missing `PromoLink` or unmaterialized
 *   preview chapters shrink the body, never blank it), which is what clears
 *   `required_metadata_missing`'s `body` check
 *   (`src/server/publish-gate/evaluator.ts`) — the publish gate's other
 *   reasons (`promo_link_missing`, `preview_chapter_missing`, …) are
 *   untouched by this and still gate `published` normally.
 * - **Never touches `PromoLink`.** Claiming/creating promo assets is S5's
 *   territory. `Article.promoLinkId` is left `null`; `article_published_
 *   promo_link_check` already stops a promo-less Article from publishing.
 * - **Never writes `status`.** Both `Novel.status` and `Article.status`
 *   default to `"draft"` at the schema level
 *   (`prisma/schema.prisma`) — this module relies on that default and never
 *   spells a `status:` key in its `create()` calls. That is not a style
 *   preference: `tests/backend/publish-gate/no-bypass.test.ts` statically
 *   scans every `.article.*(`/`.novel.*(` write call outside
 *   `src/server/publish-gate/` for a `status:` key at all (literal or
 *   variable, any value) and fails the build if one appears. Re-adding
 *   `status: "draft"` here — even though `"draft"` is safe — is
 *   indistinguishable to that scanner from a real publish bypass. Leave it
 *   to the column default.
 * - **No admin UI, no Server Action wrapper.** Nothing under `src/app/**`
 *   calls this yet (there is no admin page to trigger it from in this
 *   round) — it is invoked directly by whatever automation S5+ wires up.
 *
 * ## Idempotency and concurrency
 *
 * The durable idempotency key is `NovelSourceItem.novelId` (nullable,
 * becomes non-null exactly once — `novel_source_item.status` semantics:
 * "linked: Source row is linked to exactly one source-language Novel",
 * `src/domain/database-statuses.ts`). A repeat call for a source item that
 * is already linked short-circuits to `"already_exists"` and performs zero
 * writes; the schema's compound FK
 * (`article_promo_link_novel_fkey`... irrelevant here, but the *shape* of
 * "guard read, then decide" is the same one `src/server/publish-gate/
 * service.ts` documents at length) makes this the same idempotency pattern
 * used throughout this codebase's other write paths.
 *
 * Two genuinely concurrent calls for the same source item can both pass the
 * initial guard read (Postgres READ COMMITTED gives each statement a fresh
 * read, not a stable transaction-wide snapshot) and both proceed to build a
 * full `Novel`+`Article` pair. The race is closed at the very end by a
 * conditional `updateMany` — `WHERE id = ? AND novel_id IS NULL` — whose
 * `count` can only be 1 for the transaction that wins; the loser throws
 * `ContentCreationConflictSignal` to force `$transaction` to roll back its
 * own just-inserted `Novel`/`Article` rows rather than leave them as
 * orphans. Same throw-not-return reasoning as `PublishConflictSignal` in
 * `src/server/publish-gate/service.ts` — see that class's doc comment.
 */
import { Prisma, type PrismaClient } from "@prisma/client";

import { isHealthySlug, textToSlug } from "@/lib/slug/text-to-slug";
import { createWithPublicPageShortIdRetry, generatePublicPageShortIdCandidate } from "@/lib/slug/short-id";
import { withDbRetry } from "@/lib/db/db-retry";
import { SITE_LOCALES, type SiteLocale } from "@/lib/locale/locale-canonical";
// C-30A (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4A.1): write point 1
// of 2 for `Novel.titleNormalized` — see that function's own header for why
// write point 2 (a Novel title-update path) does not exist in this
// codebase today.
import { normalizeNovelTitle } from "@/lib/novel/novel-identity";
import {
  buildNovelTemplateValues,
  isTemplateRenderError,
  renderArticleDraft,
  type TemplateErrorCode,
} from "@/lib/seo/template";
import {
  ensureDefaultArticleTemplate,
  selectActiveArticleTemplate,
  validateStoredArticleTemplate,
} from "@/server/article-templates";

import { createNovelWithBusinessIdRetry } from "./business-id";
import {
  enqueueContentCreationPreview,
  type ContentCreationPreviewEnqueueResult,
} from "./preview-enqueue";

// ---------------------------------------------------------------------------
// Actor / audit
// ---------------------------------------------------------------------------

/** Who is asking — mirrors `PublishTransitionActor`'s shape (`src/server/publish-gate/service.ts`) for the same reason: audit attribution needs to distinguish a real admin session from unattended automation, and both must funnel through one function. */
export type CreateContentActor =
  | { readonly type: "admin"; readonly adminId: string }
  | { readonly type: "system"; readonly source: string };

function auditActorType(actor: CreateContentActor): "admin" | "system" {
  return actor.type;
}

function auditActorId(actor: CreateContentActor): string {
  return actor.type === "admin" ? actor.adminId : actor.source;
}

const CONTENT_CREATE_AUDIT_ACTION = "novel.create";

// ---------------------------------------------------------------------------
// Input validation. Most of these throw for malformed caller input (not a
// business state) — `invalid_novel_source_item_id`/`invalid_actor`/
// `invalid_request_id` are checked synchronously off the raw input, before
// any DB read. `missing_locale`/`unsupported_locale` are the two
// exceptions: they can only be discovered *after* `loadPlan` reads the
// `NovelSourceItem` row (locale is derived from `sourceItem.sourceLocale`,
// never caller-supplied — see module header), so they are business-state
// discoveries surfaced through this same throw-based class rather than a
// synchronous pre-check. Reusing `ContentCreationInputError` for them is
// deliberate, not a category error: `src/app/(admin)/catalog-sync/
// _actions.ts` and `./batch.ts`'s `runSequentialBudgetedBatch` already catch
// this exact class and classify it as `kind: "invalid_input"` /
// `inputErrorCode`, so both new codes get that plumbing for free.
// ---------------------------------------------------------------------------

export type ContentCreationInputErrorCode =
  | "invalid_novel_source_item_id"
  | "missing_locale"
  | "unsupported_locale"
  | "invalid_actor"
  | "invalid_request_id";

export class ContentCreationInputError extends Error {
  readonly code: ContentCreationInputErrorCode;

  constructor(code: ContentCreationInputErrorCode, message: string) {
    super(message);
    this.name = "ContentCreationInputError";
    this.code = code;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ContentCreationInputError("invalid_novel_source_item_id", "A valid NovelSourceItem UUID is required");
  }
  return value.toLowerCase();
}

/**
 * Derives `Novel.locale`/`Article.locale` from `NovelSourceItem.sourceLocale`
 * — see module header, "Locale is derived from the source item, never
 * caller-supplied." `sourceLocale` is already a resolved BCP-47 locale or
 * `NULL` (L10N P1's worker write path); this function does not re-resolve it
 * from a raw upstream code/name (that would be a second, forbidden mapping
 * implementation — `src/lib/locale/README.md`). It only checks registration
 * against `SITE_LOCALES`, the same membership test
 * `src/server/publish-gate/evaluator.ts`'s `isRegisteredSiteLocale` and
 * `src/app/[locale]/_guard.ts` already use elsewhere in this codebase.
 *
 * L10N P5 §1.E: the missing-value check was a strict `=== null`, which let
 * a non-null-but-blank `sourceLocale` (`""`/whitespace-only) fall through
 * to the `SITE_LOCALES` membership check below and get misclassified as
 * `unsupported_locale` instead of `missing_locale` — the wrong diagnosis
 * for "there was never a value to check membership for" (L10N P1's worker
 * write path never writes a blank string today, but this function must not
 * depend on that upstream discipline to classify correctly). Changed to
 * `!sourceLocale?.trim()`, aligned with CPS
 * `changdu-promote-drama-dry-run.ts:531`'s own
 * `if (!source.sourceLocale?.trim()) blockReasons.push("missing_locale", ...)`
 * blank check — same condition shape, not CPS's multi-reason-array push
 * (this function throws a single error, matching its own existing
 * single-error-code contract).
 */
function deriveLocale(sourceLocale: string | null): SiteLocale {
  if (!sourceLocale?.trim()) {
    throw new ContentCreationInputError(
      "missing_locale",
      "NovelSourceItem.sourceLocale is NULL/blank — cannot derive a content locale without human/vendor-code correction upstream",
    );
  }
  if (!(SITE_LOCALES as readonly string[]).includes(sourceLocale)) {
    throw new ContentCreationInputError(
      "unsupported_locale",
      `NovelSourceItem.sourceLocale "${sourceLocale}" resolved to a locale that is not a registered SiteLocale`,
    );
  }
  return sourceLocale as SiteLocale;
}

function requireActor(actor: CreateContentActor): void {
  const id = actor.type === "admin" ? actor.adminId : actor.source;
  if (typeof id !== "string" || id.trim().length === 0 || id.length > 128) {
    throw new ContentCreationInputError("invalid_actor", "A valid actor identity is required");
  }
}

function requireRequestId(requestId: unknown): string {
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 160) {
    throw new ContentCreationInputError("invalid_request_id", "A valid requestId is required");
  }
  return requestId;
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export type CreatedContentSummary = {
  readonly novelId: string;
  readonly novelBusinessId: string;
  readonly articleId: string;
  readonly locale: SiteLocale;
  readonly novelSlug: string;
  readonly articleSlug: string;
  readonly publicPageShortId: string;
};

export type ContentCreationPlan = {
  readonly locale: SiteLocale;
  readonly title: string;
  readonly novelSlug: string;
  readonly articleSlug: string;
  /** A freshly generated candidate, not reserved against the database — dry-run performs zero writes, so the real value assigned at creation time may differ. */
  readonly provisionalPublicPageShortId: string;
};

export type CreateContentResult =
  | ({ readonly outcome: "created"; readonly previewEnqueue?: ContentCreationPreviewEnqueueResult } & CreatedContentSummary)
  | ({ readonly outcome: "already_exists" } & CreatedContentSummary)
  | { readonly outcome: "dry_run"; readonly plan: ContentCreationPlan }
  | { readonly outcome: "source_item_not_found" }
  | { readonly outcome: "source_item_deleted" }
  | { readonly outcome: "source_item_ignored" }
  | { readonly outcome: "source_item_stale" }
  /**
   * CPS parity (matrix #4, `3a76877:src/actions/article-actions.ts:569-576`
   * + `src/lib/template-locale-guard.ts` + `batch-actions-core.ts:167-183`,
   * batch semantics — 海阅创建是单事务，无单篇/批量之分): `selectActiveArticleTemplate`
   * found no active, applicable template for the derived `locale` (an
   * explicit `templateKey` that exists but is inactive/wrong-locale/
   * wrong-type collapses into the same "no usable template for this locale"
   * signal as no `templateKey` at all — CPS's batch path does not
   * distinguish "template doesn't exist" from "template is the wrong
   * locale" either, see the read-only reference above). Hard-blocks
   * creation; `templateKey` is present only when the caller requested one
   * explicitly.
   */
  | { readonly outcome: "template_locale_mismatch"; readonly locale: SiteLocale; readonly templateKey?: string }
  /** Defensive: the source item's `novelId`/`status` combination doesn't match any state this service's state machine expects (e.g. `status === "linked"` but `novelId` is `null`, or `novelId` points at a missing/soft-deleted Novel, or a linked Novel has no Article for its own locale). Not this call's job to repair — surfaced for manual review. */
  | { readonly outcome: "source_item_inconsistent_state" }
  | {
      readonly outcome: "locale_conflict";
      readonly reason: "source_item_already_linked_to_different_locale";
      readonly existingNovelId: string;
      readonly existingLocale: string;
      /**
       * The locale just derived from `sourceItem.sourceLocale` (see module
       * header) — the value that disagreed with `existingLocale`. L10N P2:
       * before locale was derived, every caller in this codebase hardcoded
       * `"en"`, so UI copy could safely assume that was always the attempted
       * value; now it can legitimately be anything in `SITE_LOCALES`, so
       * that assumption must not be baked into copy again — see
       * `catalog-sync/_lib/outcome-copy.ts`'s `locale_conflict` case.
       */
      readonly derivedLocale: SiteLocale;
    }
  | { readonly outcome: "slug_unhealthy"; readonly field: "novel" | "article"; readonly baseSlug: string }
  | { readonly outcome: "slug_conflict_exhausted"; readonly field: "novel" | "article"; readonly baseSlug: string }
  /** Lost the creation race to a concurrent call for the same source item — see module header. Safe to retry: the retry will land in `"already_exists"`. */
  | { readonly outcome: "concurrent_creation_conflict" }
  /**
   * `DEFAULT_ARTICLE_TEMPLATE` (or, once wired, a DB-sourced template) failed
   * to render — see `TemplateRenderError` (`@/lib/seo/template`). Structured
   * the same way the rest of this union prefers a returned outcome over an
   * uncaught throw: the failing `novel.create`/`Novel` this attempt started
   * is rolled back (the transaction still aborts — this outcome is produced
   * by catching the render failure *outside* the transaction, after
   * `$transaction` has already unwound it), so a retry starts clean rather
   * than colliding with an orphaned row. `code`/`slot`/`constraint` mirror
   * `TemplateRenderError`'s own fields; deliberately excludes `field` (the
   * template variable name) and any rendered content — this outcome must
   * stay safe to log verbatim. Every field of `DEFAULT_ARTICLE_TEMPLATE` is
   * either a required, non-blank DB column (`novel_title`/`novel_description`)
   * or wrapped in `{if}`, so this should not occur in practice; it exists as
   * a fail-closed backstop, not an expected steady-state outcome.
   */
  | { readonly outcome: "template_render_failed"; readonly code: TemplateErrorCode; readonly slot?: string; readonly constraint?: string };

export type CreateContentFromSourceItemInput = {
  readonly novelSourceItemId: string;
  /** Explicit active template selection; omitted uses the fixed system-default-v1 preference, then the oldest active compatible template. */
  readonly templateKey?: string;
  /** Defaults to `"dry_run"` — same safety-first default `src/lib/tasks/moboreader.ts` uses for its own `mode` parameter. */
  readonly mode?: "dry_run" | "apply";
  readonly actor: CreateContentActor;
  readonly requestId: string;
  /** Batch orchestration defers preview enqueue so one aggregate task is created. */
  readonly deferPreviewEnqueue?: boolean;
};

/** Thrown only to force `$transaction` to roll back a losing attempt's just-inserted rows — never crosses this module's public boundary. See module header. */
class ContentCreationConflictSignal extends Error {}

// ---------------------------------------------------------------------------
// Slug conflict resolution
// ---------------------------------------------------------------------------

/** Read-only conflict probe for one candidate slug in a given locale. `true` means taken (by an active, non-soft-deleted row). */
type SlugConflictCheck = (candidateSlug: string) => Promise<boolean>;

type SlugResolution =
  | { readonly outcome: "ok"; readonly slug: string; readonly baseSlug: string }
  | { readonly outcome: "slug_unhealthy"; readonly baseSlug: string }
  | { readonly outcome: "slug_conflict_exhausted"; readonly baseSlug: string };

/**
 * Bounded suffix escalation (`-2`, `-3`, ...) against the active-row partial
 * unique index (`novel_locale_slug_active_uidx` / `article_locale_slug_
 * active_uidx`, both `WHERE deleted_at IS NULL`) — chosen over "throw on
 * first collision" because `src/lib/slug/README.md` explicitly authorizes
 * both strategies ("slug 冲突时 suffix-or-throw，绝不静默覆盖") and an
 * automated ingestion pipeline hitting a duplicate-title collision on nearly
 * every run (generic titles are common) would otherwise stall content
 * creation for manual intervention far more often than a self-healing
 * suffix would ever be wrong. Exhausting the bound (200 — double CPS's
 * reference implementation's 100, since this path runs unattended rather
 * than interactively) falls back to the "throw" half of that same
 * authorization, surfaced here as a structured outcome rather than a raw
 * throw so the caller never has to catch an exception to detect it — see
 * module-level discussion of returned vs. thrown failures.
 */
const SLUG_SUFFIX_MAX_ATTEMPTS = 200;

async function resolveUniqueSlug(title: string, locale: SiteLocale, exists: SlugConflictCheck): Promise<SlugResolution> {
  const baseSlug = textToSlug(title, locale);
  if (!isHealthySlug(baseSlug)) {
    return { outcome: "slug_unhealthy", baseSlug };
  }
  if (!(await exists(baseSlug))) {
    return { outcome: "ok", slug: baseSlug, baseSlug };
  }
  for (let suffix = 2; suffix <= SLUG_SUFFIX_MAX_ATTEMPTS; suffix += 1) {
    const candidate = `${baseSlug}-${suffix}`;
    // Sequential by design — deterministic escalation must probe candidates
    // in order; parallelizing would let two candidates both look free.
    if (!(await exists(candidate))) {
      return { outcome: "ok", slug: candidate, baseSlug };
    }
  }
  return { outcome: "slug_conflict_exhausted", baseSlug };
}

// ---------------------------------------------------------------------------
// Minimal read shapes this module needs (kept narrow so a hand-rolled test
// double only has to implement exactly these call shapes).
// ---------------------------------------------------------------------------

type SourceItemRow = {
  id: string;
  novelId: string | null;
  status: string;
  title: string;
  description: string;
  coverUrl: string | null;
  totalChapterCount: number;
  paidFromChapter: number | null;
  splitRatio: Prisma.Decimal | null;
  /** Already a resolved BCP-47 locale or `NULL` (L10N P1) — see `deriveLocale` above. Never re-resolved here. */
  sourceLocale: string | null;
  deletedAt: Date | null;
};

const SOURCE_ITEM_PLAN_SELECT = Object.freeze({
  id: true,
  novelId: true,
  status: true,
  title: true,
  description: true,
  coverUrl: true,
  totalChapterCount: true,
  paidFromChapter: true,
  splitRatio: true,
  sourceLocale: true,
  deletedAt: true,
} as const);

type NovelRow = { id: string; businessId: string; locale: string; slug: string; deletedAt: Date | null };
type ArticleRow = { id: string; slug: string; publicPageShortId: string };

type ReadClient = {
  novelSourceItem: {
    findFirst: (args: {
      where: { id: string };
      select: typeof SOURCE_ITEM_PLAN_SELECT;
    }) => Promise<SourceItemRow | null>;
  };
  novel: {
    findFirst: (args: {
      where: { id?: string; locale?: string; slug?: string; deletedAt?: null };
      select?: { id: true };
    }) => Promise<NovelRow | { id: string } | null>;
  };
  article: {
    findFirst: (args: {
      where: { novelId?: string; locale?: string; slug?: string; deletedAt?: null };
      select?: { id: true };
    }) => Promise<ArticleRow | { id: string } | null>;
  };
};

function existsCheck(
  find: (args: { where: { locale: string; slug: string; deletedAt: null }; select: { id: true } }) => Promise<{ id: string } | null>,
  locale: SiteLocale,
): SlugConflictCheck {
  return async (candidate) => (await find({ where: { locale, slug: candidate, deletedAt: null }, select: { id: true } })) !== null;
}

/**
 * Loads the guard facts + computes both slug plans against `client` (either
 * a live `tx` inside the write transaction, or the top-level `db` for a
 * read-only dry run) without writing anything. Shared by both branches so
 * dry-run and apply can never silently diverge on what counts as a
 * conflict.
 */
async function loadPlan(
  client: ReadClient,
  novelSourceItemId: string,
): Promise<
  | { readonly stage: "blocked"; readonly result: CreateContentResult }
  | { readonly stage: "already_exists"; readonly summary: CreatedContentSummary }
  | { readonly stage: "ready"; readonly sourceItem: SourceItemRow; readonly locale: SiteLocale; readonly novelSlug: string; readonly articleSlug: string }
> {
  // web_app deliberately has no SELECT grant on raw_payload. Keep this query
  // aligned with the explicit column grant instead of letting Prisma request
  // every NovelSourceItem column for a plan that needs only mirrored fields.
  const sourceItem = await client.novelSourceItem.findFirst({
    where: { id: novelSourceItemId },
    select: SOURCE_ITEM_PLAN_SELECT,
  });
  if (!sourceItem) return { stage: "blocked", result: { outcome: "source_item_not_found" } };
  if (sourceItem.deletedAt !== null) return { stage: "blocked", result: { outcome: "source_item_deleted" } };

  // Locale is derived here, before any other branching, so every downstream
  // decision (already-linked idempotent replay included) uses the same
  // derived value a fresh creation would — see module header and
  // `deriveLocale`'s own doc comment. Throws `ContentCreationInputError`
  // (`missing_locale`/`unsupported_locale`) rather than returning a
  // `CreateContentResult` outcome — see the "Input validation" section
  // header above for why.
  const locale = deriveLocale(sourceItem.sourceLocale);

  if (sourceItem.novelId !== null) {
    const existingNovel = (await client.novel.findFirst({ where: { id: sourceItem.novelId } })) as NovelRow | null;
    if (!existingNovel || existingNovel.deletedAt !== null) {
      return { stage: "blocked", result: { outcome: "source_item_inconsistent_state" } };
    }
    if (existingNovel.locale !== locale) {
      return {
        stage: "blocked",
        result: {
          outcome: "locale_conflict",
          reason: "source_item_already_linked_to_different_locale",
          existingNovelId: existingNovel.id,
          existingLocale: existingNovel.locale,
          derivedLocale: locale,
        },
      };
    }
    const existingArticle = (await client.article.findFirst({
      where: { novelId: existingNovel.id, locale },
    })) as ArticleRow | null;
    if (!existingArticle) {
      return { stage: "blocked", result: { outcome: "source_item_inconsistent_state" } };
    }
    return {
      stage: "already_exists",
      summary: {
        novelId: existingNovel.id,
        novelBusinessId: existingNovel.businessId,
        articleId: existingArticle.id,
        locale,
        novelSlug: existingNovel.slug,
        articleSlug: existingArticle.slug,
        publicPageShortId: existingArticle.publicPageShortId,
      },
    };
  }

  if (sourceItem.status === "ignored") return { stage: "blocked", result: { outcome: "source_item_ignored" } };
  if (sourceItem.status === "stale") return { stage: "blocked", result: { outcome: "source_item_stale" } };
  if (sourceItem.status !== "pending") return { stage: "blocked", result: { outcome: "source_item_inconsistent_state" } };

  const novelExists = existsCheck(
    (args) => client.novel.findFirst(args) as Promise<{ id: string } | null>,
    locale,
  );
  const novelSlugResult = await resolveUniqueSlug(sourceItem.title, locale, novelExists);
  if (novelSlugResult.outcome !== "ok") {
    return { stage: "blocked", result: { outcome: novelSlugResult.outcome, field: "novel", baseSlug: novelSlugResult.baseSlug } };
  }

  const articleExists = existsCheck(
    (args) => client.article.findFirst(args) as Promise<{ id: string } | null>,
    locale,
  );
  const articleSlugResult = await resolveUniqueSlug(sourceItem.title, locale, articleExists);
  if (articleSlugResult.outcome !== "ok") {
    return { stage: "blocked", result: { outcome: articleSlugResult.outcome, field: "article", baseSlug: articleSlugResult.baseSlug } };
  }

  return { stage: "ready", sourceItem, locale, novelSlug: novelSlugResult.slug, articleSlug: articleSlugResult.slug };
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

async function runDryRun(
  db: PrismaClient,
  novelSourceItemId: string,
  templateKey?: string,
): Promise<CreateContentResult> {
  const plan = await loadPlan(db as unknown as ReadClient, novelSourceItemId);
  if (plan.stage === "blocked") return plan.result;
  if (plan.stage === "already_exists") return { outcome: "already_exists", ...plan.summary };

  // Explicit templateKey preview check moved in here (from the old top-level
  // pre-check in `createContentFromSourceItem`) because it needs the derived
  // `plan.locale`, which is only known once `loadPlan` has read the source
  // item — see module header. A dry run with no explicit `templateKey` does
  // not check template availability at all (unchanged behavior): the
  // auto-select preference/fallback only gets evaluated inside the real
  // creation transaction (`runCreateTransaction`).
  if (templateKey) {
    const template = await selectActiveArticleTemplate(db, {
      locale: plan.locale,
      templateKey,
      applicableArticleType: "novel_article",
    });
    if (!template) return { outcome: "template_locale_mismatch", locale: plan.locale, templateKey };
    validateStoredArticleTemplate(template);
  }

  return {
    outcome: "dry_run",
    plan: {
      locale: plan.locale,
      title: plan.sourceItem.title,
      novelSlug: plan.novelSlug,
      articleSlug: plan.articleSlug,
      provisionalPublicPageShortId: generatePublicPageShortIdCandidate(),
    },
  };
}

// ---------------------------------------------------------------------------
// Apply (real write)
// ---------------------------------------------------------------------------

type WriteClient = ReadClient & {
  novel: ReadClient["novel"] & { create: (args: { data: Record<string, unknown> }) => Promise<NovelRow> };
  article: ReadClient["article"] & { create: (args: { data: Record<string, unknown> }) => Promise<ArticleRow> };
  novelSourceItem: ReadClient["novelSourceItem"] & {
    updateMany: (args: {
      where: { id: string; novelId: null; deletedAt: null };
      data: { novelId: string; status: "linked" };
    }) => Promise<{ count: number }>;
  };
  operationAudit: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
  articleTemplate: Prisma.TransactionClient["articleTemplate"];
};

async function runCreateTransaction(
  tx: WriteClient,
  input: { novelSourceItemId: string; templateKey?: string; actorType: "admin" | "system"; actorId: string; requestId: string },
): Promise<CreateContentResult> {
  const plan = await loadPlan(tx, input.novelSourceItemId);
  if (plan.stage === "blocked") return plan.result;
  if (plan.stage === "already_exists") return { outcome: "already_exists", ...plan.summary };

  const { sourceItem, locale, novelSlug, articleSlug } = plan;

  await ensureDefaultArticleTemplate(tx);
  const template = await selectActiveArticleTemplate(tx as unknown as PrismaClient, {
    locale,
    applicableArticleType: "novel_article",
    ...(input.templateKey ? { templateKey: input.templateKey } : {}),
  });
  if (!template) {
    return {
      outcome: "template_locale_mismatch",
      locale,
      ...(input.templateKey ? { templateKey: input.templateKey } : {}),
    };
  }
  const templateSource = validateStoredArticleTemplate(template);

  const novel = await createNovelWithBusinessIdRetry((businessId) =>
    tx.novel.create({
      data: {
        businessId,
        title: sourceItem.title,
        // C-30A: maintained alongside `title` at this, the only write point
        // that sets `Novel.title` in this codebase today — see
        // `normalizeNovelTitle`'s own doc comment.
        titleNormalized: normalizeNovelTitle(sourceItem.title),
        description: sourceItem.description,
        coverUrl: sourceItem.coverUrl,
        locale,
        slug: novelSlug,
        totalChapterCount: sourceItem.totalChapterCount,
        paidFromChapter: sourceItem.paidFromChapter,
        splitRatio: sourceItem.splitRatio,
        // status intentionally omitted — see module header, "Never writes status".
      },
    }),
  );

  // Render before the Article write, not after: `renderArticleDraft` throws
  // (never returns a half-filled draft) on any of its four slots failing, and
  // every field it reads here (`sourceItem.title`/`description`/`coverUrl`/
  // `totalChapterCount`) is the exact same data `novel.create` above just
  // wrote — reading it off `sourceItem` instead of the returned `novel` row
  // avoids widening `NovelRow`'s type for fields nothing else in this module
  // needs. `previewChapterCount`/`promoRedirectUrl` are intentionally omitted
  // (undefined → normalizes to `""`): neither exists yet at this point in the
  // pipeline (P2-05 / S5 territory — see module header), and
  // `DEFAULT_ARTICLE_TEMPLATE` wraps both in `{if}` blocks, so their absence
  // shrinks the rendered body instead of failing it.
  const templateValues = buildNovelTemplateValues({
    title: sourceItem.title,
    description: sourceItem.description,
    coverUrl: sourceItem.coverUrl,
    totalChapterCount: sourceItem.totalChapterCount,
  });
  const rendered = renderArticleDraft(templateSource, templateValues, {
    templateKey: template.templateKey,
    novelId: novel.id,
  });

  const article = await createWithPublicPageShortIdRetry((candidateShortId) =>
    tx.article.create({
      data: {
        novelId: novel.id,
        locale,
        slug: articleSlug,
        // Spelled out (not `{ publicPageShortId }` shorthand) so this
        // remains textually greppable as the one authorized write site —
        // see tests/backend/slug/short-id-sole-source.test.ts.
        publicPageShortId: candidateShortId,
        // `rendered.title` is the `title` template slot's output — equal in
        // content to `sourceItem.title` today (`DEFAULT_ARTICLE_TEMPLATE.title`
        // is the bare `{novel_title}` variable) but trimmed and already
        // checked against `Article.title`'s `VarChar(500)` bound
        // (`ERR_TEMPLATE_OUTPUT_INVALID`/`too_long` above, before this
        // insert), rather than trusting the DB to reject an oversized value.
        title: rendered.title,
        summary: sourceItem.description,
        // The Template Engine's (P2-02, `@/lib/seo/template`) real rendered
        // body — see module header. Non-blank by construction: every
        // required field it references (`novel_title`/`novel_description`)
        // is a NOT NULL `Novel` column, and every optional one is guarded by
        // `{if}`. This is what clears `required_metadata_missing`'s `body`
        // check in `src/server/publish-gate/evaluator.ts`.
        body: rendered.body,
        seoMetadata: rendered.seoMetadata,
        seoSchemaVersion: rendered.seoSchemaVersion,
        templateId: template.id,
        /**
         * C-26 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md`
         * §三/C-26): this insert IS "创建服务里的文章插入" — the plan's other
         * authorized `Article.contentMode` write site (the first is
         * `src/server/articles/service.ts`'s `updateArticleContent`/
         * `regenerateCore`). Written explicitly even though
         * `content_mode`'s column default is already `"template"` (C-24) and
         * this insert would land there unwritten — spelled out the same way
         * `publicPageShortId` above is spelled out rather than shorthand: so
         * this stays the one other textually-greppable, self-documenting
         * write site the static scan
         * (`tests/backend/articles/content-mode-sole-write-paths.test.ts`)
         * expects to find, and so a future change to the column's default
         * cannot silently change this path's behavior.
         */
        contentMode: "template" as const,
        // status intentionally omitted — see module header, "Never writes status".
      },
    }),
  );

  const link = await tx.novelSourceItem.updateMany({
    where: { id: sourceItem.id, novelId: null, deletedAt: null },
    data: { novelId: novel.id, status: "linked" },
  });
  if (link.count !== 1) {
    // Lost the race — force rollback of the Novel/Article this attempt just
    // inserted. See module header.
    throw new ContentCreationConflictSignal();
  }

  await tx.operationAudit.create({
    data: {
      actorType: input.actorType,
      actorId: input.actorId,
      action: CONTENT_CREATE_AUDIT_ACTION,
      entityType: "Novel",
      entityId: novel.id,
      requestId: input.requestId,
      afterSnapshot: {
        novelId: novel.id,
        novelBusinessId: novel.businessId,
        articleId: article.id,
        locale,
        novelSlug,
        articleSlug,
        publicPageShortId: article.publicPageShortId,
        novelSourceItemId: sourceItem.id,
      },
    },
  });

  return {
    outcome: "created",
    novelId: novel.id,
    novelBusinessId: novel.businessId,
    articleId: article.id,
    locale,
    novelSlug,
    articleSlug,
    publicPageShortId: article.publicPageShortId,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Creates a draft `Novel` + same-locale draft `Article` from a
 * `NovelSourceItem`'s mirrored fields, or (in `"dry_run"` mode, the default)
 * returns the plan that would be created without writing anything. See
 * module header for full scope, idempotency, and concurrency discussion.
 */
export async function createContentFromSourceItem(
  db: PrismaClient,
  input: CreateContentFromSourceItemInput,
): Promise<CreateContentResult> {
  const novelSourceItemId = requireUuid(input.novelSourceItemId);
  const mode = input.mode ?? "dry_run";
  requireActor(input.actor);
  const requestId = requireRequestId(input.requestId);

  if (mode === "dry_run") {
    return runDryRun(db, novelSourceItemId, input.templateKey);
  }

  const actorType = auditActorType(input.actor);
  const actorId = auditActorId(input.actor);

  try {
    const result = await withDbRetry(
      () =>
        db.$transaction((tx) =>
          runCreateTransaction(tx as unknown as WriteClient, {
            novelSourceItemId,
            ...(input.templateKey ? { templateKey: input.templateKey } : {}),
            actorType,
            actorId,
            requestId,
          }),
        ),
      { op: "content-creation.createContentFromSourceItem", sourceItemId: novelSourceItemId, idempotencyKey: requestId },
    );
    if (result.outcome !== "created" || input.deferPreviewEnqueue) return result;
    const previewEnqueue = await enqueueContentCreationPreview(db, {
      novelSourceItemIds: [novelSourceItemId],
      requestToken: `moboreader.preview_refresh.v1:content_create:${novelSourceItemId}`,
      requestId,
      actorId,
    });
    return { ...result, previewEnqueue };
  } catch (error) {
    if (error instanceof ContentCreationConflictSignal) {
      return { outcome: "concurrent_creation_conflict" };
    }
    // `isTemplateRenderError` (not `instanceof`) — same cross-realm duck-type
    // guard `@/lib/seo/template`'s own doc comment requires: Worker and Web
    // are different module realms, so a naive `instanceof` could miss a
    // legitimate `TemplateRenderError` thrown from the other realm's copy of
    // the class.
    if (isTemplateRenderError(error)) {
      return {
        outcome: "template_render_failed",
        code: error.code,
        ...(error.slot === undefined ? {} : { slot: error.slot }),
        ...(error.constraint === undefined ? {} : { constraint: error.constraint }),
      };
    }
    throw error;
  }
}
