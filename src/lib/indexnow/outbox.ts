/**
 * IndexNow outbox writes: enqueue, manual defer/release, backfill candidate
 * differencing (Stream E, P2-11).
 *
 * Ported COPY_THEN_ADAPT from CPS `src/lib/indexnow-outbox.ts`
 * (`enqueueIndexNowFirstPublish`/`findPublishedWithoutIndexNowDelivery`, plus
 * the review-defer pair narrowed per `outbox-contract.ts`'s header).
 * `docs/governance/port-registry.md` has the per-symbol registration.
 *
 * Idempotency: CPS is `create()` + `catch(P2002)` against a single-column
 * `idempotencyKey` unique index, **not** an upsert
 * (`DECISION-CHECK.md` 核查1a). This module keeps that exact mechanism —
 * `create()` + catching `isUniqueConstraintViolation` — but the conflict
 * target is this codebase's frozen `@@unique([url, revision])` composite
 * instead of a single hashed key. Practical effect: a duplicate `create()`
 * against the *same* `(url, revision)` pair is a true no-op duplicate
 * (CPS's original semantics — resubmitting byte-identical content is a
 * wasted write, not a bug); a `create()` for the *same URL* but a newer
 * `revision` (Article was edited and republished) is a distinct row and a
 * fresh IndexNow submission — see `eligibility.ts`'s
 * `computeIndexNowRevision` doc comment for why that behavior change from
 * CPS is intentional here, not an oversight.
 */
import { createHash, randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";

import { isUniqueConstraintViolation } from "@/lib/db/db-retry";
import { isIndexNowOutboxEnabled, isIndexNowOutboxWriteAllowed } from "@/lib/flags";

import {
  buildIndexNowCanonicalUrl,
  computeIndexNowRevision,
  isNovelIndexNowEligible,
  loadIndexNowCandidateArticle,
} from "./eligibility";
import {
  INDEXNOW_DELIVERY_TASK_TYPE,
  INDEXNOW_EVENT_TYPE_DEFAULT,
  type EnqueueIndexNowFirstPublishInput,
  type EnqueueIndexNowFirstPublishResult,
} from "./outbox-contract";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Creates the `GenericTask` + single `GenericTaskItem` pair that makes one
 * `indexnow_outbox` row claimable by `worker/handlers/indexnow-delivery.ts`.
 * Shared between the immediate "just enqueued, deliver now" path below and
 * `sweep.ts`'s "a retry/release just became due" path — both create exactly
 * one item per due row (see `sweep.ts`'s header for why one row never has
 * two live items at once).
 */
export async function createIndexNowDeliveryTaskItem(
  db: Db,
  outboxId: string,
  params: { reason: string; triggeredBy: string },
): Promise<string> {
  const task = await db.genericTask.create({
    data: {
      taskType: INDEXNOW_DELIVERY_TASK_TYPE,
      // Not used for a concurrency dedup check here (unlike moboreader's use
      // of the same field) — this task is always created 1:1 with a single
      // `GenericTaskItem` for a single outbox row, and `sweep.ts`/
      // `outbox.ts` are what guarantee only one live item ever exists per
      // row. Still required (`GenericTaskCreateInput.operationScopeHash` has
      // no default) and kept deterministic per row for audit traceability.
      operationScopeHash: createHash("sha256").update(outboxId).digest("hex"),
      requestToken: `indexnow_delivery:${outboxId}:${randomUUID()}`,
      totalCount: 1,
      params: { reason: params.reason, triggeredBy: params.triggeredBy, outboxId },
      items: {
        create: [{ targetType: "indexnow_outbox", targetId: outboxId, payload: { outboxId } }],
      },
    },
    select: { id: true },
  });
  await db.indexNowOutbox.update({ where: { id: outboxId }, data: { deliveryTaskId: task.id } });
  return task.id;
}

/**
 * Single-article enqueue — the only shape the frozen dispatcher contract
 * ever calls with (`DispatchFirstPublicPublicationInput.articleId: string`,
 * singular; every `applyPublishTransition` call dispatches one Article at a
 * time even from `publishArticlesBatch`'s loop). CPS's `articleIds: number[]`
 * batch input is therefore not ported — see `port-registry.md`.
 */
export async function enqueueIndexNowFirstPublish(
  db: Db,
  input: EnqueueIndexNowFirstPublishInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EnqueueIndexNowFirstPublishResult> {
  if (!isIndexNowOutboxEnabled(env) || !isIndexNowOutboxWriteAllowed(env)) {
    return { outcome: "disabled" };
  }
  if ((input.deferUntil && !input.deferReason) || (!input.deferUntil && input.deferReason)) {
    throw new Error("IndexNow deferUntil and deferReason must be provided together");
  }

  const article = await loadIndexNowCandidateArticle(db, input.articleId);
  if (!article) return { outcome: "ineligible" };
  if (!isNovelIndexNowEligible(article, article.novel, article.promoLink)) {
    return { outcome: "ineligible" };
  }

  const url = buildIndexNowCanonicalUrl(article);
  const revision = computeIndexNowRevision(article.updatedAt);
  const eventType = input.eventType ?? INDEXNOW_EVENT_TYPE_DEFAULT;
  const now = new Date();
  const deferred = Boolean(input.deferUntil && input.deferUntil.getTime() > now.getTime());

  let outboxId: string;
  try {
    const row = await db.indexNowOutbox.create({
      data: {
        articleId: article.id,
        url,
        revision,
        eventType,
        locale: article.locale,
        status: "pending",
        availableAt: deferred ? input.deferUntil : null,
        deferReason: deferred ? input.deferReason : null,
        source: input.source,
        sourceTaskId: input.sourceTaskId,
      },
      select: { id: true },
    });
    outboxId = row.id;
  } catch (error) {
    if (isUniqueConstraintViolation(error)) return { outcome: "duplicate" };
    throw error;
  }

  if (!deferred) {
    await createIndexNowDeliveryTaskItem(db, outboxId, {
      reason: eventType,
      triggeredBy: input.sourceTaskId ? `${input.source}#${input.sourceTaskId}` : input.source,
    });
    return { outcome: "enqueued", outboxId };
  }
  return { outcome: "deferred", outboxId };
}

export type ReleaseDeferredIndexNowOutboxInput = Readonly<{
  outboxIds: readonly string[];
  reason: string;
  releaseCommit?: string;
  now?: Date;
}>;

/**
 * Manual release of previously-deferred rows — the generic replacement for
 * CPS's automatic terminal-source-task watchdog (`outbox-contract.ts`'s
 * header). `releaseCommit` is written *here*, not at enqueue time: the
 * foundation's schema comment on `IndexNowOutbox.releaseCommit` freezes its
 * meaning as "the deploy commit that released a deferred entry; empty string
 * when never deferred" (`prisma/schema.prisma`), narrower than CPS's
 * unconditional "commit that created this row" — this module follows the
 * foundation's frozen field semantics, not CPS's original write site.
 */
export async function releaseDeferredIndexNowOutbox(
  db: Db,
  input: ReleaseDeferredIndexNowOutboxInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ released: number }> {
  if (!isIndexNowOutboxEnabled(env) || !isIndexNowOutboxWriteAllowed(env)) return { released: 0 };
  const now = input.now ?? new Date();
  const releaseCommit = input.releaseCommit ?? env.GIT_COMMIT?.trim() ?? "";
  const ids = [...new Set(input.outboxIds)];
  if (ids.length === 0) return { released: 0 };

  const result = await db.indexNowOutbox.updateMany({
    where: {
      id: { in: ids },
      status: "pending",
      deferReason: { not: null },
      availableAt: { gt: now },
    },
    data: {
      availableAt: now,
      releasedAt: now,
      releaseReason: input.reason,
      releaseCommit,
    },
  });
  if (result.count === 0) return { released: 0 };

  const released = await db.indexNowOutbox.findMany({
    where: { id: { in: ids }, releasedAt: now, releaseReason: input.reason },
    select: { id: true },
  });
  for (const row of released) {
    await createIndexNowDeliveryTaskItem(db, row.id, { reason: "review_defer_release", triggeredBy: input.reason });
  }
  return { released: result.count };
}

/**
 * Backfill candidate source. Ported ADAPT from CPS
 * `findPublishedWithoutIndexNowDelivery` — the difference-query approach the
 * audit recommends *instead of* porting the 236-line manifest-generation
 * script's `batchTaskItem`-keyed candidate query, which is tied to CPS's AI
 * batch-generation task table this codebase does not have
 * (`P2-07-12-移植审计-2026-08-12/P2-11.md` §5). Published Articles minus
 * Articles that already have at least one `indexnow_outbox` row, each
 * re-checked through the same eligibility gate `enqueueIndexNowFirstPublish`
 * uses.
 */
export async function findPublishedWithoutIndexNowDelivery(
  db: Db,
  limit = 500,
): Promise<Array<{ articleId: string; novelId: string; locale: string; canonicalUrl: string }>> {
  const boundedLimit = Math.max(1, Math.min(limit, 5000));
  const candidates = await db.article.findMany({
    where: { status: "published", deletedAt: null },
    orderBy: { id: "asc" },
    take: boundedLimit,
    select: { id: true },
  });
  if (candidates.length === 0) return [];

  const existing = await db.indexNowOutbox.findMany({
    where: { articleId: { in: candidates.map((row) => row.id) } },
    select: { articleId: true },
  });
  const delivered = new Set(existing.map((row) => row.articleId));
  const missingIds = candidates.map((row) => row.id).filter((id) => !delivered.has(id));

  const results: Array<{ articleId: string; novelId: string; locale: string; canonicalUrl: string }> = [];
  for (const id of missingIds) {
    const article = await loadIndexNowCandidateArticle(db, id);
    if (!article) continue;
    if (!isNovelIndexNowEligible(article, article.novel, article.promoLink)) continue;
    results.push({
      articleId: article.id,
      novelId: article.novelId,
      locale: article.locale,
      canonicalUrl: buildIndexNowCanonicalUrl(article),
    });
  }
  return results;
}
