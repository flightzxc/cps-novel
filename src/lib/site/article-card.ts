/**
 * 公开列表卡片的行形状与最小转换（从 `queries.ts` 原样搬出，B-38 第二段）。
 *
 * 为什么单独成文件：`public-list.ts`（数据库分页）要用 `ARTICLE_CARD_SELECT` 按编号补全卡片、用
 * `filterPromoReady` 复核，而 `queries.ts` 又要调用 `public-list.ts` 的分页与矩阵。两边都放在
 * `queries.ts` 里就是循环引用；把这几样纯定义放到没有站内运行时依赖的叶子文件里，循环就不存在了。
 * `queries.ts` 仍然重新导出它们，所有既有的 `import … from "@/lib/site/queries"` 一概不变。
 */
import type { Prisma } from "@prisma/client";

import { isPromoReady } from "@/server/publication/visibility";

import type { PublicArticleRecord } from "./mappers";
import type { PublicTaxonomyTag } from "./public-taxonomy";

export const ARTICLE_CARD_SELECT = {
  id: true,
  title: true,
  slug: true,
  locale: true,
  publicPageShortId: true,
  publishedAt: true,
  summary: true,
  novel: {
    select: {
      id: true,
      businessId: true,
      title: true,
      description: true,
      coverUrl: true,
      locale: true,
      totalChapterCount: true,
    },
  },
  promoLink: {
    select: { status: true, webUrl: true, appUrl: true },
  },
} as const;

export type ListedArticle = Prisma.ArticleGetPayload<{ select: typeof ARTICLE_CARD_SELECT }>;

/**
 * C-27: `Article.novel` is nullable as of this round (blog articles have
 * none). Every function that renders a `NovelCardView`/`NovelDetailView`/
 * `ChapterView` — all Novel-shaped view models — treats a row with no Novel
 * as out of scope until C-29 gives blog its own view model family. The list
 * queries get this for free from the Novel join (`public-list.ts` inner-joins
 * `novel`, a null-novel row cannot match); `getPublicNovelDetail` /
 * `getPublicChapterView` (`queries.ts`) load by bare `articleId`
 * (`buildPrimaryArticleWhere` has no novel/status/promo requirement), so they
 * add an explicit `row.novel === null` check and return `null` — the same
 * "not this view model" answer they already give for promo-not-ready.
 */
export type ListedArticleWithNovel = ListedArticle & { novel: NonNullable<ListedArticle["novel"]> };

export function toPublicArticle(
  row: ListedArticleWithNovel,
  tags: readonly PublicTaxonomyTag[] = [],
): PublicArticleRecord {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    locale: row.locale,
    publicPageShortId: row.publicPageShortId,
    publishedAt: row.publishedAt,
    summary: row.summary,
    tags,
    novel: row.novel,
  };
}

// C-27: also excludes a null `novel` — see `ListedArticleWithNovel`'s doc
// comment above. The list queries' Novel join already makes this unreachable
// today; the check here is what lets the type checker see that instead of a
// `!` assertion. (B-38: `isPromoReady` stays the authority — the SQL
// fragment `promoReadySql` is proven equivalent, and `public-list.ts` logs
// any row this filter still drops as an invariant violation.)
export function filterPromoReady(rows: ListedArticle[]): ListedArticleWithNovel[] {
  return rows.filter((row): row is ListedArticleWithNovel => row.novel !== null && isPromoReady(row.promoLink));
}
