/**
 * C-30B: `submitRebindBatch`'s own selection cap (`REBIND_BATCH_LIMITS.apply`,
 * 200 in production — 施工工单 §4B.1/§4B.5 "上限拒绝"). Mocked down to a
 * tiny value, same isolation reasoning as `preview-ceilings.test.ts`
 * (200 real rows is impractical to seed in a unit test) — kept in its own
 * file so `batch.test.ts`'s other tests keep running against the REAL
 * `apply: 200` limit.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/article-rebind/batch-constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/article-rebind/batch-constants")>();
  return { ...actual, REBIND_BATCH_LIMITS: { ...actual.REBIND_BATCH_LIMITS, apply: 2 } };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { buildRebindBatchPreview } = await import("@/server/article-rebind/preview");
const { submitRebindBatch } = await import("@/server/article-rebind/batch");
const { RebindBatchDomainError } = await import("@/server/article-rebind/errors");
const { FakeBatchRebindDb, seedArticle, seedChannel, seedNovel, seedNovelUnderChannel, seedPromoLink, seedSourceApp } = await import("./batch-fake-db");

const ENABLED_ENV = { FEATURE_ARTICLE_NOVEL_REBIND: "true", ARTICLE_NOVEL_REBIND_ALLOW_WRITE: "true" } as unknown as NodeJS.ProcessEnv;

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
  const article = seedArticle(fixture.db, { id: `article-${id}`, novelId: sourceNovel.id, locale: "en", status: "published" });
  const targetNovel = seedNovel(fixture.db, { id: `novel-tgt-${id}`, locale: "en", titleNormalized: `t-${id}`, title: `Tgt ${id}` });
  seedNovelUnderChannel(fixture.db, { novelId: targetNovel.id, channelId: fixture.target.id, sourceAppId: fixture.app.id });
  seedPromoLink(fixture.db, { id: `promo-${id}`, novelId: targetNovel.id });
  return article;
}

describe("submitRebindBatch: 上限拒绝 (mocked apply=2)", () => {
  it("selecting 3 executable ids when apply=2 is INVALID_SELECTION, not a partial submit", async () => {
    const fixture = baseFixture();
    const articles = [seedUniquePair(fixture, "1"), seedUniquePair(fixture, "2"), seedUniquePair(fixture, "3")];
    const summary = await buildRebindBatchPreview(
      fixture.db.asPrismaClient(),
      { sourceChannelCode: "changdu", targetChannelCode: "beidou", locale: "en", createdBy: "admin-1" },
      ENABLED_ENV,
    );
    expect(summary.executableCount).toBe(3);

    try {
      await submitRebindBatch(
        fixture.db.asPrismaClient(),
        {
          previewId: summary.previewId,
          selectedArticleIds: articles.map((a) => a.id),
          reason: "r",
          acknowledgeRisks: false,
          requestToken: "550e8400-e29b-41d4-a716-446655440099",
          createdBy: "admin-1",
        },
        ENABLED_ENV,
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RebindBatchDomainError);
      expect((error as InstanceType<typeof RebindBatchDomainError>).code).toBe("INVALID_SELECTION");
    }
    // Nothing was created — a batch id never got as far as `article_novel_rebind_batch`.
    expect(fixture.db.batches).toHaveLength(0);
  });

  it("selecting exactly the cap (2) succeeds", async () => {
    const fixture = baseFixture();
    const articles = [seedUniquePair(fixture, "1"), seedUniquePair(fixture, "2")];
    const summary = await buildRebindBatchPreview(
      fixture.db.asPrismaClient(),
      { sourceChannelCode: "changdu", targetChannelCode: "beidou", locale: "en", createdBy: "admin-1" },
      ENABLED_ENV,
    );
    const result = await submitRebindBatch(
      fixture.db.asPrismaClient(),
      {
        previewId: summary.previewId,
        selectedArticleIds: articles.map((a) => a.id),
        reason: "r",
        acknowledgeRisks: false,
        requestToken: "550e8400-e29b-41d4-a716-446655440098",
        createdBy: "admin-1",
      },
      ENABLED_ENV,
    );
    expect(result.detail.status).toBe("completed");
  });
});
