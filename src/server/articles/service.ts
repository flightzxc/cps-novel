import { Prisma, type PrismaClient } from "@prisma/client";

import { ADMIN_CONTENT_MAX_SEARCH_LENGTH, type AdminContentPage } from "@/domain/admin-content";
import { ARTICLE_SEO_VISIBILITIES, ARTICLE_STATUSES, type ArticleSeoVisibility, type ArticleStatus } from "@/domain/database-statuses";
import { SITE_LOCALES } from "@/lib/locale/locale-canonical";
import { buildNovelTemplateValues, isTemplateRenderError, renderArticleDraft } from "@/lib/seo/template";
import { parseArticleSlugParam } from "@/lib/slug/article-path";
import type { AdminIdentityStore, SessionStore } from "@/lib/auth/ports";
import { requireFreshAdminServiceMutation, type AdminServiceAuthorization } from "@/server/auth/guards";
import { AdminContentQueryError } from "@/server/admin-content";
import { selectActiveArticleTemplate, validateStoredArticleTemplate } from "@/server/article-templates";
import { sanitizeArticleBody } from "./sanitize-body";

export const ARTICLE_REGENERATE_BATCH_MAX = 50;
export const ARTICLE_REGENERATE_BUDGET_MS = 25_000;

/**
 * N-7 optimistic lock, same error-code family as `SiteSettingMutationConflictError`
 * (`src/server/site-settings/service.ts`): a distinct thrown class carrying a
 * stable `code`/`status` pair the Server Action layer maps to a client-visible
 * code, rather than falling into the generic `*_write_failed` catch-all.
 *
 * `article_conflict` is registered in `src/contracts/errors.ts` (the
 * `AdminErrorCode` union) and `src/features/admin-ui/error-copy.ts` (the
 * Chinese copy table, lane D). Articles have no HTTP route — every mutation
 * goes through `src/app/(admin)/articles/_actions.ts`'s Server Actions — so
 * there is no `src/app/api/admin/_lib/respond.ts` boundary to also wire this
 * class into; that file's `toErrorEnvelope` only matters for `/api/admin/...`
 * routes.
 */
export class ArticleConflictError extends Error {
  readonly code = "article_conflict" as const;
  readonly status = 409 as const;
  constructor() {
    super("Article changed after it was read");
    this.name = "ArticleConflictError";
  }
}

/**
 * Round-trip validation identical in spirit to `site-settings/service.ts`'s
 * `expectedTimestamp`: `expectedUpdatedAt` must be exactly the ISO-8601
 * string a prior read produced (`Date.prototype.toISOString()`), not merely
 * *a* parseable date. This catches a client that reformats or truncates the
 * timestamp before sending it back, which would otherwise silently widen the
 * CAS window below.
 */
function expectedArticleTimestamp(value: unknown): Date {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("article_expected_updated_at_invalid");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("article_expected_updated_at_invalid");
  }
  return parsed;
}

export type ArticleServiceDependencies = {
  db: PrismaClient;
  identities: AdminIdentityStore;
  sessions: SessionStore;
  env?: NodeJS.ProcessEnv;
  now?: Date;
};

export type ArticleEditInput = {
  title: string;
  summary: string;
  body: string;
  metaTitle?: string;
  metaDescription?: string;
  /**
   * C-25 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-25):
   * optional per this round's "contract types gain optional fields only"
   * discipline. The editor's three-pill selector always sends the article's
   * current value (never omits it), but an existing/future caller that does
   * not know about this field must keep compiling and keep the column
   * untouched — see `updateArticleContent`'s `data` assembly below.
   */
  seoVisibility?: string;
};

function text(value: string, code: string, max?: number) {
  const normalized = value.trim();
  if (!normalized || (max !== undefined && normalized.length > max)) throw new Error(code);
  return normalized;
}

/** Same "throw a bare `Error(code)`" convention as {@link text} above — `_actions.ts`'s `writeErrorCode` folds any code it does not specifically recognize into the generic `article_update_failed` fallback, same as an invalid title/body already does. */
function validateSeoVisibility(value: string): ArticleSeoVisibility {
  if (!ARTICLE_SEO_VISIBILITIES.includes(value as ArticleSeoVisibility)) {
    throw new Error("article_seo_visibility_invalid");
  }
  return value as ArticleSeoVisibility;
}

async function authorize(
  authorization: AdminServiceAuthorization,
  entryId: string,
  requestId: string,
  deps: ArticleServiceDependencies,
) {
  return requireFreshAdminServiceMutation(authorization, "content:publish", {
    identities: deps.identities,
    sessions: deps.sessions,
    env: deps.env,
    now: deps.now,
    entryId,
    requestId,
  });
}

export async function updateArticleContent(input: {
  authorization: AdminServiceAuthorization;
  requestId: string;
  articleId: string;
  expectedUpdatedAt: string;
  patch: ArticleEditInput;
}, deps: ArticleServiceDependencies) {
  const context = await authorize(input.authorization, "admin.article.update", input.requestId, deps);
  const expected = expectedArticleTimestamp(input.expectedUpdatedAt);
  const data = {
    title: text(input.patch.title, "article_title_invalid", 500),
    summary: input.patch.summary.trim() || null,
    // N-8: operator-typed HTML goes through the zero-dependency whitelist —
    // never the template-engine regenerate path (see sanitize-body.ts header).
    body: sanitizeArticleBody(text(input.patch.body, "article_body_invalid")),
    seoMetadata: {
      ...(input.patch.metaTitle?.trim() ? { metaTitle: input.patch.metaTitle.trim() } : {}),
      ...(input.patch.metaDescription?.trim() ? { metaDescription: input.patch.metaDescription.trim() } : {}),
    } as Prisma.InputJsonValue,
    // C-25: omitted entirely (not even `undefined`-spread) when the caller
    // does not send it, so the column is left untouched rather than reset to
    // a default — same "optional patch field, absent = don't touch" shape as
    // `metaTitle`/`metaDescription` above.
    ...(input.patch.seoVisibility !== undefined
      ? { seoVisibility: validateSeoVisibility(input.patch.seoVisibility) }
      : {}),
  };
  // Same narrow-window CAS discipline as `site-settings/service.ts`'s
  // `updateAdminSiteSetting`: Postgres timestamptz(6) can carry sub-millisecond
  // precision that a JS `Date` round-trip cannot reproduce, so the match is a
  // `[expected, expected + 1ms)` window rather than strict equality.
  const expectedExclusive = new Date(expected.getTime() + 1);
  return deps.db.$transaction(async (tx) => {
    const before = await tx.article.findFirstOrThrow({ where: { id: input.articleId, deletedAt: null }, select: { id: true, title: true, summary: true, templateId: true, seoVisibility: true, updatedAt: true } });
    const now = deps.now ?? new Date();
    const updatedAt = new Date(Math.max(now.getTime(), expected.getTime() + 1));
    const write = await tx.article.updateMany({
      where: { id: before.id, updatedAt: { gte: expected, lt: expectedExclusive } },
      data: { ...data, updatedAt },
    });
    if (write.count !== 1) throw new ArticleConflictError();
    const row = await tx.article.findFirstOrThrow({ where: { id: before.id } });
    await tx.operationAudit.create({ data: {
      actorType: "admin", actorId: context.identity.id, action: "article.update",
      entityType: "Article", entityId: row.id, requestId: input.requestId,
      beforeSnapshot: { title: before.title, summary: before.summary, templateId: before.templateId, seoVisibility: before.seoVisibility },
      afterSnapshot: { title: row.title, summary: row.summary, templateId: row.templateId, seoVisibility: row.seoVisibility },
    } });
    return row;
  });
}

export type ArticleRegenerateResult =
  | { outcome: "regenerated"; articleId: string; templateId: string; templateKey: string }
  | { outcome: "article_not_found" }
  | { outcome: "conflict" }
  | { outcome: "template_not_available" }
  | { outcome: "template_render_failed"; code: string };

/**
 * `expectedUpdatedAt` is optional: the single-article regenerate path
 * (`regenerateArticle`, N-7) always supplies it, matching `updateArticleContent`'s
 * lock. The batch path (`regenerateArticlesBatch`) deliberately does not — an
 * operator who explicitly selects N articles and asks to regenerate all of
 * them is not "reading, then writing" any one of them the way a single-item
 * edit form is, and per-row CAS there would just turn ordinary concurrent
 * automation (e.g. another regenerate batch) into batch-wide `failed` noise
 * with no read step for the operator to have raced against.
 */
async function regenerateCore(
  db: PrismaClient,
  articleId: string,
  actorId: string,
  requestId: string,
  expectedUpdatedAt?: string,
): Promise<ArticleRegenerateResult> {
  const article = await db.article.findFirst({
    where: { id: articleId, deletedAt: null },
    select: {
      id: true, locale: true, templateId: true, updatedAt: true,
      novel: { select: { id: true, title: true, description: true, coverUrl: true, totalChapterCount: true } },
      promoLink: { select: { publicRedirectCode: true } },
    },
  });
  if (!article) return { outcome: "article_not_found" };
  if (expectedUpdatedAt !== undefined) {
    const expected = expectedArticleTimestamp(expectedUpdatedAt);
    if (article.updatedAt.getTime() !== expected.getTime()) return { outcome: "conflict" };
  }
  const linked = article.templateId ? await db.articleTemplate.findFirst({ where: { id: article.templateId, status: "active", deletedAt: null } }) : null;
  const template = linked ?? await selectActiveArticleTemplate(db, { locale: article.locale });
  if (!template) return { outcome: "template_not_available" };
  try {
    const source = validateStoredArticleTemplate(template);
    const previewChapterCount = await db.novelChapter.count({ where: { novelId: article.novel.id, status: "preview", deletedAt: null, content: { isNot: null } } });
    const rendered = renderArticleDraft(source, buildNovelTemplateValues({
      title: article.novel.title,
      description: article.novel.description,
      coverUrl: article.novel.coverUrl,
      totalChapterCount: article.novel.totalChapterCount,
      previewChapterCount,
      promoRedirectUrl: article.promoLink ? `/go/${article.promoLink.publicRedirectCode}` : undefined,
    }), { templateKey: template.templateKey, novelId: article.novel.id });
    const conflicted = await db.$transaction(async (tx) => {
      // Re-check the CAS window inside the transaction: the read above and
      // this write straddle the (possibly slow) template render, which is
      // exactly the race window `updateArticleContent`'s single findFirstOrThrow
      // + updateMany doesn't have to worry about.
      if (expectedUpdatedAt !== undefined) {
        const expected = expectedArticleTimestamp(expectedUpdatedAt);
        const write = await tx.article.updateMany({
          where: { id: article.id, updatedAt: { gte: expected, lt: new Date(expected.getTime() + 1) } },
          data: {
            title: rendered.title, body: rendered.body,
            seoMetadata: rendered.seoMetadata as Prisma.InputJsonValue,
            seoSchemaVersion: rendered.seoSchemaVersion, templateId: template.id,
          },
        });
        if (write.count !== 1) return true;
      } else {
        await tx.article.update({ where: { id: article.id }, data: {
          title: rendered.title, body: rendered.body,
          seoMetadata: rendered.seoMetadata as Prisma.InputJsonValue,
          seoSchemaVersion: rendered.seoSchemaVersion, templateId: template.id,
        } });
      }
      await tx.operationAudit.create({ data: {
        actorType: "admin", actorId, action: "article.regenerate", entityType: "Article",
        entityId: article.id, requestId, afterSnapshot: { templateId: template.id, templateKey: template.templateKey },
      } });
      return false;
    });
    if (conflicted) return { outcome: "conflict" };
    return { outcome: "regenerated", articleId: article.id, templateId: template.id, templateKey: template.templateKey };
  } catch (error) {
    if (isTemplateRenderError(error)) return { outcome: "template_render_failed", code: error.code };
    if (error instanceof Error && error.name === "ArticleTemplateInputError") return { outcome: "template_render_failed", code: "template_schema_invalid" };
    throw error;
  }
}

export async function regenerateArticle(input: {
  authorization: AdminServiceAuthorization; requestId: string; articleId: string; expectedUpdatedAt: string;
}, deps: ArticleServiceDependencies) {
  const context = await authorize(input.authorization, "admin.article.regenerate", input.requestId, deps);
  return regenerateCore(deps.db, input.articleId, context.identity.id, input.requestId, input.expectedUpdatedAt);
}

export type ArticleRegenerateBatchItem = {
  articleId: string;
  status: "regenerated" | "skipped" | "failed" | "not_processed";
  result?: ArticleRegenerateResult;
};

export async function regenerateArticlesBatch(input: {
  authorization: AdminServiceAuthorization; requestId: string; articleIds: readonly string[];
}, deps: ArticleServiceDependencies) {
  const context = await authorize(input.authorization, "admin.article.regenerate_batch", input.requestId, deps);
  const ids = Array.from(new Set(input.articleIds));
  if (ids.length === 0 || ids.length > ARTICLE_REGENERATE_BATCH_MAX) throw new Error("article_batch_selection_invalid");
  const startedAt = Date.now();
  const items: ArticleRegenerateBatchItem[] = [];
  for (let index = 0; index < ids.length; index += 1) {
    if (Date.now() - startedAt >= ARTICLE_REGENERATE_BUDGET_MS) {
      for (const id of ids.slice(index)) items.push({ articleId: id, status: "not_processed" });
      break;
    }
    try {
      const result = await regenerateCore(deps.db, ids[index]!, context.identity.id, `${input.requestId}:${ids[index]}`);
      items.push({ articleId: ids[index]!, status: result.outcome === "regenerated" ? "regenerated" : result.outcome === "article_not_found" ? "skipped" : "failed", result });
    } catch {
      items.push({ articleId: ids[index]!, status: "failed" });
    }
  }
  return {
    items,
    counts: Object.fromEntries((["regenerated", "skipped", "failed", "not_processed"] as const).map((status) => [status, items.filter((item) => item.status === status).length])),
  };
}

export type ArticleListItem = {
  id: string;
  title: string;
  locale: string;
  slug: string;
  publicPageShortId: string;
  status: string;
  summary: string | null;
  templateKey: string | null;
  updatedAt: string;
  /**
   * C-20 additions (`分析_文章管理Parity缺口_2026-09-08.md` §六). Additive/
   * optional per this round's contract discipline — no existing field's
   * shape or meaning changes.
   */
  createdAt?: string;
  /** The bound template's human name (`ArticleTemplate.templateName`); `null` when no template is bound, same as `templateKey`. */
  templateName?: string | null;
  /** The article's (required, `novelId` is `NOT NULL`) novel — id + title, for the 书目 column's link. */
  novel?: { id: string; title: string };
  /** Up to `ARTICLE_CATEGORY_DISPLAY_LIMIT` display names from the novel's Canonical Tag assignments, de-duplicated by tag id. Empty when the novel has none. */
  canonicalTags?: readonly string[];
  /**
   * C-25 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-25):
   * `Article.seoVisibility`, for the list's "SEO 可见性" badge column. Optional
   * per this round's additive-contract discipline, same as the C-20 fields
   * above.
   */
  seoVisibility?: string;
};

export type ArticleListInput = {
  page?: number;
  pageSize?: number;
  locale?: string;
  status?: string;
  novelId?: string;
  templateId?: string;
  /** C-19: title/slug/short-code substring match, plus a shortId exact match when this parses as a front-end URL — see {@link buildArticleSearchOr}. */
  search?: string;
  /** C-19: EXISTS-style filter on the article's novel's Canonical Tag assignments — see {@link listArticles}'s `where.novel`. */
  canonicalTagId?: string;
  /** C-25: exact-match filter on `Article.seoVisibility` (`public`/`seo_only`/`hidden`). */
  seoVisibility?: string;
};

export const ARTICLE_LIST_DEFAULT_PAGE_SIZE = 20;
export const ARTICLE_LIST_MAX_PAGE_SIZE = 100;

const ARTICLE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireArticleUuid(value: unknown): string {
  if (typeof value !== "string" || !ARTICLE_UUID_PATTERN.test(value)) {
    throw new AdminContentQueryError("invalid_identifier", "A valid UUID identifier is required");
  }
  return value.toLowerCase();
}

type NormalizedArticleList = {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
  locale?: string;
  status?: ArticleStatus;
  novelId?: string;
  templateId?: string;
  search?: string;
  canonicalTagId?: string;
  seoVisibility?: ArticleSeoVisibility;
};

/**
 * C-19 (`分析_文章管理Parity缺口_2026-09-08.md` §三): inverse of
 * `buildArticleRouteSlug` (`@/lib/slug/article-path`), applied to a pasted
 * search value instead of a route param. CPS parity —
 * `git show v8.3.6:src/actions/article-actions.ts:100-123`'s
 * `extractSearchShortId` — down to the "try `new URL(...)`, fall back to
 * stripping `?`/`#` by hand" trick for a bare path. `null` means "does not
 * parse as a front-end URL/slug", not "invalid": the caller still runs the
 * plain `contains` matches below.
 *
 * One deliberate CPS departure: no bare-shortId fast path
 * (`/^[a-z0-9]{8}$/`). CPS's `publicPageShortId` is a fixed 8 characters;
 * cps-novel's is not (`article-path.ts`'s own header), and a raw pasted
 * shortId is already covered by `buildArticleSearchOr`'s
 * `publicPageShortId: { contains }` branch — reusing `parseArticleSlugParam`
 * (the exact function the public route itself uses to invert a slug) rather
 * than a second hand-rolled regex, per the analysis doc's "不另写正则".
 */
function extractSearchShortId(search: string): string | null {
  const trimmed = search.trim();
  if (!trimmed) return null;
  const pathCandidate = (() => {
    try {
      return new URL(trimmed).pathname;
    } catch {
      return trimmed.split(/[?#]/)[0] ?? trimmed;
    }
  })();
  const lastSegment = pathCandidate.split("/").filter(Boolean).pop() ?? pathCandidate;
  let decoded = lastSegment;
  try {
    decoded = decodeURIComponent(lastSegment);
  } catch {
    // Keep the raw segment — a malformed pasted URL should still degrade to
    // the plain `contains` matches rather than throw.
  }
  return parseArticleSlugParam(decoded)?.shortId ?? null;
}

/**
 * CPS parity — `buildArticleSearchOr` (same file/lines as
 * {@link extractSearchShortId} above). Title/slug/short-code substring match
 * (case-insensitive, `Prisma`'s `mode: "insensitive"` — the same mechanism
 * `@/server/article-templates`'s `listArticleTemplates` and
 * `catalog-sync/_lib/read-source-items.ts` already use for their own search
 * boxes), plus the exact shortId match when the pasted value parses as a
 * URL/slug.
 */
function buildArticleSearchOr(search: string): Prisma.ArticleWhereInput[] {
  const shortId = extractSearchShortId(search);
  return [
    { title: { contains: search, mode: "insensitive" as const } },
    { slug: { contains: search, mode: "insensitive" as const } },
    { publicPageShortId: { contains: search, mode: "insensitive" as const } },
    ...(shortId ? [{ publicPageShortId: shortId }] : []),
  ];
}

/**
 * M7 ①: filter semantics mirror CPS `getArticles`
 * (`git show v8.3.6:src/actions/article-actions.ts` around line 416 —
 * `where = { ...(locale ? { locale } : {}), ...(status ? { status } : {}),
 * ...(dramaId ? { dramaId } : {}), ...(templateId ? { templateId } : {}) }`)
 * for the four dimensions registered here: `locale`, `status`, `novelId`
 * (CPS's `dramaId`, renamed for this schema), `templateId`. An unregistered
 * query-string key is silently ignored — same "a filter bar, not a schema
 * validator" contract as every other admin list page.
 *
 * Pagination reuses the existing `≤ ARTICLE_LIST_MAX_PAGE_SIZE (100)`,
 * `total`/`totalPages` computed from a real `COUNT(*)` convention
 * (`@/server/admin-content`'s `normalizeAdminNovelListInput` /
 * `ADMIN_CONTENT_MAX_PAGE_SIZE`) rather than a fixed `take` with no page
 * count — this file mints its own `ARTICLE_LIST_MAX_PAGE_SIZE` constant
 * instead of importing that one so the two lists' page-size ceilings can
 * move independently, but the value and the "explicit, not-faked" pagination
 * shape are the same choice.
 *
 * Validation errors reuse `@/server/admin-content`'s `AdminContentQueryError`
 * and its already-registered codes (`invalid_page`, `invalid_page_size`,
 * `invalid_status`, `invalid_locale`, `invalid_identifier`) rather than
 * minting article-specific duplicates — those codes are already in
 * `AdminErrorCode` and already have Chinese copy in `error-copy.ts`.
 */
function normalizeArticleListInput(input: ArticleListInput = {}): NormalizedArticleList {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? ARTICLE_LIST_DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(page) || page < 1) {
    throw new AdminContentQueryError("invalid_page", "Page must be a positive integer");
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > ARTICLE_LIST_MAX_PAGE_SIZE) {
    throw new AdminContentQueryError(
      "invalid_page_size",
      `Page size must be between 1 and ${ARTICLE_LIST_MAX_PAGE_SIZE}`,
    );
  }
  if (input.status !== undefined && !ARTICLE_STATUSES.includes(input.status as ArticleStatus)) {
    throw new AdminContentQueryError("invalid_status", "Article status is not registered");
  }
  if (input.locale !== undefined && !SITE_LOCALES.includes(input.locale as never)) {
    throw new AdminContentQueryError("invalid_locale", "Locale is not registered");
  }
  // C-25: reuses `invalid_status` (same code family the plan calls for —
  // "status 取值未登记" reads equally well for a SEO-visibility value) rather
  // than minting a new error code, per this round's contract discipline.
  if (input.seoVisibility !== undefined && !ARTICLE_SEO_VISIBILITIES.includes(input.seoVisibility as ArticleSeoVisibility)) {
    throw new AdminContentQueryError("invalid_status", "Article SEO visibility is not registered");
  }
  const novelId = input.novelId !== undefined ? requireArticleUuid(input.novelId) : undefined;
  const templateId = input.templateId !== undefined ? requireArticleUuid(input.templateId) : undefined;
  // C-19: same `invalid_search` code and `ADMIN_CONTENT_MAX_SEARCH_LENGTH`
  // constant as `@/server/admin-content`'s `normalizeAdminNovelListInput` —
  // reused verbatim rather than re-derived, per the analysis doc's "不新增".
  if (input.search !== undefined && typeof input.search !== "string") {
    throw new AdminContentQueryError("invalid_search", "Search must be a string");
  }
  const trimmedSearch = input.search?.trim();
  if (trimmedSearch && trimmedSearch.length > ADMIN_CONTENT_MAX_SEARCH_LENGTH) {
    throw new AdminContentQueryError(
      "invalid_search",
      `Search must not exceed ${ADMIN_CONTENT_MAX_SEARCH_LENGTH} characters`,
    );
  }
  const canonicalTagId = input.canonicalTagId !== undefined ? requireArticleUuid(input.canonicalTagId) : undefined;
  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize,
    take: pageSize,
    locale: input.locale,
    status: input.status as ArticleStatus | undefined,
    novelId,
    templateId,
    search: trimmedSearch || undefined,
    canonicalTagId,
    seoVisibility: input.seoVisibility as ArticleSeoVisibility | undefined,
  };
}

/**
 * C-20: how many de-duplicated Canonical Tag names the 分类 list column
 * shows per row. A compact-cell display cap, not a data-completeness limit —
 * the analysis doc's own wording is "多值时截取前若干个" with no fixed
 * number; 3 is chosen the same way `NovelTagsPanel`'s chip rows already read
 * (several, not a scroll of them) for a single-line table cell.
 */
const ARTICLE_CATEGORY_DISPLAY_LIMIT = 3;

const ARTICLE_LIST_SELECT = {
  id: true,
  title: true,
  locale: true,
  slug: true,
  publicPageShortId: true,
  status: true,
  summary: true,
  updatedAt: true,
  createdAt: true,
  seoVisibility: true,
  template: { select: { templateKey: true, templateName: true } },
  // C-20: 书目 column (id + title, links to `/novels/{id}`) and 分类 column
  // (via the novel's Canonical Tag assignments — see the analysis doc's §零
  // third correction on why "分类" is not a column on Article itself). No
  // `take` on `canonicalTags`: a novel's own tag count is small, and capping
  // display happens in `articleCanonicalTagNames` below, after de-duplicating
  // by `canonicalTagId` (`NovelCanonicalTag`'s unique key is
  // `(novelId, canonicalTagId, source)`, so the *same* tag can appear more
  // than once — e.g. once `auto`, once `manual` — and a `take` here could
  // silently discard the one relevant duplicate before dedup ever runs).
  novel: {
    select: {
      id: true,
      title: true,
      canonicalTags: {
        select: {
          canonicalTagId: true,
          canonicalTag: {
            select: {
              stableId: true,
              translations: { where: { locale: "zh" }, select: { displayName: true } },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.ArticleSelect;

type ArticleListSelectCanonicalTag = {
  canonicalTagId: string;
  canonicalTag: { stableId: string; translations: readonly { displayName: string }[] };
};

/**
 * De-duplicates a novel's raw `NovelCanonicalTag` rows by `canonicalTagId`
 * (see `ARTICLE_LIST_SELECT`'s comment on why a duplicate tag id is
 * possible), resolves each to a display name — the `zh` translation
 * (queried pre-filtered by `ARTICLE_LIST_SELECT`), falling back to
 * `stableId` when there is none, same fallback rule as
 * `../_lib/category-options.ts`'s dropdown labels — and caps the result at
 * `ARTICLE_CATEGORY_DISPLAY_LIMIT`.
 */
function articleCanonicalTagNames(tags: readonly ArticleListSelectCanonicalTag[]): readonly string[] {
  const names = new Map<string, string>();
  for (const link of tags) {
    if (names.has(link.canonicalTagId)) continue;
    names.set(link.canonicalTagId, link.canonicalTag.translations[0]?.displayName ?? link.canonicalTag.stableId);
  }
  return Array.from(names.values()).slice(0, ARTICLE_CATEGORY_DISPLAY_LIMIT);
}

/**
 * Article list for `/articles` (M7). A plain read, not a service mutation —
 * same shape as `@/server/admin-content`'s `listAdminNovels` — so it takes no
 * `AdminServiceAuthorization`; the page (`requireContentPage("/articles",
 * "content:view")`) is what gates access, exactly as it already did before
 * this function existed.
 */
export async function listArticles(
  db: Pick<PrismaClient, "article">,
  input: ArticleListInput = {},
): Promise<AdminContentPage<ArticleListItem>> {
  const normalized = normalizeArticleListInput(input);
  const searchOr = normalized.search ? buildArticleSearchOr(normalized.search) : undefined;
  const where: Prisma.ArticleWhereInput = {
    deletedAt: null,
    ...(normalized.locale ? { locale: normalized.locale } : {}),
    ...(normalized.status ? { status: normalized.status } : {}),
    ...(normalized.novelId ? { novelId: normalized.novelId } : {}),
    ...(normalized.templateId ? { templateId: normalized.templateId } : {}),
    // C-25: exact-match filter on the admin's own SEO-visibility axis — not
    // to be confused with the public-site "list"/"collectability" where
    // fragments in `@/server/publication/visibility.ts`, which answer a
    // different question (what the public site may show) than this one
    // (what the operator asked to see in the admin list).
    ...(normalized.seoVisibility ? { seoVisibility: normalized.seoVisibility } : {}),
    ...(searchOr ? { OR: searchOr } : {}),
    // C-19: "分类" filter — the article has no category column of its own
    // (see the analysis doc's §零 third correction), so this reads as an
    // EXISTS over the article's *novel*'s Canonical Tag assignments rather
    // than a scalar equality. Prisma's `some` on a to-many relation compiles
    // to `EXISTS (...)`, not a `JOIN`, so this cannot fan out `count()`.
    ...(normalized.canonicalTagId
      ? { novel: { canonicalTags: { some: { canonicalTagId: normalized.canonicalTagId } } } }
      : {}),
  };
  const [total, rows] = await Promise.all([
    db.article.count({ where }),
    db.article.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: normalized.skip,
      take: normalized.take,
      select: ARTICLE_LIST_SELECT,
    }),
  ]);
  const items = rows.map((row): ArticleListItem => ({
    id: row.id,
    title: row.title,
    locale: row.locale,
    slug: row.slug,
    publicPageShortId: row.publicPageShortId,
    status: row.status,
    summary: row.summary,
    templateKey: row.template?.templateKey ?? null,
    updatedAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    templateName: row.template?.templateName ?? null,
    novel: { id: row.novel.id, title: row.novel.title },
    canonicalTags: articleCanonicalTagNames(row.novel.canonicalTags),
    seoVisibility: row.seoVisibility,
  }));
  return {
    items,
    page: normalized.page,
    pageSize: normalized.pageSize,
    total,
    totalPages: Math.ceil(total / normalized.pageSize),
  };
}

/**
 * C-19 (item #9, ADAPT): the filter bar's locale options, sourced from
 * distinct live `Article.locale` values instead of all 15 registered
 * `SITE_LOCALES` — with the site at (today) one populated locale, the other
 * 14 were dead options that only added noise. `distinct` runs at the
 * database (a single indexed query), not by fetching every row and
 * de-duplicating in application code.
 */
export async function listDistinctArticleLocales(
  db: Pick<PrismaClient, "article">,
): Promise<readonly string[]> {
  const rows = await db.article.findMany({
    where: { deletedAt: null },
    select: { locale: true },
    distinct: ["locale"],
    orderBy: { locale: "asc" },
  });
  return rows.map((row) => row.locale);
}
