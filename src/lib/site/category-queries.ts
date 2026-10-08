/**
 * CPS v8.3.6 category-page semantics, adapted from Drama/Article.categoryId
 * to Novel's CanonicalTag membership: active category, published-only cards,
 * stable pagination, and an empty category treated as not found rather than
 * publishing a thin page.
 *
 * B-38 (v0.5.13): "which books are in this category, how many, which page" is a database question now —
 * `src/lib/site/public-list.ts` is the ONE definition of it (the list-visibility predicate, the
 * `novel_effective_tag` membership, the order, the page/count queries, the per-locale-per-category count
 * matrix). This file only adds what is category-specific: resolving the slug to an active `canonical_tag`,
 * the category's display name, and the 404 rules (zero books → null, page beyond the last → null).
 * There is no list window any more: every book in the category is reachable, and `totalCount` is the real
 * total. Membership respects the manual FULL_SNAPSHOT and the shared auto-tag gate because the table does
 * (see `effective-tag-projection.ts`).
 */
import type { Prisma, PrismaClient } from "@prisma/client";

import type { SiteLocale } from "@/lib/locale/locale-canonical";

import { resolveCanonicalTagLabel } from "./canonical-tag-label";
import { categoryCountsForLocale, listPublicNovelPage, queryPublicCategoryCounts } from "./public-list";
import { BROWSE_PAGE_SIZE, type BrowsePageResult } from "./queries";

type Db = PrismaClient | Prisma.TransactionClient;

export type PublicCategoryPage = BrowsePageResult & Readonly<{
  category: {
    id: string;
    slug: string;
    name: string;
    /**
     * Locale-specific long description. Public CanonicalTag rows do not
     * carry one (canonical_definition is Chinese classifier copy and is
     * never shown here), so this is null until a dedicated description
     * translation exists. Callers must omit it — not invent English
     * `${name} novels.` filler.
     */
    description: string | null;
    sortOrder: number;
    updatedAt: Date;
  };
}>;

/**
 * 一个语种里"分类页会返回 200"的分类及其总页数：slug → `totalPages`。站点地图 mainpage 用它决定
 * 列哪些 `/category/{slug}`（含 `?page=N`，N 取 1..totalPages，与页面 `page > totalPages → 404` 同口径）。
 *
 * 读每语种每分类本数矩阵，**不带缓存**（站点地图在 worker 里跑，要刷新时刻的真实快照）。矩阵与
 * `getPublicCategoryPage` 用同一段列表可见性 / 分类归属 SQL（`public-list.ts`），所以"有书的分类"和每个分类的
 * 页数与页面本身恒等；真实库用例 `tests/integration/site/consistency-invariants-postgres.test.ts` 逐个
 * (slug, page) 验证站点地图集合 = 页面返回 200 的集合，且第 N+1 页必为 null。没有书的分类不在返回里。
 */
export async function listPublicCategoryPageCounts(
  db: Db,
  locale: SiteLocale,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReadonlyMap<string, number>> {
  const counts = await queryPublicCategoryCounts(db, env, { locales: [locale] });
  const pages = new Map<string, number>();
  for (const { slug, count } of categoryCountsForLocale(counts, locale).values()) {
    pages.set(slug, Math.max(1, Math.ceil(count / BROWSE_PAGE_SIZE)));
  }
  return pages;
}

export async function getPublicCategoryPage(
  db: Db,
  locale: SiteLocale,
  slug: string,
  page: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PublicCategoryPage | null> {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!normalizedSlug || normalizedSlug.length > 160) return null;

  const tag = await db.canonicalTag.findFirst({
    where: { slug: normalizedSlug, status: "active" },
    include: { translations: { where: { locale: { in: [locale, "en", "zh"] } } } },
  });
  if (!tag) return null;

  const paged = await listPublicNovelPage(db, { locale, tagId: tag.id, page, pageSize: BROWSE_PAGE_SIZE, env });
  if (paged.totalCount === 0) return null;
  if (page > paged.totalPages) return null;
  const requested = tag.translations.find((translation) => translation.locale === locale);
  const en = tag.translations.find((translation) => translation.locale === "en");
  const zh = tag.translations.find((translation) => translation.locale === "zh");

  return {
    ...paged,
    category: {
      id: tag.id,
      slug: tag.slug,
      name: resolveCanonicalTagLabel({
        requested: requested?.displayName,
        en: en?.displayName,
        zh: zh?.displayName,
        slug: tag.slug,
      }),
      description: null,
      sortOrder: tag.sortOrder,
      updatedAt: tag.updatedAt,
    },
  };
}
