import type { Prisma, PrismaClient } from "@prisma/client";

import type { NovelCardView, NovelDetailView, ChapterView } from "@/features/public-ui/types";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";
import { parseArticleSlugParam } from "@/lib/slug/article-path";
import { checkNovelArticlePublicAccess } from "@/server/publication/access";
import {
  buildPrimaryArticleWhere,
  buildPublicListArticleWhere,
  isPromoReady,
} from "@/server/publication/visibility";
import { getSiteSetting, type SiteSettingSnapshot } from "@/server/site-settings/service";

import { chromeFromSiteSetting, type PublicChromeCurrent } from "./chrome";
import {
  toChapterView,
  toNovelCardView,
  toNovelDetailView,
  type PublicArticleRecord,
  type PublicArticleDetailRecord,
  type PreviewChapterRecord,
} from "./mappers";
import {
  listDistinctPublicTaxonomy,
  loadPublicTaxonomyByNovelIds,
  type PublicTaxonomyTag,
} from "./public-taxonomy";

export type { PublicChromeCurrent };

/**
 * Hard cap on the public Article candidate set loaded into memory before
 * `isPromoReady` filtering and in-memory pagination.
 *
 * Impact if the catalog grows past this cap (accepted for V1, not fixed here):
 * - `paginateCards` `totalCount` / `totalPages` under-count (browse pager lies)
 * - sitemap may still emit URLs that `/browse` never lists (internal-link gap)
 */
export const PUBLIC_LIST_CAP = 240;
export const HOME_GRID_LIMIT = 20;
export const BROWSE_PAGE_SIZE = 20;
export const PREVIEW_CHAPTER_TAKE = 64;

const ARTICLE_CARD_SELECT = {
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

/**
 * Detail / chapter select. Extends the card select with `publicRedirectCode`
 * so the mapper can compute `readOnUpstreamHref`.
 *
 * 🔴 Deliberately NOT reused by `listPublicArticles`/`filterPromoReady` (the
 * card path) — `tests/backend/public/mappers.test.ts:41` asserts the card
 * JSON never carries the public redirect code, so the card query must keep
 * loading `ARTICLE_CARD_SELECT` as-is rather than sharing this wider shape.
 */
const ARTICLE_DETAIL_SELECT = {
  ...ARTICLE_CARD_SELECT,
  body: true,
  seoMetadata: true,
  promoLink: {
    select: { status: true, webUrl: true, appUrl: true, publicRedirectCode: true },
  },
} as const;

type ListedArticle = Prisma.ArticleGetPayload<{ select: typeof ARTICLE_CARD_SELECT }>;
type ListedArticleDetail = Prisma.ArticleGetPayload<{ select: typeof ARTICLE_DETAIL_SELECT }>;

export type PublicArticleAccess =
  | {
      kind: "published";
      articleId: string;
      novelId: string;
      slugPart: string;
      shortId: string;
      title: string;
    }
  | { kind: "unavailable"; title: string }
  | { kind: "takedown"; title: string }
  | { kind: "not_found" };

export async function resolvePublicArticleBySlugParam(
  db: PrismaClient | Prisma.TransactionClient,
  slugParam: string,
  locale: SiteLocale,
): Promise<PublicArticleAccess> {
  const parsed = parseArticleSlugParam(slugParam);
  if (!parsed) return { kind: "not_found" };

  const access = await checkNovelArticlePublicAccess(db, { locale, slug: parsed.slugPart });
  if (access.kind === "not_found") return { kind: "not_found" };

  const article = await db.article.findFirst({
    where: buildPrimaryArticleWhere({ locale, slug: parsed.slugPart }),
    select: { id: true, title: true, publicPageShortId: true },
  });
  if (!article || article.publicPageShortId !== parsed.shortId) {
    return { kind: "not_found" };
  }

  if (access.kind === "published") {
    return {
      kind: "published",
      articleId: access.articleId,
      novelId: access.novelId,
      slugPart: parsed.slugPart,
      shortId: parsed.shortId,
      title: article.title,
    };
  }

  return { kind: access.kind, title: article.title };
}

function toPublicArticle(
  row: ListedArticle,
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

function toPublicArticleDetail(
  row: ListedArticleDetail,
  tags: readonly PublicTaxonomyTag[] = [],
): PublicArticleDetailRecord {
  return {
    ...toPublicArticle(row, tags),
    body: row.body,
    seoMetadata: row.seoMetadata,
    promoLink: row.promoLink ? { publicRedirectCode: row.promoLink.publicRedirectCode } : null,
  };
}

function filterPromoReady(rows: ListedArticle[]): ListedArticle[] {
  return rows.filter((row) => isPromoReady(row.promoLink));
}

export async function listPublicArticles(
  db: PrismaClient | Prisma.TransactionClient,
  locale: SiteLocale,
): Promise<NovelCardView[]> {
  const rows = await db.article.findMany({
    // C-25: on-site listing excludes both `hidden` and `seo_only` — the
    // stricter "list" fragment, distinct from `buildPublicArticleWhere`'s
    // collectability fragment (sitemap/IndexNow/hreflang, which keep
    // `seo_only`). See `@/server/publication/visibility.ts`'s header.
    where: buildPublicListArticleWhere({ locale }),
    orderBy: [{ publishedAt: "desc" }, { id: "asc" }],
    take: PUBLIC_LIST_CAP,
    select: ARTICLE_CARD_SELECT,
  });

  const visibleRows = filterPromoReady(rows);
  const tagsByNovel = await loadPublicTaxonomyByNovelIds(
    db,
    visibleRows.map((row) => row.novel.id),
    locale,
  );
  const cards: NovelCardView[] = [];
  for (const row of visibleRows) {
    const card = toNovelCardView(toPublicArticle(row, tagsByNovel.get(row.novel.id) ?? []));
    if (card) cards.push(card);
  }
  return cards;
}

export async function listPublicCategories(
  db: PrismaClient | Prisma.TransactionClient,
  locale: SiteLocale,
): Promise<readonly PublicTaxonomyTag[]> {
  const rows = await db.article.findMany({
    // C-25: same "list" fragment as `listPublicArticles` above — the
    // category enumeration must not surface a category that only exists
    // because of a `seo_only`/`hidden` Article that never appears on-site.
    where: buildPublicListArticleWhere({ locale }),
    orderBy: [{ publishedAt: "desc" }, { id: "asc" }],
    take: PUBLIC_LIST_CAP,
    select: ARTICLE_CARD_SELECT,
  });
  const visibleRows = filterPromoReady(rows);
  return listDistinctPublicTaxonomy(await loadPublicTaxonomyByNovelIds(
    db,
    visibleRows.map((row) => row.novel.id),
    locale,
  ));
}

export async function listHomeNovels(
  db: PrismaClient | Prisma.TransactionClient,
  locale: SiteLocale,
): Promise<NovelCardView[]> {
  const cards = await listPublicArticles(db, locale);
  return cards.slice(0, HOME_GRID_LIMIT);
}

export type BrowsePageResult = {
  novels: NovelCardView[];
  page: number;
  totalPages: number;
  totalCount: number;
};

export function paginateCards(cards: NovelCardView[], page: number): BrowsePageResult {
  const totalCount = cards.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / BROWSE_PAGE_SIZE) || 1);
  const currentPage = Number.isInteger(page) && page > 0 ? page : 1;
  const start = (currentPage - 1) * BROWSE_PAGE_SIZE;
  return {
    novels: cards.slice(start, start + BROWSE_PAGE_SIZE),
    page: currentPage,
    totalPages: totalCount === 0 ? 1 : totalPages,
    totalCount,
  };
}

export async function getPublicNovelDetail(
  db: PrismaClient | Prisma.TransactionClient,
  articleId: string,
): Promise<NovelDetailView | null> {
  const row = await db.article.findFirst({
    where: buildPrimaryArticleWhere({ id: articleId }),
    select: ARTICLE_DETAIL_SELECT,
  });
  if (!row || !isPromoReady(row.promoLink)) return null;

  const previewChapters = await listPreviewChapterRefs(db, row.novel.id);
  const tags = await loadPublicTaxonomyByNovelIds(db, [row.novel.id], row.locale);
  return toNovelDetailView(toPublicArticleDetail(row, tags.get(row.novel.id) ?? []), previewChapters);
}

export async function listPreviewChapterRefs(
  db: PrismaClient | Prisma.TransactionClient,
  novelId: string,
): Promise<PreviewChapterRecord[]> {
  return db.novelChapter.findMany({
    where: {
      novelId,
      deletedAt: null,
      status: "preview",
      content: { isNot: null },
    },
    orderBy: { canonicalChapterNumber: "asc" },
    take: PREVIEW_CHAPTER_TAKE,
    select: {
      canonicalChapterNumber: true,
      title: true,
    },
  });
}

export async function getPublicChapterView(
  db: PrismaClient | Prisma.TransactionClient,
  articleId: string,
  chapterNumber: number,
): Promise<ChapterView | null> {
  const row = await db.article.findFirst({
    where: buildPrimaryArticleWhere({ id: articleId }),
    select: ARTICLE_DETAIL_SELECT,
  });
  if (!row || !isPromoReady(row.promoLink)) return null;

  const previewChapters = await listPreviewChapterRefs(db, row.novel.id);
  const match = previewChapters.find((chapter) => chapter.canonicalChapterNumber === chapterNumber);
  if (!match) return null;

  const chapter = await db.novelChapter.findFirst({
    where: {
      novelId: row.novel.id,
      canonicalChapterNumber: chapterNumber,
      deletedAt: null,
      status: "preview",
      content: { isNot: null },
    },
    select: {
      canonicalChapterNumber: true,
      title: true,
      content: { select: { body: true } },
    },
  });
  const body = chapter?.content?.body;
  if (!chapter || !body?.trim()) return null;

  const tags = await loadPublicTaxonomyByNovelIds(db, [row.novel.id], row.locale);
  return toChapterView(
    toPublicArticleDetail(row, tags.get(row.novel.id) ?? []),
    { ...match, body },
    previewChapters,
  );
}

/**
 * N-9: `categories` is optional so a caller who already needs the full
 * taxonomy list for its own purposes (`src/app/page.tsx`'s `HomeScreen`
 * `categories` prop) can compute it once and pass it in here, instead of
 * this function re-running `listPublicCategories`'s `article.findMany` +
 * taxonomy lookup a second time for the footer. Every other caller
 * (`novel/[slugParam]/page.tsx`, which only wants the footer) is unaffected
 * — it keeps calling this with two arguments and gets the original
 * self-fetching behavior.
 *
 * Wired into `src/app/page.tsx` (lane D): `@/app/_lib/public-load`'s
 * `loadChrome` now forwards an optional second argument down to this
 * function's `categories` parameter, and both `generateMetadata` and the
 * default export there fetch `loadPublicCategories(locale)` once and hand the
 * (request-deduped, reference-equal) result to `loadChrome("home",
 * categories)`, instead of `loadChrome("home")` running its own internal
 * categories query *and* the page separately calling `loadPublicCategories`
 * again. This landed as a `loadChrome` signature change rather than a new
 * export precisely so `tests/ui/public-routes.test.tsx`'s
 * `vi.mock("@/app/_lib/public-load", () => ({ loadChrome: vi.fn(), ... }))`
 * factory (outside this lane's file boundary, not to be edited) keeps
 * resolving `loadChrome` to a real mock function regardless of how many
 * arguments `page.tsx` passes it — a second export absent from that fixed
 * factory would be `undefined` at render time.
 * `tests/backend/site/public-query-budget.test.ts` pins the resulting
 * per-render query count.
 */
export async function loadPublicChrome(
  db: PrismaClient | Prisma.TransactionClient,
  current?: PublicChromeCurrent,
  categories?: readonly PublicTaxonomyTag[],
) {
  const [settings, resolvedCategories] = await Promise.all([
    getSiteSetting(db),
    categories ?? listPublicCategories(db, PUBLIC_SITE_LOCALE),
  ]);
  return { settings, chrome: chromeFromSiteSetting(settings, current, resolvedCategories) };
}

export type { SiteSettingSnapshot };
