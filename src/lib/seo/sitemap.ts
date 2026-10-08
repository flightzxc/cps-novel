import {
  SITE_LOCALES,
  type SiteLocale,
} from "@/lib/locale/locale-canonical";
import type { Prisma, PrismaClient } from "@prisma/client";

import { BLOG_FAMILY_ARTICLE_TYPES } from "@/domain/database-statuses";
import { loadAllByIdCursor, whereAfterId } from "@/lib/db/id-cursor-pages";
import { isArticleBlogEnabled } from "@/lib/flags";
import { buildChapterPath } from "@/lib/seo/chapter-path";
import { getSiteUrl, toAbsoluteUrl } from "@/lib/seo/site-url";
import { buildArticlePath, buildBlogPath, localePrefix } from "@/lib/slug/article-path";
import {
  buildPublicArticleWhere,
  buildPublicBlogArticleWhere,
  isHiddenFromPublicView,
  isPromoReady,
  isPublicationStatePublic,
} from "@/server/publication/visibility";
import { getSiteSetting } from "@/server/site-settings/service";
import {
  listDistinctPublicTaxonomy,
  loadPublicTaxonomyByNovelIds,
} from "@/lib/site/public-taxonomy";
import { listPublicCategoryPageCounts } from "@/lib/site/category-queries";
import {
  PREVIEW_CHAPTER_TAKE,
  PUBLIC_PREVIEW_CHAPTER_WHERE,
} from "@/lib/site/queries";

/**
 * C-29 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-29):
 * `blogpage` is the fourth sitemap family — the blog-family counterpart to
 * `novelpage`. File-name pattern (`getSitemapFileName`/
 * `parseSitemapFileName` below) and family dispatch
 * (`createSitemapFamilyBuilder`) both had to change in lockstep — the plan's
 * own risk note for this exact spot: "sitemap 文件名正则改漏一处（解析、
 * 分发、生成三处），表现是 sitemap 索引里有博客家族但请求那个文件返回
 * 404，或者反过来。三处必须同改并有测试。" `tests/backend/seo/
 * sitemap-blog.test.ts` covers all three.
 */
/**
 * 运营 V2（Owner 2026-09-30）：分类页并入 mainpage——照 CPS v8.5.1
 * `src/lib/sitemap.ts:31`（`SitemapFamilySpec.type` 只有 mainpage/dramapage/blogpage
 * 三类，分类页在 mainpage 里，见同文件 `buildMainPageEntries` 339-367 行）。海阅不再有
 * `categorypage` 分片；旧的 `site_categorypage_<语种>[_N].xml` 网址由
 * `/sitemap/[fileName]` 路由 308 到 `site_mainpage_<语种>.xml`（见
 * `parseLegacyCategoryPageFileName`）。
 */
export const SITEMAP_TYPES = ["mainpage", "novelpage", "blogpage"] as const;
export type SitemapType = (typeof SITEMAP_TYPES)[number];

export interface SitemapFamilySpec {
  type: SitemapType;
  locale: SiteLocale;
}

export type SitemapChangefreq =
  | "always"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly"
  | "never";

export interface SitemapEntry {
  loc: string;
  lastmod: string;
  changefreq?: SitemapChangefreq;
  priority?: number;
  imageUrl?: string;
  imageTitle?: string;
}

export interface SitemapFile {
  name: string;
  url: string;
  lastmod: string;
  entries: SitemapEntry[];
}

export type BuildSitemapFamily = (spec: SitemapFamilySpec) => Promise<SitemapFile[]>;

export const SITEMAP_SHARD_SIZE = 10_000;

/**
 * 站点地图读取一个语种的公开文章时，每条 `article.findMany` 最多取多少行。
 *
 * 🔴 这个值不是性能旋钮，是正确性上限：`ARTICLE_SITEMAP_SELECT` 带了组合外键关系 `promoLink`
 * （`Article.[promoLinkId, novelId] → PromoLink.[id, novelId]`），Prisma 为它生成
 * `(id, novel_id) IN ((…),(…),…)`，一次取回的行数一多就撑爆 PostgreSQL 的解析栈（54001）或
 * Prisma 自己的 32,767 绑定变量上限——2026-10-06 预生产英语文章过万后站点地图刷新连续失败的根因。
 * 完整机理与实测门槛见 `@/lib/db/id-cursor-pages`（本机 7,281 组起 54001、事故现场 6,835 组；500 组留出 13 倍以上余量）；
 * 博客家族 select 里没有关系，也按同一个块大小读，只为让两条路径形状一致、结果集不再一次性整块进内存。
 * 不要把它改回「一次读完」：`tests/integration/tasks/sitemap-scale-postgres.test.ts` 用 3 万篇真实库数据守着它。
 */
export const SITEMAP_ARTICLE_LOAD_CHUNK_SIZE = 500;

/** 仅供测试覆盖块大小（验证任意块大小下输出逐字节相同）；生产调用方一律不传。 */
export interface SitemapFamilyBuilderOptions {
  readonly articleLoadChunkSize?: number;
}

type SitemapDb = PrismaClient | Prisma.TransactionClient;

const ARTICLE_SITEMAP_SELECT = {
  id: true,
  locale: true,
  slug: true,
  publicPageShortId: true,
  title: true,
  status: true,
  seoVisibility: true,
  deletedAt: true,
  updatedAt: true,
  novel: {
    select: {
      id: true,
      status: true,
      deletedAt: true,
      coverUrl: true,
    },
  },
  promoLink: {
    select: {
      status: true,
      webUrl: true,
      appUrl: true,
      deletedAt: true,
    },
  },
} as const satisfies Prisma.ArticleSelect;

type ArticleSitemapCandidate = Prisma.ArticleGetPayload<{
  select: typeof ARTICLE_SITEMAP_SELECT;
}>;

/**
 * C-27: `Article.novel` is nullable as of this round (blog articles have
 * none). Novel/category sitemap families are specifically Novel-page
 * families — a row with no Novel is out of scope for both, the same way
 * `isVisibleCandidate` below already excludes it. Narrowing here (a type
 * predicate `isVisibleCandidate` filters into) lets `buildNovelPageFiles`/
 * `buildCategoryPageFiles` keep reading `candidate.novel.*` without a `!`
 * assertion — blog sitemap coverage is C-29's job, on its own family.
 */
type ArticleSitemapCandidateWithNovel = ArticleSitemapCandidate & {
  novel: NonNullable<ArticleSitemapCandidate["novel"]>;
};

/**
 * L10N P4: extracted from this file's own former private `articleSitemapWhere`
 * so `src/lib/locale/active-locales.ts` can build its `groupBy` `where` from
 * the exact same collectability fragment instead of hand-rolling a second one
 * (the construction prompt's explicit ban on "另造... 第二份可见性 where").
 * `locale` accepts either one `SiteLocale` (sitemap's per-locale query) or an
 * `{ in: [...] }` filter (active-locales' single cross-locale query) — same
 * `Prisma.ArticleWhereInput["locale"]` field, two different narrowing shapes.
 *
 * C-25: `buildPublicArticleWhere` is the "collectability" fragment —
 * excludes `hidden`, keeps `seo_only` (sitemap/active-locales are both
 * exactly a collectability boundary, same as IndexNow). This DB-side
 * condition is a pre-filter only; `isVisibleCandidate` below re-checks it per
 * row for sitemap generation, per this file's own "DB filter is a superset,
 * application layer is authoritative" discipline. `active-locales.ts` does
 * not have per-row rows to recheck (it only reads a `groupBy` locale
 * breakdown) — see that module's own header for why the coarser superset is
 * an accepted, bounded approximation there.
 */
export function activePublicArticleWhere(
  locale: Prisma.ArticleWhereInput["locale"],
  env: NodeJS.ProcessEnv,
): Prisma.ArticleWhereInput {
  return buildPublicArticleWhere({
    locale,
    promoLink: {
      is: {
        deletedAt: null,
        // Index-friendly SUPERSET only. isPromoReady below remains authoritative
        // and excludes whitespace-only URLs after trimming.
        OR: [{ webUrl: { not: "" } }, { appUrl: { not: "" } }],
      },
    },
  }, env);
}

function articleSitemapWhere(locale: SiteLocale, env: NodeJS.ProcessEnv): Prisma.ArticleWhereInput {
  return activePublicArticleWhere(locale, env);
}

function isVisibleCandidate(
  candidate: ArticleSitemapCandidate,
  env: NodeJS.ProcessEnv,
): candidate is ArticleSitemapCandidateWithNovel {
  // C-27: no Novel means this cannot be a novel-page sitemap candidate,
  // full stop — see `ArticleSitemapCandidateWithNovel`'s doc comment.
  if (candidate.novel === null) return false;
  return candidate.deletedAt === null
    && candidate.novel.deletedAt === null
    && candidate.promoLink?.deletedAt === null
    && isPublicationStatePublic(candidate.novel, candidate)
    && isPromoReady(candidate.promoLink)
    // C-25: application-layer recheck for `hidden` — the DB `where` above is
    // only a pre-filter (never authoritative alone, per this file's header
    // convention), so a `hidden` row must also be caught here.
    && !isHiddenFromPublicView(candidate, env);
}

function latestDate(dates: readonly Date[]): Date {
  if (dates.length === 0) throw new Error("Cannot calculate sitemap lastmod from an empty set");
  let latest = dates[0]!.valueOf();
  for (let index = 1; index < dates.length; index += 1) {
    latest = Math.max(latest, dates[index]!.valueOf());
  }
  return new Date(latest);
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

/**
 * 运营 V2（Owner 2026-09-30，NOVEL_ONLY，CPS 无对应）：免费可读的章节页写进站点地图。
 *
 * 入选条件 = 章节页自己认为可读的那一批：共用 `PUBLIC_PREVIEW_CHAPTER_WHERE`
 * （`deletedAt` 空、`status = preview`、正文行存在）、按章节号升序只取前
 * `PREVIEW_CHAPTER_TAKE` 条（章节页 `listPreviewChapterRefs` 同一个窗口，窗口之外的章节号
 * 页面自己会 404），再剔除正文字数为 0 的行。所属小说 / 文章本身的可见性由调用方传入的
 * `candidates` 保证（同 novelpage 的 `isVisibleCandidate`，与章节页的
 * `resolveNovelArticlePublicAccessByShortId` + `isPromoReady` 同口径）。
 *
 * 只取章节号、更新时间、字数三列，不读正文。⚠️ 正文"非空白"无法用 where 表达，这里退而求其次
 * 只排除字数为 0 的行；全空白正文（上游给了一段纯空白）是已接受的极小缺口。
 */
const CHAPTER_SITEMAP_SELECT = {
  novelId: true,
  canonicalChapterNumber: true,
  updatedAt: true,
  content: { select: { charCount: true } },
} as const satisfies Prisma.NovelChapterSelect;

type ChapterSitemapRow = Prisma.NovelChapterGetPayload<{
  select: typeof CHAPTER_SITEMAP_SELECT;
}>;

/** 每次按这么多本小说的 id 取章节，避免一条 `IN (...)` 带上万个参数。 */
const CHAPTER_LOAD_BATCH_SIZE = 500;

async function loadPublicChaptersByNovelId(
  db: SitemapDb,
  novelIds: readonly string[],
): Promise<Map<string, ChapterSitemapRow[]>> {
  const byNovel = new Map<string, ChapterSitemapRow[]>();
  const uniqueIds = [...new Set(novelIds)];
  for (const batch of chunks(uniqueIds, CHAPTER_LOAD_BATCH_SIZE)) {
    const rows = await db.novelChapter.findMany({
      where: { ...PUBLIC_PREVIEW_CHAPTER_WHERE, novelId: { in: batch } },
      orderBy: [{ novelId: "asc" }, { canonicalChapterNumber: "asc" }],
      select: CHAPTER_SITEMAP_SELECT,
    });
    for (const row of rows) {
      const list = byNovel.get(row.novelId);
      if (list) list.push(row);
      else byNovel.set(row.novelId, [row]);
    }
  }
  for (const [novelId, rows] of byNovel) {
    // 先按章节页同一个窗口截取，再剔除空正文——顺序反过来会让窗口外的章节号"补位"进来。
    byNovel.set(
      novelId,
      rows.slice(0, PREVIEW_CHAPTER_TAKE).filter((row) => (row.content?.charCount ?? 0) > 0),
    );
  }
  return byNovel;
}

function buildNovelPageFiles(
  locale: SiteLocale,
  candidates: readonly ArticleSitemapCandidateWithNovel[],
  chaptersByNovelId: ReadonlyMap<string, readonly ChapterSitemapRow[]>,
): SitemapFile[] {
  const entries: SitemapEntry[] = [];
  for (const candidate of candidates) {
    entries.push({
      loc: toAbsoluteUrl(buildArticlePath({
        locale,
        slug: candidate.slug,
        shortId: candidate.publicPageShortId,
      })),
      lastmod: candidate.updatedAt.toISOString(),
      changefreq: "weekly",
      priority: 0.9,
      imageUrl: candidate.novel.coverUrl ?? undefined,
      imageTitle: candidate.title,
    });
    // 章节网址紧跟在所属小说后面，不新增分片类型；沿用同一个每文件条数上限与分片逻辑。
    // 网址一律走 `buildChapterPath`，不手拼。lastmod = 该章节行（`novel_chapter`）自己的
    // `updatedAt`。章节页不进 IndexNow（推送范围不变）。
    for (const chapter of chaptersByNovelId.get(candidate.novel.id) ?? []) {
      entries.push({
        loc: toAbsoluteUrl(buildChapterPath({
          locale,
          slug: candidate.slug,
          shortId: candidate.publicPageShortId,
          chapterNumber: chapter.canonicalChapterNumber,
        })),
        lastmod: chapter.updatedAt.toISOString(),
        changefreq: "monthly",
        priority: 0.6,
      });
    }
  }

  return chunks(entries, SITEMAP_SHARD_SIZE).map((shardEntries, index) => {
    const name = getSitemapFileName("novelpage", locale, index);
    return {
      name,
      url: toAbsoluteUrl(`/sitemap/${name}`),
      lastmod: latestDate(shardEntries.map((entry) => new Date(entry.lastmod))).toISOString(),
      entries: shardEntries,
    };
  });
}

/**
 * 分类页条目（并入 mainpage，见 `SITEMAP_TYPES` 注释）。只列页面确实返回 200 的分类网址。
 *
 * 🔴 B-38：**是否列、列几页**由 `listPublicCategoryPageCounts` 决定——它读每语种每分类本数矩阵
 * （不带缓存，刷新时刻的真实快照），与分类页（`getPublicCategoryPage`）、页脚、首页题材导航、
 * 详情页的可链接分类集合、分类页 hreflang 用的是 `src/lib/site/public-list.ts` 里同一段列表可见性 /
 * 分类归属 SQL，所以"列了、页面却 404"（历史上的 B-38 现象）与"页面是 200、站点地图没列"都不会发生；
 * `?page=N` 的 N 取 1..总页数，与页面 `page > totalPages → 404` 同口径。真实库用例
 * （`tests/integration/site/consistency-invariants-postgres.test.ts`）逐个 (slug, page) 验证。
 * 候选里有、页面列表里没有的分类（例如只有 `seo_only` 书的分类：站点地图收，列表不收）不列。
 *
 * 分类的排序、`lastmod` 的取法**不变**（仍按全量候选算：分类自身 `updatedAt` 与全部归属
 * 候选文章 `updatedAt` 的最大值——归属读 `novel_effective_tag`，经 `loadPublicTaxonomyByNovelIds`）、
 * 网址形状与 priority 也不变，保留下来的条目与改前逐字相同。
 */
async function buildCategoryEntries(
  db: SitemapDb,
  locale: SiteLocale,
  candidates: readonly ArticleSitemapCandidateWithNovel[],
  env: NodeJS.ProcessEnv,
): Promise<SitemapEntry[]> {
  const tagsByNovel = await loadPublicTaxonomyByNovelIds(
    db,
    candidates.map((candidate) => candidate.novel.id),
    locale,
    env,
  );
  const categories = listDistinctPublicTaxonomy(tagsByNovel);
  if (categories.length === 0) return [];

  // 页面认为"有书"的分类 → 总页数（矩阵，一次查询，见函数注释）。
  const listedPageCounts = await listPublicCategoryPageCounts(db, locale, env);

  const entries: SitemapEntry[] = [];
  for (const category of categories) {
    // 页面会 404（该分类在列表里没有书，例如书只是 seo_only 不进列表）：不列。
    const pageCount = listedPageCounts.get(category.slug);
    if (pageCount === undefined) continue;
    const matching = candidates.filter((candidate) =>
      (tagsByNovel.get(candidate.novel.id) ?? []).some((tag) => tag.id === category.id));
    if (matching.length === 0) continue;
    const lastmod = latestDate([
      category.updatedAt,
      ...matching.map((candidate) => candidate.updatedAt),
    ]).toISOString();
    for (let page = 1; page <= pageCount; page += 1) {
      // 2026-09-30：分类页 URL 必须带该分片所属语种的前缀（`localePrefix`，与
      // 同文件 novelpage/blogpage/mainpage 三个家族一致，也与短剧站
      // `${localePrefix}${getPagePath("category", …)}` 一致）。此前这里漏了前缀，
      // ko 的分类分片里全是无前缀的 en 地址——而海阅的空分类是 404（en 没有
      // 这个分类），生产实测 `/category/female-audience` 404，
      // `/ko/category/female-audience` 200。
      const categoryPath = `${localePrefix(locale)}/category/${category.slug}`;
      const path = page === 1 ? categoryPath : `${categoryPath}?page=${page}`;
      entries.push({
        loc: toAbsoluteUrl(path),
        lastmod,
        changefreq: "weekly",
        priority: page === 1 ? 0.7 : 0.5,
      });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// C-29 blog family. Separate SELECT/candidate-type/where/filter/builder set
// from the Novel-page family above — a blog Article structurally cannot
// satisfy `ArticleSitemapCandidateWithNovel` (no Novel, no PromoLink), same
// reasoning `access.ts`'s `checkBlogArticlePublicAccess` documents for why
// it is a parallel function rather than a branch inside the Novel one.
// ---------------------------------------------------------------------------

const BLOG_ARTICLE_SITEMAP_SELECT = {
  id: true,
  locale: true,
  slug: true,
  title: true,
  status: true,
  articleType: true,
  seoVisibility: true,
  deletedAt: true,
  updatedAt: true,
} as const satisfies Prisma.ArticleSelect;

type BlogArticleSitemapCandidate = Prisma.ArticleGetPayload<{
  select: typeof BLOG_ARTICLE_SITEMAP_SELECT;
}>;

function blogArticleSitemapWhere(locale: SiteLocale, env: NodeJS.ProcessEnv): Prisma.ArticleWhereInput {
  // C-25: same "collectability" fragment discipline as `articleSitemapWhere`
  // above (excludes `hidden`, keeps `seo_only`) — just the blog-family
  // record shape (`PUBLIC_BLOG_ARTICLE_RECORD`) instead of the Novel one.
  return buildPublicBlogArticleWhere({ locale }, env);
}

function isVisibleBlogCandidate(
  candidate: BlogArticleSitemapCandidate,
  env: NodeJS.ProcessEnv,
): boolean {
  return candidate.deletedAt === null
    && candidate.status === "published"
    && (BLOG_FAMILY_ARTICLE_TYPES as readonly string[]).includes(candidate.articleType)
    // C-25: application-layer recheck for `hidden`, same "DB filter is a
    // superset, application layer is authoritative" discipline as
    // `isVisibleCandidate` above.
    && !isHiddenFromPublicView(candidate, env);
}

function buildBlogPageFiles(
  locale: SiteLocale,
  candidates: readonly BlogArticleSitemapCandidate[],
): SitemapFile[] {
  const entries = candidates.map((candidate): SitemapEntry => ({
    loc: toAbsoluteUrl(buildBlogPath({ locale, slug: candidate.slug })),
    lastmod: candidate.updatedAt.toISOString(),
    changefreq: "weekly",
    priority: 0.6,
    // No `imageUrl`/`imageTitle` — a blog Article's optional cover (C-28's
    // `seoMetadata.coverUrl`) is not selected here; `renderUrlSetXml` only
    // emits the `<image:image>` block when `imageUrl` is present, so this
    // is simply "no image", not a gap versus the Novel family above.
  }));

  return chunks(entries, SITEMAP_SHARD_SIZE).map((shardEntries, index) => {
    const name = getSitemapFileName("blogpage", locale, index);
    return {
      name,
      url: toAbsoluteUrl(`/sitemap/${name}`),
      lastmod: latestDate(shardEntries.map((entry) => new Date(entry.lastmod))).toISOString(),
      entries: shardEntries,
    };
  });
}

/**
 * Production DB builder injected into the PR1 filesystem generator. Database
 * reads happen only in the refresh worker; request routes remain static-only.
 *
 * `env` (C-25, default `process.env`) threads `FEATURE_ARTICLE_SEO_VISIBILITY`
 * down to both the DB pre-filter and the per-row recheck — an explicit
 * override lets tests exercise the flag-on path without mutating global
 * `process.env`.
 */
export function createSitemapFamilyBuilder(
  db: SitemapDb,
  env: NodeJS.ProcessEnv = process.env,
  options: SitemapFamilyBuilderOptions = {},
): BuildSitemapFamily {
  const chunkSize = options.articleLoadChunkSize ?? SITEMAP_ARTICLE_LOAD_CHUNK_SIZE;
  const candidateCacheByRoute = new Map<SiteLocale, Promise<ArticleSitemapCandidateWithNovel[]>>();
  const loadVisible = (locale: SiteLocale) => {
    const existing = candidateCacheByRoute.get(locale);
    if (existing) return existing;
    // 按 id 游标分块读（块大小见 `SITEMAP_ARTICLE_LOAD_CHUNK_SIZE` 的注释）；过滤、排序、应用层复核都不变。
    const where = articleSitemapWhere(locale, env);
    const pending = loadAllByIdCursor(chunkSize, ({ take, after }) => db.article.findMany({
      where: whereAfterId(where, after),
      select: ARTICLE_SITEMAP_SELECT,
      orderBy: { id: "asc" },
      take,
    })).then((rows) => rows.filter((row) => isVisibleCandidate(row, env)));
    candidateCacheByRoute.set(locale, pending);
    return pending;
  };

  // C-29: separate cache from the Novel-page one above — different SELECT
  // shape, different candidate type, never shares a Map key/value shape
  // with `candidateCacheByRoute`.
  const blogCandidateCacheByRoute = new Map<SiteLocale, Promise<BlogArticleSitemapCandidate[]>>();
  const loadVisibleBlog = (locale: SiteLocale) => {
    const existing = blogCandidateCacheByRoute.get(locale);
    if (existing) return existing;
    const where = blogArticleSitemapWhere(locale, env);
    const pending = loadAllByIdCursor(chunkSize, ({ take, after }) => db.article.findMany({
      where: whereAfterId(where, after),
      select: BLOG_ARTICLE_SITEMAP_SELECT,
      orderBy: { id: "asc" },
      take,
    })).then((rows) => rows.filter((row) => isVisibleBlogCandidate(row, env)));
    blogCandidateCacheByRoute.set(locale, pending);
    return pending;
  };

  /**
   * 一个语种的 mainpage（首页 + 分类页）只在它有书时才出。
   *
   * 🔴 PN-09（Owner 2026-10-08：没有书时连入口也隐藏）修订了运营 V2（2026-09-30）的口径：
   * V2 把"有内容"定为"至少一本公开可见的小说，或者（博客开启时）至少一篇公开可见的博客文章"，
   * 于是只有博客的语种仍会把首页写进站点地图。但这个首页现在是 noindex 的（没有书 = 空语种，
   * 见 `@/lib/locale/empty-locale`、`@/lib/seo/empty-locale-seo`），站点地图里列一个
   * noindex 网址会在 Search Console 报"提交的网址带有 noindex"。所以 mainpage 的判定收回到
   * 只看书。
   *
   * 这仍是**同一个**"有书"定义，不是第二份：`loadVisible` 读的 `articleSitemapWhere` 就是
   * `activePublicArticleWhere`——`getActiveLocales()`（语言菜单与 noindex 的依据）用来做
   * `groupBy` 的那个同名片段；这里只是在其后多做一道逐行复核（`isVisibleCandidate`，例如纯空白的
   * 推广链接），所以"站点地图有首页"⊆"活跃语种"，不会出现"站点地图列了、页面却 noindex"。
   * 默认语种 `en` 仍按同一规则处理，没书也不列。
   *
   * 只有博客的语种：novelpage 本来就空，mainpage 现在也不出，blogpage 不变（博客文章页本身
   * 有内容、仍可收录——它们的 robots 不受空语种影响）。
   */
  const localeHasPublicBooks = async (locale: SiteLocale): Promise<boolean> =>
    (await loadVisible(locale)).length > 0;

  return async ({ type, locale }) => {
    if (type === "blogpage") {
      // C-29 "开关": `FEATURE_ARTICLE_BLOG` off -> the blog family emits
      // zero files (not merely zero URLs inside one empty file) — matching
      // the plan's "关闭时 ... sitemap 不生成博客家族" and keeping the
      // sitemap in lockstep with `access.ts`'s `checkBlogArticlePublicAccess`
      // (which also fails closed on this same flag before querying), so a
      // `/blog/{slug}` URL is never listed in a sitemap while the route
      // that URL points at would itself 404.
      if (!isArticleBlogEnabled(env)) return [];
      const blogCandidates = await loadVisibleBlog(locale);
      return buildBlogPageFiles(locale, blogCandidates);
    }

    if (type === "novelpage") {
      const candidates = await loadVisible(locale);
      if (candidates.length === 0) return [];
      const chaptersByNovelId = await loadPublicChaptersByNovelId(
        db,
        candidates.map((candidate) => candidate.novel.id),
      );
      return buildNovelPageFiles(locale, candidates, chaptersByNovelId);
    }

    // mainpage：首页 → 该语种有公开内容的分类页（并入自原 categorypage，CPS v8.5.1
    // `src/lib/sitemap.ts` 330-367 行同一顺序：首页在前、分类页在后）。
    if (!(await localeHasPublicBooks(locale))) return [];
    const candidates = await loadVisible(locale);
    const settings = await getSiteSetting(db, { ttlMs: 0 });
    const homeLastmod = latestDate([
      settings.updatedAt,
      ...candidates.map((candidate) => candidate.updatedAt),
    ]).toISOString();
    const entries: SitemapEntry[] = [{
      loc: locale === "en" ? getSiteUrl() : toAbsoluteUrl(`/${locale}`),
      lastmod: homeLastmod,
      changefreq: "daily",
      priority: 1,
    }];
    if (candidates.length > 0) {
      entries.push(...await buildCategoryEntries(db, locale, candidates, env));
    }

    return chunks(entries, SITEMAP_SHARD_SIZE).map((shardEntries, index) => {
      const name = getSitemapFileName("mainpage", locale, index);
      return {
        name,
        url: toAbsoluteUrl(`/sitemap/${name}`),
        lastmod: latestDate(shardEntries.map((entry) => new Date(entry.lastmod))).toISOString(),
        entries: shardEntries,
      };
    });
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function getSitemapFileName(
  type: SitemapType,
  locale: SiteLocale,
  index: number,
): string {
  const baseName = `site_${type}_${locale}`;
  return index === 0 ? `${baseName}.xml` : `${baseName}_${index}.xml`;
}

export function parseSitemapFileName(fileName: string): {
  type: SitemapType;
  locale: SiteLocale;
  index: number;
} | null {
  const match = /^site_(mainpage|novelpage|blogpage)_([a-zA-Z-]+)(?:_(\d+))?\.xml$/.exec(fileName);
  if (!match) return null;

  const locale = match[2];
  if (!(SITE_LOCALES as readonly string[]).includes(locale)) return null;

  return {
    type: match[1] as SitemapType,
    locale: locale as SiteLocale,
    index: match[3] ? Number.parseInt(match[3], 10) : 0,
  };
}

/**
 * 旧的 `site_categorypage_<语种>.xml`（含 `_N` 分页）——分类页并入 mainpage 之前的分片文件名。
 * 不再是有效的分片类型（`parseSitemapFileName` 不认），单独解析只为让路由把它 308 到
 * `site_mainpage_<语种>.xml`。语种必须是已登记的 `SITE_LOCALES`，否则返回 null。
 */
export function parseLegacyCategoryPageFileName(fileName: string): {
  locale: SiteLocale;
  index: number;
} | null {
  const match = /^site_categorypage_([a-zA-Z-]+)(?:_(\d+))?\.xml$/.exec(fileName);
  if (!match) return null;

  const locale = match[1];
  if (!(SITE_LOCALES as readonly string[]).includes(locale)) return null;

  return {
    locale: locale as SiteLocale,
    index: match[2] ? Number.parseInt(match[2], 10) : 0,
  };
}

/** 从总索引 XML 里取出它列出的全部分片文件名（`/sitemap/<name>.xml`）。 */
export function extractIndexedSitemapFileNames(indexXml: string): string[] {
  return Array.from(indexXml.matchAll(/<loc>[^<]*\/sitemap\/([^/<]+\.xml)<\/loc>/g)).map(
    (match) => match[1]!,
  );
}

export function renderUrlSetXml(entries: SitemapEntry[]): string {
  const body = entries
    .map((entry) => {
      const absoluteImageUrl = toAbsoluteUrl(entry.imageUrl);
      const changefreqLine = entry.changefreq
        ? `\n    <changefreq>${escapeXml(entry.changefreq)}</changefreq>`
        : "";
      const priorityLine = entry.priority !== undefined
        ? `\n    <priority>${entry.priority.toFixed(1)}</priority>`
        : "";
      const imageLines = absoluteImageUrl
        ? `\n    <image:image>\n      <image:loc>${escapeXml(absoluteImageUrl)}</image:loc>`
          + (entry.imageTitle ? `\n      <image:title>${escapeXml(entry.imageTitle)}</image:title>` : "")
          + "\n    </image:image>"
        : "";
      return `  <url>
    <loc>${escapeXml(entry.loc)}</loc>
    <lastmod>${escapeXml(entry.lastmod)}</lastmod>${changefreqLine}${priorityLine}${imageLines}
  </url>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${body}
</urlset>`;
}

export function renderSitemapIndexXml(files: SitemapFile[]): string {
  const body = files
    .map(
      (file) => `  <sitemap>
    <loc>${escapeXml(file.url)}</loc>
    <lastmod>${escapeXml(file.lastmod)}</lastmod>
  </sitemap>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</sitemapindex>`;
}
