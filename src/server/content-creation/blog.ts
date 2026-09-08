/**
 * C-28 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-28):
 * "新建博客" — the second write path in this codebase that ever calls
 * `article.create` (the first is `./service.ts`'s `createContentFromSourceItem`,
 * which this file deliberately does not touch or extend). **Must** live in
 * this directory: `Article.publicPageShortId`'s sole-generation-entry-point
 * static scan (`tests/backend/slug/short-id-sole-source.test.ts`) only
 * authorizes a `publicPageShortId:` write site under
 * `src/server/content-creation/`, and `Article.contentMode`'s own sole-
 * write-paths scan (`tests/backend/articles/content-mode-sole-write-paths.test.ts`)
 * authorizes the same directory (alongside `src/server/articles/`) for a
 * `contentMode:` write site — this file needs both.
 *
 * Fixed values this function writes, never caller-supplied: `articleType:
 * "blog_article"`, `contentMode: "manual"`, `novelId: null`, `templateId:
 * null`, `promoLinkId: null`. `status` is never spelled at all (same
 * discipline `./service.ts`'s header documents at length) — the column
 * default is `"draft"` and `tests/backend/publish-gate/no-bypass.test.ts`
 * statically forbids a `status:` key on any `.article.*(` write outside
 * `src/server/publish-gate/`, literal or variable, any value. A blog
 * Article's only door into `published` is the publish gate
 * (`admin.article.update` 编辑页 → 列表页"发布" → `publishArticleAsAdmin`),
 * exactly like a `novel_article` — this service creates a normal draft, one
 * extra click away from published, in exchange for the write口 staying
 * singular. See `./service.ts`'s own header for the identical reasoning
 * applied to the novel-article creation pipeline.
 *
 * Slug uniqueness: deliberately **not** `./service.ts`'s `resolveUniqueSlug`
 * (bounded `-2`/`-3`/... suffix escalation). That strategy exists for the
 * *automated* catalog-ingestion pipeline, where a generic source-item title
 * colliding with an existing slug is common and a human is not standing by
 * to react. A blog post's slug is operator-typed (the "自定义地址" field,
 * `docs/governance/database-governance.md`'s "slug 不静默覆盖" — see
 * `src/lib/slug/README.md`) — silently appending `-2` to what an operator
 * just typed would publish a URL they neither chose nor were told about.
 * The plan is explicit on this point: "不自动加后缀（与 CPS 一致，也与本仓库
 * 'slug 不静默覆盖'的既有裁决一致）". This function instead does a plain
 * "先查后插 + 唯一冲突兜底": a pre-check under the same transaction, then a
 * defense-in-depth catch on the insert itself for the race window between
 * the check and the write (two genuinely concurrent submissions of the same
 * (locale, slug) pair) — both paths return the same `slug_conflict` outcome,
 * never a silent suffix.
 */
import { Prisma, type PrismaClient } from "@prisma/client";

import { ARTICLE_SEO_VISIBILITIES, type ArticleSeoVisibility } from "@/domain/database-statuses";
import { isUniqueConstraintViolation } from "@/lib/db/db-retry";
import { isArticleBlogEnabled, isArticleBlogWriteAllowed } from "@/lib/flags";
import { SITE_LOCALES, type SiteLocale } from "@/lib/locale/locale-canonical";
import { createWithPublicPageShortIdRetry, isPublicPageShortIdConflict } from "@/lib/slug/short-id";
import { sanitizeArticleBody } from "@/server/articles/sanitize-body";

import type { CreateContentActor } from "./service";

// ---------------------------------------------------------------------------
// Input validation (throws — malformed caller input, same discipline as
// `./service.ts`'s `ContentCreationInputError`, not a business state).
// ---------------------------------------------------------------------------

export type BlogArticleInputErrorCode =
  | "invalid_locale"
  | "invalid_title"
  | "invalid_slug"
  | "invalid_body"
  | "invalid_seo_visibility"
  | "invalid_actor"
  | "invalid_request_id";

export class BlogArticleInputError extends Error {
  readonly code: BlogArticleInputErrorCode;

  constructor(code: BlogArticleInputErrorCode, message: string) {
    super(message);
    this.name = "BlogArticleInputError";
    this.code = code;
  }
}

const ARTICLE_TITLE_MAX_LENGTH = 500; // Article.title @db.VarChar(500)
const ARTICLE_SLUG_MAX_LENGTH = 240; // Article.slug @db.VarChar(240)
/**
 * Lowercase alphanumeric segments joined by single hyphens, no leading/
 * trailing hyphen. Deliberately stricter than accepting anything and
 * lower-casing it server-side: the "从标题生成" button
 * (`./_components`-adjacent client form, `@/lib/slug/text-to-slug`'s
 * `textToSlug`) already produces exactly this shape, so an operator who
 * hand-edits the field afterward into something this regex rejects gets a
 * clear validation error instead of a silent server-side rewrite of what
 * they typed — same "不静默覆盖" posture as the slug-conflict handling
 * above, applied to shape rather than uniqueness.
 */
const SLUG_FORMAT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function requireLocale(value: unknown): SiteLocale {
  if (typeof value !== "string" || !SITE_LOCALES.includes(value as SiteLocale)) {
    throw new BlogArticleInputError("invalid_locale", "Locale is not a registered SiteLocale");
  }
  return value as SiteLocale;
}

function requireTitle(value: unknown): string {
  const title = typeof value === "string" ? value.trim() : "";
  if (!title || title.length > ARTICLE_TITLE_MAX_LENGTH) {
    throw new BlogArticleInputError("invalid_title", "A non-blank title within the length bound is required");
  }
  return title;
}

function requireSlug(value: unknown): string {
  // Trimmed only — deliberately NOT lower-cased here. See `SLUG_FORMAT_RE`'s
  // own doc comment: this function rejects a shape mismatch (including
  // stray uppercase) rather than silently rewriting what the operator
  // typed, the same "不静默覆盖" posture applied to shape that the module
  // header applies to uniqueness.
  const slug = typeof value === "string" ? value.trim() : "";
  if (!slug || slug.length > ARTICLE_SLUG_MAX_LENGTH || !SLUG_FORMAT_RE.test(slug)) {
    throw new BlogArticleInputError(
      "invalid_slug",
      "Slug must be non-blank, lowercase alphanumeric segments joined by single hyphens",
    );
  }
  return slug;
}

function requireBody(value: unknown): string {
  const body = typeof value === "string" ? value.trim() : "";
  if (!body) {
    throw new BlogArticleInputError("invalid_body", "A non-blank body is required");
  }
  return body;
}

function requireSeoVisibility(value: unknown): ArticleSeoVisibility {
  if (typeof value !== "string" || !ARTICLE_SEO_VISIBILITIES.includes(value as ArticleSeoVisibility)) {
    throw new BlogArticleInputError("invalid_seo_visibility", "seoVisibility is not a registered value");
  }
  return value as ArticleSeoVisibility;
}

function requireActor(actor: CreateContentActor): void {
  const id = actor.type === "admin" ? actor.adminId : actor.source;
  if (typeof id !== "string" || id.trim().length === 0 || id.length > 128) {
    throw new BlogArticleInputError("invalid_actor", "A valid actor identity is required");
  }
}

function requireRequestId(requestId: unknown): string {
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 160) {
    throw new BlogArticleInputError("invalid_request_id", "A valid requestId is required");
  }
  return requestId;
}

/** Optional free-text field: trimmed, `undefined`/blank normalize to `undefined` (omitted from the stored JSON) rather than an empty string. */
function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

// ---------------------------------------------------------------------------
// Public input/output shapes
// ---------------------------------------------------------------------------

export type CreateBlogArticleInput = {
  /**
   * Plain `string`, not `SiteLocale` — this input crosses the Server Action
   * boundary from a raw HTML `<select>` value (`../_actions.ts`'s
   * `createBlogArticleAction`), so it is validated (not merely narrowed) at
   * runtime by `requireLocale` below, same "type-widen at the untrusted
   * boundary, throw on a bad value inside" shape `ArticleEditInput`'s own
   * `seoVisibility?: string` already uses one file over.
   */
  readonly locale: string;
  readonly title: string;
  /** Operator-typed, exact — see module header on why this is never auto-suffixed. */
  readonly slug: string;
  readonly summary?: string;
  readonly body: string;
  /** Plain `string` — see `locale`'s own doc comment above; validated by `requireSeoVisibility` below. */
  readonly seoVisibility: string;
  readonly metaTitle?: string;
  readonly metaDescription?: string;
  readonly metaKeywords?: string;
  /**
   * Optional. `Article` has no `coverUrl` column (that field lives on
   * `Novel`/`NovelSourceItem`, and this round carries no schema change —
   * C-27 already spent this round's migration budget) — stored as a key
   * inside the existing free-form `Article.seoMetadata` JSON column
   * alongside `metaTitle`/`metaDescription`/`metaKeywords`, the same
   * "additive JSON key, no migration" shape those three already use. A
   * future round with public-side blog rendering needs (C-29+) can promote
   * it to a real column then, if warranted; nothing here forecloses that.
   */
  readonly coverUrl?: string;
  readonly actor: CreateContentActor;
  readonly requestId: string;
};

export type CreateBlogArticleResult =
  | {
      readonly outcome: "created";
      readonly articleId: string;
      readonly locale: SiteLocale;
      readonly slug: string;
      readonly publicPageShortId: string;
    }
  /** `FEATURE_ARTICLE_BLOG` is off — the whole capability is fail-closed, including this direct-call path (not just the admin page/button). */
  | { readonly outcome: "feature_disabled" }
  /** `FEATURE_ARTICLE_BLOG` is on but `ARTICLE_BLOG_ALLOW_WRITE` is not — validated, zero writes. */
  | { readonly outcome: "write_disabled" }
  /** A different, non-deleted Article already occupies this (locale, slug) pair — see module header for why this is surfaced as a plain outcome rather than a silent suffix. */
  | { readonly outcome: "slug_conflict"; readonly locale: SiteLocale; readonly slug: string };

const BLOG_ARTICLE_AUDIT_ACTION = "article.create_blog";

/**
 * Creates a `draft` `blog_article` Article with no Novel, no PromoLink, and
 * no Template — see module header for the full fixed-value list and the
 * reasoning behind each deliberate omission. Runs inside its own
 * transaction (the pre-check and the insert must observe the same
 * snapshot) — unlike `./service.ts`'s `createContentFromSourceItem`, this
 * function has exactly one caller (the admin Server Action) and no batch
 * variant that would need to nest it inside an already-open transaction, so
 * `db` is a plain `PrismaClient`, not a wider `WriteClient` union.
 */
export async function createBlogArticle(
  db: PrismaClient,
  input: CreateBlogArticleInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CreateBlogArticleResult> {
  if (!isArticleBlogEnabled(env)) return { outcome: "feature_disabled" };

  const locale = requireLocale(input.locale);
  const title = requireTitle(input.title);
  const slug = requireSlug(input.slug);
  const rawBody = requireBody(input.body);
  const seoVisibility = requireSeoVisibility(input.seoVisibility);
  requireActor(input.actor);
  const requestId = requireRequestId(input.requestId);
  const summary = normalizeOptionalText(input.summary);
  const metaTitle = normalizeOptionalText(input.metaTitle);
  const metaDescription = normalizeOptionalText(input.metaDescription);
  const metaKeywords = normalizeOptionalText(input.metaKeywords);
  const coverUrl = normalizeOptionalText(input.coverUrl);

  if (!isArticleBlogWriteAllowed(env)) return { outcome: "write_disabled" };

  const body = sanitizeArticleBody(rawBody);
  const seoMetadata = {
    ...(metaTitle ? { metaTitle } : {}),
    ...(metaDescription ? { metaDescription } : {}),
    ...(metaKeywords ? { metaKeywords } : {}),
    ...(coverUrl ? { coverUrl } : {}),
  } as Prisma.InputJsonValue;

  return db.$transaction(async (tx) => {
    // "先查后插": fast path, avoids even attempting the insert for the
    // common case of an operator retyping a slug they already know is taken.
    const existing = await tx.article.findFirst({
      where: { locale, slug, deletedAt: null },
      select: { id: true },
    });
    if (existing) return { outcome: "slug_conflict", locale, slug };

    try {
      const article = await createWithPublicPageShortIdRetry((candidateShortId) =>
        tx.article.create({
          data: {
            novelId: null,
            templateId: null,
            promoLinkId: null,
            articleType: "blog_article",
            contentMode: "manual",
            locale,
            slug,
            // Spelled out (not shorthand) so this stays textually greppable
            // as an authorized write site — see
            // tests/backend/slug/short-id-sole-source.test.ts.
            publicPageShortId: candidateShortId,
            title,
            summary: summary ?? null,
            body,
            seoMetadata,
            seoVisibility,
            // status intentionally omitted — see module header.
          },
        }),
      );

      await tx.operationAudit.create({
        data: {
          actorType: input.actor.type,
          actorId: input.actor.type === "admin" ? input.actor.adminId : input.actor.source,
          action: BLOG_ARTICLE_AUDIT_ACTION,
          entityType: "Article",
          entityId: article.id,
          requestId,
          afterSnapshot: {
            articleId: article.id,
            locale,
            slug,
            publicPageShortId: article.publicPageShortId,
            seoVisibility,
          },
        },
      });

      return {
        outcome: "created",
        articleId: article.id,
        locale,
        slug,
        publicPageShortId: article.publicPageShortId,
      };
    } catch (error) {
      // `createWithPublicPageShortIdRetry` already exhausted its own
      // bounded retry for a short-id collision specifically (vanishingly
      // unlikely for a fresh 8-char candidate) and would have re-thrown
      // that unchanged — this catch is for the *other* unique index this
      // insert can hit: `article_locale_slug_active_uidx`, the race-window
      // case the pre-check above cannot close on its own (two genuinely
      // concurrent submissions of the same (locale, slug) pair). Anything
      // else (a different failure entirely) propagates unchanged.
      if (isUniqueConstraintViolation(error) && !isPublicPageShortIdConflict(error)) {
        return { outcome: "slug_conflict", locale, slug };
      }
      throw error;
    }
  });
}
