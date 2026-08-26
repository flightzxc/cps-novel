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

async function enqueueInTransaction(
  tx: Prisma.TransactionClient,
  rawInput: SitemapRefreshEnqueueInput,
  requestToken: () => string,
): Promise<SitemapRefreshEnqueueResult> {
  const reason = normalized(rawInput.reason, "reason", 500);
  const triggeredBy = normalized(rawInput.triggeredBy, "triggeredBy", 160);

  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      ${SITEMAP_REFRESH_ADVISORY_LOCK.namespace}::int,
      ${SITEMAP_REFRESH_ADVISORY_LOCK.scope}::int
    )
  `);

  const active = await tx.genericTask.findFirst({
    where: {
      taskType: SITEMAP_REFRESH_TASK_TYPE,
      operationScopeHash: SITEMAP_REFRESH_OPERATION_SCOPE_HASH,
      status: { in: ["pending", "processing"] },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (active) return { status: "coalesced", taskId: active.id };

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
