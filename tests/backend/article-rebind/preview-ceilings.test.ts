/**
 * C-30B: the four scan/candidate ceilings (施工工单 §4B.1's "四道天花板").
 * `REBIND_BATCH_LIMITS.sourceScan`/`destinationScan`/`candidate` are 20 000/
 * 20 000/1 600 in production — far too large to seed row-by-row in a unit
 * test — so this file mocks `./batch-constants` down to tiny values and
 * exercises each ceiling directly, isolated from `preview.test.ts`'s
 * (unmocked, realistic-scale) functional tests.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/article-rebind/batch-constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/article-rebind/batch-constants")>();
  return {
    ...actual,
    REBIND_BATCH_LIMITS: { ...actual.REBIND_BATCH_LIMITS, sourceScan: 2, destinationScan: 2, candidate: 1 },
  };
});

const { buildRebindBatchPreview, RebindBatchDomainError } = await import("@/server/article-rebind");
const { FakeBatchRebindDb, seedArticle, seedChannel, seedNovel, seedNovelUnderChannel, seedPromoLink, seedSourceApp } = await import("./batch-fake-db");

const ENABLED_ENV = { FEATURE_ARTICLE_NOVEL_REBIND: "true" } as unknown as NodeJS.ProcessEnv;

function baseFixture() {
  const db = new FakeBatchRebindDb();
  const source = seedChannel(db, { id: "chan-source", code: "changdu", name: "畅读" });
  const target = seedChannel(db, { id: "chan-target", code: "beidou", name: "北斗" });
  const app = seedSourceApp(db, { id: "app-1", code: "moboreader", name: "Moboreader" });
  return { db, source, target, app };
}

function seedUniquePair(fixture: ReturnType<typeof baseFixture>, id: string) {
  const sourceNovel = seedNovel(fixture.db, { id: `novel-src-${id}`, locale: "en", titleNormalized: `t-${id}`, title: `Src ${id}` });
  seedNovelUnderChannel(fixture.db, { novelId: sourceNovel.id, channelId: fixture.source.id, sourceAppId: fixture.app.id });
  seedArticle(fixture.db, { id: `article-${id}`, novelId: sourceNovel.id, locale: "en", status: "published" });
  const targetNovel = seedNovel(fixture.db, { id: `novel-tgt-${id}`, locale: "en", titleNormalized: `t-${id}`, title: `Tgt ${id}` });
  seedNovelUnderChannel(fixture.db, { novelId: targetNovel.id, channelId: fixture.target.id, sourceAppId: fixture.app.id });
  seedPromoLink(fixture.db, { id: `promo-${id}`, novelId: targetNovel.id });
}

describe("四道天花板 (mocked to sourceScan=2/destinationScan=2/candidate=1)", () => {
  it("SOURCE_SCAN_CEILING_EXCEEDED when the eligible source universe exceeds sourceScan", async () => {
    const fixture = baseFixture();
    seedUniquePair(fixture, "1");
    seedUniquePair(fixture, "2");
    seedUniquePair(fixture, "3"); // 3 source articles > sourceScan(2)
    await expect(
      buildRebindBatchPreview(fixture.db.asPrismaClient(), { sourceChannelCode: "changdu", targetChannelCode: "beidou", locale: "en", createdBy: "admin-1" }, ENABLED_ENV),
    ).rejects.toMatchObject({ code: "SOURCE_SCAN_CEILING_EXCEEDED" });
  });

  it("DESTINATION_SCAN_CEILING_EXCEEDED when the relevant destination universe exceeds destinationScan", async () => {
    const fixture = baseFixture();
    // One source article whose normalized title matches THREE distinct
    // destination novels (all under the target channel) — destinationScan(2) exceeded.
    const sourceNovel = seedNovel(fixture.db, { id: "novel-src-fan", locale: "en", titleNormalized: "fan-out", title: "Src fan" });
    seedNovelUnderChannel(fixture.db, { novelId: sourceNovel.id, channelId: fixture.source.id, sourceAppId: fixture.app.id });
    seedArticle(fixture.db, { id: "article-fan", novelId: sourceNovel.id, locale: "en", status: "published" });
    for (let i = 0; i < 3; i += 1) {
      const targetNovel = seedNovel(fixture.db, { id: `novel-tgt-fan-${i}`, locale: "en", titleNormalized: "fan-out", title: `Tgt fan ${i}` });
      seedNovelUnderChannel(fixture.db, { novelId: targetNovel.id, channelId: fixture.target.id, sourceAppId: fixture.app.id });
    }
    await expect(
      buildRebindBatchPreview(fixture.db.asPrismaClient(), { sourceChannelCode: "changdu", targetChannelCode: "beidou", locale: "en", createdBy: "admin-1" }, ENABLED_ENV),
    ).rejects.toMatchObject({ code: "DESTINATION_SCAN_CEILING_EXCEEDED" });
  });

  it("CANDIDATE_CEILING_EXCEEDED when more unique-matched pairs than `candidate` are found", async () => {
    const fixture = baseFixture();
    seedUniquePair(fixture, "1");
    seedUniquePair(fixture, "2"); // 2 unique matches > candidate(1), each with a DISTINCT title so neither becomes ambiguous.
    await expect(
      buildRebindBatchPreview(fixture.db.asPrismaClient(), { sourceChannelCode: "changdu", targetChannelCode: "beidou", locale: "en", createdBy: "admin-1" }, ENABLED_ENV),
    ).rejects.toMatchObject({ code: "CANDIDATE_CEILING_EXCEEDED" });
  });

  it("facets report previewAllowed:false once a locale's source count exceeds sourceScan, without running the scan itself", async () => {
    const fixture = baseFixture();
    seedUniquePair(fixture, "1");
    seedUniquePair(fixture, "2");
    seedUniquePair(fixture, "3");
    const { buildRebindBatchFacets } = await import("@/server/article-rebind");
    const facets = await buildRebindBatchFacets(fixture.db.asPrismaClient(), { sourceChannelCode: "changdu", targetChannelCode: "beidou", locale: "en" }, ENABLED_ENV);
    expect(facets.previewAllowed).toBe(false);
    expect(facets.selectedLocaleSourceCount).toBe(3);
  });

  it("RebindBatchDomainError carries the exact machine-readable code (sanity on the error class itself)", async () => {
    const fixture = baseFixture();
    seedUniquePair(fixture, "1");
    seedUniquePair(fixture, "2");
    seedUniquePair(fixture, "3");
    try {
      await buildRebindBatchPreview(fixture.db.asPrismaClient(), { sourceChannelCode: "changdu", targetChannelCode: "beidou", locale: "en", createdBy: "admin-1" }, ENABLED_ENV);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RebindBatchDomainError);
      expect((error as InstanceType<typeof RebindBatchDomainError>).code).toBe("SOURCE_SCAN_CEILING_EXCEEDED");
    }
  });
});
