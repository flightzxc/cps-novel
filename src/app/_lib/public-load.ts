import { cache } from "react";

import { prisma } from "@/app/_lib/public-deps";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { loadNovelHreflangSiblings } from "@/lib/seo/novel-hreflang";
import {
  getPublicBlogDetail,
  listPublicBlogArticles,
} from "@/lib/site/blog-queries";
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
import type { PublicTaxonomyTag } from "@/lib/site/public-taxonomy";
import { getHomeCarouselItems } from "@/lib/site/home-carousel-service";
import { checkBlogArticlePublicAccess } from "@/server/publication/access";


/**
 * N-9 (lane D wiring): `categories` is an optional second argument so a
 * caller that has already computed the taxonomy list via
 * `loadPublicCategories` for its own purposes (`src/app/page.tsx`'s
 * `HomeScreen` `categories` prop) can pass it straight through, and
 * `loadPublicChrome` skips re-running `listPublicCategories`'s
 * `article.findMany` + taxonomy lookup a second time for the footer. Every
 * other caller (`category/[slug]`, `novel/[slugParam]`, its
 * `chapter/[chapterNumber]`, `browse`) keeps calling this with one argument
 * and gets the original self-fetching behavior.
 *
 * This stayed a signature change rather than a new export deliberately:
 * `tests/ui/public-routes.test.tsx` mocks this module with a fixed
 * `vi.mock("@/app/_lib/public-load", () => ({ loadChrome: vi.fn(), ... }))`
 * factory (outside this lane's file boundary, not to be edited) — a second
 * export not present in that factory would be `undefined` when
 * `src/app/page.tsx` called it, throwing at render. `loadChrome` itself is
 * already in that factory as a bare `vi.fn()`, so an extra argument is a
 * silent no-op for the mock and the existing `mockResolvedValue` still
 * answers every call regardless of arity.
 *
 * Both this and `loadPublicCategories` are `React.cache()`-scoped per
 * request: when `src/app/page.tsx`'s `generateMetadata` and its default
 * export each call `loadPublicCategories(locale)` then `loadChrome(locale,
 * "home", categories)` with the same locale and the same (cache-deduped,
 * reference-equal) categories array, the pair collapses to one underlying
 * `getSiteSetting` + one `listPublicCategories` round-trip for the whole
 * render, not two of each. See `tests/backend/site/public-query-budget.test.ts`
 * for the query-count regression gate.
 *
 * WO-1 (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §6.3): `locale` is now
 * a required first argument, no default (P0-S14 — see `messages/index.ts`'s
 * `getPublicT` doc comment for the full rationale: a default here would let
 * a caller silently render English chrome under a non-English locale prefix
 * once a second locale opens). Every one of the 8 public page bodies under
 * `src/app/_pages/` now passes its own `locale` param through explicitly.
 */
export const loadChrome = cache(
  async (
    locale: SiteLocale,
    current?: PublicChromeCurrent,
    categories?: readonly PublicTaxonomyTag[],
  ) => loadPublicChrome(prisma, locale, current, categories),
);

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

// ---------------------------------------------------------------------------
// C-29 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-29):
// blog family loaders, parallel to the Novel-article ones above.
// ---------------------------------------------------------------------------

export const loadBlogList = cache(async (locale: SiteLocale) => listPublicBlogArticles(prisma, locale));

export const loadBlogAccess = cache(async (locale: string, slug: string) =>
  checkBlogArticlePublicAccess(prisma, { locale, slug }),
);

export const loadBlogDetail = cache(async (articleId: string) => getPublicBlogDetail(prisma, articleId));
