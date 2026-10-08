/**
 * 公开列表的**唯一**筛选定义（B-38 第二段，v0.5.13）。
 *
 * 首页作品格、全部作品页、分类页、页脚分类、首页题材导航、站点地图的分类网址、详情页的"可链接分类集合"、
 * 分类页的 hreflang、404 判定、"作品数"、分页——全部由这个文件里的同一段筛选条件生成，由数据库直接
 * 筛选、分页、计数：一把尺子，没有任何列表上限。
 *
 * ## 取数方式（照 CPS `getTagPageArticles`，v8.7.2）
 *
 * 原生 SQL 只负责"当前页的编号 + 总数"两条；卡片数据仍用既有的正常查询（`ARTICLE_CARD_SELECT`）按编号补全、
 * 按原顺序排好，标签用 `loadPublicTaxonomyByNovelIds`（读归属表）。不在原生 SQL 里手写卡片字段，免得与
 * Prisma 的 select 形状漂移。
 *
 * ## 列表可见性（{@link publicListFromWhereSql}）
 *
 * 与 `buildPublicListArticleWhere` + `isPromoReady` **完全等价**，等价性由真实库用例逐行证明
 * （`tests/integration/site/list-equivalence-postgres.test.ts`，推广链接那一半是
 * `promo-ready-sql-equivalence-postgres.test.ts` 对每个基本平面字符的逐个比对）。两个写法上的刻意选择：
 *
 *  1. **`promo_link` 只按 id 连接**：组合外键 `article_promo_link_novel_fkey`
 *     （`(promo_link_id, novel_id) → promo_link(id, novel_id)`）已经保证 `p.novel_id = a.novel_id`。再多写一个
 *     `p.novel_id = a.novel_id`，规划器会把这个连接的行数估成 1，选错计划——本机实测 20 毫秒对 0.2 毫秒之差。
 *     不要"补全"这个看起来不完整的连接条件。
 *  2. **`a.article_type = 'novel_article'`**：与"文章必须有小说"等价（CHECK `article_novel_id_by_type_check`：
 *     `novel_article` ⟺ `novel_id IS NOT NULL`），加它是为了命中部分索引 `article_public_list_order_idx`
 *     （`(locale, published_at DESC, id) WHERE status = 'published' AND deleted_at IS NULL AND
 *     article_type = 'novel_article'`）——没有它，规划器证明不了查询落在这个部分索引的覆盖范围内。
 *
 * `FEATURE_ARTICLE_SEO_VISIBILITY` 打开时追加 `a.seo_visibility = 'public'`（列表排除 hidden 和 seo_only，
 * 与 `buildPublicListArticleWhere` 同口径）；关闭时不区分，同改造前。
 *
 * ## 排序
 *
 * `ORDER BY a.published_at DESC, a.id ASC`：发布时间新→旧，同时间按编号升序。**不写 `NULLS LAST`**——
 * 改造前 Prisma 的 `orderBy: { publishedAt: "desc" }` 渲染成 PostgreSQL 默认的 `DESC`（即 NULLS FIRST），
 * 这里保持同一语义（也与索引的默认顺序一致）。
 *
 * ## 分类归属（{@link categoryMembershipSql}）
 *
 * 读 `novel_effective_tag`（`src/server/tagging/effective-tag-projection.ts` 在改动真源的同一事务里维护）：
 * `provenance <> 'auto' OR 自动标签开关`。开关不写进表里，读取时按当时的开关决定自动来源的行算不算。
 *
 * ## 每语种每分类本数矩阵（{@link queryPublicCategoryCounts}）
 *
 * 页脚、首页题材导航、详情页标签能不能点、分类页 hreflang 读这张小矩阵（约 330 格），一次查询覆盖全部语种，
 * web 侧缓存 {@link PUBLIC_CATEGORY_COUNTS_TTL_SECONDS} 秒（方案决定 2）；worker（站点地图）调用不带缓存的原函数。
 * 列表、作品数、分页、404 判定**不走缓存**，实时。唯一"不安全方向"的窗口：某分类最后一本书刚下架时，页脚 /
 * 详情页最多还会链向它 60 秒，而它已经 404。
 *
 * ## 规模触发器（方案 4.7）
 *
 * 深翻页耗时随页数线性增长（`OFFSET`），方案选择"不设上限，加触发器"：任一语种任一分类可见书超过
 * {@link PUBLIC_LIST_SCALE_THRESHOLDS}.perCategoryPerLocale，或任一语种列表可见总数超过
 * {@link PUBLIC_LIST_SCALE_THRESHOLDS}.perLocaleTotal，矩阵计算时记一条结构化告警
 * `public_list_scale_threshold_exceeded`，运维命令 `scripts/ops/effective-tag-projection.ts scale-check`
 * 超过即退出 3（发版检查清单用）。**到时要做**：改成游标翻页（`(published_at, id) <` 上一页末行）。
 */
import { Prisma, type PrismaClient } from "@prisma/client";

import type { NovelCardView } from "@/features/public-ui/types";
import { isArticleSeoVisibilityEnabled } from "@/lib/flags";
import { isAutoTaggingEnabled } from "@/lib/flags/feature-flags";
import { SITE_LOCALES, type SiteLocale } from "@/lib/locale/locale-canonical";
import { promoReadySql } from "@/server/publication/visibility";

import { ARTICLE_CARD_SELECT, filterPromoReady, toPublicArticle } from "./article-card";
import { createBoundedTtlCache, type BoundedTtlCache } from "./bounded-ttl-cache";
import { toNovelCardView } from "./mappers";
import { loadPublicTaxonomyByNovelIds } from "./public-taxonomy";

type Db = PrismaClient | Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// 列表可见性 / 分类归属 SQL 片段
// ---------------------------------------------------------------------------

const PUBLIC_LIST_FROM_SQL = Prisma.sql`
  FROM article a
  JOIN novel n ON n.id = a.novel_id
  JOIN promo_link p ON p.id = a.promo_link_id
`;

/**
 * 列表可见的条件（`WHERE` 之后的那一串，不含 `WHERE` 关键字）：某个语种（或一组语种）的"列表可见"文章。
 * 别名固定为 `a`（article）、`n`（novel）、`p`（promo_link）。
 *
 * `localePredicate` 是写好的 SQL 片段（`a.locale = $1` 或 `a.locale IN (…)`），因为分页查询只看一个语种，
 * 矩阵一次看全部语种——其余条件两处逐字相同，这就是"唯一定义"。
 */
export function publicListWhereSql(localePredicate: Prisma.Sql, env: NodeJS.ProcessEnv = process.env): Prisma.Sql {
  const seoVisibility = isArticleSeoVisibilityEnabled(env) ? Prisma.sql`AND a.seo_visibility = 'public'` : Prisma.empty;
  return Prisma.sql`
    ${localePredicate}
      AND a.article_type = 'novel_article'
      AND a.status = 'published'
      AND a.deleted_at IS NULL
      ${seoVisibility}
      AND n.status = 'published'
      AND n.deleted_at IS NULL
      AND ${promoReadySql("p")}
  `;
}

/** `FROM … WHERE …` 整段（需要在 FROM 与 WHERE 之间再连别的表的调用方——矩阵——自己拼：`PUBLIC_LIST_FROM_SQL` + 连接 + `WHERE` + 上一个函数）。 */
export function publicListFromWhereSql(localePredicate: Prisma.Sql, env: NodeJS.ProcessEnv = process.env): Prisma.Sql {
  return Prisma.sql`${PUBLIC_LIST_FROM_SQL} WHERE ${publicListWhereSql(localePredicate, env)}`;
}

function singleLocale(locale: string): Prisma.Sql {
  return Prisma.sql`a.locale = ${locale}`;
}

/** 某本书属于某个分类（读归属表；自动来源的行只在自动标签开关打开时算）。 */
export function categoryMembershipSql(tagId: string, env: NodeJS.ProcessEnv = process.env): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM novel_effective_tag m
    WHERE m.canonical_tag_id = ${tagId}::uuid
      AND m.novel_id = a.novel_id
      AND (m.provenance <> 'auto' OR ${isAutoTaggingEnabled(env)})
  )`;
}

function scopeSql(options: { locale: string; tagId?: string | null; env: NodeJS.ProcessEnv }): Prisma.Sql {
  const membership = options.tagId ? Prisma.sql`AND ${categoryMembershipSql(options.tagId, options.env)}` : Prisma.empty;
  return Prisma.sql`${publicListFromWhereSql(singleLocale(options.locale), options.env)} ${membership}`;
}

// ---------------------------------------------------------------------------
// 分页：编号 + 总数 → 补全卡片
// ---------------------------------------------------------------------------

export type PublicNovelPage = {
  novels: NovelCardView[];
  page: number;
  totalPages: number;
  totalCount: number;
};

export type PublicListScope = Readonly<{
  locale: SiteLocale;
  /** 只列属于这个分类（`canonical_tag.id`）的书；不传 = 全部作品。 */
  tagId?: string | null;
  env?: NodeJS.ProcessEnv;
}>;

/** 当前页的文章编号（已按"发布时间新→旧、同时间按编号升序"排好）。 */
export async function queryPublicListIds(
  db: Db,
  options: PublicListScope & Readonly<{ limit: number; offset: number }>,
): Promise<string[]> {
  const env = options.env ?? process.env;
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT a.id AS id
    ${scopeSql({ locale: options.locale, tagId: options.tagId, env })}
    ORDER BY a.published_at DESC, a.id ASC
    LIMIT ${options.limit}::int OFFSET ${options.offset}::bigint
  `);
  return rows.map((row) => row.id);
}

/** 这个范围的列表可见总数（作品数、总页数、404 判定的唯一来源）。 */
export async function queryPublicListCount(db: Db, options: PublicListScope): Promise<number> {
  const env = options.env ?? process.env;
  const rows = await db.$queryRaw<Array<{ total: number | bigint }>>(Prisma.sql`
    SELECT count(*)::int AS total
    ${scopeSql({ locale: options.locale, tagId: options.tagId, env })}
  `);
  return Number(rows[0]?.total ?? 0);
}

/**
 * 按编号补全卡片：`ARTICLE_CARD_SELECT` 正常查询 → 按传入的编号顺序排好（`findMany({ id: { in } })`
 * 本身不保序）→ `filterPromoReady` 复核 → 标签读归属表。
 *
 * 复核丢掉的行意味着"数据库说可用、程序说不可用"——`promoReadySql` 与 `isPromoReady` 的等价性被打破
 * （例如 Node 升级改了空白字符集而没人发现），正常情况下**永远不会发生**。发生时丢弃该卡片（渲染的权威
 * 仍然是 `isPromoReady`），并记一条结构化错误日志，方便看日志发现。
 * 编号在补全时已经不存在（并发删除）的行静默跳过，那是竞争不是不变量违例。
 */
export async function hydratePublicListCards(
  db: Db,
  ids: readonly string[],
  locale: SiteLocale,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NovelCardView[]> {
  if (ids.length === 0) return [];
  const rows = await db.article.findMany({
    where: { id: { in: [...ids] } },
    select: ARTICLE_CARD_SELECT,
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });

  const ready = filterPromoReady(ordered);
  if (ready.length !== ordered.length) {
    const readyIds = new Set(ready.map((row) => row.id));
    for (const row of ordered) {
      if (readyIds.has(row.id)) continue;
      console.error(JSON.stringify({
        schemaVersion: 1,
        event: "public_list_invariant_violation",
        level: "error",
        reason: row.novel === null ? "novel_missing_after_sql_filter" : "promo_not_ready_after_sql_filter",
        articleId: row.id,
        locale,
      }));
    }
  }

  const tagsByNovel = await loadPublicTaxonomyByNovelIds(db, ready.map((row) => row.novel.id), locale, env);
  const cards: NovelCardView[] = [];
  for (const row of ready) {
    const card = toNovelCardView(toPublicArticle(row, tagsByNovel.get(row.novel.id) ?? []));
    if (card) cards.push(card);
  }
  return cards;
}

/** 首页作品格：第 1 页的前 `limit` 本，直接 LIMIT，不数总数。 */
export async function listPublicNovelHead(
  db: Db,
  options: PublicListScope & Readonly<{ limit: number }>,
): Promise<NovelCardView[]> {
  const ids = await queryPublicListIds(db, { ...options, offset: 0 });
  return hydratePublicListCards(db, ids, options.locale, options.env);
}

/**
 * 一页列表 + 真实总数。`page` 不合法（非正整数）按第 1 页；超出范围的页码返回空 `novels`
 * （`totalPages` 是真实总页数，调用方据此判 404）。没有书时 `totalPages` 恒为 1（同改造前）。
 *
 * 编号与总数两条原生 SQL 并行发出。页码大到 `(page - 1) * pageSize` 不再是安全整数时直接视为超出范围、
 * 不发编号查询（数据库的 `OFFSET` 装不下，会报错而不是返回空）；总数照查，调用方照样据它判 404。
 */
export async function listPublicNovelPage(
  db: Db,
  options: PublicListScope & Readonly<{ page: number; pageSize: number }>,
): Promise<PublicNovelPage> {
  const env = options.env ?? process.env;
  const currentPage = Number.isInteger(options.page) && options.page > 0 ? options.page : 1;
  const offset = (currentPage - 1) * options.pageSize;
  const [ids, totalCount] = await Promise.all([
    Number.isSafeInteger(offset)
      ? queryPublicListIds(db, { ...options, env, limit: options.pageSize, offset })
      : Promise.resolve([] as string[]),
    queryPublicListCount(db, { ...options, env }),
  ]);
  const novels = await hydratePublicListCards(db, ids, options.locale, env);
  return {
    novels,
    page: currentPage,
    totalPages: totalCount === 0 ? 1 : Math.max(1, Math.ceil(totalCount / options.pageSize)),
    totalCount,
  };
}

// ---------------------------------------------------------------------------
// 每语种每分类本数矩阵
// ---------------------------------------------------------------------------

/**
 * 页脚 / 首页题材导航 / 详情页标签可点 / 分类页 hreflang 读矩阵的缓存时长。方案决定 2：最多晚 60 秒。
 * **代码常量，不加环境变量**——同 `related-novels.ts` 主控 2026-09-29 的裁定（本仓规矩是 TS 解析、preflight、
 * compose 透传三处一致；要调就改这里并发新版本）。
 */
export const PUBLIC_CATEGORY_COUNTS_TTL_SECONDS = 60;

/** 规模触发器阈值（方案 4.7）。导出并由用例钉住：改它们必须同时改方案与发版检查清单。 */
export const PUBLIC_LIST_SCALE_THRESHOLDS = Object.freeze({
  /** 任一语种任一分类的列表可见书超过它 → 告警。 */
  perCategoryPerLocale: 40_000,
  /** 任一语种列表可见总数超过它 → 告警。 */
  perLocaleTotal: 60_000,
});

export type PublicCategoryCount = Readonly<{
  locale: string;
  canonicalTagId: string;
  slug: string;
  /** 该语种该分类下列表可见的书数（恒 > 0；没有书的格子不出现）。 */
  count: number;
}>;

export type PublicCategoryCounts = Readonly<{
  rows: readonly PublicCategoryCount[];
  /** 每个语种列表可见的总本数（与分类无关；一本书挂多个分类只算一次）。没有书的语种不出现。 */
  visibleTotalByLocale: ReadonlyMap<string, number>;
}>;

export type PublicListScaleReport = Readonly<{
  exceeded: boolean;
  thresholds: typeof PUBLIC_LIST_SCALE_THRESHOLDS;
  maxCategoryCount: number;
  maxLocaleTotal: number;
  categories: ReadonlyArray<Readonly<{ locale: string; slug: string; count: number }>>;
  locales: ReadonlyArray<Readonly<{ locale: string; total: number }>>;
}>;

/** 纯函数：矩阵是否越过规模触发器（运维命令与矩阵计算共用）。严格大于才算超过。 */
export function evaluatePublicListScale(counts: PublicCategoryCounts): PublicListScaleReport {
  const categories = counts.rows
    .filter((row) => row.count > PUBLIC_LIST_SCALE_THRESHOLDS.perCategoryPerLocale)
    .map((row) => ({ locale: row.locale, slug: row.slug, count: row.count }));
  const locales = [...counts.visibleTotalByLocale]
    .filter(([, total]) => total > PUBLIC_LIST_SCALE_THRESHOLDS.perLocaleTotal)
    .map(([locale, total]) => ({ locale, total }));
  return {
    exceeded: categories.length > 0 || locales.length > 0,
    thresholds: PUBLIC_LIST_SCALE_THRESHOLDS,
    maxCategoryCount: counts.rows.reduce((max, row) => Math.max(max, row.count), 0),
    maxLocaleTotal: [...counts.visibleTotalByLocale.values()].reduce((max, total) => Math.max(max, total), 0),
    categories,
    locales,
  };
}

function warnIfScaleExceeded(counts: PublicCategoryCounts): void {
  const report = evaluatePublicListScale(counts);
  if (!report.exceeded) return;
  console.warn(JSON.stringify({
    schemaVersion: 1,
    event: "public_list_scale_threshold_exceeded",
    level: "warn",
    thresholds: report.thresholds,
    categories: report.categories,
    locales: report.locales,
    action: "switch public list pagination to keyset (cursor) paging; see src/lib/site/public-list.ts header",
  }));
}

type CountRow = { locale: string; canonical_tag_id: string; slug: string; n: number | bigint };
type TotalRow = { locale: string; n: number | bigint };

/**
 * 每个语种每个分类各有几本列表可见的书（只收启用中的分类，只限 `SITE_LOCALES`，或调用方给的子集）。
 * 一次查询覆盖全部语种，另一条数每个语种的列表可见总数（规模触发器用）；矩阵计算时顺带检查规模触发器。
 *
 * **不带缓存**：给 worker（站点地图、运维命令）直接用；web 侧用 {@link getPublicCategoryCounts}。
 */
export async function queryPublicCategoryCounts(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
  options: Readonly<{ locales?: readonly string[] }> = {},
): Promise<PublicCategoryCounts> {
  const locales = (options.locales ?? SITE_LOCALES).filter((locale) => (SITE_LOCALES as readonly string[]).includes(locale));
  if (locales.length === 0) return { rows: [], visibleTotalByLocale: new Map() };
  const localePredicate = Prisma.sql`a.locale IN (${Prisma.join([...locales])})`;
  const autoEnabled = isAutoTaggingEnabled(env);

  const [countRows, totalRows] = await Promise.all([
    db.$queryRaw<CountRow[]>(Prisma.sql`
      SELECT a.locale AS locale, m.canonical_tag_id AS canonical_tag_id, ct.slug AS slug, count(*)::int AS n
      ${PUBLIC_LIST_FROM_SQL}
      JOIN novel_effective_tag m
        ON m.novel_id = a.novel_id AND (m.provenance <> 'auto' OR ${autoEnabled})
      JOIN canonical_tag ct
        ON ct.id = m.canonical_tag_id AND ct.status = 'active'
      WHERE ${publicListWhereSql(localePredicate, env)}
      GROUP BY a.locale, m.canonical_tag_id, ct.slug
    `),
    db.$queryRaw<TotalRow[]>(Prisma.sql`
      SELECT a.locale AS locale, count(*)::int AS n
      ${publicListFromWhereSql(localePredicate, env)}
      GROUP BY a.locale
    `),
  ]);

  const counts: PublicCategoryCounts = {
    rows: countRows
      .map((row) => ({ locale: row.locale, canonicalTagId: row.canonical_tag_id, slug: row.slug, count: Number(row.n) }))
      .filter((row) => row.count > 0),
    visibleTotalByLocale: new Map(totalRows.map((row) => [row.locale, Number(row.n)] as const)),
  };
  warnIfScaleExceeded(counts);
  return counts;
}

let countsCache: BoundedTtlCache<PublicCategoryCounts> | null = null;

function getCountsCacheInstance(): BoundedTtlCache<PublicCategoryCounts> {
  if (!countsCache) {
    // 键 = 两个开关的取值组合（至多 4 个），多留一点余量。开关在生产进程里不变，进键只是让缓存对传入的
    // `env` 始终正确（测试里会翻开关）。
    countsCache = createBoundedTtlCache<PublicCategoryCounts>({
      maxEntries: 8,
      ttlMs: PUBLIC_CATEGORY_COUNTS_TTL_SECONDS * 1000,
    });
  }
  return countsCache;
}

/** 测试缝：清空并丢弃矩阵缓存实例（同 `clearRelatedNovelsPoolCacheForTest`）。 */
export function clearPublicCategoryCountsCacheForTest(): void {
  countsCache?.clear();
  countsCache = null;
}

/** web 侧用：矩阵 + 60 秒进程内缓存（同一时刻并发请求共享同一次计算）。 */
export async function getPublicCategoryCounts(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PublicCategoryCounts> {
  const key = `auto:${isAutoTaggingEnabled(env)}|seo:${isArticleSeoVisibilityEnabled(env)}`;
  return getCountsCacheInstance().getOrLoad(key, () => queryPublicCategoryCounts(db, env));
}

// ---------------------------------------------------------------------------
// 矩阵的读取视图（纯函数）
// ---------------------------------------------------------------------------

/** 某语种里有书的分类：分类编号 → { slug, 本数 }。 */
export function categoryCountsForLocale(
  counts: PublicCategoryCounts,
  locale: string,
): ReadonlyMap<string, Readonly<{ slug: string; count: number }>> {
  const map = new Map<string, { slug: string; count: number }>();
  for (const row of counts.rows) {
    if (row.locale === locale) map.set(row.canonicalTagId, { slug: row.slug, count: row.count });
  }
  return map;
}

/** 某分类（按 slug）在哪些语种里有书。 */
export function localesWithCategory(counts: PublicCategoryCounts, slug: string): ReadonlySet<string> {
  return new Set(counts.rows.filter((row) => row.slug === slug).map((row) => row.locale));
}
