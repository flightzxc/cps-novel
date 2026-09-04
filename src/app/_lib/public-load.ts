import { cache } from "react";

import { prisma } from "@/app/_lib/public-deps";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { loadNovelHreflangSiblings } from "@/lib/seo/novel-hreflang";
import {
  getPublicChapterView,
  getPublicNovelDetail,
  listHomeNovels,
  listPublicCategories as queryPublicCategories,
  listPublicArticles,
  loadPublicChrome,
  resolvePublicArticleBySlugParam,
  type PublicChromeCurrent,
} from "@/lib/site/queries";
import { getHomeCarouselItems } from "@/lib/site/home-carousel-service";


export const loadChrome = cache(async (current?: PublicChromeCurrent) => loadPublicChrome(prisma, current));

export const loadHomeNovels = cache(async (locale: SiteLocale) => listHomeNovels(prisma, locale));
export const loadPublicCategories = cache(async (locale: SiteLocale) => queryPublicCategories(prisma, locale));
export const loadHomeCarousel = cache(async (locale: SiteLocale) => getHomeCarouselItems(locale, prisma));

export const loadBrowseNovels = cache(async (locale: SiteLocale) => listPublicArticles(prisma, locale));

export const loadArticleAccess = cache(async (slugParam: string, locale: SiteLocale) =>
  resolvePublicArticleBySlugParam(prisma, slugParam, locale),
);

export const loadNovelDetail = cache(async (articleId: string) => getPublicNovelDetail(prisma, articleId));

export const loadChapterView = cache(async (articleId: string, chapterNumber: number) =>
  getPublicChapterView(prisma, articleId, chapterNumber),
);

/** Publicly-visible Article siblings (other locales) for one Novel — hreflang input. */
export const loadHreflangSiblings = cache(async (novelId: string) =>
  loadNovelHreflangSiblings(prisma, novelId),
);
