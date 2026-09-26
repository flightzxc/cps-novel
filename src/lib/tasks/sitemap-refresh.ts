import { createHash, randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";

import { isSitemapAutoRefreshEnabled } from "@/lib/flags";
import type { PublicationDispatchDb } from "@/server/publication/dispatcher";

export const SITEMAP_REFRESH_TASK_TYPE = "sitemap_refresh";
export const SITEMAP_REFRESH_TARGET_TYPE = "sitemap";
export const SITEMAP_REFRESH_TARGET_ID = "global";
export const SITEMAP_REFRESH_OPERATION_SCOPE_HASH = createHash("sha256")
  .update("sitemap_refresh\nglobal", "utf8")
  .digest("hex");

// Fixed two-int PostgreSQL advisory-lock namespace. pg_advisory_xact_lock is
// released with the surrounding transaction and cannot permanently suppress
// a later refresh.
export const SITEMAP_REFRESH_ADVISORY_LOCK = Object.freeze({ namespace: 50_210, scope: 1 });
const FOLLOW_UP_REQUESTED_KEY = "followUpRequested";

export type SitemapRefreshEnqueueInput = Readonly<{
  reason: string;
  triggeredBy: string;
}>;

export type SitemapRefreshEnqueueResult =
  | { status: "disabled" }
  | { status: "queued"; taskId: string }
  | { status: "coalesced"; taskId: string };

export type SitemapRefreshEnqueueOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  requestToken?: () => string;
}>;

function normalized(value: string, field: string, maxLength: number): string {
  const result = value.trim();
  if (!result || result.length > maxLength) {
    throw new Error(`${field} must contain 1-${maxLength} characters`);
  }
  return result;
}

export async function lockSitemapRefreshScope(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      ${SITEMAP_REFRESH_ADVISORY_LOCK.namespace}::int,
      ${SITEMAP_REFRESH_ADVISORY_LOCK.scope}::int
    )::text AS lock_result
  `);
}

async function enqueueInTransaction(
  tx: Prisma.TransactionClient,
  rawInput: SitemapRefreshEnqueueInput,
  requestToken: () => string,
): Promise<SitemapRefreshEnqueueResult> {
  const reason = normalized(rawInput.reason, "reason", 500);
  const triggeredBy = normalized(rawInput.triggeredBy, "triggeredBy", 160);

  await lockSitemapRefreshScope(tx);

  const active = await tx.genericTask.findFirst({
    where: {
      taskType: SITEMAP_REFRESH_TASK_TYPE,
      operationScopeHash: SITEMAP_REFRESH_OPERATION_SCOPE_HASH,
      status: { in: ["pending", "processing"] },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, status: true },
  });
  if (active) {
    if (active.status === "processing") {
      // The active-scope partial unique index forbids a second pending task
      // until this one is terminal. Persist one bit for its finalize transaction.
      await tx.$executeRaw(Prisma.sql`
        UPDATE generic_task
        SET params = jsonb_set(params, ${[FOLLOW_UP_REQUESTED_KEY]}::text[], 'true'::jsonb, true),
            updated_at = transaction_timestamp()
        WHERE id = ${active.id}::uuid AND status = 'processing'
      `);
    }
    return { status: "coalesced", taskId: active.id };
  }

  const taskId = randomUUID();
  await tx.genericTask.create({
    data: {
      id: taskId,
      taskType: SITEMAP_REFRESH_TASK_TYPE,
      operationScopeHash: SITEMAP_REFRESH_OPERATION_SCOPE_HASH,
      mode: "apply",
      status: "pending",
      requestToken: requestToken(),
      totalCount: 1,
      params: { reason, triggeredBy },
      items: {
        create: {
          targetType: SITEMAP_REFRESH_TARGET_TYPE,
          targetId: SITEMAP_REFRESH_TARGET_ID,
          payload: { reason, triggeredBy },
        },
      },
    },
  });
  return { status: "queued", taskId };
}

/** Called after the original task becomes terminal, in the same locked transaction. */
export async function enqueueSitemapFollowUpIfRequested(
  tx: Prisma.TransactionClient,
  taskId: string,
): Promise<void> {
  const task = await tx.genericTask.findUnique({
    where: { id: taskId },
    select: { status: true, params: true },
  });
  if (!task || !["completed", "completed_with_errors", "failed"].includes(task.status)) return;
  if (!task.params || typeof task.params !== "object" || Array.isArray(task.params)
    || (task.params as Record<string, unknown>)[FOLLOW_UP_REQUESTED_KEY] !== true) return;
  await enqueueInTransaction(tx, {
    reason: "article_first_publish_follow_up",
    triggeredBy: "sitemap-refresh",
  }, () => `sitemap-refresh:follow-up:${taskId}`);
}

function isPrismaClient(db: PublicationDispatchDb): db is PrismaClient {
  return "$transaction" in db;
}

export async function enqueueSitemapRefresh(
  input: SitemapRefreshEnqueueInput,
  db: PublicationDispatchDb,
  options: SitemapRefreshEnqueueOptions = {},
): Promise<SitemapRefreshEnqueueResult> {
  if (!isSitemapAutoRefreshEnabled(options.env)) return { status: "disabled" };
  const requestToken = options.requestToken
    ?? (() => `sitemap-refresh:${randomUUID()}`);

  if (isPrismaClient(db)) {
    return db.$transaction((tx) => enqueueInTransaction(tx, input, requestToken));
  }
  return enqueueInTransaction(db, input, requestToken);
}

/** Frozen PublicationDispatchHandlers.enqueueSitemapRefresh-compatible adapter. */
export const enqueueSitemapRefreshForPublication = (
  input: SitemapRefreshEnqueueInput,
  db: PublicationDispatchDb,
): Promise<unknown> => enqueueSitemapRefresh(input, db);
