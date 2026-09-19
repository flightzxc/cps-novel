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
 */
import { Prisma, type PrismaClient } from "@prisma/client";

import type { SiteTag } from "@/features/public-ui/types";
import { localePrefix } from "@/lib/slug/article-path";

import { asSiteLocale } from "./locale-label";

type Db = PrismaClient | Prisma.TransactionClient;

export type PublicTaxonomyTag = SiteTag & Readonly<{
  id: string;
  description: string;
  sortOrder: number;
  updatedAt: Date;
}>;

type PublicTaxonomyRow = {
  novel_id: string;
  id: string;
  slug: string;
  display_name: string;
  canonical_definition: string;
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
    label: row.display_name,
    href: `${prefix}/category/${row.slug}`,
    description: row.canonical_definition,
    sortOrder: row.sort_order,
    updatedAt: row.updated_at,
  });
}

/**
 * 🔴 `target_source_item` 这个 CTE 必须保留，而且必须带 `AS MATERIALIZED`。
 *
 * 它不是为了可读性拆出来的——它是这条查询唯一能跑得动的形状。
 *
 * 2026-09-20 实测（PG16，真实库）：把 `novel_id IN (...)` 直接写在下面那个
 * UNION 分支的 WHERE 里时，规划器估出 `rows=9`，**实际 1,786,842 行**，然后对
 * `novel_source_item` 做了 178 万次索引探测（每次返回 0 行）。单条查询
 * **2,696ms**，六个语种都一样。`/ko` 首页因此每次加载 5.1 秒，并发刷新时还会
 * 撞上 `web_app` 角色的 `statement_timeout=30s` 直接 500。
 *
 * 根因是下面这两行 join 谓词：
 *   slm.raw_language_scope COLLATE "C" = <nsi>.raw_language_scope COLLATE "C"
 *   slm.raw_token          COLLATE "C" = sl.external_label_value::text COLLATE "C"
 * 两侧都套了 `COLLATE` / `::text`，表达式失去可用的统计信息与索引路径，规划器
 * 对这条链的选择性估计整体塌掉，于是把**最具选择性**的 `novel_id IN (25 个)`
 * 排到了最后才过滤——先展开 `source_label_mapping × novel_source_item_label`
 * 的笛卡尔式扇出，再回头一行行丢弃。
 *
 * 先物化目标行就把这个顺序钉死了：扇出被限制在这几十行之内。
 * 实测 2,696ms → **15ms**（175×），六个语种结果集逐行完全一致（已 diff 比对）。
 *
 * 不要为了"少一层 CTE"把它内联回去；也不要去掉 `MATERIALIZED`——PG12 起 CTE
 * 默认可被内联，去掉这个关键字等于把上面那个坏计划放回来。
 * 真正的治本是消掉那两行 COLLATE/cast（需要改列的排序规则或加表达式索引），
 * 那属于 `prisma/` 与 `infra/` 的范围，不在本文件能做的事情里。
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
           COALESCE(requested.display_name, zh.display_name, ct.slug) AS display_name,
           ct.canonical_definition,
           ct.sort_order,
           ct.updated_at
    FROM public_membership membership
    JOIN canonical_tag ct
      ON ct.id = membership.canonical_tag_id AND ct.status = 'active'
    LEFT JOIN canonical_tag_translation requested
      ON requested.canonical_tag_id = ct.id AND requested.locale = ${locale}
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
