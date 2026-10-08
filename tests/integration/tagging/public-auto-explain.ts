import { Prisma, type PrismaClient } from "@prisma/client";
import { expect } from "vitest";
import { loadPublicTaxonomyByNovelIds } from "@/lib/site/public-taxonomy";
import { reconcileAllEffectiveTags, refreshEffectiveTagsForNovels } from "@/server/tagging/effective-tag-projection";

type PlanNode = { "Node Type": string; "Relation Name"?: string; "Index Name"?: string; "Index Cond"?: string; Plans?: PlanNode[] };

function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

async function explainJson(db: PrismaClient, statement: Prisma.Sql): Promise<PlanNode[]> {
  const rows = await db.$queryRaw<Array<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>>(Prisma.sql`EXPLAIN (FORMAT JSON) ${statement}`);
  return planNodes(rows[0]!["QUERY PLAN"][0]!.Plan);
}

/**
 * Synthetic load only, called after the runner has verified an isolated DB.
 *
 * B-38: card tags are no longer computed on the spot -- `loadPublicTaxonomyByNovelIds` reads the materialised
 * `novel_effective_tag`. What this fixture (80,000 novels, 1.76M label links) guards now:
 *   1. the card-tag read for 25 books is a primary-key range lookup on the projection table (never a table scan);
 *   2. the RULE SQL (which still runs in `refreshEffectiveTagsForNovels`, the write path) keeps the shape the
 *      2026-09-20 production incident forced on it: its `target_source_item` CTE is driven by `novel_id IN (…)`
 *      through an index, with `channel_app` statistics missing AND present -- never a scan over all source items.
 * The first full build of the projection over this fixture also has to finish (the migration does it in production).
 */
export async function verifyPublicAutoPlans(owner: PrismaClient, web: PrismaClient, fixture: { app: string; admin: string; mappedTag: string; textTag: string; templateNovel: string; rawScope: string }) {
  await owner.$executeRawUnsafe("ALTER TABLE channel_app SET (autovacuum_enabled = false)");
  await owner.$executeRawUnsafe(`INSERT INTO novel (id, business_id, title, description, locale, slug, updated_at)
    SELECT md5('wo7-perf-' || i)::uuid, 'wo7-perf-' || i, 'Tagged perf', '', 'en', 'wo7-perf-' || i, now()
    FROM generate_series(1, 80000) i`);
  await owner.$executeRaw(Prisma.sql`INSERT INTO novel_source_item (id, channel_app_id, novel_id, external_book_id, source_language_code, source_locale, raw_language_scope, title, description, status, raw_payload, updated_at)
    SELECT md5(n.id::text || '-source')::uuid, ${fixture.app}::uuid, n.id, n.business_id, 'en', 'en', ${fixture.rawScope}, n.title, '', 'linked', '{}'::jsonb, now()
    FROM novel n WHERE n.slug LIKE 'wo7-perf-%'`);
  await owner.$executeRaw(Prisma.sql`INSERT INTO source_label (id, channel_app_id, label_kind, external_label_value, updated_at)
    SELECT md5('wo7-perf-label-' || i)::uuid, ${fixture.app}::uuid, 'series_type', 'wo7-perf-label-' || i, now() FROM generate_series(1,22) i`);
  await owner.$executeRaw(Prisma.sql`INSERT INTO source_label_mapping (id, channel_app_id, raw_language_scope, raw_token, canonical_tag_id, mapping_version, approved_by, updated_at)
    SELECT gen_random_uuid(), ${fixture.app}::uuid, ${fixture.rawScope}, 'wo7-perf-label-' || i, ${fixture.mappedTag}::uuid, 'fixture', ${fixture.admin}::uuid, now() FROM generate_series(1,22) i`);
  await owner.$executeRawUnsafe(`INSERT INTO novel_source_item_label (id, novel_source_item_id, source_label_id, active)
    SELECT gen_random_uuid(), md5(n.id::text || '-source')::uuid, md5('wo7-perf-label-' || i)::uuid, true
    FROM novel n CROSS JOIN generate_series(1,22) i WHERE n.slug LIKE 'wo7-perf-%'`);
  await owner.$executeRaw(Prisma.sql`INSERT INTO tag_classification_run
    (id, novel_id, method, taxonomy_version, taxonomy_sha256, keyword_lexicon_version, keyword_fingerprint, classifier_config_version, classifier_config_fingerprint, content_sha256, request_id)
    SELECT md5(n.id::text || '-run')::uuid, n.id, r.method, r.taxonomy_version, r.taxonomy_sha256, r.keyword_lexicon_version, r.keyword_fingerprint, r.classifier_config_version, r.classifier_config_fingerprint, r.content_sha256, 'wo7-perf'
    FROM novel n CROSS JOIN (SELECT * FROM tag_classification_run WHERE novel_id = ${fixture.templateNovel}::uuid LIMIT 1) r WHERE n.slug LIKE 'wo7-perf-%'`);
  await owner.$executeRawUnsafe(`INSERT INTO novel_tag_state (novel_id, mode, current_auto_run_id, updated_at)
    SELECT id, 'automatic', md5(id::text || '-run')::uuid, now() FROM novel WHERE slug LIKE 'wo7-perf-%'`);
  await owner.$executeRaw(Prisma.sql`INSERT INTO novel_canonical_tag (id, novel_id, canonical_tag_id, source, score, classification_run_id, updated_at)
    SELECT gen_random_uuid(), id, ${fixture.textTag}::uuid, 'auto', 50, md5(id::text || '-run')::uuid, now() FROM novel WHERE slug LIKE 'wo7-perf-%'`);
  const targets = await owner.novel.findMany({ where: { slug: { startsWith: "wo7-perf-" } }, take: 25, orderBy: { id: "asc" }, select: { id: true } });
  for (const table of ["novel", "novel_source_item", "source_label", "source_label_mapping", "novel_source_item_label", "novel_tag_state", "novel_canonical_tag", "canonical_tag"]) {
    await owner.$executeRawUnsafe(`ANALYZE ${table}`);
  }
  // Materialise the projection for all 80,000 synthetic books (production does this in the migration).
  const startedAt = performance.now();
  const built = await reconcileAllEffectiveTags(web);
  console.log(`WO7_PROJECTION_BUILD novels=80000 inserted=${built.inserted} ms=${Math.round(performance.now() - startedAt)}`);
  expect(built.inserted).toBeGreaterThanOrEqual(80_000);
  await owner.$executeRawUnsafe("ANALYZE novel_effective_tag");

  for (const stats of ["channel-app-missing-stats", "all-analyzed"]) {
    if (stats === "all-analyzed") await owner.$executeRawUnsafe("ANALYZE channel_app");
    const statsRows = await owner.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_stats WHERE schemaname = 'public' AND tablename = 'channel_app'`;
    expect(Number(statsRows[0].count) > 0).toBe(stats === "all-analyzed");

    // 1. Card-tag read (flag on and off): primary-key / index lookup on the projection, no scan over all of it.
    for (const flag of ["false", "true"]) {
      let query: Prisma.Sql | undefined;
      await loadPublicTaxonomyByNovelIds({ $queryRaw: async (sql: Prisma.Sql) => { query = sql; return []; } } as unknown as PrismaClient, targets.map(row => row.id), "en", { NODE_ENV: "test", FEATURE_NOVEL_TAG_AUTO: flag });
      const plan = await web.$queryRaw<Array<Record<string, string>>>(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS) ${query!}`);
      const text = plan.map(row => row["QUERY PLAN"]).join("\n");
      console.log(`WO7_EXPLAIN kind=card-tags stats=${stats} auto=${flag} novels=80000 targets=25\n${text}\nWO7_EXPLAIN_END`);
      const nodes = await explainJson(web, query!);
      const onProjection = nodes.filter(node => node["Relation Name"] === "novel_effective_tag");
      expect(onProjection.length).toBeGreaterThan(0);
      for (const node of onProjection) expect(node["Node Type"], "projection must be reached through an index").not.toBe("Seq Scan");
    }

    // 2. The rule SQL for 25 targets (write path): capture the apply statement through a recording transaction client.
    const recorded: Prisma.Sql[] = [];
    const recordingTx = { $queryRaw: async (sql: Prisma.Sql) => { recorded.push(sql); return recorded.length >= 3 ? [{ inserted: 0, updated: 0, deleted: 0 }] : []; } };
    await refreshEffectiveTagsForNovels(recordingTx as never, targets.map(row => row.id));
    const apply = recorded.find(sql => sql.sql.includes("INSERT INTO novel_effective_tag"));
    expect(apply, "the per-novel recompute statement").toBeTruthy();
    const nodes = await explainJson(web, apply!);
    console.log(`WO7_EXPLAIN kind=rule-sql stats=${stats} nodes=${nodes.map(node => `${node["Node Type"]}${node["Relation Name"] ? `(${node["Relation Name"]})` : ""}`).join(">")}`);
    // Source items are reached by novel_id through an index (the CTE named target_source_item), never by scanning all of them.
    const sourceScans = nodes.filter(node => node["Relation Name"] === "novel_source_item");
    expect(sourceScans.length).toBeGreaterThan(0);
    for (const node of sourceScans) {
      expect(node["Node Type"], "novel_source_item must not be sequentially scanned for 25 targets").not.toBe("Seq Scan");
    }
  }
}
