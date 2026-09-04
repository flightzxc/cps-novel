import "./setup-cleanup";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import type { NovelDetailView } from "@/features/public-ui/types";
import { UnavailableScreen } from "@/features/public-ui/status/UnavailableScreen";

/**
 * M7 public-consumer bite tests (交接提示词 B-2 / 施工规格 ACCEPTANCE_MATRIX
 * row "M7 Article"): `novel/[slugParam]/page.tsx` must prefer
 * `Article.seoMetadata` over the base `Novel` title/description, render
 * `Article.body` (via `NovelDetailView.contentBody`), and surface FAQ
 * JSON-LD extracted from it.
 *
 * Same mocking discipline as the pre-existing `tests/ui/public-routes.test.tsx`
 * (mock `@/app/_lib/public-load` + `next/navigation`, drive the real page
 * module's exported `generateMetadata`/default functions) — this file adds
 * the specific seoMetadata/body/FAQ/unpublished-exclusion assertions that
 * file's own `DETAIL` fixture (no `seoTitle`/`seoDescription`/`contentBody`
 * set) does not exercise.
 *
 * Mutation targets named in the CHANGES_REQUIRED report:
 *   - "generateMetadata 与页面 SEO 改回读 novel.title/description → 全绿":
 *     killed by "generateMetadata 优先 seoTitle/seoDescription" and
 *     "页面 <title> 与 canonical 之外的正文...优先 seoTitle" below.
 *   - "body 不渲染 → 红": killed by "渲染 Article.body（contentBody）".
 */

const NOT_FOUND = Symbol("next-not-found");

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw NOT_FOUND;
  },
}));

vi.mock("@/app/_lib/public-load", () => ({
  loadChrome: vi.fn(),
  loadHomeNovels: vi.fn(),
  loadHomeCarousel: vi.fn(),
  loadPublicCategories: vi.fn(),
  loadBrowseNovels: vi.fn(),
  loadArticleAccess: vi.fn(),
  loadNovelDetail: vi.fn(),
  loadChapterView: vi.fn(),
  loadHreflangSiblings: vi.fn(),
}));

const publicLoad = await import("@/app/_lib/public-load");
const loadChrome = vi.mocked(publicLoad.loadChrome);
const loadArticleAccess = vi.mocked(publicLoad.loadArticleAccess);
const loadNovelDetail = vi.mocked(publicLoad.loadNovelDetail);
const loadHreflangSiblings = vi.mocked(publicLoad.loadHreflangSiblings);

const novelModule = await import("@/app/novel/[slugParam]/page");

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

const ACCESS = {
  kind: "published" as const,
  articleId: "article-1",
  novelId: "novel-1",
  slugPart: "lantern-keepers-daughter",
  shortId: "abc123",
  title: "The Lantern Keeper's Daughter",
};

const FAQ_BODY = "<h2>Is this free to read?</h2><p>Yes, the preview chapters are free.</p>";

const DETAIL_WITH_SEO: NovelDetailView = {
  id: "biz-1",
  title: "The Lantern Keeper's Daughter",
  description: "The base Novel description — must lose to seoDescription.",
  contentBody: FAQ_BODY,
  seoTitle: "SEO-Optimized Title From Article",
  seoDescription: "SEO-optimized description from Article.seoMetadata.",
  locale: { code: "en", label: "English" },
  totalChapterCount: 12,
  tags: [],
  previewChapters: [],
};

const ORIGIN = "https://example.test";

function params() {
  return { params: Promise.resolve({ slugParam: "lantern-keepers-daughter-pabc123" }) };
}

beforeEach(() => {
  process.env.SITE_URL = ORIGIN;
});

afterEach(() => {
  delete process.env.SITE_URL;
  vi.clearAllMocks();
});

describe("novel/[slugParam] · generateMetadata 优先 seoMetadata", () => {
  it("title/description 取 Article.seoMetadata（seoTitle/seoDescription），不是 Novel.title/description", async () => {
    loadChrome.mockResolvedValue({ settings: SETTINGS, chrome: CHROME });
    loadArticleAccess.mockResolvedValue(ACCESS);
    loadNovelDetail.mockResolvedValue(DETAIL_WITH_SEO);
    loadHreflangSiblings.mockResolvedValue([]);

    const metadata = await novelModule.generateMetadata(params());

    expect(metadata.title).toBe("SEO-Optimized Title From Article");
    expect(metadata.description).toBe("SEO-optimized description from Article.seoMetadata.");
    expect(metadata.description).not.toContain("base Novel description");
  });

  it("Article.seoMetadata 缺失时回退到 Novel.title/description", async () => {
    loadChrome.mockResolvedValue({ settings: SETTINGS, chrome: CHROME });
    loadArticleAccess.mockResolvedValue(ACCESS);
    loadNovelDetail.mockResolvedValue({ ...DETAIL_WITH_SEO, seoTitle: undefined, seoDescription: undefined });
    loadHreflangSiblings.mockResolvedValue([]);

    const metadata = await novelModule.generateMetadata(params());
    expect(metadata.title).toBe(DETAIL_WITH_SEO.title);
    expect(metadata.description).toBe("The base Novel description — must lose to seoDescription.");
  });
});

describe("novel/[slugParam] · 页面渲染", () => {
  it("渲染 Article.body（contentBody）与其中的 FAQ JSON-LD", async () => {
    loadChrome.mockResolvedValue({ settings: SETTINGS, chrome: CHROME });
    loadArticleAccess.mockResolvedValue(ACCESS);
    loadNovelDetail.mockResolvedValue(DETAIL_WITH_SEO);
    loadHreflangSiblings.mockResolvedValue([]);

    const tree = await novelModule.default(params());
    render(tree);

    expect(screen.getByText("Yes, the preview chapters are free.")).toBeTruthy();

    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    const faqScript = scripts.find((el) => (el.textContent ?? "").includes("FAQPage"));
    expect(faqScript).toBeTruthy();
    const faqJson = JSON.parse(faqScript!.textContent!);
    expect(faqJson.mainEntity[0]).toMatchObject({
      "@type": "Question",
      name: "Is this free to read?",
      acceptedAnswer: { "@type": "Answer", text: "Yes, the preview chapters are free." },
    });
  });

  it("contentBody 为空时不渲染正文区块，也没有 FAQ JSON-LD", async () => {
    loadChrome.mockResolvedValue({ settings: SETTINGS, chrome: CHROME });
    loadArticleAccess.mockResolvedValue(ACCESS);
    loadNovelDetail.mockResolvedValue({ ...DETAIL_WITH_SEO, contentBody: undefined });
    loadHreflangSiblings.mockResolvedValue([]);

    const tree = await novelModule.default(params());
    render(tree);
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    expect(scripts.some((el) => (el.textContent ?? "").includes("FAQPage"))).toBe(false);
  });

  it("未发布（unavailable）文章不进入 SEO 消费：渲染 UnavailableScreen，metadata noindex，不读 Article 字段", async () => {
    loadChrome.mockResolvedValue({ settings: SETTINGS, chrome: CHROME });
    loadArticleAccess.mockResolvedValue({ kind: "unavailable", title: "Some Unpublished Novel" });

    const tree = await novelModule.default(params());
    expect(tree.type).toBe(UnavailableScreen);
    expect(loadNovelDetail).not.toHaveBeenCalled();

    const metadata = await novelModule.generateMetadata(params());
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
