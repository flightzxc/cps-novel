import { cache } from "react";

import { prisma } from "@/app/_lib/public-deps";
import { getActiveLocales } from "@/lib/locale/active-locales";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { loadNovelHreflangSiblings } from "@/lib/seo/novel-hreflang";
import type { SiteTag } from "@/features/public-ui/types";
import {
  getPublicBlogDetail,
  listPublicBlogArticles,
} from "@/lib/site/blog-queries";
import {
  getPublicBrowsePage,
  getPublicChapterView,
  getPublicNovelDetail,
  listHomeNovels,
  listPublicCategories as queryPublicCategories,
  loadPublicChrome,
  resolvePublicArticleBySlugParam,
  type PublicChromeCurrent,
} from "@/lib/site/queries";
import { getPublicCategoryPage } from "@/lib/site/category-queries";
import type { PublicTaxonomyTag } from "@/lib/site/public-taxonomy";
import { restrictViewTagLinks, toLinkableCategorySlugs } from "@/lib/site/category-links";
import { asSiteLocale } from "@/lib/site/locale-label";
import { getHomeCarouselItems } from "@/lib/site/home-carousel-service";
import { getRelatedAndNewReleaseNovels } from "@/lib/site/related-novels";
import { checkBlogArticlePublicAccess } from "@/server/publication/access";

/**
 * 该语种有书的全部分类（列表可见的书至少一本）：页脚、首页题材导航，以及详情页的"可链接分类集合"
 * 都取这一份（同一请求内去重，见 `loadChrome`）。
 *
 * B-38（v0.5.13）：数据来自每语种每分类本数矩阵（`@/lib/site/public-list`，进程内缓存 60 秒，一次查询覆盖
 * 全部语种），所以页脚、首页导航、详情页标签可不可点、分类页 hreflang 最多晚 60 秒；列表、作品数、分页、
 * 404 判定不走这条缓存，实时。
 * 定义在 `loadChrome` 之前，因为 `loadChrome` 在没有传入 `categories` 时自己落到这里。
 */
export const loadPublicCategories = cache(async (locale: SiteLocale) => queryPublicCategories(prisma, locale));

/**
 * N-9 (lane D wiring): `categories` is an optional second argument so a
 * caller that has already computed the taxonomy list via
 * `loadPublicCategories` for its own purposes (`src/app/page.tsx`'s
 * `HomeScreen` `categories` prop) can pass it straight through, and
 * `loadPublicChrome` skips re-running `listPublicCategories`'s
 * `article.findMany` + taxonomy lookup a second time for the footer. Every
 * other caller (`category/[slug]`, `novel/[slugParam]`, its
 * `chapter/[chapterNumber]`, `browse`) keeps calling this without
 * `categories`; B-38 第二部分起，这时落到请求内去重的 `loadPublicCategories(locale)`
 * （此前由 `loadPublicChrome` 自己再查一遍，且 `generateMetadata` 与页面本体的实参列表
 * 不同、互相不去重，详情页/章节页一次渲染查两遍）。
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
 *
 * L10N P4: `activeLocales` is an optional 4th argument, same "caller who
 * already has it can pass it in" shape as `categories` above. Callers that
 * care about the LocaleSwitcher rendering correctly (every `_pages/*.tsx`
 * body that renders a `SiteShell`) fetch it via `loadActiveLocales()` below
 * and pass it through; callers that don't (none today) can omit it.
 */
export const loadChrome = cache(
  async (
    locale: SiteLocale,
    current?: PublicChromeCurrent,
    categories?: readonly PublicTaxonomyTag[],
    activeLocales?: readonly SiteLocale[],
  ) =>
    loadPublicChrome(
      prisma,
      locale,
      current,
      // `loadChrome` 自己的 `cache()` 按实参列表分键：详情页的 `generateMetadata`
      // （`loadChrome(locale)`）与页面本体（`loadChrome(locale, undefined, undefined, activeLocales)`）
      // 实参列表不同，过去各自让 `loadPublicChrome` 查一遍页脚分类。统一落到
      // `loadPublicCategories(locale)`，同一请求内只查一次（传 Promise 而不是先 await，
      // 保持与 `getSiteSetting` 并行发起）。
      categories ?? loadPublicCategories(locale),
      activeLocales,
    ),
);

/**
 * L10N P4: the dynamic locale layer's `React.cache()`-scoped, request-deduped
 * entry point — mirrors every other loader in this file (`loadHomeNovels`
 * etc.), wrapping the module-level `unstable_cache`d `getActiveLocales()`
 * (`@/lib/locale/active-locales`) so a render that calls it more than once
 * (e.g. `generateMetadata` and the page body both wanting it) still only
 * evaluates it once per request.
 */
export const loadActiveLocales = cache(() => getActiveLocales());

export const loadHomeNovels = cache(async (locale: SiteLocale) => listHomeNovels(prisma, locale));
export const loadHomeCarousel = cache(async (locale: SiteLocale) => getHomeCarouselItems(locale, prisma));

/**
 * 全部作品页的一页（数据库分页 + 真实总数）。请求内去重：`generateMetadata` 与页面本体用同样的
 * `(locale, page)` 调用，只查一次。
 */
export const loadBrowsePage = cache(async (locale: SiteLocale, page: number) =>
  getPublicBrowsePage(prisma, locale, page),
);

/**
 * 分类页的一页（`/category/{slug}` 与 `/browse?category=`）；分类不存在 / 没有书 / 页码超出 → `null`。
 * 请求内去重，同上。`slug` 传原始值，规范化（trim / 小写 / 长度）在 `getPublicCategoryPage` 里。
 */
export const loadCategoryPage = cache(async (locale: SiteLocale, slug: string, page: number) =>
  getPublicCategoryPage(prisma, locale, slug, page),
);

export const loadArticleAccess = cache(async (slugParam: string, locale: SiteLocale) =>
  resolvePublicArticleBySlugParam(prisma, slugParam, locale),
);

/**
 * B-38 第二部分：交给页面的视图里，标签只有在分类页确实返回 200 时才带 `href`。
 *
 * 详情页的标签来自**这本书**的全部 active 分类，而分类页在该语种没有书时返回 404（空分类即 404），所以
 * 书挂着该语种里没有书的分类时，`Tag` 渲染出来的 `<a href="/category/x">` 就是 404（见
 * `@/lib/site/category-links`）。"可链接分类集合"取 `loadPublicCategories(locale)`——同一请求内页脚已经取过的
 * 那一份（每语种每分类本数矩阵，最多晚 60 秒），所以判定新增 0 次数据库查询；书没有标签时连这一份都不碰。
 * 语种认不出来时按"都不可链接"处理（宁可纯文字，不出死链）。
 */
async function withLinkableTagHrefs<V extends { tags: readonly SiteTag[] }>(
  view: V,
  localeCode: string,
): Promise<V> {
  if (view.tags.length === 0) return view;
  const locale = asSiteLocale(localeCode);
  const linkable = toLinkableCategorySlugs(locale ? await loadPublicCategories(locale) : []);
  return restrictViewTagLinks(view, linkable);
}

export const loadNovelDetail = cache(async (articleId: string) => {
  const novel = await getPublicNovelDetail(prisma, articleId);
  return novel ? withLinkableTagHrefs(novel, novel.locale.code) : null;
});

export const loadChapterView = cache(async (articleId: string, chapterNumber: number) =>
  getPublicChapterView(prisma, articleId, chapterNumber),
);

/** Publicly-visible Article siblings (other locales) for one Novel — hreflang input. */
export const loadHreflangSiblings = cache(async (novelId: string) =>
  loadNovelHreflangSiblings(prisma, novelId),
);

/**
 * A4/B3: "相关推荐" + "新书推荐"，小说页与章节页共用同一次查询。
 * `articleId`/`novelId` 都是当前页面的 Article/Novel（Prisma 内部 id，不是
 * `NovelDetailView.id` 那个 businessId）——两个页面的 loader 都已经手上有
 * `access.articleId`/`access.novelId`，直接传入即可。
 */
export const loadRelatedAndNewReleases = cache(
  async (locale: SiteLocale, articleId: string, novelId: string) => {
    const { related, newReleases } = await getRelatedAndNewReleaseNovels(prisma, locale, articleId, novelId);
    // 候选池是最新 500 本，里面的卡片可能挂着该语种里没有书的分类（卡片标签来自这本书自己的全部分类）；
    // 同详情页标签的规则（`loadNovelDetail` 的注释）。目前两个推荐区都用 `minimal` 卡片、不渲染标签，
    // 这里按数据层一并收口，免得将来去掉 `minimal` 时悄悄冒出 404 链接。
    return {
      related: await Promise.all(related.map((card) => withLinkableTagHrefs(card, locale))),
      newReleases: await Promise.all(newReleases.map((card) => withLinkableTagHrefs(card, locale))),
    };
  },
);

// ---------------------------------------------------------------------------
// C-29 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-29):
// blog family loaders, parallel to the Novel-article ones above.
// ---------------------------------------------------------------------------

export const loadBlogList = cache(async (locale: SiteLocale, page: number) =>
  listPublicBlogArticles(prisma, locale, page),
);

export const loadBlogAccess = cache(async (locale: string, slug: string) =>
  checkBlogArticlePublicAccess(prisma, { locale, slug }),
);

export const loadBlogDetail = cache(async (articleId: string) => getPublicBlogDetail(prisma, articleId));
