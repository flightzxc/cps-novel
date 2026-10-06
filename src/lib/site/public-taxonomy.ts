/**
 * Public CanonicalTag projection.
 *
 * CPS v8.3.6 category pages expose only active taxonomy rows, ordered by the
 * operator-owned sort field. Novel keeps that serving contract, but adapts
 * the membership rule to ADR-P2-06-5: a manual FULL_SNAPSHOT is authoritative
 * (including an empty snapshot); automatic or missing state derives membership
 * from live SourceLabelMapping edges. With FEATURE_NOVEL_TAG_AUTO enabled,
 * automatic membership also includes the current auto run, with mapped
 * provenance winning duplicates. Raw source labels never cross this boundary.
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
import { chunkIds } from "@/lib/db/chunked-id-lookup";
import { isAutoTaggingEnabled } from "@/lib/flags/feature-flags";
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
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReadonlyMap<string, readonly PublicTaxonomyTag[]>> {
  const uniqueIds = [...new Set(novelIds)];
  if (uniqueIds.length === 0) return new Map();

  // 小说 id 按块查（见 `PUBLIC_TAXONOMY_NOVEL_ID_CHUNK_SIZE`）：不超过一块时只发一条查询，SQL 与行序同改前。
  // 每本书的标签顺序只取决于行自己的排序键（排序权重 / slug / 分数 / 稳定 id），与同批里有哪些别的书无关，
  // 所以分块不改变任何一本书的结果；变的只有返回 Map 里「书」的插入顺序（调用方都是按 id 取，不依赖它）。
  const grouped = new Map<string, PublicTaxonomyTag[]>();
  for (const idChunk of chunkIds(uniqueIds, PUBLIC_TAXONOMY_NOVEL_ID_CHUNK_SIZE)) {
    for (const row of await queryPublicTaxonomyRows(db, idChunk, locale, env)) {
      const tags = grouped.get(row.novel_id) ?? [];
      tags.push(project(row, locale));
      grouped.set(row.novel_id, tags);
    }
  }
  return grouped;
}

/**
 * 每次查询最多带多少个小说 id。
 *
 * 🔴 不是性能旋钮，是正确性上限：下面的原生 SQL 里同一组 id 会**重复出现 2～3 次**
 * （自动标签关闭：`target_source_item` + `public_membership` 两处；开启：再加 `auto_membership` 共三处），
 * 每次出现都各占 N 个绑定变量，而 Prisma 单条语句最多 32,767 个
 * （`too many bind variables in prepared statement, expected maximum of 32767`）。
 * 即：自动标签开启时，一次超过约 10,900 本书就必然失败；关闭时约 16,300 本。
 * 站点地图的分类页要对「一个语种全部公开小说」取归属，2026-10-06 预生产英语文章已过 1.3 万篇，
 * 修掉站点地图整块读取之后，这里就是下一道墙（`tests/integration/tasks/sitemap-scale-postgres.test.ts` 的 mainpage 用例）。
 * 2,000 × 3 次 = 6,000 个绑定变量，离上限还有 5 倍余量。
 */
export const PUBLIC_TAXONOMY_NOVEL_ID_CHUNK_SIZE = 2_000;

async function queryPublicTaxonomyRows(
  db: Db,
  uniqueIds: readonly string[],
  locale: string,
  env: NodeJS.ProcessEnv,
): Promise<PublicTaxonomyRow[]> {
  const ids = Prisma.join(uniqueIds.map((id) => Prisma.sql`${id}::uuid`));
  return db.$queryRaw<PublicTaxonomyRow[]>(isAutoTaggingEnabled(env) ? Prisma.sql`
    WITH target_source_item AS MATERIALIZED (
      SELECT nsi.id, nsi.novel_id, nsi.channel_app_id, nsi.raw_language_scope
      FROM novel_source_item nsi
      WHERE nsi.novel_id IN (${ids})
        AND nsi.status = 'linked'
        AND nsi.deleted_at IS NULL
        AND nsi.raw_language_scope IS NOT NULL
    ),
    base_membership AS MATERIALIZED (
      SELECT nct.novel_id, nct.canonical_tag_id, 0 AS source_rank, NULL::double precision AS score
      FROM novel_canonical_tag nct
      JOIN novel_tag_state nts ON nts.novel_id = nct.novel_id AND nts.mode = 'manual'
      WHERE nct.novel_id IN (${ids})
        AND nct.source = 'manual'
      UNION
      SELECT tsi.novel_id, slm.canonical_tag_id, 0 AS source_rank, NULL::double precision AS score
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
    , auto_membership AS MATERIALIZED (
      SELECT nct.novel_id, nct.canonical_tag_id, 1 AS source_rank, nct.score
      FROM novel_tag_state nts
      JOIN novel_canonical_tag nct
        ON nct.novel_id = nts.novel_id
       AND nct.classification_run_id = nts.current_auto_run_id
       AND nct.source = 'auto'
      WHERE nts.novel_id IN (${ids}) AND nts.mode = 'automatic'
    ), public_membership AS (
      SELECT * FROM base_membership
      UNION ALL
      SELECT automatic.* FROM auto_membership automatic
      WHERE NOT EXISTS (
        SELECT 1 FROM base_membership mapped
        WHERE mapped.novel_id = automatic.novel_id
          AND mapped.canonical_tag_id = automatic.canonical_tag_id
      )
    )
    SELECT membership.novel_id,
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
    ORDER BY membership.source_rank,
             CASE WHEN membership.source_rank = 0 THEN ct.sort_order END,
             CASE WHEN membership.source_rank = 0 THEN ct.slug END,
             CASE WHEN membership.source_rank = 1 THEN membership.score END DESC,
             CASE WHEN membership.source_rank = 1 THEN ct.stable_id END,
             membership.novel_id
  ` : Prisma.sql`
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
