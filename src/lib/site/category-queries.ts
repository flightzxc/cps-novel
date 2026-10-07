/**
 * CPS v8.3.6 category-page semantics, adapted from Drama/Article.categoryId
 * to Novel's CanonicalTag membership: active category, published-only cards,
 * stable pagination, and an empty category treated as not found rather than
 * publishing a thin page. Membership is supplied by public-taxonomy.ts and
 * therefore respects manual FULL_SNAPSHOT and the shared auto feature gate.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

import type { NovelCardView } from "@/features/public-ui/types";
import type { SiteLocale } from "@/lib/locale/locale-canonical";

import { resolveCanonicalTagLabel } from "./canonical-tag-label";
import { listPublicArticles, paginateCards, type BrowsePageResult } from "./queries";

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

function hasCategory(card: NovelCardView, slug: string): boolean {
  return card.tags.some((tag) => tag.slug === slug);
}

/**
 * 分类页展示的卡片 = 列表（`listPublicArticles`，最新 `PUBLIC_LIST_CAP` 本）里挂着这个分类的那些。
 *
 * 🔴 这是"分类下有没有书"的**唯一定义**：`getPublicCategoryPage`（页面返回 200 还是 404）与
 * `listPublicCategoryPageCounts`（站点地图该列哪些分类网址）都经由它，不得在别处另写一份——
 * 否则站点地图与页面会再次漂移（B-38：站点地图按全量书目列分类，页面只看最新 240 本，
 * 冷门分类在最新 240 本里一本都没有时，站点地图列了、页面 404）。
 */
function cardsInCategory(cards: readonly NovelCardView[], slug: string): NovelCardView[] {
  return cards.filter((card) => hasCategory(card, slug));
}

/**
 * 一个语种里"分类页会返回 200"的分类及其总页数：slug → `totalPages`。站点地图 mainpage 用它决定
 * 列哪些 `/category/{slug}`（含 `?page=N`，N 取 1..totalPages，与页面 `page > totalPages → 404` 同口径）。
 *
 * 每个语种只调用**一次** `listPublicArticles`（页面自己的列表查询：可见性、排序、`PUBLIC_LIST_CAP`
 * 截断、标签成员规则都跟着页面走），然后在内存里按 `cardsInCategory` / `paginateCards` 逐分类求出；
 * 不是每个分类查一次库。没有书的分类不在返回里。
 *
 * 分类 slug 取自卡片标签：`loadPublicTaxonomyByNovelIds` 只投影 `status = 'active'` 的标签，且库里
 * `canonical_tag.slug` 受 CHECK `^[a-z0-9]+(?:-[a-z0-9]+)*$` 约束（小写、≤160），所以页面入口的
 * `trim().toLowerCase()` 与长度判定、`canonicalTag.findFirst({ status: 'active' })` 对这些 slug 恒为恒等/命中。
 */
export async function listPublicCategoryPageCounts(
  db: Db,
  locale: SiteLocale,
): Promise<ReadonlyMap<string, number>> {
  const cards = await listPublicArticles(db, locale);
  const slugs = new Set<string>();
  for (const card of cards) {
    for (const tag of card.tags) slugs.add(tag.slug);
  }
  const counts = new Map<string, number>();
  for (const slug of slugs) {
    const members = cardsInCategory(cards, slug);
    if (members.length > 0) counts.set(slug, paginateCards(members, 1).totalPages);
  }
  return counts;
}

export async function getPublicCategoryPage(
  db: Db,
  locale: SiteLocale,
  slug: string,
  page: number,
): Promise<PublicCategoryPage | null> {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!normalizedSlug || normalizedSlug.length > 160) return null;

  const tag = await db.canonicalTag.findFirst({
    where: { slug: normalizedSlug, status: "active" },
    include: { translations: { where: { locale: { in: [locale, "en", "zh"] } } } },
  });
  if (!tag) return null;

  const cards = cardsInCategory(await listPublicArticles(db, locale), tag.slug);
  if (cards.length === 0) return null;
  const paged = paginateCards(cards, page);
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
