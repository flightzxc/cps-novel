import type { PrismaClient } from "@prisma/client";

import type { FeaturedEntry } from "@/features/public-ui/home/HomeScreen";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { buildArticlePath } from "@/lib/slug/article-path";
import { buildPublicArticleWhere, isPromoReady } from "@/server/publication/visibility";

import { toNovelDetailView, type PublicArticleDetailRecord } from "./mappers";
import { listPreviewChapterRefs } from "./queries";

/**
 * Typed home-carousel contract aligned with `HomeScreen.featuredList`.
 *
 * Owner-final for this round: return an empty list. Do not import or query
 * the five `HomeCarousel*` tables. `heroImageUrl` has no DB column — do not
 * invent one. An empty list already skips FeaturedHero and FeaturedNovel.
 */
export type HomeCarouselItem = FeaturedEntry;

const SELECT = {
  id: true, title: true, summary: true, body: true, seoMetadata: true, slug: true, locale: true,
  publicPageShortId: true, publishedAt: true,
  novel: { select: { id: true, businessId: true, title: true, description: true, coverUrl: true, locale: true, totalChapterCount: true } },
  promoLink: { select: { status: true, webUrl: true, appUrl: true, publicRedirectCode: true } },
} as const;

async function fallbackRows(db: PrismaClient, locale: SiteLocale) {
  return db.article.findMany({ where: { ...buildPublicArticleWhere({ locale }), novel: { status: "published", deletedAt: null, coverUrl: { not: null } } }, orderBy: [{ updatedAt: "desc" }, { publishedAt: "desc" }, { id: "asc" }], take: 500, select: SELECT });
}

async function toFeatured(db: PrismaClient, row: Awaited<ReturnType<typeof fallbackRows>>[number]): Promise<HomeCarouselItem | null> {
  if (!isPromoReady(row.promoLink) || !row.novel.coverUrl?.trim()) return null;
  const record: PublicArticleDetailRecord = { ...row, promoLink: row.promoLink ? { publicRedirectCode: row.promoLink.publicRedirectCode } : null };
  const novel = toNovelDetailView(record, await listPreviewChapterRefs(db, row.novel.id));
  if (!novel) return null;
  const detailHref = buildArticlePath({ locale: row.locale as SiteLocale, slug: row.slug, shortId: row.publicPageShortId });
  return { novel, detailHref, startReadingHref: novel.previewChapters[0]?.href };
}

export async function getHomeCarouselItems(locale: SiteLocale, db?: PrismaClient): Promise<HomeCarouselItem[]> {
  if (!db) return [];
  const serving = await db.homeCarouselServing.findMany({ where: { locale, article: buildPublicArticleWhere({ locale }) }, orderBy: { position: "asc" }, take: 5, select: { article: { select: SELECT } } });
  const rows = serving.length > 0 ? serving.map((entry) => entry.article) : await fallbackRows(db, locale);
  const unique = new Set<string>();
  const result: HomeCarouselItem[] = [];
  for (const row of rows) {
    if (unique.has(row.novel.id)) continue;
    const item = await toFeatured(db, row);
    if (!item) continue;
    unique.add(row.novel.id);
    result.push(item);
    if (result.length === 5) break;
  }
  return result;
}
