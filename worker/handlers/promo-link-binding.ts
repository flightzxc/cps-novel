import type { Prisma } from "@prisma/client";

export interface ArticleBindingResult {
  boundArticleIds: string[];
  alreadyBoundArticleIds: string[];
  conflictedArticleIds: string[];
}

/**
 * Reconciles one fetched PromoLink onto every active Article for its Novel.
 * Existing bindings to another PromoLink are never overwritten; repeated
 * calls are zero-write for already-correct rows.
 */
export async function bindPromoLinkToArticles(
  tx: Prisma.TransactionClient,
  novelId: string,
  promoLinkId: string,
): Promise<ArticleBindingResult> {
  const articles = await tx.article.findMany({
    where: { novelId, deletedAt: null },
    select: { id: true, promoLinkId: true },
  });
  const result: ArticleBindingResult = {
    boundArticleIds: [],
    alreadyBoundArticleIds: [],
    conflictedArticleIds: [],
  };
  for (const article of articles) {
    if (article.promoLinkId === promoLinkId) {
      result.alreadyBoundArticleIds.push(article.id);
      continue;
    }
    if (article.promoLinkId !== null) {
      result.conflictedArticleIds.push(article.id);
      continue;
    }
    await tx.article.update({ where: { id: article.id }, data: { promoLinkId } });
    result.boundArticleIds.push(article.id);
  }
  return result;
}
