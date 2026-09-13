/**
 * Explicit Article generation from an already-materialized Novel.
 *
 * Prerequisite: a ready PromoLink on that Novel (`isPromoReady` +
 * `pickReadyPromoLink`). This path writes `Article.promoLinkId` at create
 * time. It never materializes a Novel and never overwrites an existing live
 * Article (that is regenerate).
 */
import { Prisma, type PrismaClient } from "@prisma/client";

import { createWithPublicPageShortIdRetry, generatePublicPageShortIdCandidate } from "@/lib/slug/short-id";
import { withDbRetry } from "@/lib/db/db-retry";
import { SITE_LOCALES, type SiteLocale } from "@/lib/locale/locale-canonical";
import {
  buildNovelTemplateValues,
  isTemplateRenderError,
  renderArticleDraft,
} from "@/lib/seo/template";
import {
  selectActiveArticleTemplate,
  validateStoredArticleTemplate,
} from "@/server/article-templates";

import { promoRedirectUrlFor, resolveReadyPromoLinkForNovel } from "./promo";
import {
  ARTICLE_GENERATE_AUDIT_ACTION,
  auditActorId,
  auditActorType,
  existsCheck,
  isArticleNovelLocaleUniqueViolation,
  requireActor,
  requireRequestId,
  requireUuid,
  resolveUniqueSlug,
} from "./shared";
import type {
  ArticleGenerateResult,
  GenerateArticleFromNovelInput,
  GeneratedArticleSummary,
} from "./types";
import { ContentCreationInputError } from "./types";

type NovelRow = {
  id: string;
  title: string;
  description: string;
  coverUrl: string | null;
  locale: string;
  totalChapterCount: number;
  deletedAt: Date | null;
};

type ArticleRow = {
  id: string;
  slug: string;
  publicPageShortId: string;
  promoLinkId: string | null;
  deletedAt: Date | null;
  template?: { templateKey: string } | null;
};

function asSiteLocale(locale: string): SiteLocale | null {
  return (SITE_LOCALES as readonly string[]).includes(locale) ? (locale as SiteLocale) : null;
}

async function countPreviewChapters(db: { novelChapter?: { count: (args: unknown) => Promise<number> } }, novelId: string): Promise<number> {
  if (!db.novelChapter) return 0;
  return db.novelChapter.count({
    where: { novelId, status: "preview", deletedAt: null, content: { isNot: null } },
  });
}

async function loadExistingArticle(
  client: PrismaClient | Prisma.TransactionClient,
  novelId: string,
  locale: SiteLocale,
): Promise<ArticleRow | null> {
  return client.article.findFirst({
    where: { novelId, locale },
    select: {
      id: true,
      slug: true,
      publicPageShortId: true,
      promoLinkId: true,
      deletedAt: true,
      template: { select: { templateKey: true } },
    },
  });
}

function alreadyExistsSummary(
  novelId: string,
  locale: SiteLocale,
  article: ArticleRow,
): GeneratedArticleSummary {
  return {
    articleId: article.id,
    novelId,
    locale,
    articleSlug: article.slug,
    publicPageShortId: article.publicPageShortId,
    promoLinkId: article.promoLinkId,
    templateKey: article.template?.templateKey ?? null,
  };
}

async function lockNovelForUpdate(
  tx: Prisma.TransactionClient,
  novelId: string,
): Promise<NovelRow | null> {
  const rows = await tx.$queryRaw<NovelRow[]>`
    SELECT id, title, description, cover_url AS "coverUrl", locale,
           total_chapter_count AS "totalChapterCount", deleted_at AS "deletedAt"
    FROM novel
    WHERE id = ${novelId}::uuid
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function resolveConflictAfterRollback(
  db: PrismaClient,
  novelId: string,
): Promise<ArticleGenerateResult> {
  const novel = await db.novel.findFirst({
    where: { id: novelId },
    select: { locale: true },
  });
  const locale = novel ? asSiteLocale(novel.locale) : null;
  const existing = locale ? await loadExistingArticle(db, novelId, locale) : null;
  if (existing?.deletedAt) return { outcome: "article_soft_deleted", articleId: existing.id };
  if (existing && locale) {
    return { outcome: "already_exists", ...alreadyExistsSummary(novelId, locale, existing) };
  }
  return { outcome: "concurrent_generation_conflict" };
}

async function resolveTemplate(
  db: Pick<PrismaClient, "articleTemplate">,
  locale: SiteLocale,
  templateKey?: string,
) {
  if (templateKey) {
    const template = await selectActiveArticleTemplate(db, {
      locale,
      templateKey,
      applicableArticleType: "novel_article",
    });
    if (!template) {
      return { outcome: "template_locale_mismatch" as const, locale, templateKey };
    }
    return { outcome: "ok" as const, template, source: validateStoredArticleTemplate(template) };
  }
  const template = await selectActiveArticleTemplate(db, {
    locale,
    applicableArticleType: "novel_article",
  });
  if (!template) {
    return { outcome: "template_not_available" as const, locale };
  }
  return { outcome: "ok" as const, template, source: validateStoredArticleTemplate(template) };
}

async function runGenerate(
  db: PrismaClient | Prisma.TransactionClient,
  input: {
    novelId: string;
    templateKey?: string;
    actorType: "admin" | "system";
    actorId: string;
    requestId: string;
    dryRun: boolean;
    lockNovel: boolean;
  },
): Promise<ArticleGenerateResult> {
  const novel = input.lockNovel
    ? await lockNovelForUpdate(db as Prisma.TransactionClient, input.novelId)
    : await db.novel.findFirst({
        where: { id: input.novelId },
        select: {
          id: true,
          title: true,
          description: true,
          coverUrl: true,
          locale: true,
          totalChapterCount: true,
          deletedAt: true,
        },
      }) as NovelRow | null;
  if (!novel) return { outcome: "novel_not_found" };
  if (novel.deletedAt !== null) return { outcome: "novel_deleted" };
  const locale = asSiteLocale(novel.locale);
  if (!locale) return { outcome: "template_not_available", locale: novel.locale as SiteLocale };

  const existing = await loadExistingArticle(db, novel.id, locale);
  if (existing?.deletedAt) {
    return { outcome: "article_soft_deleted", articleId: existing.id };
  }
  if (existing) {
    return {
      outcome: "already_exists",
      ...alreadyExistsSummary(novel.id, locale, existing),
    };
  }

  const promo = await resolveReadyPromoLinkForNovel(db as never, novel.id);
  if (promo.outcome !== "ready") return { outcome: promo.outcome };

  const selected = await resolveTemplate(db as Pick<PrismaClient, "articleTemplate">, locale, input.templateKey);
  if (selected.outcome !== "ok") return selected;

  const articleSlugResult = await resolveUniqueSlug(
    novel.title,
    locale,
    existsCheck((args) => db.article.findFirst(args) as Promise<{ id: string } | null>, locale),
  );
  if (articleSlugResult.outcome !== "ok") {
    return { outcome: articleSlugResult.outcome, field: "article", baseSlug: articleSlugResult.baseSlug };
  }

  if (input.dryRun) {
    return {
      outcome: "dry_run",
      plan: {
        locale,
        title: novel.title,
        articleSlug: articleSlugResult.slug,
        provisionalPublicPageShortId: generatePublicPageShortIdCandidate(),
        promoLinkId: promo.promo.id,
        templateKey: selected.template.templateKey,
      },
    };
  }

  const previewChapterCount = await countPreviewChapters(db as never, novel.id);
  const rendered = renderArticleDraft(
    selected.source,
    buildNovelTemplateValues({
      title: novel.title,
      description: novel.description,
      coverUrl: novel.coverUrl,
      totalChapterCount: novel.totalChapterCount,
      previewChapterCount,
      promoRedirectUrl: promoRedirectUrlFor(promo.promo.publicRedirectCode),
    }),
    { templateKey: selected.template.templateKey, novelId: novel.id },
  );

  const article = await createWithPublicPageShortIdRetry((candidateShortId) =>
    db.article.create({
      data: {
        novelId: novel.id,
        locale,
        slug: articleSlugResult.slug,
        publicPageShortId: candidateShortId,
        title: rendered.title,
        summary: novel.description,
        body: rendered.body,
        seoMetadata: rendered.seoMetadata,
        seoSchemaVersion: rendered.seoSchemaVersion,
        templateId: selected.template.id,
        contentMode: "template" as const,
        articleType: "novel_article",
        promoLinkId: promo.promo.id,
      },
    }),
  );

  await db.operationAudit.create({
    data: {
      actorType: input.actorType,
      actorId: input.actorId,
      action: ARTICLE_GENERATE_AUDIT_ACTION,
      entityType: "Article",
      entityId: article.id,
      requestId: input.requestId,
      afterSnapshot: {
        articleId: article.id,
        novelId: novel.id,
        locale,
        articleSlug: article.slug,
        publicPageShortId: article.publicPageShortId,
        promoLinkId: promo.promo.id,
        templateKey: selected.template.templateKey,
      },
    },
  });

  return {
    outcome: "created",
    articleId: article.id,
    novelId: novel.id,
    locale,
    articleSlug: article.slug,
    publicPageShortId: article.publicPageShortId,
    promoLinkId: promo.promo.id,
    templateKey: selected.template.templateKey,
  };
}

export async function generateArticleFromNovelInTransaction(
  tx: Prisma.TransactionClient,
  input: Omit<GenerateArticleFromNovelInput, "mode">,
): Promise<ArticleGenerateResult> {
  const novelId = requireUuid(input.novelId, "invalid_novel_id");
  requireActor(input.actor);
  const requestId = requireRequestId(input.requestId);
  return runGenerate(tx, {
    novelId,
    ...(input.templateKey ? { templateKey: input.templateKey } : {}),
    actorType: auditActorType(input.actor),
    actorId: auditActorId(input.actor),
    requestId,
    dryRun: false,
    lockNovel: true,
  });
}

export async function generateArticleFromNovel(
  db: PrismaClient,
  input: GenerateArticleFromNovelInput,
): Promise<ArticleGenerateResult> {
  const novelId = requireUuid(input.novelId, "invalid_novel_id");
  const mode = input.mode ?? "dry_run";
  requireActor(input.actor);
  const requestId = requireRequestId(input.requestId);
  const actorType = auditActorType(input.actor);
  const actorId = auditActorId(input.actor);

  try {
    if (mode === "dry_run") {
      return await runGenerate(db, {
        novelId,
        ...(input.templateKey ? { templateKey: input.templateKey } : {}),
        actorType,
        actorId,
        requestId,
        dryRun: true,
        lockNovel: false,
      });
    }
    return await withDbRetry(
      () =>
        db.$transaction((tx) =>
          generateArticleFromNovelInTransaction(tx, {
            novelId,
            actor: input.actor,
            requestId,
            ...(input.templateKey ? { templateKey: input.templateKey } : {}),
          }),
        ),
      { op: "content-creation.generateArticleFromNovel", idempotencyKey: requestId },
    );
  } catch (error) {
    if (error instanceof ContentCreationInputError) throw error;
    if (isTemplateRenderError(error)) {
      return {
        outcome: "template_render_failed",
        code: error.code,
        ...(error.slot === undefined ? {} : { slot: error.slot }),
        ...(error.constraint === undefined ? {} : { constraint: error.constraint }),
      };
    }
    if (isArticleNovelLocaleUniqueViolation(error)) {
      return resolveConflictAfterRollback(db, novelId);
    }
    throw error;
  }
}
