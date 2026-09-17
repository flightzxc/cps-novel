import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { checkBlogArticlePublicAccess } from "@/server/publication/access";

function dbReturning(article: unknown): PrismaClient {
  return { article: { findFirst: vi.fn().mockResolvedValue(article) } } as unknown as PrismaClient;
}

function row(overrides: {
  articleType?: string;
  status?: string;
  seoVisibility?: string;
}) {
  return {
    id: "blog-article-1",
    title: "A blog post",
    articleType: overrides.articleType ?? "blog_article",
    status: overrides.status ?? "published",
    seoVisibility: overrides.seoVisibility ?? "public",
  };
}

/** `checkBlogArticlePublicAccess`'s own default `env` param defaults to `process.env`, so tests pass an explicit override to isolate from the real environment. */
const BLOG_ON = { FEATURE_ARTICLE_BLOG: "true" } as unknown as NodeJS.ProcessEnv;
const BLOG_AND_SEO_VISIBILITY_ON = {
  FEATURE_ARTICLE_BLOG: "true",
  FEATURE_ARTICLE_SEO_VISIBILITY: "true",
} as unknown as NodeJS.ProcessEnv;

describe("checkBlogArticlePublicAccess", () => {
  it("C-29 开关: FEATURE_ARTICLE_BLOG off -> not_found without even querying", async () => {
    const db = dbReturning(row({}));
    const result = await checkBlogArticlePublicAccess(db, { locale: "en", slug: "a-post" }, {} as NodeJS.ProcessEnv);
    expect(result).toEqual({ kind: "not_found" });
    expect((db.article.findFirst as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("returns not_found when no matching row exists", async () => {
    const db = dbReturning(null);
    const result = await checkBlogArticlePublicAccess(db, { locale: "en", slug: "missing" }, BLOG_ON);
    expect(result).toEqual({ kind: "not_found" });
  });

  it("returns not_found for a novel_article row (other null-novel/typed rows stay 404, per the plan)", async () => {
    const db = dbReturning(row({ articleType: "novel_article" }));
    const result = await checkBlogArticlePublicAccess(db, { locale: "en", slug: "a-novel" }, BLOG_ON);
    expect(result).toEqual({ kind: "not_found" });
  });

  it("returns not_found for a listicle row (registered for CPS-enum parity, no public route yet — C-26)", async () => {
    const db = dbReturning(row({ articleType: "listicle" }));
    const result = await checkBlogArticlePublicAccess(db, { locale: "en", slug: "a-listicle" }, BLOG_ON);
    expect(result).toEqual({ kind: "not_found" });
  });

  it("returns not_found for a guide row", async () => {
    const db = dbReturning(row({ articleType: "guide" }));
    const result = await checkBlogArticlePublicAccess(db, { locale: "en", slug: "a-guide" }, BLOG_ON);
    expect(result).toEqual({ kind: "not_found" });
  });

  it("returns not_found for a draft blog Article (the common case immediately after creation)", async () => {
    const db = dbReturning(row({ status: "draft" }));
    const result = await checkBlogArticlePublicAccess(db, { locale: "en", slug: "a-draft" }, BLOG_ON);
    expect(result).toEqual({ kind: "not_found" });
  });

  it("returns takedown for a takedown blog Article, checked before hidden", async () => {
    const db = dbReturning(row({ status: "takedown", seoVisibility: "hidden" }));
    const result = await checkBlogArticlePublicAccess(db, { locale: "en", slug: "a-takedown" }, BLOG_AND_SEO_VISIBILITY_ON);
    expect(result).toEqual({ kind: "takedown", title: "A blog post" });
  });

  it("returns unavailable for an unpublished blog Article", async () => {
    const db = dbReturning(row({ status: "unpublished" }));
    const result = await checkBlogArticlePublicAccess(db, { locale: "en", slug: "an-unpublished" }, BLOG_ON);
    expect(result).toEqual({ kind: "unavailable", title: "A blog post" });
  });

  it("returns published for a published, public blog Article", async () => {
    const db = dbReturning(row({ status: "published", seoVisibility: "public" }));
    const result = await checkBlogArticlePublicAccess(db, { locale: "en", slug: "a-post" }, BLOG_ON);
    expect(result).toEqual({ kind: "published", articleId: "blog-article-1", title: "A blog post" });
  });

  /**
   * C-25 x C-29 nine-cell truth table's blog half: three seoVisibility
   * values × {published, draft} — this file's own version of
   * `tests/backend/publication/visibility.test.ts`'s承重 real-values table,
   * scoped to the blog access-check boundary specifically. `seo_only`
   * behaves EXACTLY like `public` at this boundary (detail reachability) —
   * the plan's own wording: "`seo_only` → 与 `public` 完全一致地渲染".
   */
  describe("seoVisibility × status truth table (FEATURE_ARTICLE_SEO_VISIBILITY on)", () => {
    it("public + published -> published", async () => {
      const db = dbReturning(row({ status: "published", seoVisibility: "public" }));
      const result = await checkBlogArticlePublicAccess(db, { locale: "en", slug: "x" }, BLOG_AND_SEO_VISIBILITY_ON);
      expect(result.kind).toBe("published");
    });

    it("seo_only + published -> published (detail is reachable; only listing excludes seo_only)", async () => {
      const db = dbReturning(row({ status: "published", seoVisibility: "seo_only" }));
      const result = await checkBlogArticlePublicAccess(db, { locale: "en", slug: "x" }, BLOG_AND_SEO_VISIBILITY_ON);
      expect(result.kind).toBe("published");
    });

    it("hidden + published -> not_found (a pure 404, not noindex)", async () => {
      const db = dbReturning(row({ status: "published", seoVisibility: "hidden" }));
      const result = await checkBlogArticlePublicAccess(db, { locale: "en", slug: "x" }, BLOG_AND_SEO_VISIBILITY_ON);
      expect(result).toEqual({ kind: "not_found" });
    });

    it("hidden + draft -> not_found (draft is already not_found regardless)", async () => {
      const db = dbReturning(row({ status: "draft", seoVisibility: "hidden" }));
      const result = await checkBlogArticlePublicAccess(db, { locale: "en", slug: "x" }, BLOG_AND_SEO_VISIBILITY_ON);
      expect(result).toEqual({ kind: "not_found" });
    });
  });

  it("while FEATURE_ARTICLE_SEO_VISIBILITY is off, a hidden blog Article still renders (pre-C-25 degrade, same as the Novel side)", async () => {
    const db = dbReturning(row({ status: "published", seoVisibility: "hidden" }));
    const result = await checkBlogArticlePublicAccess(db, { locale: "en", slug: "x" }, BLOG_ON);
    expect(result.kind).toBe("published");
  });

  it("queries by locale and slug via the primary (non-deleted) where fragment", async () => {
    const db = dbReturning(null);
    await checkBlogArticlePublicAccess(db, { locale: "en", slug: "some-slug" }, BLOG_ON);
    expect(db.article.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([expect.objectContaining({ locale: "en", slug: "some-slug" })]),
        }),
      }),
    );
  });
});
