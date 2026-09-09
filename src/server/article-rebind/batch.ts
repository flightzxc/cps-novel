/**
 * C-30B (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4B.2). Durable batch
 * execution: idempotent submission, active-article locking, lease-fenced
 * execution with per-item resume, and terminal finalize.
 *
 * CPS parity map (施工工单 §3.1):
 *   - `activeArticleLocks`/`createDurableBatchOnce`/`createDurableBatchAtomically`
 *   - `acquireDurableBatchLease`/`renewDurableBatchLease`/`durableLeaseRemainingMs`/
 *     `releaseDurableBatchLease`/`guardDurableBatchFence`/`claimDurableBatchItem`
 *   - `markDurableItemErrorWithFence`/`classifyDurableSwitchError`
 *   - `finalizeDurableBatch`/`executeDurableBatch`/`applyDurableBatch`/`resumeDurableBatch`
 *   - `toDurableBatchDetail`/`getDurableBatchDetail`/`getDurableBatchByRequestToken`
 *
 * 🔴 Per-item processing (`processRebindBatchItem`) is the one piece that
 * does NOT parity-copy CPS's `processDurableBatchItem` body — that function
 * calls CPS's own `switchArticleDrama(tx, ...)` directly (a function that
 * takes an already-open `tx` and performs no I/O of its own beyond the
 * write). This repo's single-article service (`./service.ts`) instead
 * resolves a fresh `AdminServiceAuthorization` ticket and opens its OWN
 * transaction — appropriate for a human-triggered single edit, wrong for
 * 200 fenced batch items sharing ONE submit-time authorization. So this
 * file calls `./service.ts`'s `runRebindTransactionalWrite` — the exact
 * same guard-then-write-then-audit core `switchArticleNovel` itself calls —
 * inside its OWN per-item transaction, with `actorId`/`requestId` derived
 * from the batch (not a re-authorized ticket). Per-item integrity comes
 * from this file's own batch/item fence tokens, not from re-running
 * `requireFreshAdminServiceMutation` 200 times.
 *
 * 🔴 One transaction PER ITEM (施工工单 §4B.2/§6 item 8), never one
 * transaction for the whole batch — `executeRebindBatch`'s loop opens (via
 * `processRebindBatchItem`) exactly one `db.$transaction` per item; a
 * failure inside one item's transaction only rolls back that item's own
 * writes (its `updateMany`/`operationAudit.create` — never a peer item's).
 */
import { createHash, randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { isArticleNovelRebindEnabled, isArticleNovelRebindWriteAllowed } from "@/lib/flags";

import { REBIND_BATCH_LIMITS } from "./batch-constants";
import { RebindArticleNotEligibleError, RebindDriftError, RebindGuardBlockedError, rebindBatchDomainError } from "./errors";
import { cleanupExpiredRebindPreviews, loadOwnedRebindPreview, type RebindPreviewDb, type RebindPreviewSnapshot } from "./preview";
import {
  RebindFeatureDisabledError,
  RebindWriteDisabledError,
  invalidateRebindArticleCache,
  runRebindTransactionalWrite,
  type ArticleRebindDb,
  type ArticleRebindTxClient,
} from "./service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DelegateArgs = any;

export type RebindBatchDb = Omit<ArticleRebindDb, "$transaction"> &
  RebindPreviewDb & {
    articleNovelRebindBatch: {
      create(args: DelegateArgs): Promise<DelegateArgs>;
      findUnique(args: DelegateArgs): Promise<DelegateArgs | null>;
      findFirst(args: DelegateArgs): Promise<DelegateArgs | null>;
      updateMany(args: DelegateArgs): Promise<{ count: number }>;
    };
    articleNovelRebindBatchItem: {
      createMany(args: DelegateArgs): Promise<{ count: number }>;
      findMany(args: DelegateArgs): Promise<DelegateArgs[]>;
      findUnique(args: DelegateArgs): Promise<DelegateArgs | null>;
      updateMany(args: DelegateArgs): Promise<{ count: number }>;
      groupBy(args: DelegateArgs): Promise<DelegateArgs[]>;
    };
    $transaction<T>(fn: (tx: RebindBatchTxClient) => Promise<T>): Promise<T>;
  };

/** Transaction-scoped subset used inside `db.$transaction` callbacks in this file. */
export type RebindBatchTxClient = ArticleRebindTxClient & {
  articleNovelRebindBatch: RebindBatchDb["articleNovelRebindBatch"];
  articleNovelRebindBatchItem: RebindBatchDb["articleNovelRebindBatchItem"];
};

function trimText(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function iso(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

/** 🔴 零裸 UUID (施工工单 §4B.4) — human-readable, application-supplied batch id. */
export function generateRebindBatchId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `rebind-${stamp}-${randomUUID().slice(0, 8)}`;
}

function normalizeRequestToken(value: string): string {
  const token = trimText(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
    rebindBatchDomainError("INVALID_REQUEST_TOKEN", "requestToken must be a UUID");
  }
  return token;
}

function normalizeArticleIds(articleIds: readonly string[]): string[] {
  const ids = [...new Set(articleIds)].sort();
  if (ids.length === 0 || ids.length > REBIND_BATCH_LIMITS.apply) {
    rebindBatchDomainError("INVALID_SELECTION", `selectedArticleIds must contain between 1 and ${REBIND_BATCH_LIMITS.apply} unique ids`);
  }
  return ids;
}

export type SubmitRebindBatchInput = {
  previewId: string;
  selectedArticleIds: readonly string[];
  reason: string;
  acknowledgeRisks: boolean;
  requestToken: string;
  createdBy: string;
};

export type RebindBatchRequestFingerprint = {
  previewId: string;
  selectedArticleIds: string[];
  reason: string;
  acknowledgeRisks: boolean;
  requestToken: string;
  createdBy: string;
  selectionHash: string;
  requestPayloadHash: string;
};

/** CPS parity: `buildDurableRequestFingerprint`. */
export function buildRebindBatchRequestFingerprint(input: SubmitRebindBatchInput): RebindBatchRequestFingerprint {
  const selectedArticleIds = normalizeArticleIds(input.selectedArticleIds);
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) rebindBatchDomainError("INVALID_REASON", "reason must contain between 1 and 500 characters");
  const requestToken = normalizeRequestToken(input.requestToken);
  const previewId = trimText(input.previewId);
  if (!previewId) rebindBatchDomainError("PREVIEW_NOT_FOUND", "previewId is required");
  const createdBy = trimText(input.createdBy);
  if (!createdBy) rebindBatchDomainError("INVALID_SELECTION", "createdBy is required");

  const selectionHash = sha256(JSON.stringify(selectedArticleIds));
  const requestPayloadHash = sha256(
    JSON.stringify({
      actor: createdBy,
      previewId,
      selectedArticleIds,
      reason,
      acknowledgeRisks: Boolean(input.acknowledgeRisks),
    }),
  );

  return {
    previewId,
    selectedArticleIds,
    reason,
    acknowledgeRisks: Boolean(input.acknowledgeRisks),
    requestToken,
    createdBy,
    selectionHash,
    requestPayloadHash,
  };
}

function assertSamePayload(batch: DelegateArgs, normalized: RebindBatchRequestFingerprint): void {
  const same =
    batch.createdBy === normalized.createdBy &&
    batch.previewId === normalized.previewId &&
    batch.selectionHash === normalized.selectionHash &&
    batch.requestPayloadHash === normalized.requestPayloadHash &&
    batch.reason === normalized.reason &&
    Boolean(batch.acknowledgeRisks) === normalized.acknowledgeRisks;
  if (!same) {
    rebindBatchDomainError("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", "requestToken is already bound to a different payload");
  }
}

/** CPS parity: `activeArticleLocks` — articles already claimed by a pending/processing item of ANOTHER batch. */
async function activeArticleLocks(db: RebindBatchDb, articleIds: readonly string[]): Promise<Set<string>> {
  const rows = await db.articleNovelRebindBatchItem.findMany({
    where: { articleId: { in: articleIds }, status: { in: ["pending", "processing"] } },
    select: { articleId: true },
  });
  return new Set<string>((rows as Array<{ articleId: string }>).map((row) => row.articleId));
}

async function createBatchOnce(
  db: RebindBatchDb,
  input: {
    normalized: RebindBatchRequestFingerprint;
    preview: DelegateArgs;
    rowsByArticle: Map<string, { oldNovelId: string; targetNovelId: string; targetPromoLinkId: string | null }>;
    locked: Set<string>;
  },
): Promise<DelegateArgs> {
  const id = generateRebindBatchId();
  const itemData = input.normalized.selectedArticleIds.map((articleId) => {
    const row = input.rowsByArticle.get(articleId)!;
    const locked = input.locked.has(articleId);
    return {
      batchId: id,
      articleId,
      oldNovelId: row.oldNovelId,
      expectedNewNovelId: row.targetNovelId,
      expectedNewPromoLinkId: row.targetPromoLinkId,
      status: locked ? "skipped" : "pending",
      errorKind: locked ? "blocked" : null,
      errorMessage: locked ? "article is claimed by another active rebind batch" : null,
      finishedAt: locked ? new Date() : null,
    };
  });
  const resolvableCount = itemData.filter((item) => item.status === "pending").length;

  return db.$transaction(async (tx) => {
    const created = await tx.articleNovelRebindBatch.create({
      data: {
        id,
        createdBy: input.normalized.createdBy,
        requestToken: input.normalized.requestToken,
        previewId: input.normalized.previewId,
        selectionHash: input.normalized.selectionHash,
        requestPayloadHash: input.normalized.requestPayloadHash,
        sourceChannelCode: input.preview.sourceChannelCode,
        targetChannelCode: input.preview.targetChannelCode,
        status: "ready",
        acknowledgeRisks: input.normalized.acknowledgeRisks,
        submittedCount: itemData.length,
        resolvableCount,
        filtersJson: input.preview.filtersJson,
        planHash: input.preview.planHash,
        reason: input.normalized.reason,
      },
    });
    await tx.articleNovelRebindBatchItem.createMany({ data: itemData });
    return created;
  });
}

/** CPS parity: `createDurableBatchAtomically` — unique-constraint race on `request_token` falls back to the row created by the winner; two attempts to re-check active-article locks. */
async function createBatchAtomically(
  db: RebindBatchDb,
  input: {
    normalized: RebindBatchRequestFingerprint;
    preview: DelegateArgs;
    rowsByArticle: Map<string, { oldNovelId: string; targetNovelId: string; targetPromoLinkId: string | null }>;
  },
): Promise<{ batch: DelegateArgs; created: boolean }> {
  let locked = await activeArticleLocks(db, input.normalized.selectedArticleIds);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const batch = await createBatchOnce(db, { ...input, locked });
      return { batch, created: true };
    } catch (error) {
      const existing = await db.articleNovelRebindBatch.findUnique({ where: { requestToken: input.normalized.requestToken } });
      if (existing) {
        assertSamePayload(existing, input.normalized);
        return { batch: existing, created: false };
      }
      if (attempt === 0) {
        locked = await activeArticleLocks(db, input.normalized.selectedArticleIds);
        continue;
      }
      throw error;
    }
  }
  return rebindBatchDomainError("ACTIVE_ARTICLE_CONFLICT_RETRY", "active article ownership kept changing");
}

/** CPS parity: `acquireDurableBatchLease` — conditional update only succeeds when no lease is held or the held one expired. */
export async function acquireRebindBatchLease(db: RebindBatchDb, batchId: string, attempt: string, now = new Date()): Promise<boolean> {
  const leaseExpiresAt = new Date(now.getTime() + REBIND_BATCH_LIMITS.leaseMs);
  const updated = await db.articleNovelRebindBatch.updateMany({
    where: {
      id: batchId,
      status: { in: ["ready", "processing"] },
      OR: [{ executionToken: null }, { leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    },
    data: { status: "processing", executionToken: attempt, leaseExpiresAt, heartbeatAt: now },
  });
  if (updated.count !== 1) return false;
  await db.articleNovelRebindBatch.updateMany({ where: { id: batchId, executionToken: attempt, startedAt: null }, data: { startedAt: now } });
  return true;
}

async function renewRebindBatchLease(db: RebindBatchDb, batchId: string, attempt: string, now = new Date()): Promise<boolean> {
  const updated = await db.articleNovelRebindBatch.updateMany({
    where: { id: batchId, status: "processing", executionToken: attempt, leaseExpiresAt: { gt: now } },
    data: { leaseExpiresAt: new Date(now.getTime() + REBIND_BATCH_LIMITS.leaseMs), heartbeatAt: now },
  });
  return updated.count === 1;
}

async function leaseRemainingMs(db: RebindBatchDb, batchId: string, attempt: string): Promise<number> {
  const batch = await db.articleNovelRebindBatch.findFirst({ where: { id: batchId, executionToken: attempt, status: "processing" }, select: { leaseExpiresAt: true } });
  return batch?.leaseExpiresAt ? new Date(batch.leaseExpiresAt).getTime() - Date.now() : 0;
}

async function guardBatchFence(tx: RebindBatchTxClient, batchId: string, attempt: string, now = new Date()): Promise<void> {
  const guarded = await tx.articleNovelRebindBatch.updateMany({
    where: { id: batchId, status: "processing", executionToken: attempt, leaseExpiresAt: { gt: now } },
    data: { heartbeatAt: now },
  });
  if (guarded.count !== 1) rebindBatchDomainError("EXECUTION_FENCE_LOST");
}

export type ClaimRebindBatchItemResult = "claimed" | "terminal" | "lost";

/** CPS parity: `claimDurableBatchItem` — batch-fence check + item conditional claim, both inside one transaction. */
export async function claimRebindBatchItem(db: RebindBatchDb, input: { batchId: string; itemId: string; attempt: string }): Promise<ClaimRebindBatchItemResult> {
  return db.$transaction(async (tx) => {
    try {
      await guardBatchFence(tx, input.batchId, input.attempt);
    } catch {
      return "lost";
    }
    const claimed = await tx.articleNovelRebindBatchItem.updateMany({
      where: { id: input.itemId, batchId: input.batchId, status: { in: ["pending", "processing"] } },
      data: { status: "processing", processingToken: input.attempt, startedAt: new Date() },
    });
    if (claimed.count === 1) return "claimed";
    const item = await tx.articleNovelRebindBatchItem.findUnique({ where: { id: input.itemId }, select: { status: true } });
    return item && ["applied", "skipped", "failed"].includes(item.status) ? "terminal" : "lost";
  });
}

/** CPS parity: `classifyDurableSwitchError`. */
function classifyItemError(error: unknown): { kind: "drift" | "not_found" | "blocked" | "ineligible" | "fence_lost" | "unknown"; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RebindDriftError) return { kind: "drift", message };
  if (error instanceof RebindArticleNotEligibleError) {
    return { kind: error.code === "ARTICLE_NOT_FOUND" ? "not_found" : "ineligible", message };
  }
  if (error instanceof RebindGuardBlockedError) return { kind: "blocked", message };
  if (/EXECUTION_FENCE_LOST/i.test(message)) return { kind: "fence_lost", message };
  return { kind: "unknown", message };
}

/** CPS parity: `markDurableItemErrorWithFence` — a fence-lost failure is NEVER recorded as a terminal `failed` item; it just aborts (so a future resume can re-claim it). */
async function markItemErrorWithFence(db: RebindBatchDb, input: { batchId: string; itemId: string; attempt: string; error: unknown }): Promise<boolean> {
  const classified = classifyItemError(input.error);
  if (classified.kind === "fence_lost") return false;
  return db.$transaction(async (tx) => {
    try {
      await guardBatchFence(tx, input.batchId, input.attempt);
    } catch {
      return false;
    }
    const updated = await tx.articleNovelRebindBatchItem.updateMany({
      where: { id: input.itemId, batchId: input.batchId, status: "processing", processingToken: input.attempt },
      data: { status: "failed", errorKind: classified.kind, errorMessage: classified.message.slice(0, 1000), finishedAt: new Date() },
    });
    return updated.count === 1;
  });
}

export type ProcessedRebindBatchItemResult = { locale: string; slug: string; publicPageShortId: string };

/**
 * 🔴 One transaction PER ITEM. Batch fence check, item fence re-check, the
 * shared guard-then-write-then-audit core (`./service.ts`'s
 * `runRebindTransactionalWrite` — guards re-evaluated fresh, never trusting
 * the preview), then the item's own terminal-state write — all inside this
 * one `db.$transaction` call, and no other item's transaction.
 */
export async function processRebindBatchItem(
  db: RebindBatchDb,
  input: { batch: DelegateArgs; item: DelegateArgs; attempt: string },
): Promise<ProcessedRebindBatchItemResult> {
  return db.$transaction(async (tx) => {
    await guardBatchFence(tx, input.batch.id, input.attempt);
    const itemFence = await tx.articleNovelRebindBatchItem.updateMany({
      where: { id: input.item.id, batchId: input.batch.id, status: "processing", processingToken: input.attempt },
      data: { processingToken: input.attempt },
    });
    if (itemFence.count !== 1) rebindBatchDomainError("EXECUTION_FENCE_LOST");

    const result = await runRebindTransactionalWrite(tx, {
      articleId: input.item.articleId,
      expectedOldNovelId: input.item.oldNovelId,
      targetNovelId: input.item.expectedNewNovelId,
      reason: input.batch.reason,
      acknowledgeRisks: input.batch.acknowledgeRisks,
      actorId: input.batch.createdBy,
      requestId: `${input.batch.id}:${input.item.id}`,
      action: "article.rebind_novel",
    });

    const terminal = await tx.articleNovelRebindBatchItem.updateMany({
      where: { id: input.item.id, batchId: input.batch.id, status: "processing", processingToken: input.attempt },
      data: {
        status: "applied",
        oldPromoLinkId: result.oldPromoLinkId,
        appliedNewNovelId: result.newNovelId,
        appliedNewPromoLinkId: result.newPromoLinkId,
        auditId: BigInt(result.auditId),
        finishedAt: new Date(),
      },
    });
    if (terminal.count !== 1) rebindBatchDomainError("EXECUTION_FENCE_LOST");
    return { locale: result.locale, slug: result.slug, publicPageShortId: result.publicPageShortId };
  });
}

export type RebindBatchCounts = { submitted: number; resolvable: number; applied: number; skipped: number; failed: number; pending: number; processing: number };

export type RebindBatchDetail = {
  batchId: string;
  status: "ready" | "processing" | "interrupted" | "completed" | "partial" | "failed";
  persistedStatus: "ready" | "processing" | "completed" | "partial" | "failed";
  requestToken: string;
  previewId: string;
  createdBy: string;
  sourceChannelCode: string;
  targetChannelCode: string;
  reason: string;
  acknowledgeRisks: boolean;
  counts: RebindBatchCounts;
  leaseExpiresAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  items: Array<{
    id: string;
    articleId: string;
    oldNovelId: string;
    expectedNewNovelId: string;
    appliedNewNovelId: string | null;
    status: string;
    errorKind: string | null;
    errorMessage: string | null;
    auditId: string | null;
  }>;
};

function countItemStatuses(items: readonly DelegateArgs[]): { applied: number; skipped: number; failed: number; pending: number; processing: number } {
  const counts = { applied: 0, skipped: 0, failed: 0, pending: 0, processing: 0 };
  for (const item of items) if (item.status in counts) counts[item.status as keyof typeof counts] += 1;
  return counts;
}

/** CPS parity: `toDurableBatchDetail` — accounting assertion + "已中断可续跑" derived state. */
function toBatchDetail(batch: DelegateArgs): RebindBatchDetail {
  const items = (batch.items ?? []) as DelegateArgs[];
  const counts = countItemStatuses(items);
  const submitted = Number(batch.submittedCount);
  if (submitted !== counts.applied + counts.skipped + counts.failed + counts.pending + counts.processing) {
    rebindBatchDomainError("BATCH_ACCOUNTING_MISMATCH", "batch item counts do not reconcile");
  }
  const persistedStatus = batch.status as RebindBatchDetail["persistedStatus"];
  const leaseExpired = !batch.leaseExpiresAt || new Date(batch.leaseExpiresAt).getTime() <= Date.now();
  const status: RebindBatchDetail["status"] =
    persistedStatus === "processing" && leaseExpired && counts.pending + counts.processing > 0 ? "interrupted" : persistedStatus;

  return {
    batchId: batch.id,
    status,
    persistedStatus,
    requestToken: batch.requestToken,
    previewId: batch.previewId,
    createdBy: batch.createdBy,
    sourceChannelCode: batch.sourceChannelCode,
    targetChannelCode: batch.targetChannelCode,
    reason: batch.reason,
    acknowledgeRisks: Boolean(batch.acknowledgeRisks),
    counts: { submitted, resolvable: Number(batch.resolvableCount), ...counts },
    leaseExpiresAt: iso(batch.leaseExpiresAt),
    startedAt: iso(batch.startedAt),
    finishedAt: iso(batch.finishedAt),
    createdAt: iso(batch.createdAt)!,
    items: items.map((item) => ({
      id: item.id,
      articleId: item.articleId,
      oldNovelId: item.oldNovelId,
      expectedNewNovelId: item.expectedNewNovelId,
      appliedNewNovelId: item.appliedNewNovelId ?? null,
      status: item.status,
      errorKind: item.errorKind ?? null,
      errorMessage: item.errorMessage ?? null,
      auditId: item.auditId !== null && item.auditId !== undefined ? String(item.auditId) : null,
    })),
  };
}

async function loadBatchWithItems(db: RebindBatchDb, where: DelegateArgs): Promise<DelegateArgs | null> {
  return (db as unknown as { articleNovelRebindBatch: { findFirst(args: DelegateArgs): Promise<DelegateArgs | null> } }).articleNovelRebindBatch.findFirst({
    where,
    include: { items: { orderBy: { id: "asc" } } },
  });
}

export async function getRebindBatchDetail(
  dbClient: PrismaClient | RebindBatchDb,
  input: { batchId: string; createdBy: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<RebindBatchDetail> {
  if (!isArticleNovelRebindEnabled(env)) throw new RebindFeatureDisabledError();
  const db = dbClient as unknown as RebindBatchDb;
  const batch = await loadBatchWithItems(db, { id: trimText(input.batchId), createdBy: input.createdBy });
  if (!batch) rebindBatchDomainError("BATCH_NOT_FOUND");
  return toBatchDetail(batch);
}

export async function getRebindBatchByRequestToken(
  dbClient: PrismaClient | RebindBatchDb,
  input: { requestToken: string; createdBy: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<RebindBatchDetail | null> {
  if (!isArticleNovelRebindEnabled(env)) throw new RebindFeatureDisabledError();
  const db = dbClient as unknown as RebindBatchDb;
  const token = normalizeRequestToken(input.requestToken);
  const batch = await loadBatchWithItems(db, { requestToken: token, createdBy: input.createdBy });
  return batch ? toBatchDetail(batch) : null;
}

/** CPS parity: `finalizeDurableBatch` — three-way terminal status, or a false return while items remain pending/processing. */
export async function finalizeRebindBatch(db: RebindBatchDb, input: { batchId: string; attempt: string }): Promise<boolean> {
  return db.$transaction(async (tx) => {
    try {
      await guardBatchFence(tx, input.batchId, input.attempt);
    } catch {
      return false;
    }
    const groups = await tx.articleNovelRebindBatchItem.groupBy({ by: ["status"], where: { batchId: input.batchId }, _count: { _all: true } });
    const count = (status: string) => (groups as Array<{ status: string; _count: { _all: number } }>).find((g) => g.status === status)?._count._all ?? 0;
    const applied = count("applied");
    const skipped = count("skipped");
    const failed = count("failed");
    const pending = count("pending");
    const processing = count("processing");
    if (pending > 0 || processing > 0) {
      await tx.articleNovelRebindBatch.updateMany({ where: { id: input.batchId, executionToken: input.attempt }, data: { appliedCount: applied, skippedCount: skipped, failedCount: failed } });
      return false;
    }
    const status = applied === 0 ? "failed" : skipped > 0 || failed > 0 ? "partial" : "completed";
    const updated = await tx.articleNovelRebindBatch.updateMany({
      where: { id: input.batchId, status: "processing", executionToken: input.attempt, leaseExpiresAt: { gt: new Date() } },
      data: { status, appliedCount: applied, skippedCount: skipped, failedCount: failed, finishedAt: new Date(), executionToken: null, leaseExpiresAt: null },
    });
    return updated.count === 1;
  });
}

export async function releaseRebindBatchLease(db: RebindBatchDb, input: { batchId: string; attempt: string }): Promise<boolean> {
  const updated = await db.articleNovelRebindBatch.updateMany({ where: { id: input.batchId, status: "processing", executionToken: input.attempt }, data: { executionToken: null, leaseExpiresAt: null } });
  return updated.count === 1;
}

/**
 * CPS parity: `executeDurableBatch`. Acquires the lease, iterates
 * pending/processing items one `processRebindBatchItem` transaction at a
 * time (renewing the lease on a节奏 or when running low), finalizes, and —
 * `finally` — always releases the lease. Collects `{locale,slug,shortId}`
 * for every item that actually applied so the caller can invalidate the
 * public cache once, sequentially, AFTER this whole run (施工工单 §4B.2 —
 * never inside any per-item transaction, no outbox table).
 *
 * C-30 单 3 W-2 (施工工单_C30单3..._2026-09-09.md §3.2/§3.4) — CPS has no
 * equivalent of this gate (CPS's own proxy window is double this repo's;
 * see `REBIND_BATCH_LIMITS`'s own comment for the derivation). The loop
 * now also stops once it has spent `REBIND_BATCH_LIMITS.requestBudgetMs`
 * of wall clock since entering it, so a request that would otherwise run
 * past nginx's `proxy_read_timeout 30s` and get its connection cut — while
 * the write loop keeps running server-side, unseen by the operator — stops
 * itself first and lands in the SAME "interrupted, resumable" state as any
 * other lease/claim `break` below. `resumeRebindBatch` calls this same
 * function, unchanged, so a resumed run is bound by the identical budget —
 * a multi-round batch just means the operator clicks "继续执行" more than
 * once, each round advancing one budget window's worth of items.
 *
 * `now` is the one test-only signature extension this order allows
 * (施工工单 §5.1): optional, defaults to `Date.now`, so every non-test call
 * site is byte-for-byte unchanged. Deliberately NOT a global `Date.now`
 * mock in tests — `leaseRemainingMs` below does its own real-time query
 * against the lease row, and mocking the global clock would drag that
 * along with it.
 */
export async function executeRebindBatch(
  db: RebindBatchDb,
  input: { batchId: string; attempt?: string },
  now: () => number = Date.now,
): Promise<ProcessedRebindBatchItemResult[]> {
  const attempt = input.attempt ?? randomUUID();
  const invalidations: ProcessedRebindBatchItemResult[] = [];
  if (!(await acquireRebindBatchLease(db, input.batchId, attempt))) {
    const batch = await db.articleNovelRebindBatch.findUnique({ where: { id: input.batchId }, select: { status: true } });
    if (batch && ["completed", "partial", "failed"].includes(batch.status)) rebindBatchDomainError("BATCH_TERMINAL");
    rebindBatchDomainError("BATCH_ALREADY_RUNNING");
  }

  const batch = await db.articleNovelRebindBatch.findUnique({ where: { id: input.batchId } });
  if (!batch) rebindBatchDomainError("BATCH_NOT_FOUND");
  let processedSinceRenew = 0;
  try {
    const items = await db.articleNovelRebindBatchItem.findMany({ where: { batchId: input.batchId, status: { in: ["pending", "processing"] } }, orderBy: { id: "asc" } });
    const startedAt = now();
    for (const item of items as DelegateArgs[]) {
      // W-2's only new stop condition. Checked BEFORE the renew/claim
      // steps below — i.e. before claiming the next item, never after —
      // and between items only, never inside `processRebindBatchItem`'s
      // own transaction: an in-flight item always finishes. `break` (not
      // `return`) so this falls into the exact same finalize path the
      // three pre-existing lease/claim `break`s already use.
      if (now() - startedAt >= REBIND_BATCH_LIMITS.requestBudgetMs) break;
      if (processedSinceRenew >= REBIND_BATCH_LIMITS.leaseRenewEvery || (await leaseRemainingMs(db, input.batchId, attempt)) < REBIND_BATCH_LIMITS.leaseRenewThresholdMs) {
        if (!(await renewRebindBatchLease(db, input.batchId, attempt))) break;
        processedSinceRenew = 0;
      }
      const claimed = await claimRebindBatchItem(db, { batchId: input.batchId, itemId: item.id, attempt });
      if (claimed === "terminal") continue;
      if (claimed !== "claimed") break;
      try {
        const processed = await processRebindBatchItem(db, { batch, item, attempt });
        invalidations.push(processed);
      } catch (error) {
        const marked = await markItemErrorWithFence(db, { batchId: input.batchId, itemId: item.id, attempt, error });
        if (!marked) break;
      }
      processedSinceRenew += 1;
    }
    await finalizeRebindBatch(db, { batchId: input.batchId, attempt });
  } finally {
    await releaseRebindBatchLease(db, { batchId: input.batchId, attempt });
  }
  return invalidations;
}

function invalidateAll(results: readonly ProcessedRebindBatchItemResult[]): void {
  for (const result of results) {
    invalidateRebindArticleCache({ locale: result.locale, slug: result.slug, publicPageShortId: result.publicPageShortId });
  }
}

export type SubmitAndExecuteRebindBatchResult = { detail: RebindBatchDetail; created: boolean };

/**
 * CPS parity: `applyDurableBatch`. Idempotent on `requestToken`
 * (same-token-same-payload replays the existing batch's detail without a
 * second write; same-token-different-payload is a hard error), validates
 * every selected id is an `executable` row of an owned, unexpired preview,
 * creates the batch + items atomically, then runs it to completion (or
 * until the lease/time budget runs out) before returning.
 */
export async function submitRebindBatch(
  dbClient: PrismaClient | RebindBatchDb,
  input: SubmitRebindBatchInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SubmitAndExecuteRebindBatchResult> {
  if (!isArticleNovelRebindEnabled(env)) throw new RebindFeatureDisabledError();
  if (!isArticleNovelRebindWriteAllowed(env)) throw new RebindWriteDisabledError();
  const db = dbClient as unknown as RebindBatchDb;

  const normalized = buildRebindBatchRequestFingerprint(input);
  const existing = await db.articleNovelRebindBatch.findUnique({ where: { requestToken: normalized.requestToken } });
  if (existing) {
    assertSamePayload(existing, normalized);
    return { detail: await getRebindBatchDetail(db, { batchId: existing.id, createdBy: normalized.createdBy }, env), created: false };
  }

  // CPS parity: `applyDurableBatch` runs the bounded expired-preview sweep at
  // exactly this point, immediately before loading the owned preview
  // (`article-drama-batch-switch-service.ts:2961`,
  // `await cleanupExpiredBatchSwitchPreviews(db).catch(() => 0)`). This is the
  // ONLY call site the reference implementation has, so without it
  // `cleanupExpiredRebindPreviews` is dead code and
  // `article_novel_rebind_preview` — whose `matches_json` holds every
  // classified row of a scan bounded only by `sourceScan: 20_000` — grows
  // without bound. Never allowed to fail the submit: the sweep is
  // housekeeping, the batch is the operator's actual request.
  await cleanupExpiredRebindPreviews(db).catch(() => 0);
  const preview = await loadOwnedRebindPreview(db, normalized.previewId, normalized.createdBy);
  const snapshot = preview.matchesJson as RebindPreviewSnapshot;
  const rowsByArticle = new Map<string, { oldNovelId: string; targetNovelId: string; targetPromoLinkId: string | null }>();
  for (const row of snapshot.rows) {
    if (row.category === "executable" && row.targetNovelId) {
      rowsByArticle.set(row.articleId, { oldNovelId: row.oldNovelId, targetNovelId: row.targetNovelId, targetPromoLinkId: row.targetPromoLinkId });
    }
  }
  if (normalized.selectedArticleIds.some((id) => !rowsByArticle.has(id))) {
    rebindBatchDomainError("INVALID_SELECTION", "selection contains ids outside the preview's executable rows");
  }

  const created = await createBatchAtomically(db, { normalized, preview, rowsByArticle });
  if (!created.created) {
    return { detail: await getRebindBatchDetail(db, { batchId: created.batch.id, createdBy: normalized.createdBy }, env), created: false };
  }

  const invalidations = await executeRebindBatch(db, { batchId: created.batch.id, attempt: randomUUID() });
  invalidateAll(invalidations);
  return { detail: await getRebindBatchDetail(db, { batchId: created.batch.id, createdBy: normalized.createdBy }, env), created: true };
}

export async function resumeRebindBatch(
  dbClient: PrismaClient | RebindBatchDb,
  input: { batchId: string; createdBy: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<RebindBatchDetail> {
  if (!isArticleNovelRebindEnabled(env)) throw new RebindFeatureDisabledError();
  if (!isArticleNovelRebindWriteAllowed(env)) throw new RebindWriteDisabledError();
  const db = dbClient as unknown as RebindBatchDb;

  const batch = await db.articleNovelRebindBatch.findFirst({ where: { id: trimText(input.batchId), createdBy: input.createdBy } });
  if (!batch) rebindBatchDomainError("BATCH_NOT_FOUND");
  if (["completed", "partial", "failed"].includes(batch.status)) rebindBatchDomainError("BATCH_TERMINAL");
  const invalidations = await executeRebindBatch(db, { batchId: batch.id, attempt: randomUUID() });
  invalidateAll(invalidations);
  return getRebindBatchDetail(db, input, env);
}

/** Type-only re-export so callers only need `import type { PrismaClient } from "@prisma/client"` once at the action layer. */
export type RebindBatchServiceDb = PrismaClient;
