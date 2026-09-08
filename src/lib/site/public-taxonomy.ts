/**
 * Public CanonicalTag projection.
 *
 * CPS v8.3.6 category pages expose only active taxonomy rows, ordered by the
 * operator-owned sort field. Novel keeps that serving contract, but adapts
 * the membership rule to ADR-P2-06-5: public membership is the union of a
 * manual FULL_SNAPSHOT and live SourceLabelMapping-derived edges. Classifier
 * (`source = 'auto'`) rows are deliberately absent and raw SourceLabel values
 * never cross this module's return boundary.
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

export async function loadPublicTaxonomyByNovelIds(
  db: Db,
  novelIds: readonly string[],
  locale: string,
): Promise<ReadonlyMap<string, readonly PublicTaxonomyTag[]>> {
  const uniqueIds = [...new Set(novelIds)];
  if (uniqueIds.length === 0) return new Map();

  const ids = Prisma.join(uniqueIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await db.$queryRaw<PublicTaxonomyRow[]>(Prisma.sql`
    WITH public_membership AS (
      SELECT nct.novel_id, nct.canonical_tag_id
      FROM novel_canonical_tag nct
      WHERE nct.novel_id IN (${ids})
        AND nct.source = 'manual'
      UNION
      SELECT nsi.novel_id, slm.canonical_tag_id
      FROM novel_source_item nsi
      JOIN channel_app ca ON ca.id = nsi.channel_app_id AND ca.status = 'active'
      JOIN novel_source_item_label nsil
        ON nsil.novel_source_item_id = nsi.id AND nsil.active IS TRUE
      JOIN source_label sl
        ON sl.id = nsil.source_label_id
       AND sl.channel_app_id = nsi.channel_app_id
       AND sl.label_kind = 'series_type'
      JOIN source_label_mapping slm
        ON slm.channel_app_id = nsi.channel_app_id
       AND slm.raw_language_scope COLLATE "C" = nsi.raw_language_scope COLLATE "C"
       AND slm.raw_token COLLATE "C" = sl.external_label_value::text COLLATE "C"
       AND slm.active IS TRUE
      WHERE nsi.novel_id IN (${ids})
        AND nsi.status = 'linked'
        AND nsi.deleted_at IS NULL
        AND nsi.raw_language_scope IS NOT NULL
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
