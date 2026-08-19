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
 * - **Locale is caller-supplied, not derived.** Language normalization
 *   (S7a) is not wired yet — `resolveSiteLocale`/`isPublishableLocale`
 *   (`src/lib/locale/locale-canonical.ts`) are not consulted here at all.
 *   The caller is responsible for only invoking this service with a locale
 *   that actually matches `NovelSourceItem.sourceLocale`'s mapped site
 *   locale; this service only checks that the locale is a *registered*
 *   `SiteLocale` (`docs/governance/database-governance.md` §4 `novel` row:
 *   "locale 必须是站点 canonical locale"), not that it is the *correct* one
 *   for this row. **TODO(S7a): derive `locale` from
 *   `NovelSourceItem.sourceLocale` instead of accepting it as an input.**
 * - **`Article.body` is left `""`.** Rendering the actual publish-ready body
 *   is P2-02's job (Template Engine or another authorized content
 *   production path) — see `src/contracts/publish-gate.ts`'s header. An
 *   empty `body` on a `draft` row satisfies `article_published_body_check`
 *   (`status <> 'published' OR btrim(body) <> ''`) without any special
 *   casing; the publish gate's own `required_metadata_missing` /
 *   `preview_body_missing` reasons are what stop an under-filled draft from
 *   ever reaching `published` later.
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

import { createNovelWithBusinessIdRetry } from "./business-id";

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
// Input validation (throws — malformed caller input, not a business state)
// ---------------------------------------------------------------------------

export type ContentCreationInputErrorCode =
  | "invalid_novel_source_item_id"
  | "invalid_locale"
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

function requireLocale(value: SiteLocale | undefined): SiteLocale {
  const locale = value ?? "en";
  if (!SITE_LOCALES.includes(locale)) {
    throw new ContentCreationInputError("invalid_locale", `Locale is not a registered SiteLocale: ${String(locale)}`);
  }
  return locale;
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
  | ({ readonly outcome: "created" } & CreatedContentSummary)
  | ({ readonly outcome: "already_exists" } & CreatedContentSummary)
  | { readonly outcome: "dry_run"; readonly plan: ContentCreationPlan }
  | { readonly outcome: "source_item_not_found" }
  | { readonly outcome: "source_item_deleted" }
  | { readonly outcome: "source_item_ignored" }
  | { readonly outcome: "source_item_stale" }
  /** Defensive: the source item's `novelId`/`status` combination doesn't match any state this service's state machine expects (e.g. `status === "linked"` but `novelId` is `null`, or `novelId` points at a missing/soft-deleted Novel, or a linked Novel has no Article for its own locale). Not this call's job to repair — surfaced for manual review. */
  | { readonly outcome: "source_item_inconsistent_state" }
  | {
      readonly outcome: "locale_conflict";
      readonly reason: "source_item_already_linked_to_different_locale";
      readonly existingNovelId: string;
      readonly existingLocale: string;
    }
  | { readonly outcome: "slug_unhealthy"; readonly field: "novel" | "article"; readonly baseSlug: string }
  | { readonly outcome: "slug_conflict_exhausted"; readonly field: "novel" | "article"; readonly baseSlug: string }
  /** Lost the creation race to a concurrent call for the same source item — see module header. Safe to retry: the retry will land in `"already_exists"`. */
  | { readonly outcome: "concurrent_creation_conflict" };

export type CreateContentFromSourceItemInput = {
  readonly novelSourceItemId: string;
  /** Defaults to `"en"` — see module header, "Locale is caller-supplied, not derived." */
  readonly locale?: SiteLocale;
  /** Defaults to `"dry_run"` — same safety-first default `src/lib/tasks/moboreader.ts` uses for its own `mode` parameter. */
  readonly mode?: "dry_run" | "apply";
  readonly actor: CreateContentActor;
  readonly requestId: string;
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
  deletedAt: Date | null;
};

type NovelRow = { id: string; businessId: string; locale: string; slug: string; deletedAt: Date | null };
type ArticleRow = { id: string; slug: string; publicPageShortId: string };

type ReadClient = {
  novelSourceItem: { findFirst: (args: { where: { id: string } }) => Promise<SourceItemRow | null> };
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
  locale: SiteLocale,
): Promise<
  | { readonly stage: "blocked"; readonly result: CreateContentResult }
  | { readonly stage: "already_exists"; readonly summary: CreatedContentSummary }
  | { readonly stage: "ready"; readonly sourceItem: SourceItemRow; readonly novelSlug: string; readonly articleSlug: string }
> {
  const sourceItem = await client.novelSourceItem.findFirst({ where: { id: novelSourceItemId } });
  if (!sourceItem) return { stage: "blocked", result: { outcome: "source_item_not_found" } };
  if (sourceItem.deletedAt !== null) return { stage: "blocked", result: { outcome: "source_item_deleted" } };

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

  return { stage: "ready", sourceItem, novelSlug: novelSlugResult.slug, articleSlug: articleSlugResult.slug };
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

async function runDryRun(db: PrismaClient, novelSourceItemId: string, locale: SiteLocale): Promise<CreateContentResult> {
  const plan = await loadPlan(db as unknown as ReadClient, novelSourceItemId, locale);
  if (plan.stage === "blocked") return plan.result;
  if (plan.stage === "already_exists") return { outcome: "already_exists", ...plan.summary };
  return {
    outcome: "dry_run",
    plan: {
      locale,
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
};

async function runCreateTransaction(
  tx: WriteClient,
  input: { novelSourceItemId: string; locale: SiteLocale; actorType: "admin" | "system"; actorId: string; requestId: string },
): Promise<CreateContentResult> {
  const plan = await loadPlan(tx, input.novelSourceItemId, input.locale);
  if (plan.stage === "blocked") return plan.result;
  if (plan.stage === "already_exists") return { outcome: "already_exists", ...plan.summary };

  const { sourceItem, novelSlug, articleSlug } = plan;

  const novel = await createNovelWithBusinessIdRetry((businessId) =>
    tx.novel.create({
      data: {
        businessId,
        title: sourceItem.title,
        description: sourceItem.description,
        coverUrl: sourceItem.coverUrl,
        locale: input.locale,
        slug: novelSlug,
        totalChapterCount: sourceItem.totalChapterCount,
        paidFromChapter: sourceItem.paidFromChapter,
        splitRatio: sourceItem.splitRatio,
        // status intentionally omitted — see module header, "Never writes status".
      },
    }),
  );

  const article = await createWithPublicPageShortIdRetry((candidateShortId) =>
    tx.article.create({
      data: {
        novelId: novel.id,
        locale: input.locale,
        slug: articleSlug,
        // Spelled out (not `{ publicPageShortId }` shorthand) so this
        // remains textually greppable as the one authorized write site —
        // see tests/backend/slug/short-id-sole-source.test.ts.
        publicPageShortId: candidateShortId,
        title: sourceItem.title,
        summary: sourceItem.description,
        // P2-02 (Template Engine or another authorized content production
        // path) territory — see module header and
        // src/contracts/publish-gate.ts. `""` satisfies the NOT NULL column
        // and the draft-row CHECK; the publish gate blocks publish on an
        // empty body.
        body: "",
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
        locale: input.locale,
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
    locale: input.locale,
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
  const locale = requireLocale(input.locale);
  const mode = input.mode ?? "dry_run";
  requireActor(input.actor);
  const requestId = requireRequestId(input.requestId);

  if (mode === "dry_run") {
    return runDryRun(db, novelSourceItemId, locale);
  }

  const actorType = auditActorType(input.actor);
  const actorId = auditActorId(input.actor);

  try {
    return await withDbRetry(
      () =>
        db.$transaction((tx) =>
          runCreateTransaction(tx as unknown as WriteClient, { novelSourceItemId, locale, actorType, actorId, requestId }),
        ),
      { op: "content-creation.createContentFromSourceItem", sourceItemId: novelSourceItemId, idempotencyKey: requestId },
    );
  } catch (error) {
    if (error instanceof ContentCreationConflictSignal) {
      return { outcome: "concurrent_creation_conflict" };
    }
    throw error;
  }
}
