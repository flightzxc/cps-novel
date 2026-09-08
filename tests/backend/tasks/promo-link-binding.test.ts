/**
 * L-1 (C-27 review closure, `docs/governance/database-governance.md` §12
 * C-27 row): `bindPromoLinkToArticles` (`worker/handlers/promo-link-
 * binding.ts`) is the only write path in the codebase that ever sets
 * `Article.promoLinkId` after row creation. Since C-27 made `novel_id`
 * nullable, `novel_id IS NULL AND promo_link_id IS NOT NULL` became a
 * schema-legal (composite FK `article_promo_link_novel_fkey` is `MATCH
 * SIMPLE`, so a NULL `novel_id` skips the FK check entirely) but never
 * business-legal shape — a blog/listicle/guide Article has no Novel, and a
 * PromoLink always belongs to one. The function's own `where: { novelId }`
 * filter already makes a Novel-less row structurally unreachable through
 * this call today, but that safety was only implicit in the query shape.
 * This test drives the function directly with a minimal `tx` double whose
 * `article.findMany` is (deliberately, unrealistically) made to return a
 * Novel-less row, to exercise the explicit guard added for this review
 * without needing a real Postgres connection.
 */
import { describe, expect, it, vi } from "vitest";

import { bindPromoLinkToArticles } from "../../../worker/handlers/promo-link-binding";

type FakeRow = { id: string; novelId: string | null; promoLinkId: string | null };

function fakeTx(rows: FakeRow[]) {
  const update = vi.fn(async () => ({}));
  const findMany = vi.fn(async () => rows.map(({ id, novelId, promoLinkId }) => ({ id, novelId, promoLinkId })));
  const tx = {
    article: { findMany, update },
  } as unknown as Parameters<typeof bindPromoLinkToArticles>[0];
  return { tx, update, findMany };
}

describe("bindPromoLinkToArticles", () => {
  it("still binds a normal (novel-carrying) unbound Article — regression baseline", async () => {
    const { tx, update } = fakeTx([{ id: "article-1", novelId: "novel-1", promoLinkId: null }]);
    const result = await bindPromoLinkToArticles(tx, "novel-1", "promo-1");
    expect(result).toEqual({
      boundArticleIds: ["article-1"],
      alreadyBoundArticleIds: [],
      conflictedArticleIds: [],
    });
    expect(update).toHaveBeenCalledWith({ where: { id: "article-1" }, data: { promoLinkId: "promo-1" } });
  });

  it("still treats an already-bound row as idempotent and a differently-bound row as a conflict — regression baseline", async () => {
    const { tx, update } = fakeTx([
      { id: "article-already", novelId: "novel-1", promoLinkId: "promo-1" },
      { id: "article-conflict", novelId: "novel-1", promoLinkId: "promo-other" },
    ]);
    const result = await bindPromoLinkToArticles(tx, "novel-1", "promo-1");
    expect(result).toEqual({
      boundArticleIds: [],
      alreadyBoundArticleIds: ["article-already"],
      conflictedArticleIds: ["article-conflict"],
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("L-1: throws instead of writing when a returned row has no novelId, and never calls article.update", async () => {
    const { tx, update } = fakeTx([{ id: "blog-article-1", novelId: null, promoLinkId: null }]);
    await expect(bindPromoLinkToArticles(tx, "novel-1", "promo-1")).rejects.toThrow(
      /bind_promo_link_to_articles_novel_less_article/,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("L-1: a Novel-less row after an already-processed Novel-carrying row still stops before any write for the bad row, and no partial write for it leaks through", async () => {
    const { tx, update } = fakeTx([
      { id: "article-1", novelId: "novel-1", promoLinkId: null },
      { id: "blog-article-1", novelId: null, promoLinkId: null },
    ]);
    await expect(bindPromoLinkToArticles(tx, "novel-1", "promo-1")).rejects.toThrow(
      /bind_promo_link_to_articles_novel_less_article/,
    );
    // article-1 (processed before the throw) is the only legitimate write;
    // blog-article-1 must never appear in an update call.
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ where: { id: "article-1" }, data: { promoLinkId: "promo-1" } });
  });
});
