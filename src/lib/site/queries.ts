import type { Prisma, PrismaClient } from "@prisma/client";

import type { NovelCardView, NovelDetailView, ChapterView } from "@/features/public-ui/types";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { parseArticleSlugParam } from "@/lib/slug/article-path";
import { checkNovelArticlePublicAccess } from "@/server/publication/access";
import {
  buildPrimaryArticleWhere,
  buildPublicArticleWhere,
  isPromoReady,
} from "@/server/publication/visibility";
import { getSiteSetting, type SiteSettingSnapshot } from "@/server/site-settings/service";

import { chromeFromSiteSetting, type PublicChromeCurrent } from "./chrome";
import {
  toChapterView,
  toNovelCardView,
  toNovelDetailView,
  type PublicArticleRecord,
  type PreviewChapterRecord,
} from "./mappers";

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

type ListedArticle = Prisma.ArticleGetPayload<{ select: typeof ARTICLE_CARD_SELECT }>;

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

function toPublicArticle(row: ListedArticle): PublicArticleRecord {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    locale: row.locale,
    publicPageShortId: row.publicPageShortId,
    publishedAt: row.publishedAt,
    novel: row.novel,
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
    where: buildPublicArticleWhere({ locale }),
    orderBy: [{ publishedAt: "desc" }, { id: "asc" }],
    take: PUBLIC_LIST_CAP,
    select: ARTICLE_CARD_SELECT,
  });

  const cards: NovelCardView[] = [];
  for (const row of filterPromoReady(rows)) {
    const card = toNovelCardView(toPublicArticle(row));
    if (card) cards.push(card);
  }
  return cards;
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
    select: ARTICLE_CARD_SELECT,
  });
  if (!row || !isPromoReady(row.promoLink)) return null;

  const previewChapters = await listPreviewChapterRefs(db, row.novel.id);
  return toNovelDetailView(toPublicArticle(row), previewChapters);
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
    select: ARTICLE_CARD_SELECT,
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

  return toChapterView(toPublicArticle(row), { ...match, body }, previewChapters);
}

export async function loadPublicChrome(
  db: PrismaClient | Prisma.TransactionClient,
  current?: PublicChromeCurrent,
) {
  const settings = await getSiteSetting(db);
  return { settings, chrome: chromeFromSiteSetting(settings, current) };
}

export type { SiteSettingSnapshot };
