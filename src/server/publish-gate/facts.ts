/**
 * Assembles a `PublishGateFacts` snapshot (see `evaluator.ts`) from the
 * database for one Article. Split out from the evaluator itself so the
 * evaluator stays a pure, DB-free classifier (`evaluator.test.ts` never
 * touches Prisma); this is the only file in `publish-gate/` that queries.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

import type { PublishGateFacts } from "./evaluator";

type FactsDb = PrismaClient | Prisma.TransactionClient;

export type LoadedArticle = {
  readonly id: string;
  readonly novelId: string;
  readonly locale: string;
  readonly slug: string;
  readonly status: string;
  readonly publishedAt: Date | null;
};

export type PublishGateFactsResult = {
  readonly facts: PublishGateFacts;
  readonly article: LoadedArticle;
};

/**
 * Loads every fact `evaluatePublishGate` needs for `articleId`. Returns
 * `null` when the Article does not exist or is soft-deleted (mirroring
 * `visibility.ts`'s `PRIMARY_ARTICLE_RECORD`/`PRIMARY_NOVEL_RECORD`
 * `deletedAt: null` fragments — a caller reaching this function has no
 * legitimate reason to gate a deleted row).
 */
export async function loadPublishGateFacts(
  db: FactsDb,
  articleId: string,
): Promise<PublishGateFactsResult | null> {
  const article = await db.article.findFirst({
    where: { id: articleId, deletedAt: null },
    select: {
      id: true,
      novelId: true,
      locale: true,
      slug: true,
      status: true,
      title: true,
      body: true,
      publishedAt: true,
      novel: { select: { status: true, locale: true, deletedAt: true } },
      promoLink: { select: { status: true, webUrl: true, appUrl: true } },
    },
  });
  if (!article || article.novel.deletedAt !== null) return null;

  const [previewChapters, conflictingArticle] = await Promise.all([
    db.novelChapter.findMany({
      where: { novelId: article.novelId, deletedAt: null, status: "preview" },
      select: { content: { select: { body: true } } },
    }),
    db.article.findFirst({
      where: {
        id: { not: article.id },
        deletedAt: null,
        locale: article.locale,
        slug: article.slug,
      },
      select: { id: true },
    }),
  ]);

  const facts: PublishGateFacts = {
    novel: { status: article.novel.status, locale: article.novel.locale },
    article: {
      status: article.status,
      title: article.title,
      slug: article.slug,
      body: article.body,
    },
    promoLink: article.promoLink,
    preview: {
      hasPreviewChapter: previewChapters.length > 0,
      hasPreviewBody: previewChapters.some((chapter) => (chapter.content?.body ?? "").trim().length > 0),
    },
    pageIdentity: { conflicting: conflictingArticle !== null },
  };

  return {
    facts,
    article: {
      id: article.id,
      novelId: article.novelId,
      locale: article.locale,
      slug: article.slug,
      status: article.status,
      publishedAt: article.publishedAt,
    },
  };
}
