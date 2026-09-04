import { Prisma, type PrismaClient } from "@prisma/client";

import { buildNovelTemplateValues, isTemplateRenderError, renderArticleDraft } from "@/lib/seo/template";
import type { AdminIdentityStore, SessionStore } from "@/lib/auth/ports";
import { requireFreshAdminServiceMutation, type AdminServiceAuthorization } from "@/server/auth/guards";
import { selectActiveArticleTemplate, validateStoredArticleTemplate } from "@/server/article-templates";

export const ARTICLE_REGENERATE_BATCH_MAX = 50;
export const ARTICLE_REGENERATE_BUDGET_MS = 25_000;

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
  patch: ArticleEditInput;
}, deps: ArticleServiceDependencies) {
  const context = await authorize(input.authorization, "admin.article.update", input.requestId, deps);
  const data = {
    title: text(input.patch.title, "article_title_invalid", 500),
    summary: input.patch.summary.trim() || null,
    body: text(input.patch.body, "article_body_invalid"),
    seoMetadata: {
      ...(input.patch.metaTitle?.trim() ? { metaTitle: input.patch.metaTitle.trim() } : {}),
      ...(input.patch.metaDescription?.trim() ? { metaDescription: input.patch.metaDescription.trim() } : {}),
    } as Prisma.InputJsonValue,
  };
  return deps.db.$transaction(async (tx) => {
    const before = await tx.article.findFirstOrThrow({ where: { id: input.articleId, deletedAt: null }, select: { id: true, title: true, summary: true, templateId: true } });
    const row = await tx.article.update({ where: { id: before.id }, data });
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
  | { outcome: "template_not_available" }
  | { outcome: "template_render_failed"; code: string };

async function regenerateCore(db: PrismaClient, articleId: string, actorId: string, requestId: string): Promise<ArticleRegenerateResult> {
  const article = await db.article.findFirst({
    where: { id: articleId, deletedAt: null },
    select: {
      id: true, locale: true, templateId: true,
      novel: { select: { id: true, title: true, description: true, coverUrl: true, totalChapterCount: true } },
      promoLink: { select: { publicRedirectCode: true } },
    },
  });
  if (!article) return { outcome: "article_not_found" };
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
    await db.$transaction(async (tx) => {
      await tx.article.update({ where: { id: article.id }, data: {
        title: rendered.title, body: rendered.body,
        seoMetadata: rendered.seoMetadata as Prisma.InputJsonValue,
        seoSchemaVersion: rendered.seoSchemaVersion, templateId: template.id,
      } });
      await tx.operationAudit.create({ data: {
        actorType: "admin", actorId, action: "article.regenerate", entityType: "Article",
        entityId: article.id, requestId, afterSnapshot: { templateId: template.id, templateKey: template.templateKey },
      } });
    });
    return { outcome: "regenerated", articleId: article.id, templateId: template.id, templateKey: template.templateKey };
  } catch (error) {
    if (isTemplateRenderError(error)) return { outcome: "template_render_failed", code: error.code };
    if (error instanceof Error && error.name === "ArticleTemplateInputError") return { outcome: "template_render_failed", code: "template_schema_invalid" };
    throw error;
  }
}

export async function regenerateArticle(input: {
  authorization: AdminServiceAuthorization; requestId: string; articleId: string;
}, deps: ArticleServiceDependencies) {
  const context = await authorize(input.authorization, "admin.article.regenerate", input.requestId, deps);
  return regenerateCore(deps.db, input.articleId, context.identity.id, input.requestId);
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
