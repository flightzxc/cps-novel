import { describe, expect, it } from "vitest";

import { restoreNovel, takedownNovel, withdrawNovel, PublishLifecycleError } from "@/server/publish-gate/service";

import { FakePublishGateDb } from "./fake-db";
import { NOW, issueAuthorization, newStores, seedAdmin } from "./test-support";

function deps(db: FakePublishGateDb, stores: ReturnType<typeof newStores>) {
  // `now` must match the fixed clock `seedAdmin`/`issueAuthorization` used to
  // build the session fixture — `requireFreshAdminServiceMutation` re-validates
  // the session from scratch, and a real `new Date()` here would see the fixed
  // `lastSeenAt`/`issuedAt` as hours stale and reject with idle/absolute timeout.
  return { db: db.asPrismaClient(), identities: stores, sessions: stores, now: NOW };
}

function seedPublishedNovel(db: FakePublishGateDb) {
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
  db.seedChapter({ id: "chapter-1", novelId: "novel-1", status: "preview", deletedAt: null, body: "chapter body" });
  return db;
}

describe("withdrawNovel", () => {
  it("moves a published Novel and its published Articles to unpublished", async () => {
    const stores = newStores();
    const db = seedPublishedNovel(new FakePublishGateDb());
    const admin = seedAdmin(stores);
    const { authorization, requestId } = await issueAuthorization(stores, "admin.novel.withdraw", admin.token);

    const result = await withdrawNovel(
      { authorization, requestId, novelId: "novel-1", reason: "operator request" },
      deps(db, stores),
    );

    expect(result.novelStatus).toBe("unpublished");
    expect(db.novels.get("novel-1")?.status).toBe("unpublished");
    expect(db.articles.get("article-1")?.status).toBe("unpublished");
    expect(result.affectedArticleIds).toEqual(["article-1"]);
    expect(db.audits[0]).toMatchObject({ action: "novel.withdraw", entityType: "Novel", entityId: "novel-1", reason: "operator request" });
  });

  it("does not delete chapter content — withdraw retains content, unlike takedown", async () => {
    const stores = newStores();
    const db = seedPublishedNovel(new FakePublishGateDb());
    const admin = seedAdmin(stores);
    const { authorization, requestId } = await issueAuthorization(stores, "admin.novel.withdraw", admin.token);
    await withdrawNovel({ authorization, requestId, novelId: "novel-1", reason: "r" }, deps(db, stores));
    expect(db.chapters.get("chapter-1")?.status).toBe("preview");
    expect(db.chapters.get("chapter-1")?.body).toBe("chapter body");
  });

  it("rejects withdrawing a Novel that is not currently published", async () => {
    const stores = newStores();
    const db = new FakePublishGateDb();
    db.seedNovel({ id: "novel-1", status: "draft", locale: "en", deletedAt: null });
    const admin = seedAdmin(stores);
    const { authorization, requestId } = await issueAuthorization(stores, "admin.novel.withdraw", admin.token);
    await expect(
      withdrawNovel({ authorization, requestId, novelId: "novel-1", reason: "r" }, deps(db, stores)),
    ).rejects.toBeInstanceOf(PublishLifecycleError);
  });

  it("rejects a Novel id that does not exist", async () => {
    const stores = newStores();
    const db = new FakePublishGateDb();
    const admin = seedAdmin(stores);
    const { authorization, requestId } = await issueAuthorization(stores, "admin.novel.withdraw", admin.token);
    await expect(
      withdrawNovel({ authorization, requestId, novelId: "missing", reason: "r" }, deps(db, stores)),
    ).rejects.toMatchObject({ code: "novel_not_found" });
  });

  it("requires a non-blank reason", async () => {
    const stores = newStores();
    const db = seedPublishedNovel(new FakePublishGateDb());
    const admin = seedAdmin(stores);
    const { authorization, requestId } = await issueAuthorization(stores, "admin.novel.withdraw", admin.token);
    await expect(
      withdrawNovel({ authorization, requestId, novelId: "novel-1", reason: "   " }, deps(db, stores)),
    ).rejects.toThrow();
  });

  it("is idempotent under a repeated requestId", async () => {
    const stores = newStores();
    const db = seedPublishedNovel(new FakePublishGateDb());
    const admin = seedAdmin(stores);
    const { authorization, requestId } = await issueAuthorization(stores, "admin.novel.withdraw", admin.token);
    const input = { authorization, requestId, novelId: "novel-1", reason: "r" };
    await withdrawNovel(input, deps(db, stores));
    await withdrawNovel(input, deps(db, stores));
    expect(db.audits).toHaveLength(1);
  });

  it("rejects an authorization issued for a different action (capability/entry binding)", async () => {
    const stores = newStores();
    const db = seedPublishedNovel(new FakePublishGateDb());
    const admin = seedAdmin(stores);
    const { authorization, requestId } = await issueAuthorization(stores, "admin.novel.takedown", admin.token);
    await expect(
      withdrawNovel({ authorization, requestId, novelId: "novel-1", reason: "r" }, deps(db, stores)),
    ).rejects.toThrow();
  });
});

describe("takedownNovel", () => {
  it("moves the Novel and every Article to takedown regardless of the Article's own prior status", async () => {
    const stores = newStores();
    const db = seedPublishedNovel(new FakePublishGateDb());
    db.articles.get("article-1")!.status = "draft"; // never-published article under this Novel
    const admin = seedAdmin(stores);
    const { authorization, requestId } = await issueAuthorization(stores, "admin.novel.takedown", admin.token);

    const result = await takedownNovel(
      { authorization, requestId, novelId: "novel-1", reason: "rights claim" },
      deps(db, stores),
    );

    expect(result.novelStatus).toBe("takedown");
    expect(db.novels.get("novel-1")?.status).toBe("takedown");
    expect(db.articles.get("article-1")?.status).toBe("takedown");
  });

  it("deletes NovelChapterContent and marks chapters withdrawn — the only transition that deletes content", async () => {
    const stores = newStores();
    const db = seedPublishedNovel(new FakePublishGateDb());
    const admin = seedAdmin(stores);
    const { authorization, requestId } = await issueAuthorization(stores, "admin.novel.takedown", admin.token);
    await takedownNovel({ authorization, requestId, novelId: "novel-1", reason: "r" }, deps(db, stores));
    expect(db.chapters.get("chapter-1")?.status).toBe("withdrawn");
    expect(db.chapters.get("chapter-1")?.body).toBeNull();
  });

  it("leaves already-withdrawn chapters alone (no redundant delete)", async () => {
    const stores = newStores();
    const db = seedPublishedNovel(new FakePublishGateDb());
    db.seedChapter({ id: "chapter-2", novelId: "novel-1", status: "withdrawn", deletedAt: null, body: null });
    const admin = seedAdmin(stores);
    const { authorization, requestId } = await issueAuthorization(stores, "admin.novel.takedown", admin.token);
    await takedownNovel({ authorization, requestId, novelId: "novel-1", reason: "r" }, deps(db, stores));
    expect(db.calls.filter((c) => c === "novelChapterContent.deleteMany")).toHaveLength(1);
  });

  it("rejects taking down an already-takedown Novel", async () => {
    const stores = newStores();
    const db = seedPublishedNovel(new FakePublishGateDb());
    db.novels.set("novel-1", { id: "novel-1", status: "takedown", locale: "en", deletedAt: null });
    const admin = seedAdmin(stores);
    const { authorization, requestId } = await issueAuthorization(stores, "admin.novel.takedown", admin.token);
    await expect(
      takedownNovel({ authorization, requestId, novelId: "novel-1", reason: "r" }, deps(db, stores)),
    ).rejects.toMatchObject({ code: "novel_already_takedown" });
  });
});

describe("restoreNovel", () => {
  function seedTakendownNovel(db: FakePublishGateDb) {
    db.seedNovel({ id: "novel-1", status: "takedown", locale: "en", deletedAt: null });
    db.seedArticle({
      id: "article-1",
      novelId: "novel-1",
      locale: "en",
      slug: "s",
      status: "takedown",
      title: "t",
      body: "b",
      publishedAt: new Date("2026-01-01T00:00:00.000Z"),
      publishAt: null,
      deletedAt: null,
      promoLink: { id: "promo-1", status: "fetched", webUrl: "https://a", appUrl: null },
    });
    db.seedChapter({ id: "chapter-1", novelId: "novel-1", status: "withdrawn", deletedAt: null, body: null });
    return db;
  }

  it("always restores to draft, never straight back to published (no MANUAL_EXCEPTION)", async () => {
    const stores = newStores();
    const db = seedTakendownNovel(new FakePublishGateDb());
    const admin = seedAdmin(stores);
    const { authorization, requestId } = await issueAuthorization(stores, "admin.novel.restore", admin.token);

    const result = await restoreNovel(
      { authorization, requestId, novelId: "novel-1", reason: "appeal upheld" },
      deps(db, stores),
    );

    expect(result.novelStatus).toBe("draft");
    expect(db.novels.get("novel-1")?.status).toBe("draft");
    expect(db.articles.get("article-1")?.status).toBe("draft");
  });

  it("does not resurrect deleted chapter content — chapters stay withdrawn until re-synced", async () => {
    const stores = newStores();
    const db = seedTakendownNovel(new FakePublishGateDb());
    const admin = seedAdmin(stores);
    const { authorization, requestId } = await issueAuthorization(stores, "admin.novel.restore", admin.token);
    await restoreNovel({ authorization, requestId, novelId: "novel-1", reason: "r" }, deps(db, stores));
    expect(db.chapters.get("chapter-1")?.status).toBe("withdrawn");
    expect(db.chapters.get("chapter-1")?.body).toBeNull();
  });

  it("rejects restoring a Novel that is not currently takedown", async () => {
    const stores = newStores();
    const db = new FakePublishGateDb();
    db.seedNovel({ id: "novel-1", status: "draft", locale: "en", deletedAt: null });
    const admin = seedAdmin(stores);
    const { authorization, requestId } = await issueAuthorization(stores, "admin.novel.restore", admin.token);
    await expect(
      restoreNovel({ authorization, requestId, novelId: "novel-1", reason: "r" }, deps(db, stores)),
    ).rejects.toMatchObject({ code: "novel_not_currently_takedown" });
  });

  it("only moves Articles that were actually takedown, leaving an untouched draft Article alone", async () => {
    const stores = newStores();
    const db = seedTakendownNovel(new FakePublishGateDb());
    db.seedArticle({
      id: "article-2",
      novelId: "novel-1",
      locale: "en",
      slug: "s2",
      status: "draft",
      title: "t2",
      body: "b2",
      publishedAt: null,
      publishAt: null,
      deletedAt: null,
      promoLink: null,
    });
    const admin = seedAdmin(stores);
    const { authorization, requestId } = await issueAuthorization(stores, "admin.novel.restore", admin.token);
    const result = await restoreNovel({ authorization, requestId, novelId: "novel-1", reason: "r" }, deps(db, stores));
    expect(result.affectedArticleIds).toEqual(["article-1"]);
    expect(db.articles.get("article-2")?.status).toBe("draft");
  });
});
