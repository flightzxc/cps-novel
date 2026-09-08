import { describe, expect, it, vi } from "vitest";

import { applyPublishTransition } from "@/server/publish-gate/service";

import { FakePublishGateDb } from "./fake-db";

/**
 * C-27 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-27):
 * end-to-end (`loadPublishGateFacts` + `evaluatePublishGate` +
 * `applyPublishTransition`, the real modules, only the DB double is fake)
 * coverage for the article_type fork. `evaluator.test.ts`'s "C-27:
 * non-novel_article fork" describe block already covers the evaluator in
 * isolation with hand-built facts; this file proves the same fork holds
 * through the real `loadPublishGateFacts` DB-assembly step and the real
 * write path — the plan's own required test list: "博客文章（无书目、无推广
 * 链接）能通过门禁；小说文章缺推广链接仍被拒（这条是回归防线，证明放宽没有
 * 殃及小说文章）；no-bypass 扫描仍通过" (the last item is
 * `no-bypass.test.ts`, unaffected and run as part of the same suite, not
 * duplicated here).
 *
 * A blog Article is modeled here purely by `novelId: null` (no Novel seeded
 * for it, no PromoLink, no preview chapters) — `evaluatePublishGate` forks on
 * `facts.novel === null`, not on an `articleType` string, and `facts.novel`
 * is derived entirely from whether `Article.novelId` resolves to a seeded
 * Novel (see `evaluator.ts`'s header on why the two are structurally
 * equivalent). This file's own fixtures leave `articleType` unset — the fake
 * DB (`fake-db.ts`, widened for C-29b) defaults it to `"novel_article"` when
 * omitted, so `txResult.articleType` here does not itself model the blog
 * family; the real Prisma layer's CHECK (`article_novel_id_by_type_check`)
 * is what keeps the two in lockstep on a real database, and this test only
 * needs the `novelId` side of that equivalence — the gate fork
 * (`evaluatePublishGate`) and the dispatch-call assertion below both key off
 * `novelId`/`facts.novel`, not `articleType`. `invalidation-wiring.test.ts`'s
 * "blog first-publish invalidation wiring (C-29b)" describe block is what
 * covers the `articleType`-keyed cache-invalidation branch this file does
 * not.
 */
vi.mock("@/lib/locale/locale-canonical", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/locale/locale-canonical")>();
  return { ...actual, isPublishableLocale: () => true };
});

const dispatchFirstPublicPublication = vi.fn().mockResolvedValue({ errors: [] });
vi.mock("@/server/publication/dispatcher", () => ({
  dispatchFirstPublicPublication: (...args: unknown[]) => dispatchFirstPublicPublication(...args),
}));

function seedBlogArticle(db: InstanceType<typeof FakePublishGateDb>, overrides: Record<string, unknown> = {}) {
  db.seedArticle({
    id: "blog-1",
    novelId: null,
    locale: "en",
    slug: "a-blog-post",
    status: "draft",
    title: "A Blog Post",
    body: "Real blog body content.",
    publishedAt: null,
    publishAt: null,
    deletedAt: null,
    promoLink: null,
    ...overrides,
  });
  return db;
}

function seedNovelArticle(db: InstanceType<typeof FakePublishGateDb>, overrides: Record<string, unknown> = {}) {
  db.seedNovel({ id: "novel-1", status: "ready", locale: "en", deletedAt: null });
  db.seedArticle({
    id: "novel-article-1",
    novelId: "novel-1",
    locale: "en",
    slug: "a-novel-page",
    status: "draft",
    title: "A Novel Page",
    body: "Real chapter body content.",
    publishedAt: null,
    publishAt: null,
    deletedAt: null,
    promoLink: { id: "promo-1", status: "fetched", webUrl: "https://a", appUrl: null },
    ...overrides,
  });
  db.seedChapter({ id: "chapter-1", novelId: "novel-1", status: "preview", deletedAt: null, body: "chapter body" });
  return db;
}

describe("C-27: applyPublishTransition forks by article type end-to-end", () => {
  it("publishes a blog Article (no Novel, no PromoLink, no preview chapters) — the three unaffected conditions (locale/metadata/page-identity) all pass", async () => {
    dispatchFirstPublicPublication.mockClear();
    const db = seedBlogArticle(new FakePublishGateDb());
    const now = new Date("2026-09-08T00:00:00.000Z");
    const result = await applyPublishTransition(db.asPrismaClient(), {
      articleId: "blog-1",
      requestId: "req-blog-1",
      actor: { type: "admin", adminId: "admin-1" },
      now,
    });
    expect(result).toEqual({
      outcome: "published",
      articleId: "blog-1",
      novelId: null,
      locale: "en",
      firstPublish: true,
    });
    expect(db.articles.get("blog-1")?.status).toBe("published");
    expect(db.articles.get("blog-1")?.publishedAt).toEqual(now);
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({
      action: "article.publish",
      entityType: "Article",
      entityId: "blog-1",
      beforeSnapshot: { articleStatus: "draft" },
      afterSnapshot: { articleStatus: "published" },
    });
    // No Novel write of any kind — there is no Novel to promote.
    expect(db.calls.filter((c) => c === "novel.updateMany" || c === "novel.update")).toHaveLength(0);
    // C-29b: IndexNow/sitemap first-publish dispatch is no longer skipped
    // for a `novelId === null` Article (`service.ts`'s now-removed
    // `txResult.novelId !== null` guard) — both handlers are opaque to
    // `novelId` (see that call site's own comment), so dispatch fires with
    // `novelId: null` passed straight through rather than being withheld.
    expect(dispatchFirstPublicPublication).toHaveBeenCalledTimes(1);
    expect(dispatchFirstPublicPublication).toHaveBeenCalledWith(
      expect.objectContaining({ articleId: "blog-1", novelId: null, locale: "en" }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("still rejects a novel_article missing its PromoLink — the C-27 relaxation does not weaken novel_article's own gate (regression check)", async () => {
    const db = seedNovelArticle(new FakePublishGateDb(), { promoLink: null });
    const result = await applyPublishTransition(db.asPrismaClient(), {
      articleId: "novel-article-1",
      requestId: "req-novel-1",
      actor: { type: "admin", adminId: "admin-1" },
    });
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.gate.reasons).toEqual(["promo_link_missing"]);
    }
    expect(db.articles.get("novel-article-1")?.status).toBe("draft");
  });

  it("still rejects a blog Article with blank required metadata (locale/metadata/page-identity are not skipped)", async () => {
    const db = seedBlogArticle(new FakePublishGateDb(), { title: "  ", body: "" });
    const result = await applyPublishTransition(db.asPrismaClient(), {
      articleId: "blog-1",
      requestId: "req-blog-2",
      actor: { type: "admin", adminId: "admin-1" },
    });
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.gate.reasons).toEqual(["required_metadata_missing"]);
    }
  });

  it("still rejects a blog Article whose (locale, slug) collides with a different live Article", async () => {
    const db = seedBlogArticle(new FakePublishGateDb());
    db.seedArticle({
      id: "blog-2",
      novelId: null,
      locale: "en",
      slug: "a-blog-post", // same (locale, slug) as blog-1
      status: "published",
      title: "Another",
      body: "Other body",
      publishedAt: new Date("2026-01-01T00:00:00.000Z"),
      publishAt: null,
      deletedAt: null,
      promoLink: null,
    });
    const result = await applyPublishTransition(db.asPrismaClient(), {
      articleId: "blog-1",
      requestId: "req-blog-3",
      actor: { type: "admin", adminId: "admin-1" },
    });
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.gate.reasons).toEqual(["page_identity_conflict"]);
    }
  });
});
