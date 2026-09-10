import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { checkNovelArticlePublicAccess } from "@/server/publication/access";

function dbReturning(article: unknown): PrismaClient {
  return { article: { findFirst: vi.fn().mockResolvedValue(article) } } as unknown as PrismaClient;
}

function row(overrides: {
  articleStatus?: string;
  novelStatus?: string;
  promoLink?: { status: string; webUrl: string | null; appUrl: string | null } | null;
  /** C-25: `Article.seoVisibility`; omitted defaults to the pre-C-25 shape (no column value at all). */
  seoVisibility?: string;
}) {
  return {
    id: "article-1",
    novelId: "novel-1",
    status: overrides.articleStatus ?? "published",
    novel: { status: overrides.novelStatus ?? "published" },
    promoLink:
      "promoLink" in overrides
        ? overrides.promoLink
        : { status: "fetched", webUrl: "https://a", appUrl: null },
    ...("seoVisibility" in overrides ? { seoVisibility: overrides.seoVisibility } : {}),
  };
}

describe("checkNovelArticlePublicAccess", () => {
  it("returns not_found when no matching row exists", async () => {
    const db = dbReturning(null);
    const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "missing" });
    expect(result).toEqual({ kind: "not_found" });
  });

  /**
   * C-28 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-28):
   * "Public routes are C-29 — a created blog must remain invisible
   * publicly (C-27's access.ts not_found), covered by a test." C-27 already
   * added the `article.novelId === null || article.novel === null`
   * short-circuit (this file previously had zero coverage of that branch —
   * a real gap, not merely an omission this task chooses to leave); this is
   * that missing test, using the exact shape `createBlogArticle`
   * (`src/server/content-creation/blog.ts`) produces and the publish gate
   * can legally advance to `published`: `novelId`/`novel` both `null`,
   * `promoLink` `null`, status `published`. The published status is the
   * point — without the C-27 short-circuit, a published, otherwise-normal-
   * looking row would fall through toward `isPubliclyAccessible`, which
   * needs a real `NovelPublicationState` this row does not have.
   */
  it("C-28: a published blog Article (novelId/novel both null) is not_found, not published — public routes are C-29's job, not yet built", async () => {
    const db = dbReturning({
      id: "blog-article-1",
      novelId: null,
      status: "published",
      novel: null,
      promoLink: null,
      seoVisibility: "public",
    });
    const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "a-blog-post" });
    expect(result).toEqual({ kind: "not_found" });
  });

  it("C-28: still not_found for a draft blog Article (the common case immediately after creation)", async () => {
    const db = dbReturning({
      id: "blog-article-2",
      novelId: null,
      status: "draft",
      novel: null,
      promoLink: null,
      seoVisibility: "public",
    });
    const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "a-draft-blog-post" });
    expect(result).toEqual({ kind: "not_found" });
  });

  it("queries by locale and slug via the primary (non-deleted) where fragment", async () => {
    const db = dbReturning(null);
    await checkNovelArticlePublicAccess(db, { locale: "en", slug: "some-slug" });
    const call = (db.article.findFirst as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where).toEqual({
      AND: [{ deletedAt: null }, { locale: "en", slug: "some-slug" }],
    });
  });

  it("returns published for a fully public article with a ready promo link", async () => {
    const db = dbReturning(row({}));
    const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "x" });
    expect(result).toEqual({ kind: "published", articleId: "article-1", novelId: "novel-1" });
  });

  it("returns takedown when the article itself is takedown", async () => {
    const db = dbReturning(row({ articleStatus: "takedown" }));
    const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "x" });
    expect(result).toEqual({ kind: "takedown" });
  });

  it("returns takedown when the novel is takedown, even if the article claims published", async () => {
    const db = dbReturning(row({ novelStatus: "takedown" }));
    const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "x" });
    expect(result).toEqual({ kind: "takedown" });
  });

  it("takedown wins over unpublished when both are set", async () => {
    const db = dbReturning(row({ novelStatus: "takedown", articleStatus: "unpublished" }));
    const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "x" });
    expect(result).toEqual({ kind: "takedown" });
  });

  it("returns unavailable when the article is unpublished", async () => {
    const db = dbReturning(row({ articleStatus: "unpublished" }));
    const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "x" });
    expect(result).toEqual({ kind: "unavailable" });
  });

  it("returns unavailable when the novel is unpublished", async () => {
    const db = dbReturning(row({ novelStatus: "unpublished" }));
    const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "x" });
    expect(result).toEqual({ kind: "unavailable" });
  });

  it("returns unavailable (not not_found) when both sides are published but the promo link is null", async () => {
    const db = dbReturning(row({ promoLink: null }));
    const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "x" });
    expect(result).toEqual({ kind: "unavailable" });
  });

  it("returns unavailable when both sides are published but the promo link is not fetched", async () => {
    const db = dbReturning(row({ promoLink: { status: "failed", webUrl: null, appUrl: null } }));
    const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "x" });
    expect(result).toEqual({ kind: "unavailable" });
  });

  it("returns unavailable when both sides are published but promo URLs are blank whitespace", async () => {
    const db = dbReturning(
      row({ promoLink: { status: "fetched", webUrl: "   ", appUrl: "\t" } }),
    );
    const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "x" });
    expect(result).toEqual({ kind: "unavailable" });
  });

  it("returns not_found when the article is draft", async () => {
    const db = dbReturning(row({ articleStatus: "draft" }));
    const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "x" });
    expect(result).toEqual({ kind: "not_found" });
  });

  it("returns not_found when the novel is only ready (internal readiness, not public)", async () => {
    const db = dbReturning(row({ novelStatus: "ready" }));
    const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "x" });
    expect(result).toEqual({ kind: "not_found" });
  });

  /**
   * C-25 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-25):
   * "公开访问判定函数在 hidden 时返回「未找到」（纯 404），置于权利阻断判定之后、
   * 公开可达判定之前" — a `hidden` Article is a plain 404, not the
   * `unavailable` (stable removal page) `isNoIndexRemovalState` produces, even
   * though the row is otherwise fully published + promo-ready.
   */
  describe("C-25: seoVisibility=hidden", () => {
    // Same `as unknown as NodeJS.ProcessEnv` convention as this repo's other
    // env-override tests (e.g. `tests/ui/admin-two-factor-enforcement-switch.test.ts`):
    // Next.js's global augmentation makes `NodeJS.ProcessEnv` require `NODE_ENV`,
    // which a plain single-key test literal never carries.
    const FLAG_ON = { FEATURE_ARTICLE_SEO_VISIBILITY: "true" } as unknown as NodeJS.ProcessEnv;
    const FLAG_OFF = {} as unknown as NodeJS.ProcessEnv;

    it("returns not_found for an otherwise fully publishable article when the flag is on", async () => {
      const db = dbReturning(row({ seoVisibility: "hidden" }));
      const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "x" }, FLAG_ON);
      expect(result).toEqual({ kind: "not_found" });
    });

    it("has no effect while the flag is off (pre-C-25 behavior — still published)", async () => {
      const db = dbReturning(row({ seoVisibility: "hidden" }));
      const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "x" }, FLAG_OFF);
      expect(result).toEqual({ kind: "published", articleId: "article-1", novelId: "novel-1" });
    });

    it("seo_only is NOT treated as hidden — still published (this is the 🔴 risk case: swapping this would turn seo_only into hidden)", async () => {
      const db = dbReturning(row({ seoVisibility: "seo_only" }));
      const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "x" }, FLAG_ON);
      expect(result).toEqual({ kind: "published", articleId: "article-1", novelId: "novel-1" });
    });

    it("takedown still wins over hidden (rights-blocked is checked first)", async () => {
      const db = dbReturning(row({ articleStatus: "takedown", seoVisibility: "hidden" }));
      const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "x" }, FLAG_ON);
      expect(result).toEqual({ kind: "takedown" });
    });
  });
});
