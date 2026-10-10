/**
 * IndexNow outbox writes: enqueue, manual defer/release, backfill candidate
 * differencing (Stream E, P2-11; batch delivery B-41).
 *
 * Ported COPY_THEN_ADAPT from CPS `src/lib/indexnow-outbox.ts`
 * (`enqueueIndexNowFirstPublish`/`findPublishedWithoutIndexNowDelivery`, plus
 * the review-defer pair narrowed per `outbox-contract.ts`'s header).
 * `docs/governance/port-registry.md` has the per-symbol registration.
 *
 * B-41: publishing and releasing only WRITE outbox rows — they no longer
 * create delivery tasks. The minute sweep (`sweep.ts`) is the single place
 * that creates the one batch delivery task (`ensureIndexNowBatchDeliveryTask`
 * below), so a worker-side and an admin-side publish can never both create a
 * task for the same rows, and a deployment that records rows without
 * delivering them (outbox on, delivery off) leaves no pile of idle tasks.
 * Delay from publish to push is "about one minute when there is no backlog",
 * not a guarantee.
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
import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";

import { chunkIds } from "@/lib/db/chunked-id-lookup";
import { isUniqueConstraintViolation } from "@/lib/db/db-retry";
import { isIndexNowOutboxEnabled, isIndexNowOutboxWriteAllowed } from "@/lib/flags";

import {
  buildBlogIndexNowCanonicalUrl,
  buildIndexNowCanonicalUrl,
  computeIndexNowRevision,
  isBlogIndexNowEligible,
  isNovelIndexNowEligible,
  loadIndexNowCandidateArticle,
  loadIndexNowCandidateArticles,
  type IndexNowCandidateArticleRow,
  type IndexNowEligibilityOptions,
} from "./eligibility";
import {
  INDEXNOW_BATCH_OPERATION_SCOPE_HASH,
  INDEXNOW_BATCH_PAYLOAD_MODE,
  INDEXNOW_BATCH_TARGET_ID,
  INDEXNOW_BATCH_TARGET_TYPE,
  INDEXNOW_DELIVERY_TASK_TYPE,
  INDEXNOW_EVENT_TYPE_DEFAULT,
  type EnqueueIndexNowFirstPublishInput,
  type EnqueueIndexNowFirstPublishResult,
} from "./outbox-contract";

type Db = PrismaClient | Prisma.TransactionClient;

export type EnsureIndexNowBatchDeliveryTaskResult = Readonly<{
  /** True when this call created the task; false when one is already in flight. */
  created: boolean;
  /** The in-flight (or just created) task id; null when a concurrent creator won the race. */
  taskId: string | null;
}>;

/**
 * Ensures there is exactly one in-flight batch delivery task: a `GenericTask`
 * (`taskType = indexnow_delivery`, fixed `operationScopeHash`) with one
 * `GenericTaskItem` (`targetType = indexnow_batch`, `payload = { mode:
 * "batch" }`) that `worker/handlers/indexnow-delivery.ts` turns into one batch
 * of up to 500 URLs and one HTTP request.
 *
 * Merging is done by the database: `generic_task_active_scope_uidx` allows
 * only one `pending`/`processing` task per `(task_type, channel_account_id,
 * channel_app_id, operation_scope_hash)`. This function adds two layers on
 * top so the common case never touches the constraint and the racy case never
 * poisons the caller's transaction:
 *
 *   1. look first — an in-flight batch task means `{ created: false }`;
 *   2. otherwise `createMany({ skipDuplicates: true })`, i.e.
 *      `INSERT … ON CONFLICT DO NOTHING`. A concurrent creator that wins the
 *      race makes this insert a no-op (`count === 0`) instead of raising a
 *      unique-violation, which in PostgreSQL would abort the surrounding
 *      transaction and fail the whole sweep (we cannot catch-and-continue
 *      inside one transaction).
 *
 * Must run inside a transaction: the task row and its only item have to
 * commit together — a task without an item would occupy the unique scope
 * forever and block every later batch. A bare `PrismaClient` is wrapped in a
 * transaction here; the sweep passes its own transaction client.
 */
export async function ensureIndexNowBatchDeliveryTask(
  db: Db,
  params: { reason: string; triggeredBy: string },
): Promise<EnsureIndexNowBatchDeliveryTaskResult> {
  if ("$transaction" in db) {
    return (db as PrismaClient).$transaction((tx) => ensureIndexNowBatchDeliveryTask(tx, params));
  }
  const live = await db.genericTask.findFirst({
    where: {
      taskType: INDEXNOW_DELIVERY_TASK_TYPE,
      operationScopeHash: INDEXNOW_BATCH_OPERATION_SCOPE_HASH,
      status: { in: ["pending", "processing"] },
    },
    select: { id: true },
  });
  if (live) return { created: false, taskId: live.id };

  const taskId = randomUUID();
  const inserted = await db.genericTask.createMany({
    data: [
      {
        id: taskId,
        taskType: INDEXNOW_DELIVERY_TASK_TYPE,
        operationScopeHash: INDEXNOW_BATCH_OPERATION_SCOPE_HASH,
        requestToken: `indexnow_delivery:batch:${randomUUID()}`,
        totalCount: 1,
        params: { mode: INDEXNOW_BATCH_PAYLOAD_MODE, reason: params.reason, triggeredBy: params.triggeredBy },
      },
    ],
    skipDuplicates: true,
  });
  if (inserted.count === 0) return { created: false, taskId: null };
  await db.genericTaskItem.createMany({
    data: [
      {
        taskId,
        targetType: INDEXNOW_BATCH_TARGET_TYPE,
        targetId: INDEXNOW_BATCH_TARGET_ID,
        payload: { mode: INDEXNOW_BATCH_PAYLOAD_MODE },
      },
    ],
  });
  return { created: true, taskId };
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
  // Threaded through to `isNovelIndexNowEligible` for the same reason
  // `eligibility.ts`'s doc comment gives: the real `isPublishableLocale`
  // whitelist is empty pending D-7, which would otherwise make every test
  // of this function's happy path permanently red. Production callers never
  // pass this — see `dispatch-handler.ts`.
  eligibilityOptions?: IndexNowEligibilityOptions,
): Promise<EnqueueIndexNowFirstPublishResult> {
  if (!isIndexNowOutboxEnabled(env) || !isIndexNowOutboxWriteAllowed(env)) {
    return { outcome: "disabled" };
  }
  if ((input.deferUntil && !input.deferReason) || (!input.deferUntil && input.deferReason)) {
    throw new Error("IndexNow deferUntil and deferReason must be provided together");
  }

  const article = await loadIndexNowCandidateArticle(db, input.articleId);
  if (!article) return { outcome: "ineligible" };

  // C-29b: branch by article family — `novel_article` keeps the exact
  // pre-C-29b eligibility/URL calls (`isNovelIndexNowEligible`/
  // `buildIndexNowCanonicalUrl`); the blog family (`articleType !==
  // "novel_article"`, no Novel/PromoLink to pass in, see
  // `eligibility.ts`'s `IndexNowCandidateBlogArticle`) uses the parallel
  // `isBlogIndexNowEligible`/`buildBlogIndexNowCanonicalUrl` pair instead.
  let url: string;
  if (article.articleType === "novel_article") {
    if (!isNovelIndexNowEligible(article, article.novel, article.promoLink, eligibilityOptions)) {
      return { outcome: "ineligible" };
    }
    url = buildIndexNowCanonicalUrl(article);
  } else {
    if (!isBlogIndexNowEligible(article, eligibilityOptions)) {
      return { outcome: "ineligible" };
    }
    url = buildBlogIndexNowCanonicalUrl(article);
  }
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

  // B-41: record only — the minute sweep batches due rows into one delivery task.
  return { outcome: deferred ? "deferred" : "enqueued", outboxId };
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

  // C-15 audit (施工工单_C15 §二.4): this is a manual admin action with no
  // caller wired up yet anywhere in this codebase, so unlike
  // `promo-link-claim.ts`'s enforced `maxBatchSize` there is no code-level
  // cap on `outboxIds.length` to cite as a hard bound -- chunked
  // defensively rather than recorded as bounded.
  let releasedCount = 0;
  for (const idChunk of chunkIds(ids)) {
    const result = await db.indexNowOutbox.updateMany({
      where: {
        id: { in: idChunk },
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
    releasedCount += result.count;
  }
  // B-41: no delivery task here either — released rows are due immediately
  // (`availableAt = now`) and the next minute sweep batches them.
  return { released: releasedCount };
}

// ---------------------------------------------------------------------------
// Backfill candidates (cursor-complete difference query)
// ---------------------------------------------------------------------------

/**
 * Whether the article has ANY `indexnow_outbox` row — any status, any source,
 * any revision. This is the backfill's de-duplication unit: **the backfill
 * de-duplicates per article** (an article with any record is skipped). The
 * database unique key stays `(url, revision)` — unchanged, so a later
 * substantive update could still be pushed again — but this change adds no
 * update-push entry point.
 */
export async function articleHasAnyIndexNowOutbox(db: Db, articleId: string): Promise<boolean> {
  const row = await db.indexNowOutbox.findFirst({ where: { articleId }, select: { id: true } });
  return row !== null;
}

export type IndexNowBackfillCandidate = {
  articleId: string;
  novelId: string;
  locale: string;
  canonicalUrl: string;
  /** `Article.publishedAt`; null when never stamped. Carried into manifest `published_at`. */
  publishedAt: Date | null;
};

export type IndexNowBackfillStats = {
  /** Published novel articles visited by the cursor. */
  scanned: number;
  /** Visited articles that already have at least one outbox row. */
  alreadyHasDelivery: number;
  /** Candidates (no outbox row) that failed the eligibility recheck. */
  ineligible: number;
  eligible: number;
};

/** Eligibility + canonical URL for one loaded article; null when it is not a backfill candidate. */
export function toIndexNowBackfillCandidate(
  article: IndexNowCandidateArticleRow | null | undefined,
  eligibilityOptions?: IndexNowEligibilityOptions,
): IndexNowBackfillCandidate | null {
  // Defense-in-depth narrowing: callers already scope to `novel_article`, but
  // the loader's return type is the shared union — narrow explicitly rather
  // than casting, so a blog-shaped row can never reach the Novel-only calls.
  if (!article || article.articleType !== "novel_article") return null;
  if (!isNovelIndexNowEligible(article, article.novel, article.promoLink, eligibilityOptions)) return null;
  return {
    articleId: article.id,
    novelId: article.novelId,
    locale: article.locale,
    canonicalUrl: buildIndexNowCanonicalUrl(article),
    publishedAt: article.publishedAt ?? null,
  };
}

async function articleIdsWithAnyOutbox(db: Db, articleIds: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const chunk of chunkIds(articleIds)) {
    const rows = await db.indexNowOutbox.findMany({
      where: { articleId: { in: chunk } },
      select: { articleId: true },
    });
    for (const row of rows) if (row.articleId) found.add(row.articleId);
  }
  return found;
}

/**
 * Backfill candidate source (B-41, replaces the 5,000-capped
 * `findPublishedWithoutIndexNowDelivery`). Ported ADAPT from CPS — the
 * difference-query approach the P2-11 audit recommends instead of porting the
 * 236-line manifest-generation script's `batchTaskItem`-keyed query.
 *
 * Walks every published `novel_article` by `id` cursor (`id > cursor ORDER BY
 * id ASC LIMIT pageSize`) until the cursor returns an **empty** page — "the
 * page was shorter than `pageSize`" is deliberately NOT used as the end
 * condition (a short page is not proof of the end for a cursor over a table
 * being written to, and it would silently drop everything after it). Per
 * page: articles with any outbox row are excluded (`articleHasAnyIndexNowOutbox`
 * semantics, one chunked `IN` query), the rest are batch-loaded
 * (`loadIndexNowCandidateArticles`) and run through the same eligibility gate
 * `enqueueIndexNowFirstPublish` uses.
 *
 * Scope is `novel_article`: this manifest's `novel_id` is non-null. Blog
 * articles take the outbox at first publication (C-29b); extending this
 * offline tool to the blog family is a separate change (ADR-B41 known
 * limits).
 */
export async function listPublishedWithoutIndexNowDelivery(
  db: Db,
  options: { pageSize?: number; eligibilityOptions?: IndexNowEligibilityOptions } = {},
): Promise<{ candidates: IndexNowBackfillCandidate[]; stats: IndexNowBackfillStats }> {
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? 1000));
  const candidates: IndexNowBackfillCandidate[] = [];
  const stats: IndexNowBackfillStats = { scanned: 0, alreadyHasDelivery: 0, ineligible: 0, eligible: 0 };

  let cursor: string | undefined;
  for (;;) {
    const page = await db.article.findMany({
      where: {
        status: "published",
        deletedAt: null,
        articleType: "novel_article",
        ...(cursor === undefined ? {} : { id: { gt: cursor } }),
      },
      orderBy: { id: "asc" },
      take: pageSize,
      select: { id: true },
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.id;
    stats.scanned += page.length;

    const ids = page.map((row) => row.id);
    const withOutbox = await articleIdsWithAnyOutbox(db, ids);
    const missingIds = ids.filter((id) => !withOutbox.has(id));
    stats.alreadyHasDelivery += ids.length - missingIds.length;

    const loaded = await loadIndexNowCandidateArticles(db, missingIds);
    for (const id of missingIds) {
      const candidate = toIndexNowBackfillCandidate(loaded.get(id), options.eligibilityOptions);
      if (candidate) {
        candidates.push(candidate);
        stats.eligible++;
      } else {
        stats.ineligible++;
      }
    }
  }
  return { candidates, stats };
}

export type IndexNowArticleIdClassification = {
  /** No such article (or soft-deleted). */
  nonexistent: string[];
  /** Exists, but is not "a published novel_article with no outbox row". */
  outsideCandidates: string[];
  /** A candidate that fails the eligibility recheck. */
  ineligible: string[];
  eligible: IndexNowBackfillCandidate[];
};

/**
 * Classifies an explicit `--article-ids` selection into the four CPS 7e57779
 * buckets by querying ONLY the requested ids (not the cursor result). Order of
 * the returned id lists follows the input order.
 */
export async function classifyIndexNowBackfillArticleIds(
  db: Db,
  articleIds: readonly string[],
  eligibilityOptions?: IndexNowEligibilityOptions,
): Promise<IndexNowArticleIdClassification> {
  const existing = new Map<string, { status: string; articleType: string }>();
  for (const chunk of chunkIds(articleIds)) {
    const rows = await db.article.findMany({
      where: { id: { in: chunk }, deletedAt: null },
      select: { id: true, status: true, articleType: true },
    });
    for (const row of rows) existing.set(row.id, { status: row.status, articleType: row.articleType });
  }
  const nonexistent = articleIds.filter((id) => !existing.has(id));
  const present = articleIds.filter((id) => existing.has(id));
  const withOutbox = await articleIdsWithAnyOutbox(db, present);
  const outsideCandidates = present.filter((id) => {
    const row = existing.get(id)!;
    return row.status !== "published" || row.articleType !== "novel_article" || withOutbox.has(id);
  });
  const outside = new Set(outsideCandidates);
  const remaining = present.filter((id) => !outside.has(id));

  const loaded = await loadIndexNowCandidateArticles(db, remaining);
  const eligible: IndexNowBackfillCandidate[] = [];
  const ineligible: string[] = [];
  for (const id of remaining) {
    const candidate = toIndexNowBackfillCandidate(loaded.get(id), eligibilityOptions);
    if (candidate) eligible.push(candidate);
    else ineligible.push(id);
  }
  return { nonexistent: [...nonexistent], outsideCandidates, ineligible, eligible };
}
