import type { PrismaClient } from "@prisma/client";

import type { FeaturedEntry } from "@/features/public-ui/home/HomeScreen";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { buildArticlePath } from "@/lib/slug/article-path";
import { buildPublicListArticleWhere, isPromoReady } from "@/server/publication/visibility";

import { toNovelDetailView, type PublicArticleDetailRecord } from "./mappers";
import { listPreviewChapterRefs } from "./queries";

/**
 * Typed home-carousel contract aligned with `HomeScreen.featuredList`.
 *
 * PR6 fix (B-1/B-2): this used to unconditionally `return []` ("Owner-final
 * for this round" — that round ended once M5's serving/recency-fallback
 * wiring landed). It now reads `HomeCarouselServing` (position order) and
 * falls back to a recency scan over published articles when serving is
 * empty; see `tests/backend/home-carousel/queries.test.ts` and
 * `tests/backend/public/source-boundaries.test.ts`.
 *
 * `heroImageUrl` still has no DB column and is still not invented here —
 * `toNovelDetailView` never sets it, so `FeaturedHero` (which requires it)
 * stays skipped for real data; only `FeaturedNovel`-style rendering applies.
 * That is Hero UI territory, out of this module's scope.
 */
export type HomeCarouselItem = FeaturedEntry;

const SELECT = {
  id: true, title: true, summary: true, body: true, seoMetadata: true, slug: true, locale: true,
  publicPageShortId: true, publishedAt: true,
  novel: { select: { id: true, businessId: true, title: true, description: true, coverUrl: true, locale: true, totalChapterCount: true } },
  promoLink: { select: { status: true, webUrl: true, appUrl: true, publicRedirectCode: true } },
} as const;

async function fallbackRows(db: PrismaClient, locale: SiteLocale) {
  // C-25: the carousel is a list surface (it is a home-page listing, not a
  // detail/collectability boundary) — it uses the same stricter "list"
  // fragment as `listPublicArticles`, excluding both `hidden` and `seo_only`.
  return db.article.findMany({ where: { ...buildPublicListArticleWhere({ locale }), novel: { status: "published", deletedAt: null, coverUrl: { not: null } } }, orderBy: [{ updatedAt: "desc" }, { publishedAt: "desc" }, { id: "asc" }], take: 500, select: SELECT });
}

type CarouselRow = Awaited<ReturnType<typeof fallbackRows>>[number];
/**
 * C-27: `Article.novel` is nullable as of this round (blog articles have
 * none). The home carousel is a Novel-only surface both here (`fallbackRows`
 * filters `novel: { status: "published", ... }`, which excludes a null
 * relation) and via `buildPublicListArticleWhere`'s own `novel: { is:
 * PUBLIC_NOVEL_RECORD }` requirement for the `homeCarouselServing` path — a
 * row with no novel can never actually reach `getHomeCarouselItems`'s loop.
 * Narrowed here (guard below) so `toFeatured` can keep reading `row.novel.*`
 * without a `!` assertion; blog carousel eligibility, if ever wanted, is out
 * of this round's scope.
 */
type CarouselRowWithNovel = CarouselRow & { novel: NonNullable<CarouselRow["novel"]> };

async function toFeatured(db: PrismaClient, row: CarouselRowWithNovel): Promise<HomeCarouselItem | null> {
  if (!isPromoReady(row.promoLink) || !row.novel.coverUrl?.trim()) return null;
  const record: PublicArticleDetailRecord = { ...row, promoLink: row.promoLink ? { publicRedirectCode: row.promoLink.publicRedirectCode } : null };
  const novel = toNovelDetailView(record, await listPreviewChapterRefs(db, row.novel.id));
  if (!novel) return null;
  const detailHref = buildArticlePath({ locale: row.locale as SiteLocale, slug: row.slug, shortId: row.publicPageShortId });
  return { novel, detailHref, startReadingHref: novel.previewChapters[0]?.href };
}

export async function getHomeCarouselItems(locale: SiteLocale, db?: PrismaClient): Promise<HomeCarouselItem[]> {
  if (!db) return [];
  const serving = await db.homeCarouselServing.findMany({ where: { locale, article: buildPublicListArticleWhere({ locale }) }, orderBy: { position: "asc" }, take: 5, select: { article: { select: SELECT } } });
  const rows = serving.length > 0 ? serving.map((entry) => entry.article) : await fallbackRows(db, locale);
  const unique = new Set<string>();
  const result: HomeCarouselItem[] = [];
  for (const row of rows) {
    // C-27: see `CarouselRowWithNovel` doc comment — cannot actually happen
    // given this function's two query paths, kept as a type-level guard.
    // Rebuilt into `rowWithNovel` (rather than passing `row` straight
    // through) because TS narrows the `row.novel` property access, not the
    // declared type of `row` itself — `toFeatured`'s `CarouselRowWithNovel`
    // parameter needs the rebuild to see that narrowing.
    if (row.novel === null) continue;
    const rowWithNovel: CarouselRowWithNovel = { ...row, novel: row.novel };
    if (unique.has(rowWithNovel.novel.id)) continue;
    const item = await toFeatured(db, rowWithNovel);
    if (!item) continue;
    unique.add(rowWithNovel.novel.id);
    result.push(item);
    if (result.length === 5) break;
  }
  return result;
}
