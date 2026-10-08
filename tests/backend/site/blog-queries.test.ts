import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getPublicBlogDetail, listPublicBlogArticles } from "@/lib/site/blog-queries";
import { buildPublicListBlogArticleWhere } from "@/server/publication/visibility";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "blog-1",
    title: "A blog post",
    slug: "a-blog-post",
    locale: "en",
    summary: "A short summary",
    publishedAt: new Date("2026-08-05T12:30:00.000Z"),
    updatedAt: new Date("2026-08-06T00:00:00.000Z"),
    body: "<p>Body</p>",
    seoMetadata: {},
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.SITE_URL;
  delete process.env.FEATURE_ARTICLE_SEO_VISIBILITY;
});

/** 博客列表的数据库分页：`findMany(skip/take)` + `count`（同一个 where），B-38 起没有任何上限。 */
function listDb(rows: unknown[], total: number) {
  const findMany = vi.fn().mockResolvedValue(rows);
  const count = vi.fn().mockResolvedValue(total);
  return { db: { article: { findMany, count } } as unknown as PrismaClient, findMany, count };
}

describe("listPublicBlogArticles", () => {
  it("uses the blog-family list where fragment (excludes hidden AND seo_only) for BOTH the page and the count", async () => {
    const { db, findMany, count } = listDb([row()], 1);

    const result = await listPublicBlogArticles(db, "en", 1);

    expect(findMany.mock.calls[0]![0].where).toEqual(buildPublicListBlogArticleWhere({ locale: "en" }));
    expect(count.mock.calls[0]![0].where).toEqual(buildPublicListBlogArticleWhere({ locale: "en" }));
    expect(result.posts).toEqual([{
      id: "blog-1",
      title: "A blog post",
      slug: "a-blog-post",
      summary: "A short summary",
      publishedAt: new Date("2026-08-05T12:30:00.000Z"),
      href: "/blog/a-blog-post",
    }]);
    expect(result).toMatchObject({ page: 1, totalPages: 1, totalCount: 1 });
  });

  it("orders newest first (publishedAt desc, id asc) and pages with skip/take — no cap, no take: 240", async () => {
    const { db, findMany } = listDb([row()], 45);
    await listPublicBlogArticles(db, "en", 3);
    expect(findMany.mock.calls[0]![0]).toMatchObject({
      orderBy: [{ publishedAt: "desc" }, { id: "asc" }],
      skip: 40,
      take: 20,
    });
  });

  it("page math: totalPages = ceil(total / 20); an invalid page number reads as page 1; always at least 1 total page", async () => {
    for (const [total, pages] of [[0, 1], [1, 1], [20, 1], [21, 2], [45, 3], [4_801, 241]] as const) {
      const { db } = listDb([], total);
      expect((await listPublicBlogArticles(db, "en", 1)).totalPages, `total=${total}`).toBe(pages);
    }
    for (const page of [0, -1, 1.5, Number.NaN]) {
      const { db, findMany } = listDb([], 0);
      expect((await listPublicBlogArticles(db, "en", page)).page, String(page)).toBe(1);
      expect(findMany.mock.calls[0]![0].skip, String(page)).toBe(0);
    }
  });

  it("past the end: no posts but the real totalPages (the page 404s on that); a page number whose skip is not a safe integer never reaches the database", async () => {
    const beyond = listDb([], 45);
    expect(await listPublicBlogArticles(beyond.db, "en", 9)).toMatchObject({ posts: [], page: 9, totalPages: 3, totalCount: 45 });
    const huge = listDb([row()], 45);
    expect(await listPublicBlogArticles(huge.db, "en", 1e21)).toMatchObject({ posts: [], totalPages: 3, totalCount: 45 });
    expect(huge.findMany).not.toHaveBeenCalled();
    expect(huge.count).toHaveBeenCalledTimes(1);
  });

  it("falls back to updatedAt when publishedAt is somehow null", async () => {
    const { db } = listDb([row({ publishedAt: null })], 1);

    const { posts } = await listPublicBlogArticles(db, "en", 1);

    expect(posts[0]!.publishedAt).toEqual(new Date("2026-08-06T00:00:00.000Z"));
  });

  it("omits summary when blank", async () => {
    const { db } = listDb([row({ summary: null })], 1);

    const { posts } = await listPublicBlogArticles(db, "en", 1);

    expect(posts[0]!.summary).toBeUndefined();
  });

  it("passes the SEO-visibility env through to the where fragment (flag on: only public rows)", async () => {
    const { db, findMany } = listDb([], 0);
    await listPublicBlogArticles(db, "en", 1, { NODE_ENV: "test", FEATURE_ARTICLE_SEO_VISIBILITY: "true" });
    expect(JSON.stringify(findMany.mock.calls[0]![0].where)).toContain('"seoVisibility":"public"');
    await listPublicBlogArticles(db, "en", 1, { NODE_ENV: "test", FEATURE_ARTICLE_SEO_VISIBILITY: "false" });
    expect(JSON.stringify(findMany.mock.calls[1]![0].where)).not.toContain("seoVisibility");
  });
});

describe("getPublicBlogDetail", () => {
  it("parses seoMetadata's blog-only keys (coverUrl/metaTitle/metaDescription)", async () => {
    const findFirst = vi.fn().mockResolvedValue(row({
      seoMetadata: {
        coverUrl: "https://cdn.example/cover.jpg",
        metaTitle: "Meta title",
        metaDescription: "Meta description",
      },
    }));
    const db = { article: { findFirst } } as unknown as PrismaClient;

    const detail = await getPublicBlogDetail(db, "blog-1");

    expect(detail).toMatchObject({
      coverUrl: "https://cdn.example/cover.jpg",
      metaTitle: "Meta title",
      metaDescription: "Meta description",
      body: "<p>Body</p>",
    });
  });

  // C-29b review low: `metaKeywords` is a key the admin editor still writes
  // into `seoMetadata` (`src/server/content-creation/blog.ts`), but no
  // public render path ever reads it (see `parseBlogSeoMetadata`'s own doc
  // comment — CPS's blog SEO has no `keywords` field either). A stored
  // `metaKeywords` value must not leak onto `BlogDetailView`.
  it("does not carry a stored metaKeywords value onto the detail view (dead key, dropped)", async () => {
    const findFirst = vi.fn().mockResolvedValue(row({
      seoMetadata: {
        coverUrl: "https://cdn.example/cover.jpg",
        metaKeywords: "a, b, c",
      },
    }));
    const db = { article: { findFirst } } as unknown as PrismaClient;

    const detail = await getPublicBlogDetail(db, "blog-1");

    expect(detail).toBeDefined();
    expect("metaKeywords" in (detail ?? {})).toBe(false);
  });

  it("blank/whitespace-only seoMetadata keys normalize to undefined, not empty strings", async () => {
    const findFirst = vi.fn().mockResolvedValue(row({ seoMetadata: { coverUrl: "   ", metaTitle: "" } }));
    const db = { article: { findFirst } } as unknown as PrismaClient;

    const detail = await getPublicBlogDetail(db, "blog-1");

    expect(detail?.coverUrl).toBeUndefined();
    expect(detail?.metaTitle).toBeUndefined();
  });

  it("tolerates a malformed (non-object) seoMetadata value", async () => {
    const findFirst = vi.fn().mockResolvedValue(row({ seoMetadata: "not an object" }));
    const db = { article: { findFirst } } as unknown as PrismaClient;

    const detail = await getPublicBlogDetail(db, "blog-1");

    expect(detail?.coverUrl).toBeUndefined();
  });

  it("scopes the lookup to articleType: blog_article as defense-in-depth", async () => {
    const findFirst = vi.fn().mockResolvedValue(row());
    const db = { article: { findFirst } } as unknown as PrismaClient;

    await getPublicBlogDetail(db, "blog-1");

    expect(JSON.stringify(findFirst.mock.calls[0]![0].where)).toContain('"articleType":"blog_article"');
  });

  it("returns null when no row matches", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const db = { article: { findFirst } } as unknown as PrismaClient;

    expect(await getPublicBlogDetail(db, "missing")).toBeNull();
  });
});
