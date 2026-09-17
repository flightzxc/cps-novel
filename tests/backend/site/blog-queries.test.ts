import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getPublicBlogDetail,
  listPublicBlogArticles,
  paginateBlogCards,
} from "@/lib/site/blog-queries";
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

describe("listPublicBlogArticles", () => {
  it("uses the blog-family list where fragment (excludes hidden AND seo_only)", async () => {
    const findMany = vi.fn().mockResolvedValue([row()]);
    const db = { article: { findMany } } as unknown as PrismaClient;

    const cards = await listPublicBlogArticles(db, "en");

    expect(findMany.mock.calls[0]![0].where).toEqual(buildPublicListBlogArticleWhere({ locale: "en" }));
    expect(cards).toEqual([{
      id: "blog-1",
      title: "A blog post",
      slug: "a-blog-post",
      summary: "A short summary",
      publishedAt: new Date("2026-08-05T12:30:00.000Z"),
      href: "/blog/a-blog-post",
    }]);
  });

  it("falls back to updatedAt when publishedAt is somehow null", async () => {
    const findMany = vi.fn().mockResolvedValue([row({ publishedAt: null })]);
    const db = { article: { findMany } } as unknown as PrismaClient;

    const cards = await listPublicBlogArticles(db, "en");

    expect(cards[0]!.publishedAt).toEqual(new Date("2026-08-06T00:00:00.000Z"));
  });

  it("omits summary when blank", async () => {
    const findMany = vi.fn().mockResolvedValue([row({ summary: null })]);
    const db = { article: { findMany } } as unknown as PrismaClient;

    const cards = await listPublicBlogArticles(db, "en");

    expect(cards[0]!.summary).toBeUndefined();
  });
});

describe("paginateBlogCards", () => {
  it("slices into pages using BROWSE_PAGE_SIZE", () => {
    const cards = Array.from({ length: 45 }, (_, index) => ({
      id: `p${index}`,
      title: `Post ${index}`,
      slug: `post-${index}`,
      publishedAt: new Date(),
      href: `/blog/post-${index}`,
    }));

    const page1 = paginateBlogCards(cards, 1);
    expect(page1.posts).toHaveLength(20);
    expect(page1.totalPages).toBe(3);
    expect(page1.totalCount).toBe(45);

    const page3 = paginateBlogCards(cards, 3);
    expect(page3.posts).toHaveLength(5);
  });

  it("defaults to page 1 for an invalid page number", () => {
    expect(paginateBlogCards([], 0).page).toBe(1);
    expect(paginateBlogCards([], -1).page).toBe(1);
  });

  it("always reports at least 1 total page, even when empty", () => {
    expect(paginateBlogCards([], 1).totalPages).toBe(1);
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
