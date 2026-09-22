/**
 * Public CanonicalTag projection.
 *
 * CPS v8.3.6 category pages expose only active taxonomy rows, ordered by the
 * operator-owned sort field. Novel keeps that serving contract, but adapts
 * the membership rule to ADR-P2-06-5: a manual FULL_SNAPSHOT is authoritative
 * (including an empty snapshot); automatic or missing state derives membership
 * from live SourceLabelMapping edges. Classifier (`source = 'auto'`) rows are
 * deliberately absent and raw SourceLabel values never cross this module's
 * return boundary.
 *
 * Label cache: public pages that read this module are `force-dynamic`. The
 * taxonomy query is not wrapped in `unstable_cache`; `loadPublicCategories`
 * sits behind request-scoped `React.cache()`, which expires when the request
 * ends. `unstable_cache` is used only for `getActiveLocales` (300s, locale
 * switcher membership — not tag labels). Applying a CanonicalTag translation
 * overlay is visible on the next request without restart and without waiting
 * 300s. `canonical_definition` is Chinese classifier copy and is not
 * projected onto the public tag.
 */
import { Prisma, type PrismaClient } from "@prisma/client";

import type { SiteTag } from "@/features/public-ui/types";
import { localePrefix } from "@/lib/slug/article-path";

import { resolveCanonicalTagLabel } from "./canonical-tag-label";
import { asSiteLocale } from "./locale-label";

type Db = PrismaClient | Prisma.TransactionClient;

export type PublicTaxonomyTag = SiteTag & Readonly<{
  id: string;
  sortOrder: number;
  updatedAt: Date;
}>;

type PublicTaxonomyRow = {
  novel_id: string;
  id: string;
  slug: string;
  requested_display_name: string | null;
  en_display_name: string | null;
  zh_display_name: string | null;
  sort_order: number;
  updated_at: Date;
};

/**
 * WO-2 §8.1: `href` is now locale-prefixed via `localePrefix`, the site's
 * sole prefix-building rule (`src/lib/slug/article-path.ts`), keyed off the
 * caller's own `locale` argument (this function's caller,
 * `loadPublicTaxonomyByNovelIds`, already received it — see that function's
 * doc comment). `locale` arrives here as a plain `string` (it doubles as a
 * raw SQL filter value in that caller, so its exported signature stays
 * loose); `asSiteLocale` validates it defensively the same way
 * `src/lib/site/mappers.ts` already does for content-locale values, and
 * falls back to no prefix (bare path) rather than throwing if it is ever
 * something else — a taxonomy link degrading to the default-locale path is
 * a far safer failure than a served page ever throwing.
 */
function project(row: PublicTaxonomyRow, locale: string): PublicTaxonomyTag {
  const siteLocale = asSiteLocale(locale);
  const prefix = siteLocale ? localePrefix(siteLocale) : "";
  return Object.freeze({
    id: row.id,
    slug: row.slug,
    label: resolveCanonicalTagLabel({
      requested: row.requested_display_name,
      en: row.en_display_name,
      zh: row.zh_display_name,
      slug: row.slug,
    }),
    href: `${prefix}/category/${row.slug}`,
    sortOrder: row.sort_order,
    updatedAt: row.updated_at,
  });
}

/**
 * 🔴 `target_source_item` 这个 CTE 必须保留，而且必须带 `AS MATERIALIZED`。
 *
 * 它不是为了可读性拆出来的——它是这条查询在**统计信息缺失时**唯一能跑得动的形状。
 *
 * --- 现象 ---------------------------------------------------------------
 * 2026-09-20，真实库（PG16）。把 `novel_id IN (...)` 直接写在下面那个 UNION
 * 分支的 WHERE 里时：规划器估 `rows=9`，**实际 1,786,842 行**，对
 * `novel_source_item` 做了 178 万次索引探测（每次返回 0 行），单条查询
 * **2,696ms**。`/ko` 首页每次加载 5.1 秒，并发刷新还会撞上 `web_app` 角色的
 * `statement_timeout=30s` 直接 500。
 *
 * --- 真因：`channel_app` 一张 1 行的表没有列统计 ------------------------
 * `pg_stats` 里 `channel_app` **零条目**，`last_analyze` / `last_autoanalyze`
 * 都是 NULL——这张写一次就不再变的注册表，行数太少，永远够不到 autovacuum 的
 * analyze 阈值（`50 + 0.1 × reltuples`），于是从建库起就没被分析过。
 *
 * 没有列统计，规划器对 `ca.status = 'active'` 只能套**默认等值选择率 0.005**：
 *
 *   带 ca.status 过滤：  slm ⋈ channel_app  估计 rows=1   实际 196
 *   去掉该过滤：         slm ⋈ channel_app  估计 rows=196 实际 196  ✅
 *
 * 于是整条 `slm ⋈ ca ⋈ sl` 分支被估成 1 行（实际 196），展开它看起来近乎免费，
 * 规划器就先做 `source_label_mapping × novel_source_item_label` 的扇出
 * （196 × 9117 = 1,786,842），把**最具选择性**的 `novel_id IN (25 个)` 排到最后
 * 才用。只补一句 `ANALYZE channel_app`，原查询一字不改就从 2,696ms → **0.68ms**。
 *
 * --- 两条被实验证伪的归因，不要再走一遍 ---------------------------------
 * 1. ❌「根因是下面两行 join 谓词的 `COLLATE "C"` / `::text` 让索引失效」。
 *    在可回滚事务里把 `novel_source_item.raw_language_scope` 与
 *    `source_label.external_label_value` 都改成 `COLLATE "C"`、并去掉查询里所有
 *    COLLATE/cast，重跑：**仍是 rows=9 / 1,786,842 / 2,630ms**，几乎没变。
 *    单独测那两表的 join，带不带 COLLATE 估计都是准的（估 176 / 实际 196）。
 *    这两行 COLLATE 不是冗余写法——`slm` 的两列本身就是 `text COLLATE "C"`，
 *    而对侧是默认排序规则，不显式指定会直接报「无法确定排序规则」。**别删。**
 * 2. ❌「提高统计目标 / 加扩展统计能解决」。把相关列 `SET STATISTICS 2000`、
 *    再加 `CREATE STATISTICS (ndistinct, dependencies)` 后重跑：**2,755ms**。
 *    扩展统计不跨表，而这里错的恰恰是跨表相关性。
 * 所需索引也一直都在（`novel_source_item_label (novel_source_item_id, active)`
 * 等），不缺索引。
 *
 * --- 为什么补了 ANALYZE 之后仍然保留这个 CTE ----------------------------
 *                     统计缺失      统计齐全
 *   原形状            2,696 ms      0.66 ms
 *   本形状（本文件）      15 ms      1.06 ms
 *
 * 统计齐全时本形状贵约 0.4ms，统计缺失时快 175 倍。统计信息是**环境属性**，
 * 不是代码属性：新建库、恢复备份、统计计数器被重置、小表长期够不到 autovacuum
 * 阈值——每一种都会让它重新消失，而代价是首页 2.7 秒。用 0.4ms 给最坏情况封顶
 * 是划算的。运维侧的对应动作见
 * `docs/governance/ENVIRONMENT_PROVISIONING_CHECKLIST.md` 的「统计信息」一节。
 *
 * 不要为了「少一层 CTE」把它内联回去；也不要去掉 `MATERIALIZED`——PG12 起 CTE
 * 默认可被内联，去掉这个关键字等于把上面那个坏计划放回来。
 */
export async function loadPublicTaxonomyByNovelIds(
  db: Db,
  novelIds: readonly string[],
  locale: string,
): Promise<ReadonlyMap<string, readonly PublicTaxonomyTag[]>> {
  const uniqueIds = [...new Set(novelIds)];
  if (uniqueIds.length === 0) return new Map();

  const ids = Prisma.join(uniqueIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await db.$queryRaw<PublicTaxonomyRow[]>(Prisma.sql`
    WITH target_source_item AS MATERIALIZED (
      SELECT nsi.id, nsi.novel_id, nsi.channel_app_id, nsi.raw_language_scope
      FROM novel_source_item nsi
      WHERE nsi.novel_id IN (${ids})
        AND nsi.status = 'linked'
        AND nsi.deleted_at IS NULL
        AND nsi.raw_language_scope IS NOT NULL
    ),
    public_membership AS (
      SELECT nct.novel_id, nct.canonical_tag_id
      FROM novel_canonical_tag nct
      JOIN novel_tag_state nts ON nts.novel_id = nct.novel_id AND nts.mode = 'manual'
      WHERE nct.novel_id IN (${ids})
        AND nct.source = 'manual'
      UNION
      SELECT tsi.novel_id, slm.canonical_tag_id
      FROM target_source_item tsi
      JOIN channel_app ca ON ca.id = tsi.channel_app_id AND ca.status = 'active'
      JOIN novel_source_item_label nsil
        ON nsil.novel_source_item_id = tsi.id AND nsil.active IS TRUE
      JOIN source_label sl
        ON sl.id = nsil.source_label_id
       AND sl.channel_app_id = tsi.channel_app_id
       AND sl.label_kind = 'series_type'
      JOIN source_label_mapping slm
        ON slm.channel_app_id = tsi.channel_app_id
       AND slm.raw_language_scope COLLATE "C" = tsi.raw_language_scope COLLATE "C"
       AND slm.raw_token COLLATE "C" = sl.external_label_value::text COLLATE "C"
       AND slm.active IS TRUE
      WHERE NOT EXISTS (
          SELECT 1 FROM novel_tag_state nts
          WHERE nts.novel_id = tsi.novel_id AND nts.mode = 'manual'
        )
    )
    SELECT DISTINCT membership.novel_id,
           ct.id,
           ct.slug,
           requested.display_name AS requested_display_name,
           en.display_name AS en_display_name,
           zh.display_name AS zh_display_name,
           ct.sort_order,
           ct.updated_at
    FROM public_membership membership
    JOIN canonical_tag ct
      ON ct.id = membership.canonical_tag_id AND ct.status = 'active'
    LEFT JOIN canonical_tag_translation requested
      ON requested.canonical_tag_id = ct.id AND requested.locale = ${locale}
    LEFT JOIN canonical_tag_translation en
      ON en.canonical_tag_id = ct.id AND en.locale = 'en'
    LEFT JOIN canonical_tag_translation zh
      ON zh.canonical_tag_id = ct.id AND zh.locale = 'zh'
    ORDER BY ct.sort_order, ct.slug, membership.novel_id
  `);

  const grouped = new Map<string, PublicTaxonomyTag[]>();
  for (const row of rows) {
    const tags = grouped.get(row.novel_id) ?? [];
    tags.push(project(row, locale));
    grouped.set(row.novel_id, tags);
  }
  return grouped;
}

export function listDistinctPublicTaxonomy(
  tagsByNovel: ReadonlyMap<string, readonly PublicTaxonomyTag[]>,
): readonly PublicTaxonomyTag[] {
  const distinct = new Map<string, PublicTaxonomyTag>();
  for (const tags of tagsByNovel.values()) {
    for (const tag of tags) distinct.set(tag.id, tag);
  }
  return [...distinct.values()].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.slug.localeCompare(right.slug, "en"),
  );
}
