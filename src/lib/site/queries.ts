import type { Prisma, PrismaClient } from "@prisma/client";

import type { NovelCardView, NovelDetailView, ChapterView } from "@/features/public-ui/types";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { parseArticleSlugParam } from "@/lib/slug/article-path";
import { asSiteLocale } from "./locale-label";
import { resolveNovelArticlePublicAccessByShortId } from "@/server/publication/access";
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

export const ARTICLE_CARD_SELECT = {
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

export type ListedArticle = Prisma.ArticleGetPayload<{ select: typeof ARTICLE_CARD_SELECT }>;
type ListedArticleDetail = Prisma.ArticleGetPayload<{ select: typeof ARTICLE_DETAIL_SELECT }>;

/**
 * C-27: `Article.novel` is nullable as of this round (blog articles have
 * none). Every function in this module renders a `NovelCardView`/
 * `NovelDetailView`/`ChapterView` — all Novel-shaped view models — so a row
 * with no Novel is out of scope for all of them until C-29 gives blog its
 * own view model family. `listPublicArticles`/`listPublicCategories` get
 * this for free from `buildPublicListArticleWhere`'s own `novel: { is:
 * PUBLIC_NOVEL_RECORD }` requirement (a null-novel row cannot match);
 * `getPublicNovelDetail`/`getPublicChapterView` load by bare `articleId`
 * (`buildPrimaryArticleWhere` has no novel/status/promo requirement), so
 * they add an explicit `row.novel === null` check and return `null` — the
 * same "not this view model" answer they already give for promo-not-ready.
 */
export type ListedArticleWithNovel = ListedArticle & { novel: NonNullable<ListedArticle["novel"]> };
type ListedArticleDetailWithNovel = ListedArticleDetail & { novel: NonNullable<ListedArticleDetail["novel"]> };

export type PublicArticleAccess =
  | {
      kind: "published";
      articleId: string;
      novelId: string;
      slugPart: string;
      shortId: string;
      title: string;
    }
  /**
   * 短码能找到一篇已发布文章，但这条 URL 不是它的规范地址（语种前缀不对，或
   * slug 部分过期）——调用方应 `permanentRedirect`（308）到
   * `buildArticlePath({ locale, slug: slugPart, shortId })`。CPS 同款：
   * `getDramaDetailBySlug` 的 `redirectToCanonical`（`site-queries.ts:972-993`）。
   */
  | {
      kind: "redirect";
      locale: SiteLocale;
      slugPart: string;
      shortId: string;
      title: string;
    }
  | { kind: "unavailable"; title: string }
  | { kind: "takedown"; title: string }
  | { kind: "not_found" };

/**
 * 公开详情页/章节页的访问判定入口。
 *
 * 2026-09-30（短码语种纠正，照搬短剧站 v8.5.1）：**短码是页面身份，语种前缀
 * 和 slug 只是展示**。此前这里按 (locale, slug) 找文章、找到后再要求短码相等
 * ——语种前缀不对（比如把韩语书的路径挂到英文下）就找不到行，直接 404。现在
 * 改成 CPS `getDramaDetailBySlug` 的顺序：
 *
 * 1. 短码解析不出来 → 404（没有短码就没有身份）；
 * 2. 按短码找文章，找不到 → 404；
 * 3. 找到且已发布：URL 的语种、slug 与文章真实的一致 → 正常渲染；不一致 →
 *    `redirect`，由页面 `permanentRedirect`（308）到规范地址；
 * 4. 找到但是下架（`unavailable`）/撤回（`takedown`）：只有 URL 完全就是它的
 *    规范地址才沿用原来的页面；语种/slug 不符一律 404——不通过纠正跳转去
 *    "确认"一篇非公开文章的存在，行为与改动前完全一致（改动前语种不符根本
 *    找不到行）。
 *
 * 🔴 不做批量 301、不删 slug——CPS 的历史教训（跨语言死链事故 f2e4532 /
 * 265401c）：靠短码就地纠正，永远不靠改库或大批量重定向。
 */
export async function resolvePublicArticleBySlugParam(
  db: PrismaClient | Prisma.TransactionClient,
  slugParam: string,
  locale: SiteLocale,
): Promise<PublicArticleAccess> {
  const parsed = parseArticleSlugParam(slugParam);
  if (!parsed) return { kind: "not_found" };

  const access = await resolveNovelArticlePublicAccessByShortId(db, { shortId: parsed.shortId });
  if (access.kind === "not_found") return { kind: "not_found" };

  const isCanonicalUrl = access.locale === locale && access.slug === parsed.slugPart;

  if (access.kind === "published") {
    if (isCanonicalUrl) {
      return {
        kind: "published",
        articleId: access.articleId,
        novelId: access.novelId,
        slugPart: parsed.slugPart,
        shortId: parsed.shortId,
        title: access.title,
      };
    }
    // 文章存的语种不在已登记集合里：没有可跳的规范地址，当 404 处理而不是
    // 跳到一个必然 404 的 `/{未知语种}/novel/…`。
    const canonicalLocale = asSiteLocale(access.locale);
    if (!canonicalLocale) return { kind: "not_found" };
    return {
      kind: "redirect",
      locale: canonicalLocale,
      slugPart: access.slug,
      shortId: parsed.shortId,
      title: access.title,
    };
  }

  return isCanonicalUrl ? { kind: access.kind, title: access.title } : { kind: "not_found" };
}

export function toPublicArticle(
  row: ListedArticleWithNovel,
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
  row: ListedArticleDetailWithNovel,
  tags: readonly PublicTaxonomyTag[] = [],
): PublicArticleDetailRecord {
  return {
    ...toPublicArticle(row, tags),
    body: row.body,
    seoMetadata: row.seoMetadata,
    promoLink: row.promoLink ? { publicRedirectCode: row.promoLink.publicRedirectCode } : null,
  };
}

// C-27: also excludes a null `novel` — see `ListedArticleWithNovel`'s doc
// comment above. `buildPublicListArticleWhere`'s own `novel: { is:
// PUBLIC_NOVEL_RECORD }` requirement already makes this unreachable for
// `listPublicArticles`/`listPublicCategories`'s query today; the check here
// is what lets the type checker see that instead of a `!` assertion.
export function filterPromoReady(rows: ListedArticle[]): ListedArticleWithNovel[] {
  return rows.filter((row): row is ListedArticleWithNovel => row.novel !== null && isPromoReady(row.promoLink));
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
  // C-27: `buildPrimaryArticleWhere` has no novel/status/promo requirement,
  // unlike `buildPublicListArticleWhere` — a blog article's id could reach
  // this query. `NovelDetailView` is Novel-shaped; a null-novel row is "not
  // this view model", same non-render outcome as promo-not-ready today. See
  // `ListedArticleWithNovel`'s doc comment above. `novel` is re-captured
  // into a fresh object (rather than passing `row` straight through) because
  // TS narrows a property *access* (`row.novel`), not the declared type of
  // `row` itself, so a downstream call expecting `ListedArticleDetailWithNovel`
  // still needs this rebuild to see the narrowing.
  if (!row || !isPromoReady(row.promoLink) || row.novel === null) return null;
  const rowWithNovel: ListedArticleDetailWithNovel = { ...row, novel: row.novel };

  const previewChapters = await listPreviewChapterRefs(db, rowWithNovel.novel.id);
  const tags = await loadPublicTaxonomyByNovelIds(db, [rowWithNovel.novel.id], rowWithNovel.locale);
  return toNovelDetailView(
    toPublicArticleDetail(rowWithNovel, tags.get(rowWithNovel.novel.id) ?? []),
    previewChapters,
  );
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
  // C-27: see `getPublicNovelDetail`'s identical guard above — `ChapterView`
  // is also Novel-shaped, and `row` is re-captured for the same reason.
  if (!row || !isPromoReady(row.promoLink) || row.novel === null) return null;
  const rowWithNovel: ListedArticleDetailWithNovel = { ...row, novel: row.novel };

  const previewChapters = await listPreviewChapterRefs(db, rowWithNovel.novel.id);
  const match = previewChapters.find((chapter) => chapter.canonicalChapterNumber === chapterNumber);
  if (!match) return null;

  const chapter = await db.novelChapter.findFirst({
    where: {
      novelId: rowWithNovel.novel.id,
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

  const tags = await loadPublicTaxonomyByNovelIds(db, [rowWithNovel.novel.id], rowWithNovel.locale);
  return toChapterView(
    toPublicArticleDetail(rowWithNovel, tags.get(rowWithNovel.novel.id) ?? []),
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
 *
 * WO-1 (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §6.3): `locale` is now
 * a required second positional argument (right after `db`, no default —
 * same P0-S14 rule `chromeFromSiteSetting` follows). Every caller —
 * `@/app/_lib/public-load`'s `loadChrome` included — must pass it
 * explicitly now.
 *
 * L10N P4: `activeLocales` (5th argument, optional) is the dynamic layer's
 * result (`getActiveLocales()`) — passed IN, not fetched here. This function
 * stays dependency-injected on `db` for testability
 * (`tests/backend/site/public-query-budget.test.ts` counts exact
 * `article.findMany` calls against a fixture db); `getActiveLocales()` is a
 * fixed, `unstable_cache`-wrapped singleton bound to the real production
 * `prisma` client with its own `Article.groupBy` call shape, which that
 * fixture db does not implement. `@/app/_lib/public-load`'s `loadChrome`
 * fetches it (via the new `loadActiveLocales` loader there) and forwards it
 * down to this function, the same way it already forwards `categories`.
 */
export async function loadPublicChrome(
  db: PrismaClient | Prisma.TransactionClient,
  locale: SiteLocale,
  current?: PublicChromeCurrent,
  categories?: readonly PublicTaxonomyTag[],
  activeLocales?: readonly SiteLocale[],
) {
  const [settings, resolvedCategories] = await Promise.all([
    getSiteSetting(db),
    categories ?? listPublicCategories(db, locale),
  ]);
  return {
    settings,
    chrome: chromeFromSiteSetting(settings, locale, current, resolvedCategories, activeLocales),
  };
}

export type { SiteSettingSnapshot };
