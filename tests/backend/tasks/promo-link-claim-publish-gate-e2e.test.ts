/**
 * P0-S11 end-to-end acceptance test for defect two: `Article.promoLinkId`
 * had no writer anywhere in this codebase, so `promo_link_missing` fired
 * forever even once a PromoLink genuinely reached `fetched` — see
 * `worker/handlers/promo-link-claim.ts`'s `bindPromoLinkToArticles`.
 *
 * Same scope discipline as `tests/backend/content-creation/
 * publish-gate-e2e.test.ts` (P0-S9's mandate-proving test): this drives the
 * *real*, unmodified `evaluatePublishGate` (`src/server/publish-gate/
 * evaluator.ts`) against a facts snapshot built by hand, rather than
 * exercising `loadPublishGateFacts` (`src/server/publish-gate/facts.ts`) —
 * extending `FakePromoLinkClaimHandlerDb` to also satisfy that function's
 * Prisma call shape would be a second, unrelated fake-DB surface for a
 * module this task does not touch. What *is* real and unmodified end to
 * end: `createPromoLinkClaimHandler`'s already-fetched compensation + its
 * `protectedWrite` (`reconcileAlreadyFetchedBinding` →
 * `bindPromoLinkToArticles`) actually
 * runs against the fake DB, and the resulting `Article.promoLinkId` /
 * `PromoLink` row are read back to build the "after" facts — nothing about
 * the binding outcome is asserted directly; it is only ever observed
 * through the real evaluator's `reasons` output, exactly like S9's file
 * proves its own mandate through the real evaluator rather than by
 * inspecting `Article.body` directly.
 */
import { describe, expect, it } from "vitest";

import { evaluatePublishGate, type PublishGateFacts } from "@/server/publish-gate";

import { createPromoLinkClaimHandler, buildPromoLinkIdempotencyKey } from "../../../worker/handlers/promo-link-claim";
import { FakePromoLinkClaimHandlerDb, type FakeArticle, type FakePromoLink } from "./promo-link-claim-handler-fake-db";

const APPLY_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  FEATURE_PROMO_LINK_CLAIM: "true",
  PROMO_LINK_CLAIM_ALLOW_WRITE: "true",
};

// U6 admitted en under D-7. These tests use the explicit locale predicate
// to isolate promo state transitions from whitelist policy. The evaluator
// and content-creation suites separately exercise the real whitelist;
// production publishing must not inject this override.
const GATE_DEPS_SKIP_LAUNCH_WHITELIST = { isPublishableLocale: () => true };

function baseLease(overrides: Partial<{ mode: "dry_run" | "apply" }> = {}) {
  return {
    family: "generic" as const,
    taskType: "promo_link.claim",
    mode: overrides.mode ?? "apply",
    itemId: "item-1",
    taskId: "task-1",
    workerId: "worker-1",
    executionToken: "token-1",
    leaseEpoch: 1n,
    attemptCount: 1,
    lockedUntil: new Date(Date.now() + 60_000),
  };
}

function makePayload() {
  return {
    novelSourceItemId: "source-1",
    offerType: "read",
    channelAccountId: "account-1",
    channelAppId: "app-1",
    actorId: "actor-1",
    requestId: "request-1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

/**
 * Every gate condition *except* `promo_link_missing`/`promo_link_not_ready`
 * is satisfied by construction — this test is only about the one reason
 * `bindPromoLinkToArticles` can make disappear. `promoLink` is the one
 * field this helper derives from live fake-DB state rather than hardcoding,
 * because it is the fact under test.
 */
function buildFacts(article: FakeArticle, promoLink: FakePromoLink | null): PublishGateFacts {
  return {
    novel: { status: "draft", locale: "en" },
    article: { status: "draft", locale: "en", title: "A Publishable Title", slug: "a-publishable-title", body: "Real chapter body content." },
    promoLink: promoLink ? { status: promoLink.status, webUrl: promoLink.webUrl, appUrl: promoLink.appUrl } : null,
    preview: { hasPreviewChapter: true, hasPreviewBody: true },
    pageIdentity: { conflicting: false },
  };
}

function seedFoundation(db: FakePromoLinkClaimHandlerDb) {
  db.seedChannelApp({ id: "app-1", status: "active", channelStatus: "active", channelId: "channel-1", projectType: 1 });
  db.seedChannelAccount({ id: "account-1", channelId: "channel-1", status: "active", deletedAt: null });
  db.seedSourceItem({
    id: "source-1",
    channelAppId: "app-1",
    novelId: "novel-1",
    title: "Exact Target Title",
    status: "linked",
    deletedAt: null,
    rawPayload: { kocCode: "[redacted]", publicUrl: "[redacted]" },
  });
  return db;
}

function seedCatalogPromo(db: FakePromoLinkClaimHandlerDb) {
  const idempotencyKey = buildPromoLinkIdempotencyKey({
    channelAppId: "app-1",
    novelSourceItemId: "source-1",
    channelAccountId: "account-1",
    offerType: "read",
  });
  db.promoLinks.set("promo-link-catalog", {
    id: "promo-link-catalog",
    novelId: "novel-1",
    novelSourceItemId: "source-1",
    channelAppId: "app-1",
    channelAccountId: "account-1",
    offerType: "read",
    origin: "upstream_existing",
    upstreamCode: "REALCODE-E2E",
    publicRedirectCode: "abc123def4",
    webUrl: "https://eng.moboreader.com/promo/e2e",
    appUrl: null,
    idempotencyKey,
    status: "fetched",
    errorKind: null,
    errorMessage: null,
    fetchedAt: new Date(),
    lastAttemptedAt: new Date(),
  });
  return idempotencyKey;
}

describe("P0-S11 end-to-end: promo-link-claim binding → real evaluatePublishGate", () => {
  it("promo_link_missing blocks publish before the claim runs, and disappears once the PromoLink is bound to the Article", async () => {
    const db = seedFoundation(new FakePromoLinkClaimHandlerDb());
    db.seedArticle({ id: "article-en", novelId: "novel-1", locale: "en", promoLinkId: null, deletedAt: null });

    // BEFORE: no PromoLink exists yet — the real defect this task closes.
    const before = evaluatePublishGate(buildFacts(db.articles.get("article-en")!, null), GATE_DEPS_SKIP_LAUNCH_WHITELIST);
    expect(before.reasons).toContain("promo_link_missing");
    expect(before.publishable).toBe(false);

    // Catalog capture owns §3.9 and has written the fetched PromoLink; the
    // claim handler owns only the late-Article binding compensation.
    const idempotencyKey = seedCatalogPromo(db);
    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: APPLY_ENV });
    const outcome = await handler({
      lease: { ...baseLease(), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });
    expect(outcome).toMatchObject({ status: "success", result: { decision: "already_fetched" } });
    await db.runProtectedWrite((outcome as { protectedWrite: (tx: unknown) => Promise<void> }).protectedWrite as never);

    // AFTER: re-read the same Article + its now-bound PromoLink from the
    // fake DB — nothing here is asserted about the write directly, only fed
    // into the real evaluator.
    const boundArticle = db.articles.get("article-en")!;
    expect(boundArticle.promoLinkId).not.toBeNull();
    const promoLinkRow = db.promoLinkByIdempotencyKey(idempotencyKey)!;
    expect(boundArticle.promoLinkId).toBe(promoLinkRow.id);

    const after = evaluatePublishGate(buildFacts(boundArticle, promoLinkRow), GATE_DEPS_SKIP_LAUNCH_WHITELIST);
    expect(after.reasons).not.toContain("promo_link_missing");
    expect(after.reasons).not.toContain("promo_link_not_ready");
    // Every other condition was satisfied by construction — the Article is
    // now genuinely publishable.
    expect(after.reasons).toEqual([]);
    expect(after.publishable).toBe(true);
  });

  it("(control) redacted raw promo evidence cannot clear promo_link_missing", async () => {
    const db = new FakePromoLinkClaimHandlerDb();
    db.seedChannelApp({ id: "app-1", status: "active", channelStatus: "active", channelId: "channel-1", projectType: 1 });
    db.seedChannelAccount({ id: "account-1", channelId: "channel-1", status: "active", deletedAt: null });
    db.seedSourceItem({
      id: "source-1",
      channelAppId: "app-1",
      novelId: "novel-1",
      title: "Exact Target Title",
      status: "linked",
      deletedAt: null,
      rawPayload: { kocCode: "[redacted]" },
    });
    db.seedArticle({ id: "article-en", novelId: "novel-1", locale: "en", promoLinkId: null, deletedAt: null });

    const handler = createPromoLinkClaimHandler(db.asPrismaClient(), { env: APPLY_ENV });
    const outcome = await handler({
      lease: { ...baseLease(), payload: makePayload() },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });
    expect(outcome).toMatchObject({ status: "success", result: { decision: "capability_disabled" } });
    await db.runProtectedWrite((outcome as { protectedWrite: (tx: unknown) => Promise<void> }).protectedWrite as never);

    const article = db.articles.get("article-en")!;
    expect(article.promoLinkId).toBeNull();

    const after = evaluatePublishGate(buildFacts(article, null), GATE_DEPS_SKIP_LAUNCH_WHITELIST);
    expect(after.reasons).toContain("promo_link_missing");
    expect(after.publishable).toBe(false);
  });
});
