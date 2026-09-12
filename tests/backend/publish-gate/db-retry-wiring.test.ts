/**
 * P0-S2 (db-retry wiring): proves `withDbRetry` (`src/lib/db/db-retry.ts`)
 * is actually reached by `applyPublishTransition`'s and
 * `applyNovelRightsTransition`'s `$transaction` call sites in
 * `src/server/publish-gate/service.ts`, not merely imported.
 *
 * Two things must both be true for each call site:
 *  1. A transient Postgres failure (P1008 lock-wait timeout) thrown by the
 *     first `$transaction` attempt is retried, and the second attempt's
 *     result is what the caller ultimately sees, without double-applying
 *     the write.
 *  2. A business signal — `PublishConflictSignal`, reproduced via the same
 *     TOCTOU interleaving `service.test.ts` already exercises — is
 *     rethrown on the very first attempt, never retried.
 */
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { applyPublishTransition, withdrawNovel } from "@/server/publish-gate/service";

import { FakePublishGateDb } from "./fake-db";
import { issueAuthorization, newStores, seedAdmin, NOW } from "./test-support";

// L10N P4: the `@/lib/locale/locale-canonical` mock that used to live here
// (overriding `isPublishableLocale: () => true`) is dead — the publish-gate
// evaluator's own locale check was already removed in L10N P2, before
// `isPublishableLocale` itself was deleted in P4.

vi.mock("@/server/publication/dispatcher", () => ({
  dispatchFirstPublicPublication: vi.fn().mockResolvedValue({ errors: [] }),
}));

function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`simulated ${code}`, { code, clientVersion: "6.19.2" });
}

/**
 * Wraps a `FakePublishGateDb`'s `$transaction` so its first `failures`
 * calls reject with a transient Prisma error before delegating to the real
 * implementation — simulating a lock-wait timeout on the underlying
 * connection without needing a real Postgres instance. Returns the attempt
 * counter so tests can assert how many times `$transaction` was actually
 * invoked.
 */
function withInjectedTransientFailures(db: InstanceType<typeof FakePublishGateDb>, failures: number) {
  const client = db.asPrismaClient() as unknown as { $transaction: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown> };
  const real = client.$transaction.bind(client);
  const attempts = { count: 0 };
  client.$transaction = (callback: (tx: unknown) => Promise<unknown>) => {
    attempts.count += 1;
    if (attempts.count <= failures) return Promise.reject(prismaError("P1008"));
    return real(callback);
  };
  return attempts;
}

function seedReady(db: InstanceType<typeof FakePublishGateDb>) {
  db.seedNovel({ id: "novel-1", status: "ready", locale: "en", deletedAt: null });
  db.seedArticle({
    id: "article-1",
    novelId: "novel-1",
    locale: "en",
    slug: "some-slug",
    status: "draft",
    title: "Title",
    body: "Body",
    publishedAt: null,
    publishAt: null,
    deletedAt: null,
    promoLink: { id: "promo-1", status: "fetched", webUrl: "https://a", appUrl: null },
  });
  db.seedChapter({ id: "chapter-1", novelId: "novel-1", status: "preview", deletedAt: null, body: "chapter body" });
  return db;
}

describe("db-retry wiring: applyPublishTransition", () => {
  it("retries a transient P1008 failure and succeeds on the second attempt", async () => {
    const db = seedReady(new FakePublishGateDb());
    const attempts = withInjectedTransientFailures(db, 1);

    const result = await applyPublishTransition(db.asPrismaClient(), {
      articleId: "article-1",
      requestId: "req-1",
      actor: { type: "admin", adminId: "admin-1" },
    });

    expect(attempts.count).toBe(2);
    expect(result).toMatchObject({ outcome: "published", articleId: "article-1", firstPublish: true });
    // Exactly one audit row and one committed write — the retry replayed
    // the whole aborted transaction from scratch, it did not double-apply.
    expect(db.audits).toHaveLength(1);
    expect(db.articles.get("article-1")?.status).toBe("published");
  }, 10_000);

  it("gives up and rethrows once every transient failure is exhausted", async () => {
    const db = seedReady(new FakePublishGateDb());
    // withDbRetry's default schedule is [500, 1500, 3000] — 4 total
    // attempts (1 initial + 3 retries). Failing all 4 proves this call site
    // does not swallow a permanently-down database.
    const attempts = withInjectedTransientFailures(db, 4);

    await expect(
      applyPublishTransition(db.asPrismaClient(), {
        articleId: "article-1",
        requestId: "req-1",
        actor: { type: "admin", adminId: "admin-1" },
      }),
    ).rejects.toThrow();
    expect(attempts.count).toBe(4);
    expect(db.audits).toHaveLength(0);
  }, 10_000);

  it("does not retry a PublishConflictSignal — rethrown on the first attempt", async () => {
    // Reproduces the same TOCTOU interleaving as `service.test.ts`'s "rolls
    // back an already-applied Article-side write..." test: a concurrent
    // takedown commits between this transaction's read and its conditional
    // write, so the Novel-side `updateMany` finds `count !== 1` and throws
    // `PublishConflictSignal`. That is a business signal, not a transient
    // DB error — it must not trigger a retry.
    const db = seedReady(new FakePublishGateDb());
    db.onFactsLoaded = () => {
      db.novels.set("novel-1", { id: "novel-1", status: "takedown", locale: "en", deletedAt: null });
    };
    const attempts = withInjectedTransientFailures(db, 0); // no injected failure — just counts attempts

    const result = await applyPublishTransition(db.asPrismaClient(), {
      articleId: "article-1",
      requestId: "req-1",
      actor: { type: "admin", adminId: "admin-1" },
    });

    expect(result).toEqual({ outcome: "conflict" });
    expect(attempts.count).toBe(1);
    expect(db.articles.get("article-1")?.status).toBe("draft");
    expect(db.audits).toHaveLength(0);
  });
});

describe("db-retry wiring: applyNovelRightsTransition (withdrawNovel)", () => {
  function seedPublishedNovel(db: InstanceType<typeof FakePublishGateDb>) {
    db.seedNovel({ id: "novel-1", status: "published", locale: "en", deletedAt: null });
    db.seedArticle({
      id: "article-1",
      novelId: "novel-1",
      locale: "en",
      slug: "s",
      status: "published",
      title: "t",
      body: "b",
      publishedAt: new Date("2026-01-01T00:00:00.000Z"),
      publishAt: null,
      deletedAt: null,
      promoLink: { id: "promo-1", status: "fetched", webUrl: "https://a", appUrl: null },
    });
    return db;
  }

  it("retries a transient P1008 failure and succeeds on the second attempt", async () => {
    const stores = newStores();
    const db = seedPublishedNovel(new FakePublishGateDb());
    const admin = seedAdmin(stores);
    const { authorization, requestId } = await issueAuthorization(stores, "admin.novel.withdraw", admin.token);
    const attempts = withInjectedTransientFailures(db, 1);

    const result = await withdrawNovel(
      { authorization, requestId, novelId: "novel-1", reason: "operator request" },
      { db: db.asPrismaClient(), identities: stores, sessions: stores, now: NOW },
    );

    expect(attempts.count).toBe(2);
    expect(result.novelStatus).toBe("unpublished");
    expect(db.novels.get("novel-1")?.status).toBe("unpublished");
    // Exactly one audit row — the retry replayed the whole aborted
    // transaction from scratch, it did not double-apply the transition.
    expect(db.audits).toHaveLength(1);
  }, 10_000);

  it("does not retry a business-rule rejection (PublishLifecycleError)", async () => {
    // `novel_not_currently_published` is thrown from inside the callback
    // when the source-status precondition fails — a business signal, not a
    // transient DB error. It must not trigger a retry.
    const stores = newStores();
    const db = new FakePublishGateDb();
    db.seedNovel({ id: "novel-1", status: "draft", locale: "en", deletedAt: null });
    const admin = seedAdmin(stores);
    const { authorization, requestId } = await issueAuthorization(stores, "admin.novel.withdraw", admin.token);
    const attempts = withInjectedTransientFailures(db, 0);

    await expect(
      withdrawNovel(
        { authorization, requestId, novelId: "novel-1", reason: "r" },
        { db: db.asPrismaClient(), identities: stores, sessions: stores, now: NOW },
      ),
    ).rejects.toThrow(/not currently published/);
    expect(attempts.count).toBe(1);
  });
});
