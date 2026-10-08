/**
 * "相关推荐" + "新书推荐"（A4/B3，照搬 CPS v8.5.1 的机制，适配海阅的数据形状）。
 *
 * 参照：
 *   - `git show v8.5.1:src/components/site/related-dramas.tsx`
 *   - `git show v8.5.1:src/lib/site-queries.ts` 的 `getRelatedDramas` /
 *     `getRelatedDramasPoolCached` / `fetchRelatedDramasPoolFresh`
 *     （TTL 1800 秒、候选池 ORDER BY RANDOM()、跨请求 `BoundedTtlCache`、
 *     不足 limit 条时跨维度补齐、渲染前用权威可见性判定兜底过滤下架内容）。
 *
 * 与 CPS 的结构性差异（一次性说清楚，避免被当成走样）：
 *
 *   1. **候选维度**：CPS 的 Drama 只有一个 `categoryId`，池子天然按
 *      `(categoryId, routeLocale)` 分键（键空间 ~430 组合）。海阅没有"分类"
 *      字段，是多标签（`Novel` 可以同时挂多个 `CanonicalTag`）。按 CPS 的
 *      形状给每个 `(tagId, locale)` 建一个独立候选池，需要在这里重新实现
 *      `public-taxonomy.ts` 里那套"手动 FULL_SNAPSHOT 优先、否则按
 *      SourceLabelMapping 派生"的标签归属判定——那段逻辑本身极其精细（见该
 *      文件顶部关于 `channel_app` 统计信息缺失导致规划器失控的记录），复制
 *      一份出来正是本仓 `visibility.ts` 头部明确警告过的"同一个判定被重新
 *      实现出语义漂移"。且 2026-09-28 生产只读核实 `novel_canonical_tag`
 *      为 0 行（自动标签开闸前），按标签分键的池子现在全部是空池，收益为
 *      零、复杂度却和 CPS 一样高。
 *
 *      改为**按 (locale) 建一个候选池**：池内候选携带它们各自的标签集合
 *      （复用 `public-taxonomy.ts` 的权威投影，只在池子冷启动时调用一次，
 *      不是每个请求都调用），命中共同标签的候选在请求时于内存里筛出来。
 *      标签数据仍然只有唯一真源（`loadPublicTaxonomyByNovelIds`），没有
 *      第二处重新实现归属判定。候选池仍然是**有界**的（`take: poolSize`），
 *      不是"整表读入内存再过滤"。
 *
 *   2. **取样方式**：CPS 用 `ORDER BY RANDOM() LIMIT poolSize` 在 SQL 层做
 *      随机取样，池子覆盖整个候选空间。Prisma 的类型化查询 API 没有随机排序
 *      算子，要做到同样效果得像 CPS 那样降到 `$queryRawUnsafe` 手写 SQL、
 *      在其中重新拼出 `buildPublicListArticleWhere` 的等价条件——这正是上面
 *      第 1 条要避免的"同一个可见性判定被复制出第二份"。
 *
 *      改为 `orderBy: [{ publishedAt: "desc" }, ...] take: poolSize`（与
 *      公开列表（`public-list.ts`）用的排序完全一致，直接复用
 *      `buildPublicListArticleWhere` 这个唯一真源），池子因此是"最近发布的
 *      前 poolSize 本"而不是"全量随机 poolSize 本"。当已发布小说页总数
 *      ≤ poolSize（当前生产 15 本，默认 poolSize 500）时两者等价；总数一旦
 *      远超 poolSize，较早发布的书会永远进不了候选池——这是一个已知的、
 *      有意接受的简化（换来零重复实现权威可见性/标签判定的风险），在候选池
 *      内部仍然做真随机抽样（见 `sampleFromPool`），不会退化成稳定的
 *      "总是这几本"。规模超出这个假设时的后续动作：把 poolSize 调大，或者
 *      在 SQL 查询层为 `(seoVisibility, status, novel.status, publishedAt)`
 *      建一个支持随机跳读的索引后再迁回 `ORDER BY RANDOM()`。
 *
 *   3. **"新书推荐"复用同一个池**：CPS 没有这个模块。池子本身已经是按
 *      `publishedAt desc` 排好序的候选集合，"新书推荐"直接复用同一次冷启动
 *      查询的结果（截取头部、排除当前书与已经进了"相关推荐"的书），不需要
 *      第二条查询。
 *
 * 下架内容兜底：候选池只在冷启动时刷新（TTL 内），TTL 窗口内若某本书下架，
 * 池子里可能仍留着它的条目——这里复用 `buildPublicListArticleWhere` 本身
 * 已经排除非公开状态，且候选来自"当前一次冷启动查询"的结果，不是缓存了
 * 过期的可见性判定本身，所以陈旧窗口只会让某本已下架的书在 TTL 到期前继续
 * 出现在池子里（最长 TTL 秒），不会出现在 `getRelatedAndNewReleaseNovels`
 * 的返回值里——因为池子本身来自 `buildPublicListArticleWhere` 的查询结果，
 * 下架的书在下一次冷启动查询时就会被自然排除；真正的兜底窗口就是 TTL。
 */
import type { Prisma, PrismaClient } from "@prisma/client";

import type { NovelCardView } from "@/features/public-ui/types";
import { SITE_LOCALES, type SiteLocale } from "@/lib/locale/locale-canonical";
import { buildPublicListArticleWhere } from "@/server/publication/visibility";

import { createBoundedTtlCache, type BoundedTtlCache } from "./bounded-ttl-cache";
import {
  ARTICLE_CARD_SELECT,
  filterPromoReady,
  toPublicArticle,
  type ListedArticleWithNovel,
} from "./queries";
import { toNovelCardView } from "./mappers";
import { loadPublicTaxonomyByNovelIds, type PublicTaxonomyTag } from "./public-taxonomy";

export const RELATED_NOVELS_TARGET = 6;
export const NEW_RELEASES_TARGET = 6;

// TTL/池容量——2026-09-29 主控复核裁定：改回代码常量，不读环境变量。
//
// 本仓的规矩是"TS 解析、preflight、compose 透传三处必须一致"
// （见 `docker-compose.yml`/`.env.example`/`docs/operations/
// PREPRODUCTION_DEPLOYMENT_RUNBOOK.md` 的既有环境变量登记方式）——第一版
// 加了 `SITE_RELATED_NOVELS_POOL_TTL_SECONDS`/`_POOL_SIZE`/
// `_POOL_MAX_ENTRIES` 三个环境变量读取，但没有同步登记到 compose/
// .env.example/preprod.env.example，运维在服务器上改这三个值也不会生效，
// 违反了这条规矩。这里改成最简单的做法：直接用代码常量，不读 env。
// 🔴 将来确实需要调整这三个值时，改这里的常量并发一个新版本，不要再加
// 环境变量读取——除非同时把 TS 解析/compose 透传/.env.example 三处一起补上。
export const RELATED_NOVELS_POOL_TTL_SECONDS = 1800;
export const RELATED_NOVELS_POOL_SIZE = 500;
// 键空间 = 已注册语种数（本仓按 locale 建池，不是 CPS 那种 (category, locale)
// 组合），15 个语种已经是上限，给一点余量即可。
export const RELATED_NOVELS_POOL_MAX_ENTRIES = SITE_LOCALES.length + 5;

interface PoolEntry {
  articleId: string;
  novelId: string;
  row: ListedArticleWithNovel;
  tags: readonly PublicTaxonomyTag[];
  tagIds: ReadonlySet<string>;
}

/**
 * 冷启动查询一个语种的候选池，按 publishedAt desc 取前 poolSize 本
 * （见本文件头部注释第 2 条关于为什么不是 `ORDER BY RANDOM()`）。
 * 标签在这里一次性批量取好、绑定进池子条目——请求时只做内存过滤，
 * 不再为每次请求单独查标签。
 */
export async function fetchRelatedNovelsPoolFresh(
  locale: SiteLocale,
  poolSize: number,
  db: PrismaClient | Prisma.TransactionClient,
): Promise<PoolEntry[]> {
  const rows = await db.article.findMany({
    where: buildPublicListArticleWhere({ locale }),
    orderBy: [{ publishedAt: "desc" }, { id: "asc" }],
    take: poolSize,
    select: ARTICLE_CARD_SELECT,
  });
  const visibleRows = filterPromoReady(rows);
  const tagsByNovel = await loadPublicTaxonomyByNovelIds(
    db,
    visibleRows.map((row) => row.novel.id),
    locale,
  );

  return visibleRows.map((row) => {
    const tags = tagsByNovel.get(row.novel.id) ?? [];
    return {
      articleId: row.id,
      novelId: row.novel.id,
      row,
      tags,
      tagIds: new Set(tags.map((tag) => tag.id)),
    };
  });
}

let relatedNovelsPoolCache: BoundedTtlCache<PoolEntry[]> | null = null;

function getRelatedNovelsPoolCacheInstance(): BoundedTtlCache<PoolEntry[]> {
  if (!relatedNovelsPoolCache) {
    relatedNovelsPoolCache = createBoundedTtlCache<PoolEntry[]>({
      maxEntries: RELATED_NOVELS_POOL_MAX_ENTRIES,
      ttlMs: RELATED_NOVELS_POOL_TTL_SECONDS * 1000,
    });
  }
  return relatedNovelsPoolCache;
}

export function clearRelatedNovelsPoolCacheForTest(): void {
  relatedNovelsPoolCache?.clear();
  relatedNovelsPoolCache = null;
}

export function relatedNovelsPoolCacheSizeForTest(): { entries: number; inflight: number } {
  return getRelatedNovelsPoolCacheInstance().sizeForTest();
}

export async function getRelatedNovelsPoolCached(
  locale: SiteLocale,
  db: PrismaClient | Prisma.TransactionClient,
): Promise<PoolEntry[]> {
  return getRelatedNovelsPoolCacheInstance().getOrLoad(locale, () =>
    fetchRelatedNovelsPoolFresh(locale, RELATED_NOVELS_POOL_SIZE, db),
  );
}

/** 部分 Fisher-Yates：只洗出前 take 个位置，均匀采样，不打乱整个数组。 */
function sampleEntries(pool: PoolEntry[], take: number): PoolEntry[] {
  const count = Math.min(take, pool.length);
  const shuffled = pool.slice();
  for (let i = 0; i < count; i += 1) {
    const j = i + Math.floor(Math.random() * (shuffled.length - i));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

export interface RelatedAndNewReleases {
  related: NovelCardView[];
  newReleases: NovelCardView[];
}

/**
 * "相关推荐"：候选只取同语种、已发布的小说页，排除当前这本；优先选有共同
 * 标签的书，不足时用同语种其它已发布的书补齐；取 6 本。
 *
 * "新书推荐"：同语种已发布小说页按 publishedAt 倒序取 6 本，排除当前这本，
 * 并排除已经出现在"相关推荐"里的书——直接复用同一个候选池（已经是
 * publishedAt desc 序），不需要第二条查询。
 *
 * 候选不足 6 本时正常返回已有的几本，调用方（`NovelDetailScreen` /
 * `ChapterScreen`）已经按"无数据即整块不渲染，候选不足就显示实际数量"的
 * 既有规则处理，这里不做任何补零或占位。
 */
export async function getRelatedAndNewReleaseNovels(
  db: PrismaClient | Prisma.TransactionClient,
  locale: SiteLocale,
  currentArticleId: string,
  currentNovelId: string,
): Promise<RelatedAndNewReleases> {
  const [pool, currentTagsByNovel] = await Promise.all([
    getRelatedNovelsPoolCached(locale, db),
    loadPublicTaxonomyByNovelIds(db, [currentNovelId], locale),
  ]);
  const currentTagIds = new Set((currentTagsByNovel.get(currentNovelId) ?? []).map((tag) => tag.id));

  // 池子本身已按 publishedAt desc 排好序（见 fetchRelatedNovelsPoolFresh），
  // `candidates` 保持这个顺序——"新书推荐"直接依赖它。
  const candidates = pool.filter((entry) => entry.articleId !== currentArticleId);

  const withSharedTag: PoolEntry[] = [];
  const rest: PoolEntry[] = [];
  for (const entry of candidates) {
    const sharesTag = currentTagIds.size > 0 && [...entry.tagIds].some((id) => currentTagIds.has(id));
    (sharesTag ? withSharedTag : rest).push(entry);
  }

  const relatedPicked = sampleEntries(withSharedTag, RELATED_NOVELS_TARGET);
  if (relatedPicked.length < RELATED_NOVELS_TARGET) {
    relatedPicked.push(...sampleEntries(rest, RELATED_NOVELS_TARGET - relatedPicked.length));
  }

  const relatedIds = new Set(relatedPicked.map((entry) => entry.articleId));
  const newReleasesPicked = candidates
    .filter((entry) => !relatedIds.has(entry.articleId))
    .slice(0, NEW_RELEASES_TARGET);

  const toCard = (entry: PoolEntry): NovelCardView | null =>
    toNovelCardView(toPublicArticle(entry.row, entry.tags));

  return {
    related: relatedPicked.map(toCard).filter((card): card is NovelCardView => card !== null),
    newReleases: newReleasesPicked.map(toCard).filter((card): card is NovelCardView => card !== null),
  };
}
