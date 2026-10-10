import type { Prisma, PrismaClient } from "@prisma/client";

import type { NovelCardView, NovelDetailView, ChapterView } from "@/features/public-ui/types";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { parseArticleSlugParam } from "@/lib/slug/article-path";
import { asSiteLocale } from "./locale-label";
import { resolveNovelArticlePublicAccessByShortId } from "@/server/publication/access";
import { buildPrimaryArticleWhere, isPromoReady } from "@/server/publication/visibility";
import { getSiteSetting, type SiteSettingSnapshot } from "@/server/site-settings/service";

import { ARTICLE_CARD_SELECT, filterPromoReady, toPublicArticle } from "./article-card";
import type { ListedArticle, ListedArticleWithNovel } from "./article-card";
import { chromeFromSiteSetting, type PublicChromeCurrent } from "./chrome";
import {
  toChapterView,
  toNovelDetailView,
  type PublicArticleDetailRecord,
  type PreviewChapterRecord,
} from "./mappers";
import {
  categoryCountsForLocale,
  getPublicCategoryCounts,
  listPublicNovelHead,
  listPublicNovelPage,
  type PublicNovelPage,
} from "./public-list";
import {
  loadPublicCategoryTags,
  loadPublicTaxonomyByNovelIds,
  type PublicCategoryTag,
  type PublicTaxonomyTag,
} from "./public-taxonomy";

export type { PublicChromeCurrent };
// 卡片行的形状与最小转换住在 `./article-card`（叶子文件，避免与 `./public-list` 循环引用）；这里原样重新导出，
// 所有既有的 `import … from "@/lib/site/queries"` 不变。
export { ARTICLE_CARD_SELECT, filterPromoReady, toPublicArticle };
export type { ListedArticle, ListedArticleWithNovel };

export const HOME_GRID_LIMIT = 20;
export const BROWSE_PAGE_SIZE = 20;
export const PREVIEW_CHAPTER_TAKE = 64;

/**
 * 章节页"能返回 200"的章节行条件——**唯一定义**：详情页的章节列表
 * （`listPreviewChapterRefs`）、章节页本身（`getPublicChapterView`）和站点地图列章节 URL
 * （`src/lib/seo/sitemap.ts`）三处共用同一个片段，站点地图里有的章节页就一定是页面自己
 * 认为可读的那一批（运营 V2，Owner 2026-09-30）。另外页面要求正文非空白、且章节号落在
 * 按章节号升序取前 `PREVIEW_CHAPTER_TAKE` 条之内，这两条不能写成 where 片段，由各调用方
 * 在取出行之后自己判断。
 */
export const PUBLIC_PREVIEW_CHAPTER_WHERE = {
  deletedAt: null,
  status: "preview",
  content: { isNot: null },
} satisfies Prisma.NovelChapterWhereInput;

/**
 * Detail / chapter select. Extends the card select with `publicRedirectCode`
 * so the mapper can compute `readOnUpstreamHref`.
 *
 * 🔴 Deliberately NOT reused by the list/card path (`public-list.ts`'s
 * `hydratePublicListCards` / `filterPromoReady`) — `tests/backend/public/mappers.test.ts:41` asserts the card
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

type ListedArticleDetail = Prisma.ArticleGetPayload<{ select: typeof ARTICLE_DETAIL_SELECT }>;

/** `ListedArticleWithNovel`（卡片行且必有小说）的定义与 C-27 说明见 `./article-card`。详情行同款：`novel` 非空。 */
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

/**
 * 首页作品格：该语种列表（发布时间新→旧）的前 `HOME_GRID_LIMIT` 本，数据库直接 LIMIT。
 */
export async function listHomeNovels(
  db: PrismaClient | Prisma.TransactionClient,
  locale: SiteLocale,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NovelCardView[]> {
  return listPublicNovelHead(db, { locale, limit: HOME_GRID_LIMIT, env });
}

export type BrowsePageResult = PublicNovelPage;

/**
 * 全部作品页的一页：数据库分页 + 实时真实总数（`public-list.ts`，没有任何上限）。
 * 页码超出范围时 `novels` 为空而 `totalPages` 是真实总页数，页面据此判 404；没有书时 `totalPages` 恒为 1。
 */
export async function getPublicBrowsePage(
  db: PrismaClient | Prisma.TransactionClient,
  locale: SiteLocale,
  page: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BrowsePageResult> {
  return listPublicNovelPage(db, { locale, page, pageSize: BROWSE_PAGE_SIZE, env });
}

/**
 * 该语种有书的全部分类（页脚、首页题材导航、详情页"可链接分类集合"共用），按分类自己的排序。
 *
 * 取数：每语种每分类本数矩阵（`public-list.ts`，60 秒进程内缓存）里该语种本数 > 0 的分类，再现读一次
 * 分类名（请求语种 → en → zh → slug，链接带语种前缀，与卡片标签同一个投影函数）。
 * 与分类页是否返回 200 用的是同一段筛选条件，所以这份集合与"分类页会返回 200 的分类"恒等
 * （真实库用例 `tests/integration/site/consistency-invariants-postgres.test.ts` 钉死；缓存让它最多晚 60 秒）。
 *
 * v0.5.15：每一项多带一个只读 `homepageVisible`（运营在后台勾选的"首页题材导航是否显示"），随分类名同一条
 * SELECT 读出，不新增查询。**集合与顺序不因它而变**——只有首页 `HomeBody` 用它过滤（`home-nav.ts`），
 * 页脚与详情页可链接集合照旧用这一份完整列表。
 */
export async function listPublicCategories(
  db: PrismaClient | Prisma.TransactionClient,
  locale: SiteLocale,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly PublicCategoryTag[]> {
  const counts = await getPublicCategoryCounts(db, env);
  return loadPublicCategoryTags(db, [...categoryCountsForLocale(counts, locale).keys()], locale);
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
    where: { novelId, ...PUBLIC_PREVIEW_CHAPTER_WHERE },
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
      ...PUBLIC_PREVIEW_CHAPTER_WHERE,
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
 * this function re-running `listPublicCategories` (count-matrix read + a
 * fresh category-name read, since B-38) a second time for the footer. Every other caller
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
 * (`tests/backend/site/public-query-budget.test.ts` counts the exact
 * statement list against a fixture db); `getActiveLocales()` is a
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
  // B-38 第二部分：也可以传一个还没结算的 Promise（`Promise.all` 本来就会等它）。公开路由的
  // `loadChrome` 借此把"页脚分类"落到请求内去重的 `loadPublicCategories`，同时保持与
  // `getSiteSetting` 并行发起，不因为先等分类而把设置读取推迟一拍。
  categories?: readonly PublicTaxonomyTag[] | PromiseLike<readonly PublicTaxonomyTag[]>,
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
