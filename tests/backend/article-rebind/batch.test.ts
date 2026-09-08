import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  RebindBatchDomainError,
  RebindFeatureDisabledError,
  RebindWriteDisabledError,
  acquireRebindBatchLease,
  buildRebindBatchPreview,
  getRebindBatchByRequestToken,
  getRebindBatchDetail,
  resumeRebindBatch,
  submitRebindBatch,
} from "@/server/article-rebind";

import { FakeBatchRebindDb, seedArticle, seedChannel, seedNovel, seedNovelUnderChannel, seedPromoLink, seedSourceApp } from "./batch-fake-db";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const ENABLED_ENV = { FEATURE_ARTICLE_NOVEL_REBIND: "true", ARTICLE_NOVEL_REBIND_ALLOW_WRITE: "true" } as unknown as NodeJS.ProcessEnv;
const PREVIEW_ONLY_ENV = { FEATURE_ARTICLE_NOVEL_REBIND: "true", ARTICLE_NOVEL_REBIND_ALLOW_WRITE: "false" } as unknown as NodeJS.ProcessEnv;
const DISABLED_ENV = {} as unknown as NodeJS.ProcessEnv;
const TOKEN_A = "550e8400-e29b-41d4-a716-446655440000";
const TOKEN_B = "550e8400-e29b-41d4-a716-446655440001";

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
  const promo = seedPromoLink(fixture.db, { id: `promo-${id}`, novelId: targetNovel.id });
  return { sourceNovel, article, targetNovel, promo };
}

async function seedPreview(fixture: ReturnType<typeof baseFixture>, ids: string[]) {
  const pairs = ids.map((id) => seedUniquePair(fixture, id));
  const summary = await buildRebindBatchPreview(fixture.db.asPrismaClient(), { sourceChannelCode: "changdu", targetChannelCode: "beidou", locale: "en", createdBy: "admin-1" }, ENABLED_ENV);
  return { pairs, summary };
}

describe("submitRebindBatch: idempotency", () => {
  it("same requestToken + same payload replays the existing batch, no second write", async () => {
    const fixture = baseFixture();
    const { pairs, summary } = await seedPreview(fixture, ["1"]);
    const input = { previewId: summary.previewId, selectedArticleIds: [pairs[0]!.article.id], reason: "渠道故障切换", acknowledgeRisks: false, requestToken: TOKEN_A, createdBy: "admin-1" };

    const first = await submitRebindBatch(fixture.db.asPrismaClient(), input, ENABLED_ENV);
    expect(first.created).toBe(true);
    expect(first.detail.status).toBe("completed");
    const batchCountAfterFirst = fixture.db.batches.length;
    const itemCountAfterFirst = fixture.db.batchItems.length;

    const second = await submitRebindBatch(fixture.db.asPrismaClient(), input, ENABLED_ENV);
    expect(second.created).toBe(false);
    expect(second.detail.batchId).toBe(first.detail.batchId);
    expect(fixture.db.batches.length).toBe(batchCountAfterFirst);
    expect(fixture.db.batchItems.length).toBe(itemCountAfterFirst);
    // No second write: the article's novelId did not change again (same audit count).
    expect(fixture.db.audits.length).toBe(1);
  });

  it("same requestToken + DIFFERENT payload is a hard error, not a silent overwrite", async () => {
    const fixture = baseFixture();
    const { pairs, summary } = await seedPreview(fixture, ["1"]);
    const firstInput = { previewId: summary.previewId, selectedArticleIds: [pairs[0]!.article.id], reason: "reason A", acknowledgeRisks: false, requestToken: TOKEN_A, createdBy: "admin-1" };
    await submitRebindBatch(fixture.db.asPrismaClient(), firstInput, ENABLED_ENV);

    const conflicting = { ...firstInput, reason: "reason B (different)" };
    await expect(submitRebindBatch(fixture.db.asPrismaClient(), conflicting, ENABLED_ENV)).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
    });
  });

  it("a failed/timed-out submit's requestToken can be looked up afterward instead of resubmitting", async () => {
    const fixture = baseFixture();
    const { pairs, summary } = await seedPreview(fixture, ["1"]);
    const input = { previewId: summary.previewId, selectedArticleIds: [pairs[0]!.article.id], reason: "reason", acknowledgeRisks: false, requestToken: TOKEN_A, createdBy: "admin-1" };
    const submitted = await submitRebindBatch(fixture.db.asPrismaClient(), input, ENABLED_ENV);

    const lookedUp = await getRebindBatchByRequestToken(fixture.db.asPrismaClient(), { requestToken: TOKEN_A, createdBy: "admin-1" }, ENABLED_ENV);
    expect(lookedUp?.batchId).toBe(submitted.detail.batchId);

    const notFound = await getRebindBatchByRequestToken(fixture.db.asPrismaClient(), { requestToken: TOKEN_B, createdBy: "admin-1" }, ENABLED_ENV);
    expect(notFound).toBeNull();
  });
});

describe("submitRebindBatch: selection validation", () => {
  it("selecting an id outside the preview's executable rows is INVALID_SELECTION", async () => {
    const fixture = baseFixture();
    // A skipped (unresolved) article — never executable.
    const lonelyNovel = seedNovel(fixture.db, { id: "novel-lonely", locale: "en", titleNormalized: "lonely", title: "Lonely" });
    seedNovelUnderChannel(fixture.db, { novelId: lonelyNovel.id, channelId: fixture.source.id, sourceAppId: fixture.app.id });
    const lonelyArticle = seedArticle(fixture.db, { id: "article-lonely", novelId: lonelyNovel.id, locale: "en", status: "published" });
    const { pairs, summary } = await seedPreview(fixture, ["1"]);
    void pairs;

    await expect(
      submitRebindBatch(
        fixture.db.asPrismaClient(),
        { previewId: summary.previewId, selectedArticleIds: [lonelyArticle.id], reason: "reason", acknowledgeRisks: false, requestToken: TOKEN_A, createdBy: "admin-1" },
        ENABLED_ENV,
      ),
    ).rejects.toMatchObject({ code: "INVALID_SELECTION" });
  });

  it("占用中的文章: an article already claimed by a PENDING item of another active batch is created as skipped/blocked, not processed twice", async () => {
    const fixture = baseFixture();
    const { pairs, summary } = await seedPreview(fixture, ["1", "2"]);
    // Simulate an existing, still-active batch item claiming article 1.
    fixture.db.batchItems.push({
      id: "pre-existing-item",
      batchId: "other-batch",
      articleId: pairs[0]!.article.id,
      oldNovelId: pairs[0]!.sourceNovel.id,
      oldPromoLinkId: null,
      expectedNewNovelId: pairs[0]!.targetNovel.id,
      expectedNewPromoLinkId: pairs[0]!.promo.id,
      appliedNewNovelId: null,
      appliedNewPromoLinkId: null,
      status: "pending",
      processingToken: null,
      errorKind: null,
      errorMessage: null,
      auditId: null,
      startedAt: null,
      finishedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await submitRebindBatch(
      fixture.db.asPrismaClient(),
      {
        previewId: summary.previewId,
        selectedArticleIds: [pairs[0]!.article.id, pairs[1]!.article.id],
        reason: "reason",
        acknowledgeRisks: false,
        requestToken: TOKEN_A,
        createdBy: "admin-1",
      },
      ENABLED_ENV,
    );
    const claimedItem = result.detail.items.find((item) => item.articleId === pairs[0]!.article.id)!;
    const freeItem = result.detail.items.find((item) => item.articleId === pairs[1]!.article.id)!;
    expect(claimedItem.status).toBe("skipped");
    expect(freeItem.status).toBe("applied");
    expect(result.detail.status).toBe("partial");
  });
});

describe("🔴 逐条事务 / per-item isolation: one failing item never rolls back a peer item's already-committed write", () => {
  it("3 selected items, the middle one blocked at WRITE time (guard re-run catches it, preview didn't) -> the other two still apply", async () => {
    const fixture = baseFixture();
    const { pairs, summary } = await seedPreview(fixture, ["1", "2", "3"]);
    // Between preview and apply, item 2's target promo link becomes unavailable
    // (soft-deleted) — the preview snapshot still says "executable" (stale),
    // but `runRebindTransactionalWrite`'s guard 7 re-evaluates fresh at write
    // time and blocks it, exactly the "不信任预览时的判定" contract.
    pairs[1]!.promo.deletedAt = new Date();

    const result = await submitRebindBatch(
      fixture.db.asPrismaClient(),
      {
        previewId: summary.previewId,
        selectedArticleIds: pairs.map((p) => p.article.id),
        reason: "reason",
        acknowledgeRisks: false,
        requestToken: TOKEN_A,
        createdBy: "admin-1",
      },
      ENABLED_ENV,
    );

    expect(result.detail.status).toBe("partial");
    expect(result.detail.counts).toMatchObject({ submitted: 3, applied: 2, failed: 1, skipped: 0, pending: 0, processing: 0 });

    const failedItem = result.detail.items.find((item) => item.articleId === pairs[1]!.article.id)!;
    expect(failedItem.status).toBe("failed");
    expect(failedItem.errorKind).toBe("blocked");

    // The failed item's article was NEVER written — its novelId is untouched.
    const article2 = fixture.db.articles.find((a) => a.id === pairs[1]!.article.id)!;
    expect(article2.novelId).toBe(pairs[1]!.sourceNovel.id);

    // The other two DID commit, independently of item 2's failure.
    const article1 = fixture.db.articles.find((a) => a.id === pairs[0]!.article.id)!;
    const article3 = fixture.db.articles.find((a) => a.id === pairs[2]!.article.id)!;
    expect(article1.novelId).toBe(pairs[0]!.targetNovel.id);
    expect(article3.novelId).toBe(pairs[2]!.targetNovel.id);

    // Batch accounting reconciles: submitted = applied+skipped+failed+pending+processing.
    const c = result.detail.counts;
    expect(c.submitted).toBe(c.applied + c.skipped + c.failed + c.pending + c.processing);
  });
});

describe("finalize: three-way terminal status", () => {
  it("all applied -> completed", async () => {
    const fixture = baseFixture();
    const { pairs, summary } = await seedPreview(fixture, ["1", "2"]);
    const result = await submitRebindBatch(
      fixture.db.asPrismaClient(),
      { previewId: summary.previewId, selectedArticleIds: pairs.map((p) => p.article.id), reason: "r", acknowledgeRisks: false, requestToken: TOKEN_A, createdBy: "admin-1" },
      ENABLED_ENV,
    );
    expect(result.detail.status).toBe("completed");
  });

  it("all failed -> failed (applied === 0)", async () => {
    const fixture = baseFixture();
    const { pairs, summary } = await seedPreview(fixture, ["1"]);
    pairs[0]!.promo.deletedAt = new Date();
    const result = await submitRebindBatch(
      fixture.db.asPrismaClient(),
      { previewId: summary.previewId, selectedArticleIds: [pairs[0]!.article.id], reason: "r", acknowledgeRisks: false, requestToken: TOKEN_A, createdBy: "admin-1" },
      ENABLED_ENV,
    );
    expect(result.detail.status).toBe("failed");
  });
});

describe("resume: continues an interrupted batch, never re-writes an already-applied item", () => {
  it("a batch left with items still pending after its lease expired resumes and finishes them", async () => {
    const fixture = baseFixture();
    const { pairs, summary } = await seedPreview(fixture, ["1", "2"]);
    // Manually construct an "interrupted" batch: one item already applied,
    // one still pending, lease expired — as if `executeRebindBatch`'s loop
    // was killed mid-run.
    const batchId = "rebind-interrupted-1";
    const now = new Date();
    fixture.db.batches.push({
      id: batchId,
      createdBy: "admin-1",
      requestToken: TOKEN_A,
      previewId: summary.previewId,
      selectionHash: "h",
      requestPayloadHash: "h",
      sourceChannelCode: "changdu",
      targetChannelCode: "beidou",
      status: "processing",
      acknowledgeRisks: false,
      submittedCount: 2,
      resolvableCount: 2,
      appliedCount: 1,
      skippedCount: 0,
      failedCount: 0,
      filtersJson: {},
      planHash: "h",
      reason: "r",
      executionToken: "stale-token",
      leaseExpiresAt: new Date(now.getTime() - 60_000),
      heartbeatAt: new Date(now.getTime() - 120_000),
      startedAt: new Date(now.getTime() - 200_000),
      finishedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    fixture.db.batchItems.push({
      id: "item-applied-already",
      batchId,
      articleId: pairs[0]!.article.id,
      oldNovelId: pairs[0]!.sourceNovel.id,
      oldPromoLinkId: null,
      expectedNewNovelId: pairs[0]!.targetNovel.id,
      expectedNewPromoLinkId: pairs[0]!.promo.id,
      appliedNewNovelId: pairs[0]!.targetNovel.id,
      appliedNewPromoLinkId: pairs[0]!.promo.id,
      status: "applied",
      processingToken: "stale-token",
      errorKind: null,
      errorMessage: null,
      auditId: 999n,
      startedAt: now,
      finishedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    fixture.db.batchItems.push({
      id: "item-still-pending",
      batchId,
      articleId: pairs[1]!.article.id,
      oldNovelId: pairs[1]!.sourceNovel.id,
      oldPromoLinkId: null,
      expectedNewNovelId: pairs[1]!.targetNovel.id,
      expectedNewPromoLinkId: pairs[1]!.promo.id,
      appliedNewNovelId: null,
      appliedNewPromoLinkId: null,
      status: "pending",
      processingToken: null,
      errorKind: null,
      errorMessage: null,
      auditId: null,
      startedAt: null,
      finishedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    // Manually apply item 1's write to the article (as if it already committed before the interruption).
    fixture.db.articles.find((a) => a.id === pairs[0]!.article.id)!.novelId = pairs[0]!.targetNovel.id;
    const auditCountBeforeResume = fixture.db.audits.length;

    const detail = await getRebindBatchDetail(fixture.db.asPrismaClient(), { batchId, createdBy: "admin-1" }, ENABLED_ENV);
    expect(detail.status).toBe("interrupted");

    const resumed = await resumeRebindBatch(fixture.db.asPrismaClient(), { batchId, createdBy: "admin-1" }, ENABLED_ENV);
    expect(resumed.status).toBe("completed");
    expect(resumed.counts.applied).toBe(2);

    // Item 1 (already applied before resume) got no second write — only ONE new audit row (for item 2) was created by the resume.
    expect(fixture.db.audits.length).toBe(auditCountBeforeResume + 1);
  });

  it("a terminal batch cannot be resumed", async () => {
    const fixture = baseFixture();
    const { pairs, summary } = await seedPreview(fixture, ["1"]);
    const result = await submitRebindBatch(
      fixture.db.asPrismaClient(),
      { previewId: summary.previewId, selectedArticleIds: [pairs[0]!.article.id], reason: "r", acknowledgeRisks: false, requestToken: TOKEN_A, createdBy: "admin-1" },
      ENABLED_ENV,
    );
    expect(result.detail.status).toBe("completed");
    await expect(resumeRebindBatch(fixture.db.asPrismaClient(), { batchId: result.detail.batchId, createdBy: "admin-1" }, ENABLED_ENV)).rejects.toMatchObject({ code: "BATCH_TERMINAL" });
  });
});

describe("lease mutual exclusion", () => {
  it("two concurrent acquire attempts on the same batch — only one succeeds", async () => {
    const fixture = baseFixture();
    fixture.db.batches.push({
      id: "batch-lease-race",
      createdBy: "admin-1",
      requestToken: TOKEN_A,
      previewId: "preview-x",
      selectionHash: "h",
      requestPayloadHash: "h",
      sourceChannelCode: "changdu",
      targetChannelCode: "beidou",
      status: "ready",
      acknowledgeRisks: false,
      submittedCount: 1,
      resolvableCount: 1,
      appliedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      filtersJson: {},
      planHash: "h",
      reason: "r",
      executionToken: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      startedAt: null,
      finishedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const db = fixture.db.asPrismaClient() as unknown as Parameters<typeof acquireRebindBatchLease>[0];
    const first = await acquireRebindBatchLease(db, "batch-lease-race", "attempt-1");
    const second = await acquireRebindBatchLease(db, "batch-lease-race", "attempt-2");
    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});

describe("批次计数对账 (batch accounting)", () => {
  it("submitted always equals the sum of the five per-item statuses across a mixed-result batch", async () => {
    const fixture = baseFixture();
    const { pairs, summary } = await seedPreview(fixture, ["1", "2", "3"]);
    pairs[1]!.promo.deletedAt = new Date(); // item 2 fails at write time
    const result = await submitRebindBatch(
      fixture.db.asPrismaClient(),
      { previewId: summary.previewId, selectedArticleIds: pairs.map((p) => p.article.id), reason: "r", acknowledgeRisks: false, requestToken: TOKEN_A, createdBy: "admin-1" },
      ENABLED_ENV,
    );
    const c = result.detail.counts;
    expect(c.submitted).toBe(3);
    expect(c.submitted).toBe(c.applied + c.skipped + c.failed + c.pending + c.processing);
  });
});

describe("🔴 IndexNow: batch rebind must never enqueue (negative, CPS parity)", () => {
  it("src/server/article-rebind/batch.ts and preview.ts never mention indexnow, in any casing", async () => {
    const root = path.resolve(process.cwd(), "src/server/article-rebind");
    for (const file of ["batch.ts", "preview.ts"]) {
      const source = await readFile(path.join(root, file), "utf8");
      expect(source.toLowerCase()).not.toMatch(/indexnow/);
    }
  });

  it("src/server/article-rebind/ (whole directory) imports nothing from @/lib/indexnow", async () => {
    const root = path.resolve(process.cwd(), "src/server/article-rebind");
    const entries = await readdir(root);
    for (const entry of entries) {
      if (!entry.endsWith(".ts")) continue;
      const source = await readFile(path.join(root, entry), "utf8");
      expect(source).not.toMatch(/@\/lib\/indexnow/);
    }
  });

  it("behavioral: a completed batch run writes zero IndexNowOutbox-shaped rows (the fake db has no such delegate — a call to it would throw, not silently no-op)", async () => {
    const fixture = baseFixture();
    const { pairs, summary } = await seedPreview(fixture, ["1"]);
    const result = await submitRebindBatch(
      fixture.db.asPrismaClient(),
      { previewId: summary.previewId, selectedArticleIds: [pairs[0]!.article.id], reason: "r", acknowledgeRisks: false, requestToken: TOKEN_A, createdBy: "admin-1" },
      ENABLED_ENV,
    );
    expect(result.detail.status).toBe("completed");
  });
});

/**
 * Review follow-up (复核_C30施工单2, 2026-09-09). `cleanupExpiredRebindPreviews`
 * was implemented and unit-tested but never called from any production path,
 * so it was dead code and `article_novel_rebind_preview` — whose
 * `matches_json` holds every classified row of a scan bounded only by
 * `sourceScan: 20_000` — grew without bound. CPS runs the sweep in exactly
 * one place, `applyDurableBatch` immediately before `loadOwnedPreview`
 * (`article-drama-batch-switch-service.ts:2961`); these two tests pin that
 * the海阅 submit path now does the same, behaviorally and structurally.
 */
describe("过期预览快照的有界清理已接线（CPS parity: applyDurableBatch:2961）", () => {
  it("submitRebindBatch 会顺带删掉已过期的预览行，且不碰未过期的行", async () => {
    const fixture = baseFixture();
    const { pairs, summary } = await seedPreview(fixture, ["1"]);

    // A stale preview left behind by an earlier session, already past its TTL.
    fixture.db.previews.push({
      ...fixture.db.previews.find((row) => row.id === summary.previewId)!,
      id: "00000000-0000-4000-8000-00000000dead",
      expiresAt: new Date(Date.now() - 60 * 60 * 1_000),
    });
    expect(fixture.db.previews).toHaveLength(2);

    const result = await submitRebindBatch(
      fixture.db.asPrismaClient(),
      { previewId: summary.previewId, selectedArticleIds: [pairs[0]!.article.id], reason: "r", acknowledgeRisks: false, requestToken: TOKEN_A, createdBy: "admin-1" },
      ENABLED_ENV,
    );

    expect(result.detail.status).toBe("completed");
    expect(fixture.db.previews.map((row) => row.id)).toEqual([summary.previewId]);
  });

  it("结构性：batch.ts 确实调用了 cleanupExpiredRebindPreviews（防止再次被摘掉后只剩一条行为测试）", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src/server/article-rebind/batch.ts"), "utf8");
    expect(source).toMatch(/await cleanupExpiredRebindPreviews\(db\)\.catch\(/);
  });
});

describe("fail-closed: capability × flag combinations", () => {
  it("submitRebindBatch: FEATURE off -> RebindFeatureDisabledError regardless of write-allow", async () => {
    const fixture = baseFixture();
    const { pairs, summary } = await seedPreview(fixture, ["1"]);
    await expect(
      submitRebindBatch(
        fixture.db.asPrismaClient(),
        { previewId: summary.previewId, selectedArticleIds: [pairs[0]!.article.id], reason: "r", acknowledgeRisks: false, requestToken: TOKEN_A, createdBy: "admin-1" },
        DISABLED_ENV,
      ),
    ).rejects.toBeInstanceOf(RebindFeatureDisabledError);
  });

  it("submitRebindBatch: FEATURE on, ALLOW_WRITE off -> RebindWriteDisabledError (submit/apply is NOT the preview single-gate exception)", async () => {
    const fixture = baseFixture();
    const { pairs, summary } = await seedPreview(fixture, ["1"]);
    await expect(
      submitRebindBatch(
        fixture.db.asPrismaClient(),
        { previewId: summary.previewId, selectedArticleIds: [pairs[0]!.article.id], reason: "r", acknowledgeRisks: false, requestToken: TOKEN_A, createdBy: "admin-1" },
        PREVIEW_ONLY_ENV,
      ),
    ).rejects.toBeInstanceOf(RebindWriteDisabledError);
  });

  it("submitRebindBatch: both flags on -> succeeds (baseline)", async () => {
    const fixture = baseFixture();
    const { pairs, summary } = await seedPreview(fixture, ["1"]);
    const result = await submitRebindBatch(
      fixture.db.asPrismaClient(),
      { previewId: summary.previewId, selectedArticleIds: [pairs[0]!.article.id], reason: "r", acknowledgeRisks: false, requestToken: TOKEN_A, createdBy: "admin-1" },
      ENABLED_ENV,
    );
    expect(result.detail.status).toBe("completed");
  });

  it("resumeRebindBatch: FEATURE on, ALLOW_WRITE off -> RebindWriteDisabledError", async () => {
    const fixture = baseFixture();
    await expect(resumeRebindBatch(fixture.db.asPrismaClient(), { batchId: "whatever", createdBy: "admin-1" }, PREVIEW_ONLY_ENV)).rejects.toBeInstanceOf(RebindWriteDisabledError);
  });

  it("getRebindBatchDetail/getRebindBatchByRequestToken: only the total gate is required (read paths)", async () => {
    const fixture = baseFixture();
    await expect(getRebindBatchDetail(fixture.db.asPrismaClient(), { batchId: "x", createdBy: "admin-1" }, DISABLED_ENV)).rejects.toBeInstanceOf(RebindFeatureDisabledError);
    await expect(getRebindBatchByRequestToken(fixture.db.asPrismaClient(), { requestToken: TOKEN_A, createdBy: "admin-1" }, DISABLED_ENV)).rejects.toBeInstanceOf(RebindFeatureDisabledError);
  });
});

describe("RebindBatchDomainError sanity", () => {
  it("cap rejection carries INVALID_SELECTION with a machine-readable code", async () => {
    const fixture = baseFixture();
    const { summary } = await seedPreview(fixture, ["1"]);
    try {
      await submitRebindBatch(
        fixture.db.asPrismaClient(),
        { previewId: summary.previewId, selectedArticleIds: [], reason: "r", acknowledgeRisks: false, requestToken: TOKEN_A, createdBy: "admin-1" },
        ENABLED_ENV,
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RebindBatchDomainError);
      expect((error as RebindBatchDomainError).code).toBe("INVALID_SELECTION");
    }
  });
});
