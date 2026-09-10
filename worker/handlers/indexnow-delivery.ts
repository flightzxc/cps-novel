/**
 * IndexNow delivery `TaskHandler` (Stream E, P2-11).
 *
 * Ported COPY_THEN_ADAPT from CPS `deliverDueIndexNow`
 * (`indexnow-delivery-service.ts:207-368`). One `GenericTaskItem` = one
 * `indexnow_outbox` row's one delivery attempt = one IndexNow HTTP POST
 * (`urlList` with exactly one URL) — see `src/lib/indexnow/sweep.ts`'s
 * header for why item creation and HTTP delivery are split this way, and
 * `src/lib/indexnow/delivery-primitives.ts`'s header for why this forgoes
 * CPS's up-to-500-URL batching.
 *
 * The `indexnow_outbox_attempt` "started" row and the outbox row's flip to
 * `processing` are written *before* the HTTP call and are **not** part of
 * this handler's `protectedWrite` — they commit unconditionally, the same
 * "durable intent before the external call" discipline
 * `docs/p1/P1_OWNER_MINIMUM_CORRECTIONS.md` 修正4 requires of
 * `side_effect_intent` (a different table, same principle: if the worker
 * dies between this write and the HTTP response, `recovery.ts`'s
 * `recoverStaleIndexNowDeliveries` — not `GenericTaskItem` fencing — is what
 * notices and safely retries). The response-side writes below are the same:
 * plain, unfenced updates, not a `protectedWrite`. This is a deliberate
 * choice, not an oversight — see `recovery.ts`'s header for the full
 * argument that `GenericTaskItem` fencing and this table's own
 * started/completed/unknown_outcome state machine answer different
 * questions and do not need to share one transaction.
 */
import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

// `worker/**` runs under plain `tsx` (`docker-compose.yml`'s worker service
// command), not the Next.js bundler — every existing worker handler
// (`worker/handlers/credential.ts`, `worker/handlers/moboreader.ts`) reaches
// into `src/` with relative paths rather than the `@/*` tsconfig alias, so
// this file follows the same convention rather than risking an alias that
// only `tsc --noEmit` resolves.
import { createHandlerRegistry, type TaskHandler } from "../../src/lib/tasks";
import { isIndexNowDeliveryEnabled, isIndexNowDeliveryWriteAllowed } from "../../src/lib/flags";
import { getIndexNowDeliveryConfig, isIndexNowConfigured } from "../../src/server/site-settings/service";

import {
  buildBlogIndexNowCanonicalUrl,
  buildIndexNowCanonicalUrl,
  isBlogIndexNowEligible,
  isNovelIndexNowEligible,
  loadIndexNowCandidateArticle,
  type IndexNowEligibilityOptions,
} from "../../src/lib/indexnow/eligibility";
import {
  classifyIndexNowResult,
  parseRetryAfter,
  resolveOutboxDeliveryStatus,
  summarizeIndexNowValue,
  INDEXNOW_ENDPOINT,
  INDEXNOW_HTTP_TIMEOUT_MS,
} from "../../src/lib/indexnow/delivery-primitives";
import { INDEXNOW_DELIVERY_TASK_TYPE } from "../../src/lib/indexnow/outbox-contract";

type FetchLike = typeof fetch;

type Payload = { outboxId: string };

function payload(value: unknown): Payload {
  const item = value as Partial<Payload>;
  if (!item?.outboxId) throw new Error("indexnow_delivery_payload_invalid");
  return item as Payload;
}

const DUE_STATUSES = new Set(["pending", "retry_wait"]);

export function createIndexNowDeliveryHandler(
  db: PrismaClient,
  fetchImpl: FetchLike = fetch,
  env: NodeJS.ProcessEnv = process.env,
  // Same test-injectability escape hatch as `outbox.ts`'s
  // `enqueueIndexNowFirstPublish` — see that function's doc comment.
  eligibilityOptions?: IndexNowEligibilityOptions,
): TaskHandler {
  return async ({ lease }) => {
    const { outboxId } = payload(lease.payload);

    if (!isIndexNowDeliveryEnabled(env) || !isIndexNowDeliveryWriteAllowed(env)) {
      return { status: "skipped", result: { reason: "delivery_disabled" } };
    }

    const row = await db.indexNowOutbox.findUnique({
      where: { id: outboxId },
      select: { id: true, articleId: true, url: true, status: true, attemptCount: true, maxAttempts: true },
    });
    if (!row || !DUE_STATUSES.has(row.status)) {
      return { status: "skipped", result: { reason: "not_due" } };
    }

    const rawConfig = await getIndexNowDeliveryConfig(db);
    if (!isIndexNowConfigured(rawConfig)) {
      await db.indexNowOutbox.update({
        where: { id: row.id },
        data: { lastErrorKind: "config_missing", lastErrorSummary: "IndexNow host/key/keyLocation is not configured." },
      });
      return { status: "skipped", result: { reason: "config_missing" } };
    }
    // `isIndexNowConfigured` is trim-authoritative but does not itself mutate
    // — trim here before use, same as CPS's `settings.indexNowHost.trim()`
    // at each read site.
    const config = { host: rawConfig.host.trim(), key: rawConfig.key.trim(), keyLocation: rawConfig.keyLocation.trim() };

    // Eligibility-drift recheck (CPS's `cancelEligibilityDrift`): the row may
    // have been due for a while — reverify the Article is still eligible and
    // its canonical URL has not changed (e.g. a slug edit) before spending a
    // submission on it.
    //
    // C-29b 🟠 fix: this used to null-check `article` but not `article.novel`
    // before calling `isNovelIndexNowEligible` — the first blog outbox row
    // to reach this recheck would have thrown (`isPubliclyAccessible` reads
    // `novel.status` unconditionally), since a blog Article has no Novel at
    // all (C-27). Branch by article family instead, same split
    // `outbox.ts`'s `enqueueIndexNowFirstPublish` uses: `novel_article`
    // keeps the exact pre-C-29b `isNovelIndexNowEligible`/
    // `buildIndexNowCanonicalUrl` calls; the blog family uses
    // `isBlogIndexNowEligible`/`buildBlogIndexNowCanonicalUrl` instead.
    const article = row.articleId ? await loadIndexNowCandidateArticle(db, row.articleId) : null;
    let stillEligible = false;
    let currentCanonical: string | null = null;
    if (article) {
      if (article.articleType === "novel_article") {
        stillEligible = isNovelIndexNowEligible(article, article.novel, article.promoLink, eligibilityOptions);
        currentCanonical = stillEligible ? buildIndexNowCanonicalUrl(article) : null;
      } else {
        stillEligible = isBlogIndexNowEligible(article, eligibilityOptions);
        currentCanonical = stillEligible ? buildBlogIndexNowCanonicalUrl(article) : null;
      }
    }
    if (!stillEligible || currentCanonical !== row.url) {
      await db.indexNowOutbox.update({
        where: { id: row.id },
        data: {
          status: "cancelled",
          lastErrorKind: "eligibility_failed",
          lastErrorSummary: article
            ? "Canonical URL changed or the page no longer satisfies publish eligibility."
            : "Article is no longer available.",
          nextAttemptAt: null,
        },
      });
      return { status: "skipped", result: { reason: "eligibility_drift" } };
    }

    // `row.attemptCount` was read via `findUnique` above, not a fenced
    // `SELECT ... FOR UPDATE` — two workers racing the same due row (e.g.
    // after a lease-expiry requeue hands the same `indexNowOutbox` row to a
    // second `GenericTaskItem` before the first one's write lands) can both
    // read the same `attemptCount` and compute the same `attemptNo` here.
    // That race is closed by `IndexNowOutboxAttempt`'s own
    // `@@unique([outboxId, attemptNo])` (`prisma/schema.prisma`), not by an
    // explicit CAS: the loser's `create` below throws a unique-violation and
    // the item fails/retries rather than proceeding. Because this `create`
    // runs *before* the HTTP call, the loser never reaches `fetchImpl` —
    // the unique index is what actually prevents a duplicate submission
    // here, not merely a duplicate audit row
    // (`scratchpad/reports/E-REVIEW.md` §3).
    const attemptNo = row.attemptCount + 1;
    const requestBatchId = randomUUID();
    const requestAt = new Date();
    await db.indexNowOutboxAttempt.create({
      data: {
        outboxId: row.id,
        attemptNo,
        outcome: "started",
        attemptState: "started",
        requestBatchId,
        startedAt: requestAt,
        requestAt,
        batchSize: 1,
        workerTaskId: lease.taskId,
      },
    });
    await db.indexNowOutbox.update({
      where: { id: row.id },
      data: { status: "processing", attemptCount: attemptNo, lastRequestAt: requestAt, payloadHost: config.host },
    });

    let httpStatus: number | null = null;
    let errorKind: string | null = null;
    let responseSummary = "";
    let retryAfterMs = 0;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), INDEXNOW_HTTP_TIMEOUT_MS);
    try {
      const response = await fetchImpl(INDEXNOW_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ host: config.host, key: config.key, keyLocation: config.keyLocation, urlList: [row.url] }),
        signal: controller.signal,
      });
      httpStatus = response.status;
      retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), requestAt.getTime());
      responseSummary = summarizeIndexNowValue(await response.text());
      if (httpStatus === 429) errorKind = "http_429";
      else if (httpStatus >= 500) errorKind = "http_5xx";
      else if (![200, 202].includes(httpStatus)) errorKind = "http_4xx";
    } catch (error) {
      errorKind = error instanceof Error && error.name === "AbortError" ? "timeout" : "network";
      responseSummary = summarizeIndexNowValue(error);
    } finally {
      clearTimeout(timeout);
    }
    const responseAt = new Date();
    const outcome = classifyIndexNowResult(httpStatus, errorKind);

    await db.indexNowOutboxAttempt.updateMany({
      where: { outboxId: row.id, attemptNo },
      data: { attemptState: "completed", outcome, responseAt, httpStatus, errorKind, responseSummary },
    });
    const decision = resolveOutboxDeliveryStatus(outcome, attemptNo, row.maxAttempts, responseAt, retryAfterMs);
    await db.indexNowOutbox.update({
      where: { id: row.id },
      data: {
        status: decision.status,
        lastHttpStatus: httpStatus,
        lastErrorKind: outcome === "accepted" ? null : errorKind,
        lastErrorSummary: outcome === "accepted" ? null : responseSummary,
        lastResponseAt: responseAt,
        nextAttemptAt: decision.nextAttemptAt,
      },
    });

    return { status: "success", result: { outcome, httpStatus } };
  };
}

export function createIndexNowWorkerHandlers(
  db: PrismaClient,
  fetchImpl: FetchLike = fetch,
  env: NodeJS.ProcessEnv = process.env,
) {
  return createHandlerRegistry({
    [INDEXNOW_DELIVERY_TASK_TYPE]: { family: "generic" as const, maxAttempts: 3, handler: createIndexNowDeliveryHandler(db, fetchImpl, env) },
  });
}
