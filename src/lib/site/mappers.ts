import type {
  ChapterNovelRef,
  ChapterView,
  NovelCardView,
  NovelDetailView,
  PreviewChapterRef,
} from "@/features/public-ui/types";
import { buildArticlePath } from "@/lib/slug/article-path";
import { buildChapterPath } from "@/lib/seo/chapter-path";

import { asSiteLocale, localeBadge } from "./locale-label";
import { splitChapterParagraphs } from "./paragraphs";

export type PublicNovelRecord = {
  id: string;
  businessId: string;
  title: string;
  description: string;
  coverUrl: string | null;
  locale: string;
  totalChapterCount: number;
};

export type PublicArticleRecord = {
  id: string;
  title: string;
  slug: string;
  locale: string;
  publicPageShortId: string;
  publishedAt: Date | null;
  novel: PublicNovelRecord;
};

export type PreviewChapterRecord = {
  canonicalChapterNumber: number;
  title: string | null;
};

export type ChapterRecord = PreviewChapterRecord & {
  body: string;
};

export function toNovelCardView(article: PublicArticleRecord): NovelCardView | null {
  const locale = asSiteLocale(article.locale);
  if (!locale) return null;

  return {
    id: article.novel.businessId,
    title: article.title,
    coverUrl: article.novel.coverUrl ?? undefined,
    tags: [],
    locale: localeBadge(locale),
    href: buildArticlePath({
      locale,
      slug: article.slug,
      shortId: article.publicPageShortId,
    }),
  };
}

export function toPreviewChapterRefs(
  article: PublicArticleRecord,
  chapters: readonly PreviewChapterRecord[],
): PreviewChapterRef[] {
  const locale = asSiteLocale(article.locale);
  if (!locale) return [];

  return chapters.map((chapter) => ({
    number: chapter.canonicalChapterNumber,
    title: chapter.title?.trim() || `Chapter ${chapter.canonicalChapterNumber}`,
    href: buildChapterPath({
      locale,
      slug: article.slug,
      shortId: article.publicPageShortId,
      chapterNumber: chapter.canonicalChapterNumber,
    }),
  }));
}

export function toNovelDetailView(
  article: PublicArticleRecord,
  previewChapters: readonly PreviewChapterRecord[],
): NovelDetailView | null {
  const locale = asSiteLocale(article.locale);
  if (!locale) return null;

  return {
    id: article.novel.businessId,
    title: article.title,
    coverUrl: article.novel.coverUrl ?? undefined,
    description: article.novel.description,
    locale: localeBadge(locale),
    totalChapterCount: article.novel.totalChapterCount,
    tags: [],
    previewChapters: toPreviewChapterRefs(article, previewChapters),
  };
}

export function toChapterView(
  article: PublicArticleRecord,
  chapter: ChapterRecord,
  previewChapters: readonly PreviewChapterRecord[],
): ChapterView | null {
  const locale = asSiteLocale(article.locale);
  if (!locale) return null;

  const paragraphs = splitChapterParagraphs(chapter.body);
  if (paragraphs.length === 0) return null;

  const index = previewChapters.findIndex(
    (entry) => entry.canonicalChapterNumber === chapter.canonicalChapterNumber,
  );
  if (index < 0) return null;

  const previous = previewChapters[index - 1];
  const next = previewChapters[index + 1];
  const novelHref = buildArticlePath({
    locale,
    slug: article.slug,
    shortId: article.publicPageShortId,
  });
  const novel: ChapterNovelRef = {
    id: article.novel.businessId,
    title: article.title,
    href: novelHref,
    coverUrl: article.novel.coverUrl ?? undefined,
  };

  return {
    number: chapter.canonicalChapterNumber,
    title: chapter.title?.trim() || `Chapter ${chapter.canonicalChapterNumber}`,
    paragraphs,
    novel,
    previewPosition: { index: index + 1, total: previewChapters.length },
    previousHref: previous
      ? buildChapterPath({
          locale,
          slug: article.slug,
          shortId: article.publicPageShortId,
          chapterNumber: previous.canonicalChapterNumber,
        })
      : undefined,
    nextHref: next
      ? buildChapterPath({
          locale,
          slug: article.slug,
          shortId: article.publicPageShortId,
          chapterNumber: next.canonicalChapterNumber,
        })
      : undefined,
  };
}
