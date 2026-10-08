/**
 * B-38 第二段·规模与性能基准（真实库、接近生产规模的合成数据）。
 *
 * 只在 `B38_BENCH=1` 时运行（默认的运行器 `run-public-list-postgres-verification.sh` 不带它）；
 * 入口是 `scripts/run-public-list-bench-postgres.sh`（一次性 PG16，迁移 + grants + 种子 + 基准）。
 *
 * 数据：`fixtures/scale-seed.ts`（英语约 4 万本、约 1.3 万本列表可见；ru / es / ko / fr 四个小语种；映射边 200 条；
 * 一个"大分类"覆盖约 75% 的英语书；约 30% 的书带自动打标），然后 `reconcileAllEffectiveTags` 算出归属表、`ANALYZE`。
 *
 * 输出：每个被测函数各跑 6 次、取后 5 次的中位数，打印
 *   B38_BENCH name=<名字> median_ms=<毫秒>
 * 对每条原生 SQL 打印 EXPLAIN (FORMAT JSON) 的顶层计划类型
 *   B38_PLAN name=<名字> top=<Node Type> seq_scans=<被顺序扫描的表>
 * 并断言：单语种的列表 / 总数查询在 article 上没有 Seq Scan，读归属表的标签查询在 novel_effective_tag 上没有 Seq Scan。
 * （矩阵查询必须读完全部可见文章，在 article 上顺序扫描是它的正确计划，只打印不断言。）
 */
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getPublicCategoryPage } from "@/lib/site/category-queries";
import {
  clearPublicCategoryCountsCacheForTest,
  getPublicCategoryCounts,
  queryPublicCategoryCounts,
  queryPublicListCount,
  queryPublicListIds,
} from "@/lib/site/public-list";
import { loadPublicTaxonomyByNovelIds } from "@/lib/site/public-taxonomy";
import { BROWSE_PAGE_SIZE, getPublicBrowsePage, listPublicCategories } from "@/lib/site/queries";
import { reconcileAllEffectiveTags } from "@/server/tagging/effective-tag-projection";
import { assertIsolatedDatabase, connectRoles, disconnectRoles, enabled, resetDatabase } from "../tagging/effective-tag-fixtures";
import { analyzeScaleTables, describeScaleData, SCALE_BIG_TAG_SLUG, seedScaleData } from "./fixtures/scale-seed";

const benchEnabled = enabled && process.env.B38_BENCH === "1";
const roles = connectRoles();
const { owner, web, worker } = roles;

const env: NodeJS.ProcessEnv = { NODE_ENV: "test", FEATURE_NOVEL_TAG_AUTO: "true", FEATURE_ARTICLE_SEO_VISIBILITY: "true" };
const RUNS = 6;

async function measure(name: string, run: () => Promise<unknown>): Promise<number> {
  const samples: number[] = [];
  for (let index = 0; index < RUNS; index += 1) {
    const startedAt = performance.now();
    await run();
    samples.push(performance.now() - startedAt);
  }
  const tail = samples.slice(1).sort((a, b) => a - b);
  const median = tail[Math.floor(tail.length / 2)]!;
  console.log(`B38_BENCH name=${name} median_ms=${median.toFixed(2)}`);
  return median;
}

type PlanNode = { "Node Type": string; "Relation Name"?: string; Plans?: PlanNode[] };

function walk(node: PlanNode, visit: (n: PlanNode) => void): void {
  visit(node);
  for (const child of node.Plans ?? []) walk(child, visit);
}

/** 捕获函数发出的原生 SQL（不执行），再对每条做 EXPLAIN (FORMAT JSON)。 */
async function capture(run: (spy: never) => Promise<unknown>): Promise<Prisma.Sql[]> {
  const captured: Prisma.Sql[] = [];
  const spy = { $queryRaw: async (sql: Prisma.Sql) => { captured.push(sql); return []; } };
  await run(spy as never);
  return captured;
}

async function explain(name: string, statements: readonly Prisma.Sql[]): Promise<Array<{ top: string; seqScans: string[] }>> {
  const out: Array<{ top: string; seqScans: string[] }> = [];
  for (const [index, statement] of statements.entries()) {
    const rows = await web.$queryRaw<Array<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>>(Prisma.sql`EXPLAIN (FORMAT JSON) ${statement}`);
    const root = rows[0]!["QUERY PLAN"][0]!.Plan;
    const seqScans: string[] = [];
    walk(root, (node) => { if (node["Node Type"] === "Seq Scan" && node["Relation Name"]) seqScans.push(node["Relation Name"]); });
    console.log(`B38_PLAN name=${name}${statements.length > 1 ? `#${index + 1}` : ""} top=${root["Node Type"]} seq_scans=${seqScans.join(",") || "-"}`);
    out.push({ top: root["Node Type"], seqScans });
  }
  return out;
}

describe.skipIf(!benchEnabled).sequential("B-38 公开列表基准（接近生产规模的合成数据）", () => {
  let smallSlug = "";
  let bigCount = 0;
  let bigLastPage = 1;
  let enTotal = 0;
  let enLastPage = 1;
  let bigTagId = "";
  let smallTagId = "";

  beforeAll(async () => {
    await assertIsolatedDatabase(owner);
    await resetDatabase(owner);
    const seededAt = performance.now();
    const seeded = await seedScaleData(owner);
    console.log(`B38_BENCH name=seed_ms median_ms=${(performance.now() - seededAt).toFixed(0)} mapping_edges=${seeded.mappingEdges}`);
    const projectedAt = performance.now();
    const summary = await reconcileAllEffectiveTags(worker);
    console.log(`B38_BENCH name=reconcile_all_first_build_ms median_ms=${(performance.now() - projectedAt).toFixed(0)} inserted=${summary.inserted}`);
    await analyzeScaleTables(owner);
    console.log(`B38_SCALE ${JSON.stringify(await describeScaleData(owner))}`);

    const counts = await queryPublicCategoryCounts(web, env);
    const en = counts.rows.filter((row) => row.locale === "en");
    enTotal = counts.visibleTotalByLocale.get("en")!;
    enLastPage = Math.ceil(enTotal / BROWSE_PAGE_SIZE);
    const big = en.find((row) => row.slug === SCALE_BIG_TAG_SLUG)!;
    bigCount = big.count;
    bigLastPage = Math.ceil(bigCount / BROWSE_PAGE_SIZE);
    bigTagId = big.canonicalTagId;
    // 小分类：英语里本数最接近 150 的分类。
    const small = [...en].filter((row) => row.slug !== SCALE_BIG_TAG_SLUG).sort((a, b) => Math.abs(a.count - 150) - Math.abs(b.count - 150))[0]!;
    smallSlug = small.slug;
    smallTagId = small.canonicalTagId;
    console.log(`B38_SCALE en_visible=${enTotal} en_categories=${en.length} big_slug=${SCALE_BIG_TAG_SLUG} big_count=${bigCount} (${Math.round((bigCount / enTotal) * 100)}%) small_slug=${smallSlug} small_count=${small.count} locales=${counts.visibleTotalByLocale.size}`);
  }, 900_000);
  afterAll(async () => { await disconnectRoles(roles); });

  it("规模自检：英语可见约 1.3 万本、大分类约 75%、映射边 200 条", async () => {
    expect(enTotal).toBeGreaterThan(12_000);
    expect(enTotal).toBeLessThan(14_000);
    expect(bigCount / enTotal).toBeGreaterThan(0.6);
    expect(bigCount / enTotal).toBeLessThan(0.9);
    const [{ edges }] = await owner.$queryRaw<Array<{ edges: number }>>`SELECT count(*)::int AS edges FROM source_label_mapping`;
    expect(edges).toBe(200);
  });

  it("基准：/browse 英语、大分类、小分类（列表 / 总数的 SQL 与完整函数）", async () => {
    clearPublicCategoryCountsCacheForTest();
    await measure("browse_en_page1", () => getPublicBrowsePage(web, "en", 1, env));
    await measure("browse_en_last_page", () => getPublicBrowsePage(web, "en", enLastPage, env));
    await measure("browse_en_ids_page1", () => queryPublicListIds(web, { locale: "en", limit: 20, offset: 0, env }));
    await measure("browse_en_ids_last_page", () => queryPublicListIds(web, { locale: "en", limit: 20, offset: (enLastPage - 1) * 20, env }));
    await measure("browse_en_count", () => queryPublicListCount(web, { locale: "en", env }));
    await measure("big_category_ids_page1", () => queryPublicListIds(web, { locale: "en", tagId: bigTagId, limit: 20, offset: 0, env }));
    await measure("big_category_ids_last_page", () => queryPublicListIds(web, { locale: "en", tagId: bigTagId, limit: 20, offset: (bigLastPage - 1) * 20, env }));
    await measure("big_category_count", () => queryPublicListCount(web, { locale: "en", tagId: bigTagId, env }));
    await measure("small_category_ids_page1", () => queryPublicListIds(web, { locale: "en", tagId: smallTagId, limit: 20, offset: 0, env }));
    await measure("small_category_count", () => queryPublicListCount(web, { locale: "en", tagId: smallTagId, env }));
    await measure("getPublicCategoryPage_big_page1", () => getPublicCategoryPage(web, "en", SCALE_BIG_TAG_SLUG, 1, env));
    await measure("getPublicCategoryPage_big_last_page", () => getPublicCategoryPage(web, "en", SCALE_BIG_TAG_SLUG, bigLastPage, env));
    await measure("getPublicCategoryPage_small_page1", () => getPublicCategoryPage(web, "en", smallSlug, 1, env));
  }, 600_000);

  it("基准：矩阵、页脚分类、卡片标签", async () => {
    await measure("category_counts_matrix_all_locales", () => queryPublicCategoryCounts(web, env));
    await measure("category_counts_matrix_en_only", () => queryPublicCategoryCounts(web, env, { locales: ["en"] }));
    await measure("listPublicCategories_en_cold", async () => {
      clearPublicCategoryCountsCacheForTest();
      return listPublicCategories(web, "en", env);
    });
    clearPublicCategoryCountsCacheForTest();
    await getPublicCategoryCounts(web, env);
    await measure("listPublicCategories_en_cached_matrix", () => listPublicCategories(web, "en", env));

    const novelIds = (await owner.$queryRaw<Array<{ id: string }>>`
      SELECT n.id FROM novel n WHERE n.locale = 'en' AND n.status = 'published' ORDER BY n.id LIMIT 500`).map((row) => row.id);
    await measure("taxonomy_20_books", () => loadPublicTaxonomyByNovelIds(web, novelIds.slice(0, 20), "en", env));
    await measure("taxonomy_500_books", () => loadPublicTaxonomyByNovelIds(web, novelIds, "en", env));
  }, 600_000);

  it("执行计划：单语种列表 / 总数查询在 article 上没有 Seq Scan；读归属表的标签查询在 novel_effective_tag 上没有 Seq Scan", async () => {
    const bigOffset = (bigLastPage - 1) * 20;
    const plans: Array<[string, Prisma.Sql[]]> = [
      ["browse_en_ids_page1", await capture((db) => queryPublicListIds(db, { locale: "en", limit: 20, offset: 0, env }))],
      ["browse_en_ids_last_page", await capture((db) => queryPublicListIds(db, { locale: "en", limit: 20, offset: (enLastPage - 1) * 20, env }))],
      ["browse_en_count", await capture((db) => queryPublicListCount(db, { locale: "en", env }))],
      ["big_category_ids_page1", await capture((db) => queryPublicListIds(db, { locale: "en", tagId: bigTagId, limit: 20, offset: 0, env }))],
      ["big_category_ids_last_page", await capture((db) => queryPublicListIds(db, { locale: "en", tagId: bigTagId, limit: 20, offset: bigOffset, env }))],
      ["big_category_count", await capture((db) => queryPublicListCount(db, { locale: "en", tagId: bigTagId, env }))],
      ["small_category_ids_page1", await capture((db) => queryPublicListIds(db, { locale: "en", tagId: smallTagId, limit: 20, offset: 0, env }))],
      ["small_category_count", await capture((db) => queryPublicListCount(db, { locale: "en", tagId: smallTagId, env }))],
      ["small_locale_browse_ids_page1", await capture((db) => queryPublicListIds(db, { locale: "ko", limit: 20, offset: 0, env }))],
    ];
    for (const [name, statements] of plans) {
      expect(statements.length, name).toBe(1);
      for (const plan of await explain(name, statements)) {
        expect(plan.seqScans.filter((relation) => relation === "article"), `${name} 不应在 article 上顺序扫描`).toEqual([]);
      }
    }

    const novelIds = (await owner.$queryRaw<Array<{ id: string }>>`
      SELECT n.id FROM novel n WHERE n.locale = 'en' AND n.status = 'published' ORDER BY n.id LIMIT 500`).map((row) => row.id);
    for (const [name, ids] of [["taxonomy_20_books", novelIds.slice(0, 20)], ["taxonomy_500_books", novelIds]] as const) {
      const statements = await capture((db) => loadPublicTaxonomyByNovelIds(db, ids, "en", env));
      for (const plan of await explain(name, statements)) {
        expect(plan.seqScans.filter((relation) => relation === "novel_effective_tag"), `${name} 不应顺序扫描归属表`).toEqual([]);
      }
    }

    // 矩阵（两条）：只打印计划，不断言——它必须读完全部可见文章。
    await explain("category_counts_matrix", await capture((db) => queryPublicCategoryCounts(db, env)));
  }, 300_000);
});
