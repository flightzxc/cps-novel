/**
 * CPS v8.3.6 category-page semantics, adapted from Drama/Article.categoryId
 * to Novel's CanonicalTag membership: active category, published-only cards,
 * stable pagination, and an empty category treated as not found rather than
 * publishing a thin page. Membership is supplied by public-taxonomy.ts and
 * therefore remains manual FULL_SNAPSHOT union mapped derivation, never auto.
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

  const cards = (await listPublicArticles(db, locale)).filter((card) => hasCategory(card, tag.slug));
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
