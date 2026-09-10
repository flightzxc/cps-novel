import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  REBIND_BATCH_LIMITS,
  RebindBatchDomainError,
  RebindFeatureDisabledError,
  RebindWriteDisabledError,
  acquireRebindBatchLease,
  buildRebindBatchPreview,
  executeRebindBatch,
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

/**
 * C-30 单 3 W-2 test fixture — a fresh, never-started ("ready") durable
 * batch with N pending items, built directly (no `submitRebindBatch`
 * round-trip, no preview needed) so `executeRebindBatch` can be called
 * directly with an injected clock. Field shapes mirror the "resume: ...”
 * describe block's own manual batch/item construction above (the one
 * pre-existing place in this file that already pokes rows into
 * `fixture.db.batches`/`batchItems` directly) — `status: "ready"`,
 * `executionToken`/`leaseExpiresAt`/`startedAt` all null is simply what
 * `createBatchAtomically` itself would have written before its own first
 * `executeRebindBatch` call.
 */
function seedReadyBatch(
  fixture: ReturnType<typeof baseFixture>,
  pairs: ReturnType<typeof seedUniquePair>[],
  options: { batchId?: string } = {},
): string {
  const batchId = options.batchId ?? `rebind-budget-${pairs.length}`;
  const now = new Date();
  fixture.db.batches.push({
    id: batchId,
    createdBy: "admin-1",
    requestToken: `token-${batchId}`,
    previewId: "preview-budget-gate",
    selectionHash: "h",
    requestPayloadHash: "h",
    sourceChannelCode: "changdu",
    targetChannelCode: "beidou",
    status: "ready",
    acknowledgeRisks: false,
    submittedCount: pairs.length,
    resolvableCount: pairs.length,
    appliedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    filtersJson: {},
    planHash: "h",
    reason: "C-30 单 3 W-2 预算闸测试",
    executionToken: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    startedAt: null,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  pairs.forEach((pair, index) => {
    fixture.db.batchItems.push({
      id: `${batchId}-item-${index}`,
      batchId,
      articleId: pair.article.id,
      oldNovelId: pair.sourceNovel.id,
      oldPromoLinkId: null,
      expectedNewNovelId: pair.targetNovel.id,
      expectedNewPromoLinkId: pair.promo.id,
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
  });
  return batchId;
}

/**
 * A deterministic clock for `executeRebindBatch`'s optional `now` param
 * (施工工单 §5.1 — the one test-only signature extension this order
 * allows). `executeRebindBatch` calls it once for `startedAt` (call #0)
 * and once per loop iteration thereafter (call #1 for item 1's check, #2
 * for item 2's, ...), so with a fixed `stepMs` the elapsed time the gate
 * sees right before item *i*'s check is exactly `i * stepMs` — deliberately
 * NOT wall-clock-driven, so a test's outcome never depends on how fast this
 * machine happens to run the fake db.
 */
function steppingClock(stepMs: number): () => number {
  let calls = 0;
  return () => {
    const value = calls * stepMs;
    calls += 1;
    return value;
  };
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

/**
 * 施工工单_C30单3_批量换小说分块执行_移植CPS_V2_2026-09-09.md §5.1 — W-2's own
 * test spec (items 1-8). CPS has no equivalent of this gate at all (see
 * `REBIND_BATCH_LIMITS`'s own comment on `requestBudgetMs`); every case
 * below drives `executeRebindBatch` directly with the injected `now` clock
 * rather than the global `Date.now` — per §5.1's own instruction, since
 * `leaseRemainingMs` (called from the SAME loop) does its own real-time
 * lease query and a global mock would drag that along with it.
 */
describe("C-30 单 3 W-2: executeRebindBatch 的墙钟预算闸", () => {
  it("§5.1-1 预算闸在条与条之间触发：断点之后的条目仍是 pending，不是 processing", async () => {
    const fixture = baseFixture();
    const pairs = ["1", "2", "3"].map((id) => seedUniquePair(fixture, id));
    const batchId = seedReadyBatch(fixture, pairs);
    const db = fixture.db.asPrismaClient() as unknown as Parameters<typeof executeRebindBatch>[0];

    // stepMs=10_000, budget=24_000: item1 check@10s (proceeds), item2
    // check@20s (proceeds), item3 check@30s (>=24s, breaks before claiming).
    await executeRebindBatch(db, { batchId, attempt: "attempt-1" }, steppingClock(10_000));

    const items = fixture.db.batchItems.filter((item) => item.batchId === batchId);
    const item1 = items.find((item) => item.articleId === pairs[0]!.article.id)!;
    const item2 = items.find((item) => item.articleId === pairs[1]!.article.id)!;
    const item3 = items.find((item) => item.articleId === pairs[2]!.article.id)!;
    expect(item1.status).toBe("applied");
    expect(item2.status).toBe("applied");
    expect(item3.status).toBe("pending");
    expect(item3.processingToken).toBeNull();
  });

  it("§5.1-2 不打断在飞事务：跨过预算的那一条仍写成终态，写入真的落了地", async () => {
    const fixture = baseFixture();
    const pairs = ["1", "2"].map((id) => seedUniquePair(fixture, id));
    const batchId = seedReadyBatch(fixture, pairs);
    const db = fixture.db.asPrismaClient() as unknown as Parameters<typeof executeRebindBatch>[0];

    // item1's check passes at 5s; the jump to 60s on the NEXT call
    // represents item1's own processing having (hypothetically) taken that
    // long — the gate never re-checks mid-item, so item1 still runs to a
    // terminal write, and only item2's check (the next one) sees the
    // overrun and stops.
    let call = 0;
    const clock = () => {
      const value = call === 0 ? 0 : call === 1 ? 5_000 : 60_000;
      call += 1;
      return value;
    };
    await executeRebindBatch(db, { batchId, attempt: "attempt-1" }, clock);

    const items = fixture.db.batchItems.filter((item) => item.batchId === batchId);
    const item1 = items.find((item) => item.articleId === pairs[0]!.article.id)!;
    const item2 = items.find((item) => item.articleId === pairs[1]!.article.id)!;
    expect(item1.status).toBe("applied");
    expect(item1.finishedAt).not.toBeNull();
    expect(item2.status).toBe("pending");
    // The write itself landed on the article row — not just bookkeeping.
    const article1 = fixture.db.articles.find((a) => a.id === pairs[0]!.article.id)!;
    expect(article1.novelId).toBe(pairs[0]!.targetNovel.id);
  });

  it("§5.1-3 停下后的状态：收尾返回未终态、批次仍是 processing、执行令牌已释放", async () => {
    const fixture = baseFixture();
    const pairs = ["1", "2", "3"].map((id) => seedUniquePair(fixture, id));
    const batchId = seedReadyBatch(fixture, pairs);
    const db = fixture.db.asPrismaClient() as unknown as Parameters<typeof executeRebindBatch>[0];

    await executeRebindBatch(db, { batchId, attempt: "attempt-1" }, steppingClock(10_000));

    const batch = fixture.db.batches.find((b) => b.id === batchId)!;
    expect(batch.status).toBe("processing");
    expect(batch.executionToken).toBeNull();
    expect(batch.leaseExpiresAt).toBeNull();
    expect(batch.appliedCount).toBe(2);
  });

  it("§5.1-4 派生出已中断：取详情时 status 是 interrupted", async () => {
    const fixture = baseFixture();
    const pairs = ["1", "2", "3"].map((id) => seedUniquePair(fixture, id));
    const batchId = seedReadyBatch(fixture, pairs);
    const db = fixture.db.asPrismaClient() as unknown as Parameters<typeof executeRebindBatch>[0];

    await executeRebindBatch(db, { batchId, attempt: "attempt-1" }, steppingClock(10_000));

    const detail = await getRebindBatchDetail(db, { batchId, createdBy: "admin-1" }, ENABLED_ENV);
    expect(detail.status).toBe("interrupted");
    expect(detail.persistedStatus).toBe("processing");
    expect(detail.counts.pending).toBe(1);
  });

  it("§5.1-5 续跑接得上：剩余条目跑完，已完成的条目不会被再写一次", async () => {
    const fixture = baseFixture();
    const pairs = ["1", "2", "3"].map((id) => seedUniquePair(fixture, id));
    const batchId = seedReadyBatch(fixture, pairs);
    const db = fixture.db.asPrismaClient() as unknown as Parameters<typeof executeRebindBatch>[0];

    await executeRebindBatch(db, { batchId, attempt: "attempt-1" }, steppingClock(10_000));
    const auditCountAfterFirstRound = fixture.db.audits.length;
    expect(auditCountAfterFirstRound).toBe(2);

    const resumed = await resumeRebindBatch(db, { batchId, createdBy: "admin-1" }, ENABLED_ENV);
    expect(resumed.status).toBe("completed");
    expect(resumed.counts.applied).toBe(3);
    // Exactly one new audit row (item 3) — items 1/2 were not re-written.
    expect(fixture.db.audits.length).toBe(auditCountAfterFirstRound + 1);
  });

  it("§5.1-6 续跑自己也吃预算闸：一次续跑同样在预算处停下，仍可再续", async () => {
    const fixture = baseFixture();
    const pairs = ["1", "2", "3", "4"].map((id) => seedUniquePair(fixture, id));
    const batchId = seedReadyBatch(fixture, pairs);
    const db = fixture.db.asPrismaClient() as unknown as Parameters<typeof executeRebindBatch>[0];

    // `resumeRebindBatch`'s own call to `executeRebindBatch` (`batch.ts`'s
    // `resumeRebindBatch`) cannot take a test clock without touching that
    // call site, which 施工工单 §3.4 forbids ("resumeRebindBatch 里那句执行
    // 调用不改 —— 续跑同样吃这个预算闸"). `executeRebindBatch` is the exact,
    // unmodified function `resumeRebindBatch` calls with a fresh `attempt`
    // — calling it again directly here, a second time with its own fresh
    // clock, exercises the identical shared code path a real "继续执行"
    // click would run, without needing a clock to reach through the wrapper.
    await executeRebindBatch(db, { batchId, attempt: "attempt-1" }, steppingClock(15_000));
    let items = fixture.db.batchItems.filter((item) => item.batchId === batchId);
    expect(items.filter((item) => item.status === "applied")).toHaveLength(1);
    expect(items.filter((item) => item.status === "pending")).toHaveLength(3);
    let detail = await getRebindBatchDetail(db, { batchId, createdBy: "admin-1" }, ENABLED_ENV);
    expect(detail.status).toBe("interrupted");

    await executeRebindBatch(db, { batchId, attempt: "attempt-2" }, steppingClock(15_000));
    items = fixture.db.batchItems.filter((item) => item.batchId === batchId);
    expect(items.filter((item) => item.status === "applied")).toHaveLength(2);
    expect(items.filter((item) => item.status === "pending")).toHaveLength(2);
    detail = await getRebindBatchDetail(db, { batchId, createdBy: "admin-1" }, ENABLED_ENV);
    expect(detail.status).toBe("interrupted");
  });

  it("§5.1-7 预算不影响小批：总耗时远低于预算时闸一次都不触发，批次一次跑到终态", async () => {
    const fixture = baseFixture();
    const pairs = ["1", "2", "3"].map((id) => seedUniquePair(fixture, id));
    const batchId = seedReadyBatch(fixture, pairs);
    const db = fixture.db.asPrismaClient() as unknown as Parameters<typeof executeRebindBatch>[0];

    await executeRebindBatch(db, { batchId, attempt: "attempt-1" }, steppingClock(10));

    const batch = fixture.db.batches.find((b) => b.id === batchId)!;
    expect(batch.status).toBe("completed");
    const items = fixture.db.batchItems.filter((item) => item.batchId === batchId);
    expect(items.every((item) => item.status === "applied")).toBe(true);
  });

  it("§5.1-8 常量断言：requestBudgetMs === 24_000 === proxyWindowMs × 0.80；apply 仍是 200", () => {
    expect(REBIND_BATCH_LIMITS.requestBudgetMs).toBe(24_000);
    expect(REBIND_BATCH_LIMITS.requestBudgetMs).toBe(REBIND_BATCH_LIMITS.proxyWindowMs * 0.8);
    expect(REBIND_BATCH_LIMITS.apply).toBe(200);
  });
});

/**
 * 反向自检一（施工工单 §5.4）— 全仓静态断言零「每请求条数」相关的新常量/新
 * 参数/新动作签名。W-2 只新增了时间维的 `requestBudgetMs`；条数维的唯一上限
 * 仍是 `apply: 200`，且没有任何形如「一次请求处理 N 条」的新东西。
 */
describe("🔴 反向自检一：没有引入分块接口（每请求条数）", () => {
  it("src/server/article-rebind/ 全目录零命中 perRequestLimit / itemsPerRequest / advanceRound，以及工单点名的中文说法", async () => {
    const root = path.resolve(process.cwd(), "src/server/article-rebind");
    const entries = await readdir(root);
    // 🔴 Deliberately does NOT include bare "chunk" here — `preview.ts`
    // legitimately has `SQL_BIND_CHUNK_SIZE`/`chunked()` (SQL bind-variable
    // chunking to stay under a `IN (...)` size limit), which 施工工单 §2.2
    // explicitly says is a different thing from HTTP-request chunking and
    // must not be confused with it. That pre-existing, unrelated usage is
    // scoped out precisely by the next test instead.
    const banned = /perrequestlimit|itemsperrequest|advanceround|每请求|单次请求|每次请求|分批提交|分批执行|分轮执行|推进一轮/i;
    for (const entry of entries) {
      if (!entry.endsWith(".ts")) continue;
      const source = await readFile(path.join(root, entry), "utf8");
      expect(source).not.toMatch(banned);
    }
  });

  it("W-2/W-3 的落点（batch.ts / batch-constants.ts）零 chunk 相关标识——「chunk」只允许出现在 preview.ts 既有的 SQL 绑定变量分块里，与本单无关", async () => {
    const root = path.resolve(process.cwd(), "src/server/article-rebind");
    for (const file of ["batch.ts", "batch-constants.ts"]) {
      const source = await readFile(path.join(root, file), "utf8");
      expect(source.toLowerCase()).not.toMatch(/chunk/);
    }
  });

  /**
   * 🔴 复核补强 (2026-09-09, 复核者) — 施工工单 §5.4 反证一 says 「全仓搜索」,
   * and the first case above only walks `src/server/article-rebind/`. This
   * one is the genuinely repo-wide half: every `.ts`/`.tsx` under `src/`,
   * `worker/` and `scripts/`.
   *
   * Identifier patterns ONLY. The Chinese phrases stay scoped to the rebind
   * directory above on purpose — 「分批提交」/「每次请求」 legitimately appear
   * today as unrelated, pre-existing user-facing copy in three other
   * features (`catalog-sync/_components/promo-link-claim-dialog.tsx:66`,
   * `novels/_lib/publish-outcome-copy.ts:42`, `dev-preview/layout.tsx:15`),
   * none of them touched by this branch; a repo-wide phrase ban would fail
   * on those and say nothing about this order.
   */
  it("🔴 全仓（src/ + worker/ + scripts/）零命中 perRequestLimit / itemsPerRequest / advanceRound / itemsPerRound / perRequestItems", async () => {
    const banned = /perRequestLimit|itemsPerRequest|advanceRound|itemsPerRound|perRequestItems/i;
    const hits: string[] = [];
    for (const dir of ["src", "worker", "scripts"]) {
      const root = path.resolve(process.cwd(), dir);
      const entries = await readdir(root, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
        const full = path.join(entry.parentPath ?? root, entry.name);
        if (banned.test(await readFile(full, "utf8"))) hits.push(path.relative(process.cwd(), full));
      }
    }
    expect(hits).toEqual([]);
  });

  it("REBIND_BATCH_LIMITS 只新增了两个字段（proxyWindowMs/requestBudgetMs），字段总数是 15", () => {
    expect(Object.keys(REBIND_BATCH_LIMITS)).toHaveLength(15);
    expect(REBIND_BATCH_LIMITS).toMatchObject({
      sourceScan: 20_000,
      destinationScan: 20_000,
      candidate: 1_600,
      apply: 200,
      pageSize: 50,
      defaultPageSize: 25,
      ambiguousDisplayCandidates: 20,
      previewTtlMs: 30 * 60 * 1_000,
      leaseMs: 90 * 1_000,
      leaseRenewEvery: 25,
      leaseRenewThresholdMs: 30 * 1_000,
      cleanupRows: 100,
      cleanupMs: 100,
      proxyWindowMs: 30_000,
      requestBudgetMs: 24_000,
    });
  });
});
