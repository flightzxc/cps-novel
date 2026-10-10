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
 * B-38 (v0.5.13): membership is no longer computed here. It is MATERIALIZED
 * into `novel_effective_tag` (CPS `drama_effective_tag` equivalent), written
 * only by `src/server/tagging/effective-tag-projection.ts` in the same
 * transaction that changes any source of truth, and this module only READS
 * that table (`loadPublicTaxonomyByNovelIds`) — so a book's card tags, its
 * detail page tags, the category pages that list it and the category-count
 * matrix (`src/lib/site/public-list.ts`) all see one copy of the data. The
 * rules, the `rank` (display order) semantics, the lock discipline and the
 * long explanation of why the rule SQL has the exact shape it has (the
 * 2026-09-20 production incident: a missing-statistics plan that cost 2.7s per
 * request) live in that module's header. The frozen pre-B-38 implementation
 * is `tests/fixtures/public-taxonomy-before-b38.ts`; the real-database case
 * `tests/integration/site/card-taxonomy-from-table-postgres.test.ts` proves
 * this reader returns exactly what it returned (order, name fallback, href).
 *
 * The automatic-tagging flag is NOT written into the table: automatic rows
 * carry `provenance = 'auto'` and are counted only while the flag is on, read
 * time, so flipping the flag takes effect immediately without a rebuild.
 *
 * Label cache: public pages that read this module are `force-dynamic`. The
 * taxonomy query is not wrapped in `unstable_cache`; `loadPublicCategories`
 * sits behind request-scoped `React.cache()`, which expires when the request
 * ends (plus the 60-second category-count matrix cache in `public-list.ts`,
 * which holds counts only — tag NAMES are read fresh on every call).
 * `unstable_cache` is used only for `getActiveLocales` (300s, locale
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

/**
 * 页脚 / 首页题材导航 / 详情页"可链接分类集合"共用的那一份分类列表里的一项（`loadPublicCategoryTags` /
 * `listPublicCategories` 返回）：在卡片标签形状（`PublicTaxonomyTag`）之上多一个只读布尔字段
 * `homepageVisible`——运营在后台"分类管理"勾选的"是否在首页题材导航显示"（`canonical_tag.is_homepage_visible`，
 * v0.5.15，默认 true）。
 *
 * 🔴 只有首页 `HomeBody` 读它（`src/lib/site/home-nav.ts` 的 `selectHomepageNavCategories`）。页脚（`chrome.ts`
 * 的 `categories.slice(0, 8)`）、详情页可链接集合（`public-load.ts` 的 `withLinkableTagHrefs`）、分类页、站点地图
 * 都不读它，所以这一份列表本身的集合与顺序不因勾选而变（字段是搭车读出来的：同一条 SELECT 多读一列，不新增查询）。
 * 卡片标签（`loadPublicTaxonomyByNovelIds`）的形状不动。
 */
export type PublicCategoryTag = PublicTaxonomyTag & Readonly<{
  homepageVisible: boolean;
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
 * The single place a tag row becomes a `PublicTaxonomyTag` (name fallback: requested locale → en → zh → slug,
 * href with the locale prefix) — card tags (`loadPublicTaxonomyByNovelIds`) and the category lists
 * (`loadPublicCategoryTags`) both use it.
 *
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
export function projectPublicTaxonomyTag(row: Omit<PublicTaxonomyRow, "novel_id">, locale: string): PublicTaxonomyTag {
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
 * 一批小说的前台标签，按每本书自己的显示顺序（`novel_effective_tag.rank`）。
 *
 * 读的是物化好的归属表，不再现场计算：规则、排序位语义、"统计信息缺失也不出坏计划"的专门写法（含
 * 2026-09-20 `/ko` 首页 5.1 秒事故的完整现象与两条被证伪的归因）都在
 * `src/server/tagging/effective-tag-projection.ts` 的文件头里，那里是规则 SQL 唯一还在运行的地方。
 * 读取侧只有一条普通的主键范围查询：
 *   - `novel_id IN (…)`：按块（见 `PUBLIC_TAXONOMY_NOVEL_ID_CHUNK_SIZE`）；
 *   - `provenance <> 'auto' OR 自动标签开关`：开关不写进表，读取时按当时的开关决定自动来源的行算不算
 *     （关开关立即生效，不需要重建；排序位把人工 / 映射排在前、自动排在后，去掉自动行后顺序仍然正确）；
 *   - `canonical_tag.status = 'active'`：表里本来就只收启用中的分类，这里再实时连一次（CPS 同款
 *     "刻意的冗余"：公开语义只有"启用"这一个说法，表只是它的物化）；
 *   - `ORDER BY m.novel_id, m.rank`：与改造前逐本相同的标签顺序（冻结参照
 *     `tests/fixtures/public-taxonomy-before-b38.ts`，真实库用例逐项比对）。
 *
 * 签名、分块、输出（含每本书的标签顺序）与改造前完全一致；变的只有返回 Map 里"书"的插入顺序
 * （现在按小说 id），调用方都是按 id 取，不依赖它。
 */
export async function loadPublicTaxonomyByNovelIds(
  db: Db,
  novelIds: readonly string[],
  locale: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReadonlyMap<string, readonly PublicTaxonomyTag[]>> {
  const uniqueIds = [...new Set(novelIds)];
  if (uniqueIds.length === 0) return new Map();

  const grouped = new Map<string, PublicTaxonomyTag[]>();
  for (const idChunk of chunkIds(uniqueIds, PUBLIC_TAXONOMY_NOVEL_ID_CHUNK_SIZE)) {
    for (const row of await queryPublicTaxonomyRows(db, idChunk, locale, env)) {
      const tags = grouped.get(row.novel_id) ?? [];
      tags.push(projectPublicTaxonomyTag(row, locale));
      grouped.set(row.novel_id, tags);
    }
  }
  return grouped;
}

/**
 * 每次查询最多带多少个小说 id。
 *
 * 🔴 不是性能旋钮，是正确性上限：Prisma 单条语句最多 32,767 个绑定变量
 * （`too many bind variables in prepared statement, expected maximum of 32767`）。读归属表之后这里的 id 列表
 * 只出现一次（改造前的现场计算里它要重复出现 2～3 次，上限曾经是约 1.09 万本），但站点地图的分类页要对
 * "一个语种全部公开小说"（预生产英语已过 1.3 万篇）取归属，所以分块这条纪律保持不变——
 * `tests/integration/tasks/sitemap-scale-postgres.test.ts` 的 mainpage 用例守着它。2,000 本一块，离上限有 16 倍余量。
 */
export const PUBLIC_TAXONOMY_NOVEL_ID_CHUNK_SIZE = 2_000;

async function queryPublicTaxonomyRows(
  db: Db,
  uniqueIds: readonly string[],
  locale: string,
  env: NodeJS.ProcessEnv,
): Promise<PublicTaxonomyRow[]> {
  const ids = Prisma.join(uniqueIds.map((id) => Prisma.sql`${id}::uuid`));
  return db.$queryRaw<PublicTaxonomyRow[]>(Prisma.sql`
    SELECT m.novel_id,
           ct.id,
           ct.slug,
           requested.display_name AS requested_display_name,
           en.display_name AS en_display_name,
           zh.display_name AS zh_display_name,
           ct.sort_order,
           ct.updated_at
    FROM novel_effective_tag m
    JOIN canonical_tag ct
      ON ct.id = m.canonical_tag_id AND ct.status = 'active'
    LEFT JOIN canonical_tag_translation requested
      ON requested.canonical_tag_id = ct.id AND requested.locale = ${locale}
    LEFT JOIN canonical_tag_translation en
      ON en.canonical_tag_id = ct.id AND en.locale = 'en'
    LEFT JOIN canonical_tag_translation zh
      ON zh.canonical_tag_id = ct.id AND zh.locale = 'zh'
    WHERE m.novel_id IN (${ids})
      AND (m.provenance <> 'auto' OR ${isAutoTaggingEnabled(env)})
    ORDER BY m.novel_id, m.rank
  `);
}

/**
 * 一批分类（编号）的前台标签形状——页脚、首页题材导航、"可链接分类集合"用。名字取法与卡片标签完全相同
 * （`projectPublicTaxonomyTag`：请求语种 → en → zh → slug，链接带语种前缀），按分类自身排序
 * （`sort_order`，再 slug）。停用的分类不返回。名字每次现读，不进 60 秒矩阵缓存：译名覆盖应用后立即生效。
 */
export async function loadPublicCategoryTags(
  db: Db,
  tagIds: readonly string[],
  locale: string,
): Promise<readonly PublicCategoryTag[]> {
  const uniqueIds = [...new Set(tagIds)];
  if (uniqueIds.length === 0) return [];
  const ids = Prisma.join(uniqueIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await db.$queryRaw<Array<Omit<PublicTaxonomyRow, "novel_id"> & { is_homepage_visible: boolean }>>(Prisma.sql`
    SELECT ct.id,
           ct.slug,
           requested.display_name AS requested_display_name,
           en.display_name AS en_display_name,
           zh.display_name AS zh_display_name,
           ct.sort_order,
           ct.updated_at,
           ct.is_homepage_visible
    FROM canonical_tag ct
    LEFT JOIN canonical_tag_translation requested
      ON requested.canonical_tag_id = ct.id AND requested.locale = ${locale}
    LEFT JOIN canonical_tag_translation en
      ON en.canonical_tag_id = ct.id AND en.locale = 'en'
    LEFT JOIN canonical_tag_translation zh
      ON zh.canonical_tag_id = ct.id AND zh.locale = 'zh'
    WHERE ct.id IN (${ids}) AND ct.status = 'active'
  `);
  return sortPublicTaxonomyTags(rows.map((row): PublicCategoryTag => Object.freeze({
    ...projectPublicTaxonomyTag(row, locale),
    homepageVisible: row.is_homepage_visible,
  })));
}

function sortPublicTaxonomyTags<T extends PublicTaxonomyTag>(tags: readonly T[]): T[] {
  return [...tags].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.slug.localeCompare(right.slug, "en"),
  );
}

export function listDistinctPublicTaxonomy(
  tagsByNovel: ReadonlyMap<string, readonly PublicTaxonomyTag[]>,
): readonly PublicTaxonomyTag[] {
  const distinct = new Map<string, PublicTaxonomyTag>();
  for (const tags of tagsByNovel.values()) {
    for (const tag of tags) distinct.set(tag.id, tag);
  }
  return sortPublicTaxonomyTags([...distinct.values()]);
}
