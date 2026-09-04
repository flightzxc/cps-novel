import { Prisma, type PrismaClient } from "@prisma/client";

import { buildNovelTemplateValues, isTemplateRenderError, renderArticleDraft } from "@/lib/seo/template";
import type { AdminIdentityStore, SessionStore } from "@/lib/auth/ports";
import { requireFreshAdminServiceMutation, type AdminServiceAuthorization } from "@/server/auth/guards";
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
 * `article_conflict` still needs registering in `src/contracts/errors.ts`
 * (the `AdminErrorCode` union) and `src/features/admin-ui/error-copy.ts` (the
 * Chinese copy table) — both files sit outside this lane's file boundary
 * (`src/server/articles/**`, `src/app/(admin)/articles/**` only), so they are
 * not touched here. See the lane report for the exact entries to add.
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
};

function text(value: string, code: string, max?: number) {
  const normalized = value.trim();
  if (!normalized || (max !== undefined && normalized.length > max)) throw new Error(code);
  return normalized;
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
  };
  // Same narrow-window CAS discipline as `site-settings/service.ts`'s
  // `updateAdminSiteSetting`: Postgres timestamptz(6) can carry sub-millisecond
  // precision that a JS `Date` round-trip cannot reproduce, so the match is a
  // `[expected, expected + 1ms)` window rather than strict equality.
  const expectedExclusive = new Date(expected.getTime() + 1);
  return deps.db.$transaction(async (tx) => {
    const before = await tx.article.findFirstOrThrow({ where: { id: input.articleId, deletedAt: null }, select: { id: true, title: true, summary: true, templateId: true, updatedAt: true } });
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
      beforeSnapshot: { title: before.title, summary: before.summary, templateId: before.templateId },
      afterSnapshot: { title: row.title, summary: row.summary, templateId: row.templateId },
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
