import "./setup-cleanup";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import type { BlogDetailView } from "@/lib/site/blog-queries";
import { buildBlogPath } from "@/lib/slug/article-path";

/**
 * Blog-family sibling of `novel-slug-decode-and-canonical-prefix.test.ts` —
 * `blog-detail.tsx` had the SAME two defects `novel-detail.tsx` had before
 * X8 轮 2f (`l10n-uat-progress.md` 轮 2f 小节) were fixed there: (1) the raw
 * `[slug]` route param was never run through `decodeSlugParam`, so a
 * non-ASCII blog slug's `params.slug` reached `loadBlogAccess` still
 * percent-encoded (see `decodeSlugParam`'s own doc comment,
 * `src/lib/slug/article-path.ts` — Next does not decode a non-ASCII
 * percent-escape in a `force-dynamic` route segment on its own); (2) the
 * blog family's own `canonicalPath` was built with the locale-unaware
 * `buildBlogRoutePath` instead of `buildBlogPath`, silently dropping the
 * `/{locale}` prefix for every non-`en` locale (byte-identical to the
 * correct output for `en` only, since `localePrefix("en") === ""` — exactly
 * why this never showed up before this round's first non-`en` blog post).
 * Same fix shape, same regression risk, hence a parallel test file rather
 * than folding into the novel one (`BlogArticleAccessResult`/
 * `BlogDetailView` are structurally unrelated to the Novel-shaped
 * `NovelArticleAccessResult`/`NovelDetailView` — no short id, no
 * `-p{shortId}` suffix, no hreflang siblings).
 *
 * Mutation targets（本文件报告里逐条人工验证过，此处保留描述供复核对照）：
 *   - "blog-detail.tsx 删掉 decodeSlugParam 调用" → 本文件"①"组的
 *     `toHaveBeenCalledWith` 断言红（`loadBlogAccess` 收到的还是原样编码串，
 *     不等于期望的解码串）。
 *   - "blog canonical 改回 buildBlogRoutePath" → 本文件"②"组的 canonical
 *     断言红（非 en locale 缺 /{locale} 前缀）。
 */

const NOT_FOUND = Symbol("next-not-found");

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw NOT_FOUND;
  },
}));

vi.mock("@/app/_lib/public-load", () => ({
  loadChrome: vi.fn(),
  loadActiveLocales: vi.fn(),
  loadBlogAccess: vi.fn(),
  loadBlogDetail: vi.fn(),
}));

const publicLoad = await import("@/app/_lib/public-load");
const loadChrome = vi.mocked(publicLoad.loadChrome);
const loadActiveLocales = vi.mocked(publicLoad.loadActiveLocales);
const loadBlogAccess = vi.mocked(publicLoad.loadBlogAccess);
const loadBlogDetail = vi.mocked(publicLoad.loadBlogDetail);

const { buildBlogDetailMetadata, BlogDetailBody } = await import("@/app/_pages/blog-detail");

const ORIGIN = "https://example.test";

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
  navItems: [{ label: "Home", href: "/", current: true }],
  footerNote: "© test",
};

beforeEach(() => {
  process.env.SITE_URL = ORIGIN;
  process.env.FEATURE_ARTICLE_BLOG = "true";
  loadChrome.mockReset();
  loadChrome.mockResolvedValue({ settings: SETTINGS, chrome: CHROME });
  loadActiveLocales.mockReset();
  loadActiveLocales.mockResolvedValue(["en", "ru"] as never);
  loadBlogAccess.mockReset();
  loadBlogDetail.mockReset();
});

afterEach(() => {
  delete process.env.SITE_URL;
  delete process.env.FEATURE_ARTICLE_BLOG;
  vi.clearAllMocks();
});

describe("① 非 ASCII blog slug：decodeSlugParam 在 loadBlogAccess 之前解码一次", () => {
  const plainSlug = "тайны-старого-дома";
  // 与站点自身 buildBlogRoutePath 的 encodeURIComponent 完全同形——这正是
  // Next 交给页面的原始 params.slug（未解码）。
  const rawEncodedSlug = encodeURIComponent(plainSlug);

  const DETAIL: BlogDetailView = {
    id: "blog-1",
    title: "Тайны старого дома",
    slug: plainSlug,
    summary: "A short summary",
    publishedAt: new Date("2026-08-05T12:30:00.000Z"),
    href: `/ru/blog/${encodeURIComponent(plainSlug)}`,
    body: "<p>Body</p>",
    updatedAt: new Date("2026-08-06T00:00:00.000Z"),
  };

  it("loadBlogAccess 收到解码后的明文，而不是原样编码串", async () => {
    loadBlogAccess.mockResolvedValue({ kind: "published", articleId: "blog-1", title: DETAIL.title });
    loadBlogDetail.mockResolvedValue(DETAIL);

    const metadata = await buildBlogDetailMetadata("ru", Promise.resolve({ slug: rawEncodedSlug }));

    expect(loadBlogAccess).toHaveBeenCalledWith("ru", plainSlug);
    expect(loadBlogAccess).not.toHaveBeenCalledWith("ru", rawEncodedSlug);
    expect(metadata.title).toContain(DETAIL.title);

    const tree = await BlogDetailBody({ locale: "ru", params: Promise.resolve({ slug: rawEncodedSlug }) });
    render(tree);
    expect(screen.getByTestId("blog-body")).toBeTruthy();
  });

  it("非法转义（%zz）不抛出，回落原文，随后按 not_found 走 notFound()", async () => {
    const malformed = "bad%zzslug";
    loadBlogAccess.mockResolvedValue({ kind: "not_found" });

    await expect(
      BlogDetailBody({ locale: "ru", params: Promise.resolve({ slug: malformed }) }),
    ).rejects.toBe(NOT_FOUND);
    expect(loadBlogAccess).toHaveBeenCalledWith("ru", malformed);
  });
});

describe("② blog canonical：非 en locale 必须带 /{locale} 前缀，en 保持裸路径不回归", () => {
  const DETAIL: BlogDetailView = {
    id: "blog-2",
    title: "A Russian blog post",
    slug: "a-russian-blog-post",
    summary: "A short summary",
    publishedAt: new Date("2026-08-05T12:30:00.000Z"),
    href: "/ru/blog/a-russian-blog-post",
    body: "<p>Body</p>",
    updatedAt: new Date("2026-08-06T00:00:00.000Z"),
  };

  it("ru：canonical 带 /ru/blog/<slug> 前缀（非裸 /blog/...)", async () => {
    loadBlogAccess.mockResolvedValue({ kind: "published", articleId: "blog-2", title: DETAIL.title });
    loadBlogDetail.mockResolvedValue(DETAIL);

    const metadata = await buildBlogDetailMetadata("ru", Promise.resolve({ slug: DETAIL.slug }));

    const expectedCanonical = `${ORIGIN}${buildBlogPath({ locale: "ru", slug: DETAIL.slug })}`;
    expect(expectedCanonical).toBe(`${ORIGIN}/ru/blog/a-russian-blog-post`);
    expect(metadata.alternates?.canonical).toBe(expectedCanonical);
    const canonicalStr = String(metadata.alternates?.canonical);
    expect(canonicalStr.startsWith(`${ORIGIN}/blog/`)).toBe(false);

    const tree = await BlogDetailBody({ locale: "ru", params: Promise.resolve({ slug: DETAIL.slug }) });
    render(tree);
    expect(screen.getByTestId("blog-body")).toBeTruthy();
  });

  it("en 不回归：前缀为空，canonical 与旧行为字节一致（裸 /blog/<slug>）", async () => {
    loadBlogAccess.mockResolvedValue({ kind: "published", articleId: "blog-2", title: DETAIL.title });
    loadBlogDetail.mockResolvedValue(DETAIL);

    const metadata = await buildBlogDetailMetadata("en", Promise.resolve({ slug: DETAIL.slug }));

    expect(metadata.alternates?.canonical).toBe(`${ORIGIN}/blog/a-russian-blog-post`);
  });
});
