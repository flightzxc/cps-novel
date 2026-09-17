/**
 * Publication side-effect dispatcher (v0.2.0 foundation, Stream F). Ported
 * from CPS `src/lib/publication-dispatcher.ts` (46 lines) — the orchestration
 * shape only. This PR does not implement IndexNow delivery/enqueue or
 * Sitemap refresh business logic (that is Stream E / Stream D's job); the
 * handlers below are only ever explicitly supplied by the caller.
 *
 * CPS's version statically imports `enqueueIndexNowFirstPublish` and
 * `enqueueSitemapRefresh` and gates each with its own feature flag
 * (`isIndexNowOutboxEnabled()`/`isSitemapAutoRefreshEnabled()`). Neither of
 * those modules nor flags exist in cps-novel yet. Rather than adding stub
 * enqueue functions or flags that would need to be un-stubbed later (and
 * would be exactly the kind of "IndexNow delivery/enqueue business" this PR
 * is not scoped to implement), this module takes optional `handlers` as a
 * parameter instead of importing them statically:
 *
 *   - Today, Stream A (发布门禁) can call `dispatchFirstPublicPublication`
 *     with no handlers at all and get a safe no-op (empty result, zero
 *     errors, zero side effects) — the call site is wired in from day one,
 *     nothing needs to change there once Streams D/E land.
 *   - Later, Streams D/E supply `enqueueSitemapRefresh`/`enqueueIndexNow`
 *     (each internally deciding whether to no-op via its own feature flag,
 *     matching CPS's per-handler gating) without this dispatcher's public
 *     signature changing.
 *
 * Each handler is invoked independently and its own failure is caught and
 * recorded in `result.errors` rather than thrown, matching CPS's isolation
 * behavior: an IndexNow enqueue failure must never block a Sitemap refresh
 * enqueue or bubble up into the caller's publish transaction.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

export type DispatchFirstPublicPublicationInput = Readonly<{
  articleId: string;
  /** C-29b: `null` for a non-`novel_article` (blog/listicle/guide) — the handlers below are opaque to this value (see `dispatch-handler.ts`), so widening it here is what lets `service.ts` dispatch a blog Article's first publish at all. */
  novelId: string | null;
  locale: string;
  /** Free-form origin tag for audit/troubleshooting, e.g. "admin.article.publish" or a task type. */
  source: string;
  sourceTaskId?: string;
  eventType?: string;
}>;

export type PublicationDispatchDb = PrismaClient | Prisma.TransactionClient;

export type PublicationDispatchHandlers = Readonly<{
  enqueueIndexNow?: (
    input: DispatchFirstPublicPublicationInput,
    db: PublicationDispatchDb,
  ) => Promise<unknown>;
  enqueueSitemapRefresh?: (
    input: Readonly<{ reason: string; triggeredBy: string }>,
    db: PublicationDispatchDb,
  ) => Promise<unknown>;
}>;

export type PublicationDispatchResult = {
  indexnow?: unknown;
  sitemap?: unknown;
  readonly errors: string[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function dispatchFirstPublicPublication(
  input: DispatchFirstPublicPublicationInput,
  db: PublicationDispatchDb,
  handlers: PublicationDispatchHandlers = {},
): Promise<PublicationDispatchResult> {
  const result: PublicationDispatchResult = { errors: [] };

  if (handlers.enqueueIndexNow) {
    try {
      result.indexnow = await handlers.enqueueIndexNow(input, db);
    } catch (error) {
      const message = errorMessage(error);
      result.errors.push(`indexnow:${message}`);
      console.error("[PublicationDispatcher] IndexNow enqueue failed:", message);
    }
  }

  if (handlers.enqueueSitemapRefresh) {
    try {
      result.sitemap = await handlers.enqueueSitemapRefresh(
        {
          reason: input.eventType ?? "article_first_publish",
          triggeredBy: input.sourceTaskId ? `${input.source}#${input.sourceTaskId}` : input.source,
        },
        db,
      );
    } catch (error) {
      const message = errorMessage(error);
      result.errors.push(`sitemap:${message}`);
      console.error("[PublicationDispatcher] sitemap enqueue failed:", message);
    }
  }

  return result;
}
