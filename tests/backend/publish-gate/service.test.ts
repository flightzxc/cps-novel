import { describe, expect, it, vi } from "vitest";

import {
  applyPublishTransition,
  publishArticlesBatch,
  publishDueScheduledArticles,
} from "@/server/publish-gate/service";

import { FakePublishGateDb } from "./fake-db";

// L10N P4: the `@/lib/locale/locale-canonical` mock that used to live here
// (overriding `isPublishableLocale: () => true`, so `applyPublishTransition`
// could exercise `evaluatePublishGate`'s "gate passes" path against the
// then-real, empty-whitelist `isPublishableLocale`) is dead — `evaluator.ts`
// dropped its own `checkLocale`/`isRegisteredSiteLocale` locale check
// entirely in L10N P2 (发布门禁语种条件删除, Owner明示例外), before
// `isPublishableLocale` itself was deleted here in P4. There is no locale
// gate left in `evaluatePublishGate` for this mock to have ever needed to
// satisfy since P2.

const dispatchFirstPublicPublication = vi.fn().mockResolvedValue({ errors: [] });
vi.mock("@/server/publication/dispatcher", () => ({
  dispatchFirstPublicPublication: (...args: unknown[]) => dispatchFirstPublicPublication(...args),
}));

function readyArticle(overrides: Partial<Parameters<InstanceType<typeof FakePublishGateDb>["seedArticle"]>[0]> = {}) {
  return {
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
    ...overrides,
  };
}

function seedReady(db: InstanceType<typeof FakePublishGateDb>, overrides: Parameters<typeof readyArticle>[0] = {}) {
  db.seedNovel({ id: "novel-1", status: "ready", locale: "en", deletedAt: null });
  db.seedArticle(readyArticle(overrides));
  db.seedChapter({ id: "chapter-1", novelId: "novel-1", status: "preview", deletedAt: null, body: "chapter body" });
  return db;
}

describe("applyPublishTransition", () => {
  it("returns not_found for a missing or soft-deleted Article", async () => {
    const db = new FakePublishGateDb();
    const result = await applyPublishTransition(db.asPrismaClient(), {
      articleId: "missing",
      requestId: "req-1",
      actor: { type: "admin", adminId: "admin-1" },
    });
    expect(result).toEqual({ outcome: "not_found" });
  });

  it("rejects and writes nothing when the gate fails", async () => {
    dispatchFirstPublicPublication.mockClear();
    const db = seedReady(new FakePublishGateDb(), { promoLink: null });
    const result = await applyPublishTransition(db.asPrismaClient(), {
      articleId: "article-1",
      requestId: "req-1",
      actor: { type: "admin", adminId: "admin-1" },
    });
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.gate.reasons).toEqual(["promo_link_missing"]);
    }
    expect(db.articles.get("article-1")?.status).toBe("draft");
    expect(db.novels.get("novel-1")?.status).toBe("ready");
    expect(db.audits).toHaveLength(0);
    expect(dispatchFirstPublicPublication).not.toHaveBeenCalled();
  });

  it("publishes the Article and its Novel together on a passing gate, and dispatches first-publish", async () => {
    dispatchFirstPublicPublication.mockClear();
    const db = seedReady(new FakePublishGateDb());
    const now = new Date("2026-08-18T00:00:00.000Z");
    const result = await applyPublishTransition(db.asPrismaClient(), {
      articleId: "article-1",
      requestId: "req-1",
      actor: { type: "admin", adminId: "admin-1" },
      now,
    });
    expect(result).toEqual({
      outcome: "published",
      articleId: "article-1",
      novelId: "novel-1",
      locale: "en",
      firstPublish: true,
    });
    expect(db.articles.get("article-1")?.status).toBe("published");
    expect(db.articles.get("article-1")?.publishedAt).toEqual(now);
    expect(db.novels.get("novel-1")?.status).toBe("published");
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({
      actorType: "admin",
      actorId: "admin-1",
      action: "article.publish",
      entityType: "Article",
      entityId: "article-1",
      requestId: "req-1",
    });
    expect(dispatchFirstPublicPublication).toHaveBeenCalledTimes(1);
    expect(dispatchFirstPublicPublication).toHaveBeenCalledWith(
      { articleId: "article-1", novelId: "novel-1", locale: "en", source: "admin.article.publish" },
      db.asPrismaClient(),
      // Integration wiring: both flag-gated side-effect handlers attached.
      {
        enqueueIndexNow: expect.any(Function),
        enqueueSitemapRefresh: expect.any(Function),
      },
    );
  });

  it("does not re-promote an already-published Novel (idempotent no-op on that side)", async () => {
    const db = seedReady(new FakePublishGateDb(), { publishedAt: new Date("2026-01-01T00:00:00.000Z") });
    db.novels.set("novel-1", { id: "novel-1", status: "published", locale: "en", deletedAt: null });
    db.articles.get("article-1")!.status = "unpublished"; // republish path: was public before, withdrawn, now retried
    await applyPublishTransition(db.asPrismaClient(), {
      articleId: "article-1",
      requestId: "req-1",
      actor: { type: "admin", adminId: "admin-1" },
    });
    expect(db.calls.filter((c) => c === "novel.updateMany")).toHaveLength(0);
  });

  it("preserves publishedAt and does not fire dispatch again on a second publish (firstPublish: false)", async () => {
    dispatchFirstPublicPublication.mockClear();
    const originalPublishedAt = new Date("2026-01-01T00:00:00.000Z");
    const db = seedReady(new FakePublishGateDb(), { status: "unpublished", publishedAt: originalPublishedAt });
    const result = await applyPublishTransition(db.asPrismaClient(), {
      articleId: "article-1",
      requestId: "req-1",
      actor: { type: "admin", adminId: "admin-1" },
      now: new Date("2026-08-18T00:00:00.000Z"),
    });
    expect(result).toMatchObject({ outcome: "published", firstPublish: false });
    expect(db.articles.get("article-1")?.publishedAt).toEqual(originalPublishedAt);
    expect(dispatchFirstPublicPublication).not.toHaveBeenCalled();
  });

  it("is idempotent under a repeated requestId: does not write or dispatch twice", async () => {
    dispatchFirstPublicPublication.mockClear();
    const db = seedReady(new FakePublishGateDb());
    const input = {
      articleId: "article-1",
      requestId: "req-1",
      actor: { type: "admin" as const, adminId: "admin-1" },
    };
    await applyPublishTransition(db.asPrismaClient(), input);
    const updateCallsAfterFirst = db.calls.filter((c) => c === "article.updateMany").length;
    await applyPublishTransition(db.asPrismaClient(), input);
    expect(db.calls.filter((c) => c === "article.updateMany")).toHaveLength(updateCallsAfterFirst);
    expect(db.audits).toHaveLength(1);
    expect(dispatchFirstPublicPublication).toHaveBeenCalledTimes(1);
  });

  describe("TOCTOU: concurrent interleaving between the gate's read and its write", () => {
    /**
     * Reproduces `scratchpad/reports/A-REVIEW.md` 必改 1's interleaving
     * exactly, without real threads: `FakePublishGateDb.onFactsLoaded` fires
     * once, right after `loadPublishGateFacts`'s primary Article read
     * returns — precisely the TOCTOU window the review identified — and
     * mutates the store as if a concurrent `takedownNovel` transaction had
     * just committed there. Before the fix this test guards,
     * `article.update`/`novel.update` were unconditional and would have
     * overwritten that interleaved takedown with `published`.
     */
    it("does not overwrite a Novel takedown that commits between the gate read and the write", async () => {
      dispatchFirstPublicPublication.mockClear();
      const db = seedReady(new FakePublishGateDb());
      db.onFactsLoaded = () => {
        // Simulates takedownNovel's effect committing inside the window
        // between this transaction's primary Article read (which observed
        // draft/ready) and everything after it.
        db.novels.set("novel-1", { id: "novel-1", status: "takedown", locale: "en", deletedAt: null });
        const article = db.articles.get("article-1")!;
        article.status = "takedown";
        const chapter = db.chapters.get("chapter-1")!;
        chapter.status = "withdrawn";
        chapter.body = null; // NovelChapterContent deleted by the takedown workflow
      };

      const result = await applyPublishTransition(db.asPrismaClient(), {
        articleId: "article-1",
        requestId: "req-1",
        actor: { type: "admin", adminId: "admin-1" },
      });

      // `loadPublishGateFacts` issues the preview-chapter query *after* the
      // primary Article read (in the `Promise.all` — see `facts.ts`), so it
      // observes the hook's already-committed chapter withdrawal: the gate
      // sees `preview_chapter_missing` and rejects on that basis, never
      // reaching the write. This is READ COMMITTED behaving exactly as it
      // should — each statement in the transaction sees the latest
      // committed data as of that statement, not a single frozen snapshot —
      // and it is a *second*, independent layer of protection on top of the
      // write-side `conflict` check below: whichever part of
      // `loadPublishGateFacts` happens to observe the interleaved commit is
      // what catches it. `firstPublish` is never fired by mistake.
      expect(result).toEqual({
        outcome: "rejected",
        gate: { publishable: false, reasons: ["preview_chapter_missing"], requiredMetadataMissing: null },
      });
      // The interleaved takedown must survive untouched — not silently
      // republished over content whose body no longer exists.
      expect(db.novels.get("novel-1")?.status).toBe("takedown");
      expect(db.articles.get("article-1")?.status).toBe("takedown");
      expect(db.chapters.get("chapter-1")?.body).toBeNull();
      expect(db.audits).toHaveLength(0);
      expect(dispatchFirstPublicPublication).not.toHaveBeenCalled();
    });

    it("rolls back an already-applied Article-side write when the Novel-side conditional write then finds a conflict", async () => {
      // Same window, but only the Novel side changes concurrently (e.g. a
      // second Article on the same Novel triggered the takedown) — the
      // Article-side updateMany runs first and DOES succeed (its own
      // precondition — Article status — was untouched by the hook); the
      // Novel-side conditional write is what then detects the interleaving
      // and throws `PublishConflictSignal`, which must roll back the
      // Article-side write too. Without the throw-to-roll-back fix (an
      // earlier revision just returned `{ outcome: "conflict" }` from inside
      // the transaction), Prisma would have committed that partial write —
      // publishing the Article while reporting "conflict" to the caller.
      const db = seedReady(new FakePublishGateDb());
      db.onFactsLoaded = () => {
        db.novels.set("novel-1", { id: "novel-1", status: "takedown", locale: "en", deletedAt: null });
      };

      const result = await applyPublishTransition(db.asPrismaClient(), {
        articleId: "article-1",
        requestId: "req-1",
        actor: { type: "admin", adminId: "admin-1" },
      });

      expect(result).toEqual({ outcome: "conflict" });
      // The concurrent takedown survives — it was a different, already-
      // committed transaction (`onFactsLoaded` bypasses this transaction's
      // undo log entirely, exactly as a real concurrent COMMIT would).
      expect(db.novels.get("novel-1")?.status).toBe("takedown");
      // This transaction's OWN partial write is rolled back, not committed.
      expect(db.articles.get("article-1")?.status).toBe("draft");
      expect(db.audits).toHaveLength(0);
    });
  });

  it("a system actor (scheduled-publish sweep) records a system-attributed audit row", async () => {
    const db = seedReady(new FakePublishGateDb());
    await applyPublishTransition(db.asPrismaClient(), {
      articleId: "article-1",
      requestId: "req-1",
      actor: { type: "system", source: "scheduled-publish" },
    });
    expect(db.audits[0]).toMatchObject({ actorType: "system", actorId: "scheduled-publish" });
  });
});

describe("publishArticlesBatch", () => {
  it("evaluates the gate per item — one rejection does not block the others", async () => {
    const db = new FakePublishGateDb();
    db.seedNovel({ id: "novel-1", status: "ready", locale: "en", deletedAt: null });
    db.seedChapter({ id: "chapter-1", novelId: "novel-1", status: "preview", deletedAt: null, body: "b" });
    db.seedArticle(readyArticle({ id: "article-ok", slug: "ok" }));
    db.seedArticle(readyArticle({ id: "article-bad", slug: "bad", promoLink: null }));

    const result = await publishArticlesBatch(db.asPrismaClient(), {
      articleIds: ["article-ok", "article-bad"],
      requestId: "batch-1",
      actor: { type: "admin", adminId: "admin-1" },
    });

    expect(result.results).toEqual([
      { articleId: "article-ok", result: expect.objectContaining({ outcome: "published" }) },
      { articleId: "article-bad", result: expect.objectContaining({ outcome: "rejected" }) },
    ]);
    expect(db.articles.get("article-ok")?.status).toBe("published");
    expect(db.articles.get("article-bad")?.status).toBe("draft");
  });

  it("rejects an oversized batch before writing anything", async () => {
    const db = new FakePublishGateDb();
    const ids = Array.from({ length: 201 }, (_, i) => `article-${i}`);
    await expect(
      publishArticlesBatch(db.asPrismaClient(), {
        articleIds: ids,
        requestId: "batch-1",
        actor: { type: "admin", adminId: "admin-1" },
      }),
    ).rejects.toMatchObject({ code: "batch_too_large" });
    expect(db.calls).toHaveLength(0);
  });

  it("a shared batch requestId does not collide across different Article ids (per-item entityId in the idempotency key)", async () => {
    const db = new FakePublishGateDb();
    db.seedNovel({ id: "novel-1", status: "ready", locale: "en", deletedAt: null });
    db.seedChapter({ id: "chapter-1", novelId: "novel-1", status: "preview", deletedAt: null, body: "b" });
    db.seedArticle(readyArticle({ id: "article-a", slug: "a" }));
    db.seedArticle(readyArticle({ id: "article-b", slug: "b" }));
    await publishArticlesBatch(db.asPrismaClient(), {
      articleIds: ["article-a", "article-b"],
      requestId: "same-request-id",
      actor: { type: "admin", adminId: "admin-1" },
    });
    expect(db.articles.get("article-a")?.status).toBe("published");
    expect(db.articles.get("article-b")?.status).toBe("published");
    expect(db.audits).toHaveLength(2);
  });
});

describe("publishDueScheduledArticles", () => {
  it("only picks up draft Articles whose publishAt has passed, gated the same as an interactive publish", async () => {
    const db = new FakePublishGateDb();
    db.seedNovel({ id: "novel-1", status: "ready", locale: "en", deletedAt: null });
    db.seedChapter({ id: "chapter-1", novelId: "novel-1", status: "preview", deletedAt: null, body: "b" });
    const now = new Date("2026-08-18T12:00:00.000Z");
    db.seedArticle(readyArticle({ id: "due", slug: "due", publishAt: new Date("2026-08-18T00:00:00.000Z") }));
    db.seedArticle(readyArticle({ id: "not-due", slug: "not-due", publishAt: new Date("2026-08-19T00:00:00.000Z") }));
    db.seedArticle(readyArticle({ id: "no-schedule", slug: "no-schedule", publishAt: null }));

    const result = await publishDueScheduledArticles(db.asPrismaClient(), { now });

    expect(result.results.map((r) => r.articleId)).toEqual(["due"]);
    expect(db.articles.get("due")?.status).toBe("published");
    expect(db.articles.get("not-due")?.status).toBe("draft");
    expect(db.articles.get("no-schedule")?.status).toBe("draft");
    expect(db.audits[0]).toMatchObject({ actorType: "system", actorId: "scheduled-publish" });
  });
});
