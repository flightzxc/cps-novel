import "./setup-cleanup";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const NOT_FOUND = Symbol("next-not-found");

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw NOT_FOUND;
  },
}));

vi.mock("@/app/_lib/public-load", () => ({
  loadChrome: vi.fn(),
  loadBlogList: vi.fn(),
  loadBlogAccess: vi.fn(),
  loadBlogDetail: vi.fn(),
}));

const publicLoad = await import("@/app/_lib/public-load");
const loadChrome = vi.mocked(publicLoad.loadChrome);
const loadBlogList = vi.mocked(publicLoad.loadBlogList);
const loadBlogAccess = vi.mocked(publicLoad.loadBlogAccess);
const loadBlogDetail = vi.mocked(publicLoad.loadBlogDetail);

const SETTINGS = {
  siteName: "cps-novel",
  siteDescription: "Overseas novels.",
  homeMetaTitle: "cps-novel",
  homeMetaDescription: "Read overseas novels.",
  defaultOgImage: "https://example.test/og.png",
  googleSearchConsoleVerification: "",
  footerCopyrightText: "© test",
  footerDisclaimerText: "",
  friendLinks: [],
  indexNowHost: "",
  indexNowKey: "",
  indexNowKeyLocation: "",
  ga4MeasurementId: null,
  updatedAt: new Date("2026-08-18T00:00:00Z"),
};

const CHROME = {
  brandHref: "/",
  navItems: [
    { label: "Home", href: "/", current: false },
    { label: "All works", href: "/browse" },
  ],
  footerNote: "© test",
};

const POST = {
  id: "blog-1",
  title: "A blog post",
  slug: "a-blog-post",
  summary: "A short summary",
  publishedAt: new Date("2026-08-05T12:30:00.000Z"),
  href: "/blog/a-blog-post",
};

const DETAIL = {
  ...POST,
  body: "<p>Body</p>",
  updatedAt: new Date("2026-08-06T00:00:00.000Z"),
};

const ORIGIN = "https://example.test";

const listModule = await import("@/app/blog/page");
const detailModule = await import("@/app/blog/[slug]/page");

beforeEach(() => {
  process.env.SITE_URL = ORIGIN;
  process.env.FEATURE_ARTICLE_BLOG = "true";
  loadChrome.mockReset();
  loadChrome.mockResolvedValue({ settings: SETTINGS, chrome: CHROME });
  loadBlogList.mockReset();
  loadBlogList.mockResolvedValue([POST]);
  loadBlogAccess.mockReset();
  loadBlogDetail.mockReset();
});

afterEach(() => {
  delete process.env.SITE_URL;
  delete process.env.FEATURE_ARTICLE_BLOG;
});

describe("/blog list route", () => {
  it("renders the list of posts", async () => {
    const tree = await listModule.default({ searchParams: Promise.resolve({}) });
    render(tree);
    expect(screen.getByTestId("blog-list")).toBeTruthy();
    expect(screen.getByText("A blog post")).toBeTruthy();
  });

  it("renders the empty state when there are no posts", async () => {
    loadBlogList.mockResolvedValue([]);
    const tree = await listModule.default({ searchParams: Promise.resolve({}) });
    render(tree);
    expect(screen.getByTestId("blog-list-empty")).toBeTruthy();
  });

  it("C-29 开关: FEATURE_ARTICLE_BLOG off -> notFound() without ever calling loadBlogList", async () => {
    delete process.env.FEATURE_ARTICLE_BLOG;
    await expect(listModule.default({ searchParams: Promise.resolve({}) })).rejects.toBe(NOT_FOUND);
    expect(loadBlogList).not.toHaveBeenCalled();
  });

  it("C-29 开关: FEATURE_ARTICLE_BLOG off -> generateMetadata also noindexes rather than crashing", async () => {
    delete process.env.FEATURE_ARTICLE_BLOG;
    const metadata = await listModule.generateMetadata({ searchParams: Promise.resolve({}) });
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("opens indexing with a /blog canonical when the flag is on", async () => {
    const metadata = await listModule.generateMetadata({ searchParams: Promise.resolve({}) });
    expect(metadata.robots).toEqual({ index: true, follow: true });
    expect(metadata.alternates).toEqual(expect.objectContaining({ canonical: `${ORIGIN}/blog` }));
  });
});

describe("/blog/[slug] detail route", () => {
  it("renders the post body for a published post", async () => {
    loadBlogAccess.mockResolvedValue({ kind: "published", articleId: "blog-1", title: DETAIL.title });
    loadBlogDetail.mockResolvedValue(DETAIL);

    const tree = await detailModule.default({ params: Promise.resolve({ slug: "a-blog-post" }) });
    render(tree);
    expect(screen.getByRole("heading", { name: DETAIL.title })).toBeTruthy();
    expect(screen.getByTestId("blog-body")).toBeTruthy();
  });

  it("404s when access is not_found — this is what a hidden post also resolves to (checkBlogArticlePublicAccess folds hidden into not_found, see tests/backend/publication/access-blog.test.ts)", async () => {
    loadBlogAccess.mockResolvedValue({ kind: "not_found" });

    await expect(
      detailModule.default({ params: Promise.resolve({ slug: "hidden-post" }) }),
    ).rejects.toBe(NOT_FOUND);
  });

  it("404s for a takedown post, same precedent as /novel/[slugParam]", async () => {
    loadBlogAccess.mockResolvedValue({ kind: "takedown", title: DETAIL.title });

    await expect(
      detailModule.default({ params: Promise.resolve({ slug: "a-takedown-post" }) }),
    ).rejects.toBe(NOT_FOUND);
  });

  it("renders BlogUnavailableScreen (not a 404) for an unpublished post", async () => {
    loadBlogAccess.mockResolvedValue({ kind: "unavailable", title: DETAIL.title });

    const tree = await detailModule.default({ params: Promise.resolve({ slug: "an-unpublished-post" }) });
    render(tree);
    expect(screen.getByTestId("blog-unavailable-screen")).toBeTruthy();
    // Blog-specific copy, not the Novel-side "book" wording.
    expect(screen.queryByText(/book/i)).toBeNull();
  });

  it("seo_only renders identically to public (checkBlogArticlePublicAccess does not distinguish them) with robots index/follow", async () => {
    // `access.ts`'s `checkBlogArticlePublicAccess` folds both `public` and
    // `seo_only` into the same `published` outcome (see access-blog.test.ts's
    // own truth table) — from this page's perspective they are
    // indistinguishable, exactly matching the plan's "seo_only → 与 public
    // 完全一致地渲染".
    loadBlogAccess.mockResolvedValue({ kind: "published", articleId: "blog-1", title: DETAIL.title });
    loadBlogDetail.mockResolvedValue(DETAIL);

    const metadata = await detailModule.generateMetadata({ params: Promise.resolve({ slug: "a-blog-post" }) });
    expect(metadata.robots).toEqual({ index: true, follow: true });

    const tree = await detailModule.default({ params: Promise.resolve({ slug: "a-blog-post" }) });
    render(tree);
    expect(screen.getByTestId("blog-body")).toBeTruthy();
  });

  it("noindexes metadata for not_found/unavailable/takedown", async () => {
    loadBlogAccess.mockResolvedValue({ kind: "not_found" });
    await expect(
      detailModule.generateMetadata({ params: Promise.resolve({ slug: "x" }) }),
    ).resolves.toEqual(expect.objectContaining({ robots: { index: false, follow: false } }));

    loadBlogAccess.mockResolvedValue({ kind: "unavailable", title: DETAIL.title });
    await expect(
      detailModule.generateMetadata({ params: Promise.resolve({ slug: "x" }) }),
    ).resolves.toEqual(expect.objectContaining({ robots: { index: false, follow: false } }));

    loadBlogAccess.mockResolvedValue({ kind: "takedown", title: DETAIL.title });
    await expect(
      detailModule.generateMetadata({ params: Promise.resolve({ slug: "x" }) }),
    ).resolves.toEqual(expect.objectContaining({ robots: { index: false, follow: false } }));
  });

  it("canonical path has no short id, matching buildBlogRoutePath", async () => {
    loadBlogAccess.mockResolvedValue({ kind: "published", articleId: "blog-1", title: DETAIL.title });
    loadBlogDetail.mockResolvedValue(DETAIL);

    const metadata = await detailModule.generateMetadata({ params: Promise.resolve({ slug: "a-blog-post" }) });
    expect(metadata.alternates?.canonical).toBe(`${ORIGIN}/blog/a-blog-post`);
  });
});
