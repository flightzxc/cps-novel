/**
 * Stream C / P2-09 — proves `src/server/publish-gate/service.ts` actually
 * calls `@/server/publication/revalidate` after each write commits, with the
 * correct path-building arguments, and that a thrown invalidation failure
 * never blocks the write path that triggered it.
 *
 * Mocking `@/server/publication/revalidate` here (rather than letting the
 * real module run, as `tests/backend/publish-gate/{service,rights-
 * transitions}.test.ts` implicitly do since they don't mock it) is what
 * makes call-site assertions and the throw-isolation test possible — see
 * `tests/backend/publication/revalidate.test.ts` for the real module's own
 * unit coverage (path construction, `"layout"`-typed chapter subtree call,
 * per-call `revalidatePath` isolation).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/locale/locale-canonical", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/locale/locale-canonical")>();
  return { ...actual, isPublishableLocale: () => true };
});

const revalidatePublicArticlePaths = vi.fn();
const revalidatePublicArticleSet = vi.fn();
const revalidatePublicBlogPaths = vi.fn();
vi.mock("@/server/publication/revalidate", () => ({
  revalidatePublicArticlePaths: (...args: unknown[]) => revalidatePublicArticlePaths(...args),
  revalidatePublicArticleSet: (...args: unknown[]) => revalidatePublicArticleSet(...args),
  revalidatePublicBlogPaths: (...args: unknown[]) => revalidatePublicBlogPaths(...args),
}));

import { applyPublishTransition, restoreNovel, takedownNovel, withdrawNovel } from "@/server/publish-gate/service";

import { FakePublishGateDb } from "./fake-db";
import { NOW, issueAuthorization, newStores, seedAdmin } from "./test-support";

function deps(db: FakePublishGateDb, stores: ReturnType<typeof newStores>) {
  return { db: db.asPrismaClient(), identities: stores, sessions: stores, now: NOW };
}

function seedDraftArticle(overrides: Partial<Parameters<InstanceType<typeof FakePublishGateDb>["seedArticle"]>[0]> = {}) {
  const db = new FakePublishGateDb();
  db.seedNovel({ id: "novel-1", status: "ready", locale: "en", deletedAt: null });
  db.seedArticle({
    id: "article-1",
    novelId: "novel-1",
    locale: "en",
    slug: "dragon-throne",
    status: "draft",
    title: "Dragon Throne",
    body: "Body",
    publishedAt: null,
    publishAt: null,
    deletedAt: null,
    promoLink: { id: "promo-1", status: "fetched", webUrl: "https://a", appUrl: null },
    publicPageShortId: "abc123",
    ...overrides,
  });
  db.seedChapter({ id: "chapter-1", novelId: "novel-1", status: "preview", deletedAt: null, body: "chapter body" });
  return db;
}

function seedPublishedNovel(overrides: Partial<Parameters<InstanceType<typeof FakePublishGateDb>["seedArticle"]>[0]> = {}) {
  const db = new FakePublishGateDb();
  db.seedNovel({ id: "novel-1", status: "published", locale: "en", deletedAt: null });
  db.seedArticle({
    id: "article-1",
    novelId: "novel-1",
    locale: "en",
    slug: "dragon-throne",
    status: "published",
    title: "Dragon Throne",
    body: "Body",
    publishedAt: new Date("2026-01-01T00:00:00.000Z"),
    publishAt: null,
    deletedAt: null,
    promoLink: { id: "promo-1", status: "fetched", webUrl: "https://a", appUrl: null },
    publicPageShortId: "short9",
    ...overrides,
  });
  db.seedChapter({ id: "chapter-1", novelId: "novel-1", status: "preview", deletedAt: null, body: "chapter body" });
  return db;
}

beforeEach(() => {
  revalidatePublicArticlePaths.mockReset();
  revalidatePublicArticleSet.mockReset();
  revalidatePublicBlogPaths.mockReset();
});

describe("applyPublishTransition invalidation wiring", () => {
  it("calls revalidatePublicArticlePaths with the Article's public path on a real publish write — byte-identical to pre-C-29b (novel_article never calls revalidatePublicBlogPaths)", async () => {
    const db = seedDraftArticle();
    const result = await applyPublishTransition(db.asPrismaClient(), {
      articleId: "article-1",
      requestId: "req-1",
      actor: { type: "admin", adminId: "admin-1" },
    });

    expect(result.outcome).toBe("published");
    expect(revalidatePublicArticlePaths).toHaveBeenCalledTimes(1);
    expect(revalidatePublicArticlePaths).toHaveBeenCalledWith({
      locale: "en",
      slug: "dragon-throne",
      shortId: "abc123",
    });
    expect(revalidatePublicBlogPaths).not.toHaveBeenCalled();
  });

  it("does not invalidate anything when the gate rejects (no write happened)", async () => {
    const db = seedDraftArticle({ promoLink: null });
    const result = await applyPublishTransition(db.asPrismaClient(), {
      articleId: "article-1",
      requestId: "req-1",
      actor: { type: "admin", adminId: "admin-1" },
    });

    expect(result.outcome).toBe("rejected");
    expect(revalidatePublicArticlePaths).not.toHaveBeenCalled();
  });

  it("does not invalidate again on an idempotent replay of the same requestId", async () => {
    const db = seedDraftArticle();
    const input = {
      articleId: "article-1",
      requestId: "req-1",
      actor: { type: "admin" as const, adminId: "admin-1" },
    };
    await applyPublishTransition(db.asPrismaClient(), input);
    await applyPublishTransition(db.asPrismaClient(), input);

    expect(revalidatePublicArticlePaths).toHaveBeenCalledTimes(1);
  });

  it("a thrown invalidation failure does not block the write or its returned outcome", async () => {
    revalidatePublicArticlePaths.mockImplementationOnce(() => {
      throw new Error("simulated cache invalidation failure");
    });
    const db = seedDraftArticle();
    const result = await applyPublishTransition(db.asPrismaClient(), {
      articleId: "article-1",
      requestId: "req-1",
      actor: { type: "admin", adminId: "admin-1" },
    });

    expect(result.outcome).toBe("published");
    expect(db.articles.get("article-1")?.status).toBe("published");
    expect(db.novels.get("novel-1")?.status).toBe("published");
  });
});

/**
 * C-29b: a blog/listicle/guide Article (`novelId: null`, C-27) has no
 * chapter subtree and is not part of `/`/`/browse` — `revalidatePublicBlogPaths`
 * is the only invalidation call it should ever trigger. No `seedNovel`/
 * `seedChapter` needed here: `facts.novel` is `null` for this fixture (same
 * shape `evaluator.ts`'s header documents), so none of the Novel-side gate
 * conditions apply.
 */
function seedDraftBlogArticle(overrides: Partial<Parameters<InstanceType<typeof FakePublishGateDb>["seedArticle"]>[0]> = {}) {
  const db = new FakePublishGateDb();
  db.seedArticle({
    id: "blog-1",
    novelId: null,
    articleType: "blog_article",
    locale: "en",
    slug: "a-blog-post",
    status: "draft",
    title: "A Blog Post",
    body: "Body",
    publishedAt: null,
    publishAt: null,
    deletedAt: null,
    promoLink: null,
    publicPageShortId: "blogshort1",
    ...overrides,
  });
  return db;
}

describe("blog first-publish invalidation wiring (C-29b)", () => {
  it("calls revalidatePublicBlogPaths with the post's slug, never revalidatePublicArticlePaths/Set", async () => {
    const db = seedDraftBlogArticle();
    const result = await applyPublishTransition(db.asPrismaClient(), {
      articleId: "blog-1",
      requestId: "req-1",
      actor: { type: "admin", adminId: "admin-1" },
    });

    expect(result.outcome).toBe("published");
    expect(revalidatePublicBlogPaths).toHaveBeenCalledTimes(1);
    expect(revalidatePublicBlogPaths).toHaveBeenCalledWith({ slug: "a-blog-post" });
    expect(revalidatePublicArticlePaths).not.toHaveBeenCalled();
    expect(revalidatePublicArticleSet).not.toHaveBeenCalled();
  });

  it("a thrown blog invalidation failure does not block the write or its returned outcome", async () => {
    revalidatePublicBlogPaths.mockImplementationOnce(() => {
      throw new Error("simulated cache invalidation failure");
    });
    const db = seedDraftBlogArticle();
    const result = await applyPublishTransition(db.asPrismaClient(), {
      articleId: "blog-1",
      requestId: "req-1",
      actor: { type: "admin", adminId: "admin-1" },
    });

    expect(result.outcome).toBe("published");
    expect(db.articles.get("blog-1")?.status).toBe("published");
  });
});

describe("Novel rights-transition invalidation wiring", () => {
  it("withdrawNovel calls revalidatePublicArticleSet with the affected Article's path", async () => {
    const stores = newStores();
    const db = seedPublishedNovel();
    const admin = seedAdmin(stores);
    const { authorization, requestId } = await issueAuthorization(stores, "admin.novel.withdraw", admin.token);

    const result = await withdrawNovel(
      { authorization, requestId, novelId: "novel-1", reason: "operator request" },
      deps(db, stores),
    );

    expect(result.novelStatus).toBe("unpublished");
    expect(revalidatePublicArticleSet).toHaveBeenCalledTimes(1);
    expect(revalidatePublicArticleSet).toHaveBeenCalledWith([
      { locale: "en", slug: "dragon-throne", shortId: "short9" },
    ]);
  });

  it("takedownNovel calls revalidatePublicArticleSet even for an Article that was not previously published", async () => {
    const stores = newStores();
    const db = seedPublishedNovel();
    // A second, never-published Article on the same Novel — takedown cascades
    // to it unconditionally (`applyNovelRightsTransition`'s "cascades down,
    // never up" comment), so it must be invalidated too even though it was
    // never publicly visible before.
    db.seedArticle({
      id: "article-2",
      novelId: "novel-1",
      locale: "en",
      slug: "draft-sibling",
      status: "draft",
      title: "t2",
      body: "b2",
      publishedAt: null,
      publishAt: null,
      deletedAt: null,
      promoLink: null,
      publicPageShortId: "short2",
    });
    const admin = seedAdmin(stores);
    const { authorization, requestId } = await issueAuthorization(stores, "admin.novel.takedown", admin.token);

    const result = await takedownNovel(
      { authorization, requestId, novelId: "novel-1", reason: "rights dispute" },
      deps(db, stores),
    );

    expect(result.novelStatus).toBe("takedown");
    expect(revalidatePublicArticleSet).toHaveBeenCalledTimes(1);
    const [calledWith] = revalidatePublicArticleSet.mock.calls[0] as [Array<{ slug: string }>];
    expect(calledWith.map((p) => p.slug).sort()).toEqual(["draft-sibling", "dragon-throne"]);
  });

  it("restoreNovel calls revalidatePublicArticleSet with the restored Article's path", async () => {
    const stores = newStores();
    const db = seedPublishedNovel({ status: "takedown" });
    db.novels.set("novel-1", { id: "novel-1", status: "takedown", locale: "en", deletedAt: null });
    const admin = seedAdmin(stores);
    const { authorization, requestId } = await issueAuthorization(stores, "admin.novel.restore", admin.token);

    const result = await restoreNovel(
      { authorization, requestId, novelId: "novel-1", reason: "rights cleared" },
      deps(db, stores),
    );

    expect(result.novelStatus).toBe("draft");
    expect(revalidatePublicArticleSet).toHaveBeenCalledTimes(1);
    expect(revalidatePublicArticleSet).toHaveBeenCalledWith([
      { locale: "en", slug: "dragon-throne", shortId: "short9" },
    ]);
  });

  it("a thrown invalidation failure does not block withdrawNovel's write or its returned outcome", async () => {
    revalidatePublicArticleSet.mockImplementationOnce(() => {
      throw new Error("simulated cache invalidation failure");
    });
    const stores = newStores();
    const db = seedPublishedNovel();
    const admin = seedAdmin(stores);
    const { authorization, requestId } = await issueAuthorization(stores, "admin.novel.withdraw", admin.token);

    const result = await withdrawNovel(
      { authorization, requestId, novelId: "novel-1", reason: "r" },
      deps(db, stores),
    );

    expect(result.novelStatus).toBe("unpublished");
    expect(db.novels.get("novel-1")?.status).toBe("unpublished");
  });

  it("still broadcasts on an idempotent replay of the same requestId (safe to over-invalidate)", async () => {
    const stores = newStores();
    const db = seedPublishedNovel();
    const admin = seedAdmin(stores);
    const { authorization, requestId } = await issueAuthorization(stores, "admin.novel.withdraw", admin.token);
    const input = { authorization, requestId, novelId: "novel-1", reason: "r" };

    await withdrawNovel(input, deps(db, stores));
    await withdrawNovel(input, deps(db, stores));

    // Replay hits the existingAudit branch, which queries all of the Novel's
    // current (non-deleted) Articles unconditionally — unlike the first-call
    // branch's kind-specific status filter — and still broadcasts. Calling
    // twice for a sequential retry is deliberately not de-duplicated: see
    // this module's header, "Cache invalidation" note in service.ts ("safe
    // to over-invalidate").
    expect(revalidatePublicArticleSet).toHaveBeenCalledTimes(2);
    expect(db.audits).toHaveLength(1);
  });
});
