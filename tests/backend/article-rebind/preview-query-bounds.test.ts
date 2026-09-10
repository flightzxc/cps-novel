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
 *      Fixed by turning that read into `groupBy({ by: ["novelId"] })`, which
 *      emits a real SQL `GROUP BY` and so caps the rows POSTGRES ITSELF
 *      returns at the chunk's distinct-novelId count. It is deliberately NOT
 *      `findMany({ distinct: ["novelId"] })`: Prisma's `distinct` is an
 *      in-memory, engine-side filter unless the `nativeDistinct` preview
 *      feature is on (`prisma/schema.prisma` enables no preview features),
 *      and the SQL emitted for this `where` with `distinct` was measured to
 *      be byte-identical to the SQL without it — it would have shrunk only
 *      the engine→JS handoff, not the ~22,400 rows Postgres scans and ships.
 *
 * This file seeds past `SQL_BIND_CHUNK_SIZE` (500) unique candidate pairs to
 * prove chunking actually happens — `REBIND_BATCH_LIMITS.candidate` is 1,600
 * in production, so 501 unique pairs crosses the chunk boundary without
 * tripping that ceiling, and is cheap enough to seed row-by-row (unlike the
 * 20,000/1,600-scale ceilings `preview-ceilings.test.ts` mocks down instead
 * of seeding for real).
 */
import { describe, expect, it, vi } from "vitest";

import { buildRebindBatchPreview, getRebindBatchPage } from "@/server/article-rebind";

import {
  FakeBatchRebindDb,
  seedArticle,
  seedChannel,
  seedNovel,
  seedNovelUnderChannel,
  seedPromoLink,
  seedSourceApp,
} from "./batch-fake-db";

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
type SpiedGroupByDelegate = { groupBy: (...args: unknown[]) => unknown };

describe("buildCandidateFindings 三处 IN(...) 查询分块 (C-30 施工单2复核 §6.3 item 1)", () => {
  it(`chunks the promoLink / occupying-article / sibling-article lookups once candidates exceed SQL_BIND_CHUNK_SIZE (${CANDIDATE_COUNT} unique pairs)`, async () => {
    const fixture = baseFixture();
    seedManyUniquePairs(fixture, CANDIDATE_COUNT);
    const prismaClient = fixture.db.asPrismaClient();
    const promoLinkFindMany = vi.spyOn((prismaClient as unknown as { promoLink: SpiedDelegate }).promoLink, "findMany");
    const articleFindMany = vi.spyOn((prismaClient as unknown as { article: SpiedDelegate }).article, "findMany");
    const articleGroupBy = vi.spyOn((prismaClient as unknown as { article: SpiedGroupByDelegate }).article, "groupBy");

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
    // Guard 9's sibling lookup no longer travels through `findMany` at all —
    // it is a `groupBy` (item 2 below). Assert BOTH halves, so a silent
    // revert to `findMany({ distinct })` fails here rather than passing on
    // the chunk-count assertion alone.
    const siblingFindManyCalls = articleFindMany.mock.calls.filter((call) => {
      const where = (call[0] as { where: Record<string, unknown> }).where;
      return "novelId" in where && where.status === "published" && "deletedAt" in where;
    });
    expect(occupyingCalls).toHaveLength(2);
    expect(siblingFindManyCalls).toHaveLength(0);
    expect(articleGroupBy).toHaveBeenCalledTimes(2);
    for (const call of articleGroupBy.mock.calls) {
      const args = call[0] as { by: string[]; where: { novelId: { in: string[] } } };
      expect(args.by).toEqual(["novelId"]);
      expect(args.where.novelId.in.length).toBeLessThanOrEqual(500);
    }
    for (const call of occupyingCalls) {
      const where = (call[0] as { where: { novelId: { in: string[] } } }).where;
      expect(where.novelId.in.length).toBeLessThanOrEqual(500);
    }
  });
});

describe("守卫 9 兄弟查询用 groupBy 收窄行数 (C-30 施工单2复核 §6.3 item 2)", () => {
  it("issues a real groupBy by ['novelId'] — not an in-memory distinct — and still detects the sibling fact with one source novel published under four other locales", async () => {
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
    // 🔴 The target MUST have a ready PromoLink. Without it guard 7
    // (TARGET_PROMO_LINK_MISSING) blocks this pair on its own, and the
    // guard-9 assertion below would pass for the wrong reason — a broken
    // sibling read would still leave `riskBlockedCount === 1`. Mirrors
    // `preview.test.ts`'s own `seedUniquePair`, which seeds one for exactly
    // this reason.
    seedPromoLink(fixture.db, { id: "promo-multi", novelId: targetNovel.id });

    const prismaClient = fixture.db.asPrismaClient();
    const articleFindMany = vi.spyOn((prismaClient as unknown as { article: SpiedDelegate }).article, "findMany");
    const articleGroupBy = vi.spyOn((prismaClient as unknown as { article: SpiedGroupByDelegate }).article, "groupBy");

    const summary = await buildRebindBatchPreview(
      prismaClient,
      { sourceChannelCode: "changdu", targetChannelCode: "beidou", locale: "en", createdBy: "admin-1" },
      ENABLED_ENV,
    );

    // Read as a `groupBy` (real SQL `GROUP BY`), never as a `findMany` whose
    // `distinct` would be an in-memory no-op at the SQL layer.
    const siblingFindMany = articleFindMany.mock.calls.find((call) => {
      const where = (call[0] as { where: Record<string, unknown> }).where;
      return "novelId" in where && where.status === "published" && "deletedAt" in where;
    });
    expect(siblingFindMany).toBeUndefined();
    expect(articleGroupBy).toHaveBeenCalledTimes(1);
    const groupByArgs = articleGroupBy.mock.calls[0][0] as {
      by: string[];
      where: Record<string, unknown>;
      distinct?: unknown;
    };
    expect(groupByArgs.by).toEqual(["novelId"]);
    expect(groupByArgs.where.status).toBe("published");
    expect(groupByArgs.distinct).toBeUndefined();

    // Guard 9 (CROSS_LOCALE_SIBLINGS) fired — proves the grouping did not
    // lose the fact, it only stopped Postgres from producing the four
    // redundant rows behind it. Assert the FINDING, not just the bucket
    // count: with the target's PromoLink seeded above, guard 9 is the only
    // remaining reason this pair can be risk_blocked, and the finding code
    // is what actually proves the sibling set survived the round trip.
    expect(summary.riskBlockedCount).toBe(1);
    expect(summary.executableCount).toBe(0);
    const page = await getRebindBatchPage(
      prismaClient,
      { previewId: summary.previewId, category: "risk_blocked", createdBy: "admin-1" },
      ENABLED_ENV,
    );
    const finding = page.items[0]!.findings.find((f) => f.code === "CROSS_LOCALE_SIBLINGS");
    expect(finding?.level).toBe("needs_ack");
  });
});
