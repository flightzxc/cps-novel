import { Prisma, type PrismaClient } from "@prisma/client";
import { expect } from "vitest";
import { loadPublicTaxonomyByNovelIds } from "@/lib/site/public-taxonomy";

/** Synthetic load only, called after the runner has verified an isolated DB. */
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
  for (const stats of ["channel-app-missing-stats", "all-analyzed"]) {
    if (stats === "all-analyzed") await owner.$executeRawUnsafe("ANALYZE channel_app");
    const statsRows = await owner.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_stats WHERE schemaname = 'public' AND tablename = 'channel_app'`;
    expect(Number(statsRows[0].count) > 0).toBe(stats === "all-analyzed");
    for (const flag of ["false", "true"]) {
      let query: Prisma.Sql | undefined;
      await loadPublicTaxonomyByNovelIds({ $queryRaw: async (sql: Prisma.Sql) => { query = sql; return []; } } as unknown as PrismaClient, targets.map(row => row.id), "en", { NODE_ENV: "test", FEATURE_NOVEL_TAG_AUTO: flag });
      const plan = await web.$queryRaw<Array<Record<string, string>>>(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS) ${query!}`);
      const text = plan.map(row => row["QUERY PLAN"]).join("\n");
      console.log(`WO7_EXPLAIN stats=${stats} auto=${flag} novels=80000 label_links=1760000 targets=25\n${text}\nWO7_EXPLAIN_END`);
      // Target CTE may not degenerate into millions of per-row source probes.
      const sourceScans = text.split("\n").filter(line => /(?:Index|Seq|Bitmap Heap).* on novel_source_item nsi /.test(line));
      expect(sourceScans.length).toBeGreaterThan(0);
      for (const line of sourceScans) expect(Number(line.match(/loops=(\d+)/)?.[1] ?? "0")).toBeLessThanOrEqual(25);
      expect(text).toContain("CTE target_source_item");
    }
  }
}
