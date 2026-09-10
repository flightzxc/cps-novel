import { describe, expect, it, vi } from "vitest";

import { publishArticleAsAdmin, publishArticlesBatchAsAdmin } from "@/server/publish-gate/service";

import { FakePublishGateDb } from "./fake-db";
import { NOW, issueAuthorization, newStores, seedAdmin } from "./test-support";

// L10N P4: the `@/lib/locale/locale-canonical` mock that used to live here
// (overriding `isPublishableLocale: () => true`) is dead — the publish-gate
// evaluator's own locale check (`checkLocale`/`isRegisteredSiteLocale`) was
// already removed in L10N P2, before `isPublishableLocale` itself was
// deleted in P4. Nothing in this file's call path reads either symbol.
vi.mock("@/server/publication/dispatcher", () => ({
  dispatchFirstPublicPublication: vi.fn().mockResolvedValue({ errors: [] }),
}));

function deps(db: FakePublishGateDb, stores: ReturnType<typeof newStores>) {
  return { db: db.asPrismaClient(), identities: stores, sessions: stores, now: NOW };
}

function seedReady(db: FakePublishGateDb, id = "article-1") {
  db.seedNovel({ id: "novel-1", status: "ready", locale: "en", deletedAt: null });
  db.seedArticle({
    id,
    novelId: "novel-1",
    locale: "en",
    slug: id,
    status: "draft",
    title: "t",
    body: "b",
    publishedAt: null,
    publishAt: null,
    deletedAt: null,
    promoLink: { id: "promo-1", status: "fetched", webUrl: "https://a", appUrl: null },
  });
  db.seedChapter({ id: "chapter-1", novelId: "novel-1", status: "preview", deletedAt: null, body: "b" });
  return db;
}

describe("publishArticleAsAdmin", () => {
  it("enforces content:publish and delegates to applyPublishTransition, attributing the audit to the admin identity", async () => {
    const stores = newStores();
    const db = seedReady(new FakePublishGateDb());
    const admin = seedAdmin(stores, { identityId: "admin-42" });
    const { authorization, requestId } = await issueAuthorization(stores, "admin.article.publish", admin.token);

    const result = await publishArticleAsAdmin(
      { authorization, requestId, articleId: "article-1" },
      deps(db, stores),
    );

    expect(result).toMatchObject({ outcome: "published", articleId: "article-1" });
    expect(db.audits[0]).toMatchObject({ actorType: "admin", actorId: "admin-42" });
  });

  it("rejects a caller without the content:publish role — enforced at ticket issuance, before the service is ever reached", async () => {
    const stores = newStores();
    const db = seedReady(new FakePublishGateDb());
    const admin = seedAdmin(stores, { role: "editor" }); // not super_admin, the default-deny role for content:publish
    await expect(issueAuthorization(stores, "admin.article.publish", admin.token)).rejects.toThrow(
      "Missing admin capability: content:publish",
    );
    expect(db.articles.get("article-1")?.status).toBe("draft");
  });
});

describe("publishArticlesBatchAsAdmin", () => {
  it("checks the capability once and publishes every eligible item", async () => {
    const stores = newStores();
    const db = seedReady(new FakePublishGateDb(), "article-1");
    db.seedArticle({
      id: "article-2",
      novelId: "novel-1",
      locale: "en",
      slug: "article-2",
      status: "draft",
      title: "t",
      body: "b",
      publishedAt: null,
      publishAt: null,
      deletedAt: null,
      promoLink: { id: "promo-2", status: "fetched", webUrl: "https://a", appUrl: null },
    });
    const admin = seedAdmin(stores);
    const { authorization, requestId } = await issueAuthorization(stores, "admin.article.publish_batch", admin.token);

    const result = await publishArticlesBatchAsAdmin(
      { authorization, requestId, articleIds: ["article-1", "article-2"] },
      deps(db, stores),
    );

    expect(result.results.every((r) => r.result.outcome === "published")).toBe(true);
    expect(db.articles.get("article-1")?.status).toBe("published");
    expect(db.articles.get("article-2")?.status).toBe("published");
  });
});
