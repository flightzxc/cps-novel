/**
 * `PublicationDispatchHandlers.enqueueIndexNow` implementation (Stream E,
 * P2-11).
 *
 * Matches `src/server/publication/dispatcher.ts`'s frozen handler signature
 * exactly (`docs/p2/V020_FOUNDATION_INTERFACES.md` §5). Not wired into any
 * `dispatchFirstPublicPublication(...)` call site by this PR — per that
 * interface doc, "Stream D and Stream E each supply their own ... handler
 * ... and wire it in wherever `dispatchFirstPublicPublication` is called";
 * per this Stream's task book, the integrator adds the one-line `handlers`
 * argument at the existing call site
 * (`src/server/publish-gate/service.ts:361-369`) — see this Stream's wiring
 * notes (`docs/p2/P2_11_INDEXNOW_WIRING_NOTES.md`) for the exact diff.
 *
 * Internally no-ops via its own feature flag (`isIndexNowOutboxEnabled`/
 * `isIndexNowOutboxWriteAllowed`, checked inside `enqueueIndexNowFirstPublish`)
 * rather than the caller needing to know whether IndexNow is turned on —
 * exactly the per-handler self-gating `dispatcher.ts`'s header describes.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

import type { DispatchFirstPublicPublicationInput } from "@/server/publication/dispatcher";

import { enqueueIndexNowFirstPublish } from "./outbox";
import type { EnqueueIndexNowFirstPublishResult } from "./outbox-contract";

export async function enqueueIndexNow(
  input: DispatchFirstPublicPublicationInput,
  db: PrismaClient | Prisma.TransactionClient,
): Promise<EnqueueIndexNowFirstPublishResult> {
  return enqueueIndexNowFirstPublish(db, {
    articleId: input.articleId,
    source: input.source,
    sourceTaskId: input.sourceTaskId,
    eventType: input.eventType,
  });
}
