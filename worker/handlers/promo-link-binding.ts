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
 *
 * L-1 (C-27 review): this is the only production write path that ever
 * sets `Article.promoLinkId` after row creation (`src/server/content-
 * creation/service.ts` always creates with it `null` — see that module's
 * header; `scripts/x8-promo-fixture.ts`'s acceptance fixture also writes it
 * directly, but that is a one-off ops script, not a production path).
 * Since C-27 made `Article.novel_id` nullable, `novel_id IS NULL
 * AND promo_link_id IS NOT NULL` is a schema-legal shape (the composite FK
 * `article_promo_link_novel_fkey` is `MATCH SIMPLE`, so it does not check
 * anything when either column is NULL) — but it is never a *business*-legal
 * one: a blog/listicle/guide Article has no Novel, and a PromoLink always
 * belongs to a Novel, so a Novel-less Article has nothing to bind. The
 * `where: { novelId, ... }` filter below only ever matches Articles whose
 * `novel_id` already equals this call's (always Novel-scoped) `novelId`
 * argument, so a Novel-less row cannot appear in `articles` today — but
 * that safety is implicit in this one query's shape, not asserted. The
 * `article.novelId === null` check below fails loudly instead of silently
 * writing a PromoLink onto a blog Article if a future refactor (a join, an
 * `OR`, a batched multi-Novel call) ever widens this query to include one.
 */
export async function bindPromoLinkToArticles(
  tx: Prisma.TransactionClient,
  novelId: string,
  promoLinkId: string,
): Promise<ArticleBindingResult> {
  const articles = await tx.article.findMany({
    where: { novelId, deletedAt: null },
    select: { id: true, novelId: true, promoLinkId: true },
  });
  const result: ArticleBindingResult = {
    boundArticleIds: [],
    alreadyBoundArticleIds: [],
    conflictedArticleIds: [],
  };
  for (const article of articles) {
    if (article.novelId === null) {
      // See this function's doc comment — structurally unreachable via the
      // `where` filter above today, kept as an explicit assertion rather
      // than relying on that filter's incidental behavior.
      throw new Error(
        `bind_promo_link_to_articles_novel_less_article: article ${article.id} has no novelId; refusing to bind promoLinkId ${promoLinkId}`,
      );
    }
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
