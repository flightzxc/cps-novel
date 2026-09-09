/**
 * C-30B (`复核_C30施工单2_批量换小说_2026-09-09.md` §6.3 "两处查询规模值得看住"
 * — two P3 follow-ups from the施工单2 review, both inside
 * `buildCandidateFindings` (`../../../src/server/article-rebind/preview.ts`):
 *
 *   1. Its three bulk `novelId: { in: [...] } }` queries (promoLink lookup /
 *      occupying-article lookup / sibling-article lookup) were the only
 *      unchunked `in` lookups in the file — `loadTheaterEvidence` and
 *      `loadRelevantDestinations` already route every `{ in: [...] } }`
 *      through the file's own `chunked()` helper
 *      (`SQL_BIND_CHUNK_SIZE = 500`), but these three did not, even though
 *      `targetNovelIds`/`sourceNovelIds` can reach 1,600 distinct ids at
 *      `REBIND_BATCH_LIMITS.candidate`. Fixed by routing all three through
 *      the same `chunked()` helper (repo convention, C-15): no new
 *      truncation/rejection behavior needed, since chunking only changes
 *      how many round trips fetch the SAME rows.
 *   2. Guard 9's sibling-article query could return up to
 *      `sourceNovelIds.length × (site locale count − 1)` rows — ≈22,400 at
 *      the 1,600-candidate ceiling — even though only the DISTINCT
 *      `novelId` set is ever consulted afterward (`siblingNovelIds.has`).
 *      Fixed with `distinct: ["novelId"]`, which structurally caps this
 *      query's own row count at `sourceNovelIds.length` (≤ 1,600) — no
 *      separate ceiling/truncation branch is reachable, because "rows ≤
 *      distinct input ids" is a property of `distinct`, not a runtime check.
 *
 * This file seeds past `SQL_BIND_CHUNK_SIZE` (500) unique candidate pairs to
 * prove chunking actually happens — `REBIND_BATCH_LIMITS.candidate` is 1,600
 * in production, so 501 unique pairs crosses the chunk boundary without
 * tripping that ceiling, and is cheap enough to seed row-by-row (unlike the
 * 20,000/1,600-scale ceilings `preview-ceilings.test.ts` mocks down instead
 * of seeding for real).
 */
import { describe, expect, it, vi } from "vitest";

import { buildRebindBatchPreview } from "@/server/article-rebind";

import { FakeBatchRebindDb, seedArticle, seedChannel, seedNovel, seedNovelUnderChannel, seedSourceApp } from "./batch-fake-db";

const ENABLED_ENV = { FEATURE_ARTICLE_NOVEL_REBIND: "true" } as unknown as NodeJS.ProcessEnv;

/** > SQL_BIND_CHUNK_SIZE (500), < REBIND_BATCH_LIMITS.candidate (1,600) — forces exactly two chunks without tripping CANDIDATE_CEILING_EXCEEDED. */
const CANDIDATE_COUNT = 501;

function baseFixture() {
  const db = new FakeBatchRebindDb();
  const source = seedChannel(db, { id: "chan-source", code: "changdu", name: "畅读" });
  const target = seedChannel(db, { id: "chan-target", code: "beidou", name: "北斗" });
  const app = seedSourceApp(db, { id: "app-1", code: "moboreader", name: "Moboreader" });
  return { db, source, target, app };
}

function seedManyUniquePairs(fixture: ReturnType<typeof baseFixture>, count: number) {
  for (let i = 0; i < count; i += 1) {
    const id = String(i).padStart(4, "0");
    const titleNormalized = `bulk-title-${id}`;
    const sourceNovel = seedNovel(fixture.db, { id: `novel-src-${id}`, locale: "en", titleNormalized, title: `Src ${id}` });
    seedNovelUnderChannel(fixture.db, { novelId: sourceNovel.id, channelId: fixture.source.id, sourceAppId: fixture.app.id });
    seedArticle(fixture.db, { id: `article-${id}`, novelId: sourceNovel.id, locale: "en", status: "published" });
    const targetNovel = seedNovel(fixture.db, { id: `novel-tgt-${id}`, locale: "en", titleNormalized, title: `Tgt ${id}` });
    seedNovelUnderChannel(fixture.db, { novelId: targetNovel.id, channelId: fixture.target.id, sourceAppId: fixture.app.id });
  }
}

type SpiedDelegate = { findMany: (...args: unknown[]) => unknown };

describe("buildCandidateFindings 三处 IN(...) 查询分块 (C-30 施工单2复核 §6.3 item 1)", () => {
  it(`chunks the promoLink / occupying-article / sibling-article lookups once candidates exceed SQL_BIND_CHUNK_SIZE (${CANDIDATE_COUNT} unique pairs)`, async () => {
    const fixture = baseFixture();
    seedManyUniquePairs(fixture, CANDIDATE_COUNT);
    const prismaClient = fixture.db.asPrismaClient();
    const promoLinkFindMany = vi.spyOn((prismaClient as unknown as { promoLink: SpiedDelegate }).promoLink, "findMany");
    const articleFindMany = vi.spyOn((prismaClient as unknown as { article: SpiedDelegate }).article, "findMany");

    await buildRebindBatchPreview(
      prismaClient,
      { sourceChannelCode: "changdu", targetChannelCode: "beidou", locale: "en", createdBy: "admin-1" },
      ENABLED_ENV,
    );

    // promoLink.findMany has exactly one call site in the whole module (the
    // guard-7 bulk lookup in `buildCandidateFindings`) — TWO calls here
    // means 501 ids chunked into ⌈501/500⌉, not one unbounded `in` list.
    expect(promoLinkFindMany).toHaveBeenCalledTimes(2);
    for (const call of promoLinkFindMany.mock.calls) {
      const where = (call[0] as { where: { novelId: { in: string[] } } }).where;
      expect(where.novelId.in.length).toBeLessThanOrEqual(500);
    }

    // article.findMany is shared by loadSourceUniverse (1 call, unchunked —
    // it has its own count-then-take ceiling, a different mechanism this
    // fix does not touch) plus the two newly-chunked bulk lookups this fix
    // adds (guard 8's occupying-article query, guard 9's sibling-article
    // query). Isolate each shape by its distinguishing where-clause keys.
    const occupyingCalls = articleFindMany.mock.calls.filter((call) => {
      const where = (call[0] as { where: Record<string, unknown> }).where;
      return "novelId" in where && where.locale === "en" && !("status" in where);
    });
    const siblingCalls = articleFindMany.mock.calls.filter((call) => {
      const where = (call[0] as { where: Record<string, unknown> }).where;
      return "novelId" in where && where.status === "published" && "deletedAt" in where;
    });
    expect(occupyingCalls).toHaveLength(2);
    expect(siblingCalls).toHaveLength(2);
    for (const call of [...occupyingCalls, ...siblingCalls]) {
      const where = (call[0] as { where: { novelId: { in: string[] } } }).where;
      expect(where.novelId.in.length).toBeLessThanOrEqual(500);
    }
  });
});

describe("守卫 9 兄弟查询用 distinct 收窄行数 (C-30 施工单2复核 §6.3 item 2)", () => {
  it("issues distinct: ['novelId'] and still detects the sibling fact with one source novel published under four other locales", async () => {
    const fixture = baseFixture();
    const sourceNovel = seedNovel(fixture.db, { id: "novel-src-multi", locale: "en", titleNormalized: "multi-sibling", title: "Src multi" });
    seedNovelUnderChannel(fixture.db, { novelId: sourceNovel.id, channelId: fixture.source.id, sourceAppId: fixture.app.id });
    seedArticle(fixture.db, { id: "article-multi-en", novelId: sourceNovel.id, locale: "en", status: "published" });
    // Same source novel published under FOUR other locales — the exact
    // shape that used to fan out into one row per sibling locale
    // (≈22,400 rows worst case at the 1,600-candidate ceiling).
    for (const locale of ["ja", "ko", "fr", "de"]) {
      seedArticle(fixture.db, { id: `article-multi-${locale}`, novelId: sourceNovel.id, locale, status: "published" });
    }
    const targetNovel = seedNovel(fixture.db, { id: "novel-tgt-multi", locale: "en", titleNormalized: "multi-sibling", title: "Tgt multi" });
    seedNovelUnderChannel(fixture.db, { novelId: targetNovel.id, channelId: fixture.target.id, sourceAppId: fixture.app.id });

    const prismaClient = fixture.db.asPrismaClient();
    const articleFindMany = vi.spyOn((prismaClient as unknown as { article: SpiedDelegate }).article, "findMany");

    const summary = await buildRebindBatchPreview(
      prismaClient,
      { sourceChannelCode: "changdu", targetChannelCode: "beidou", locale: "en", createdBy: "admin-1" },
      ENABLED_ENV,
    );

    const siblingCall = articleFindMany.mock.calls.find((call) => {
      const where = (call[0] as { where: Record<string, unknown> }).where;
      return "novelId" in where && where.status === "published" && "deletedAt" in where;
    });
    expect(siblingCall).toBeDefined();
    expect((siblingCall![0] as { distinct?: string[] }).distinct).toEqual(["novelId"]);

    // Guard 9 (CROSS_LOCALE_SIBLINGS) fired — proves the dedup did not lose
    // the fact, it only stopped over-fetching the four redundant rows
    // behind it.
    expect(summary.riskBlockedCount).toBe(1);
    expect(summary.executableCount).toBe(0);
  });
});
