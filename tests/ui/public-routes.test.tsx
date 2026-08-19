import "./setup-cleanup";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { HomeScreen } from "@/features/public-ui/home/HomeScreen";
import { Pagination } from "@/features/public-ui/collection/Pagination";
import { ReaderSettingsProvider } from "@/features/public-ui/chapter/ReaderSettingsProvider";
import { UnavailableScreen } from "@/features/public-ui/status/UnavailableScreen";
import type { NovelCardView, NovelDetailView } from "@/features/public-ui/types";

const NOT_FOUND = Symbol("next-not-found");

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw NOT_FOUND;
  },
}));

vi.mock("@/app/_lib/public-load", () => ({
  loadChrome: vi.fn(),
  loadHomeNovels: vi.fn(),
  loadBrowseNovels: vi.fn(),
  loadArticleAccess: vi.fn(),
  loadNovelDetail: vi.fn(),
  loadChapterView: vi.fn(),
  loadHreflangSiblings: vi.fn(),
}));

const publicLoad = await import("@/app/_lib/public-load");
const loadChrome = vi.mocked(publicLoad.loadChrome);
const loadHomeNovels = vi.mocked(publicLoad.loadHomeNovels);
const loadBrowseNovels = vi.mocked(publicLoad.loadBrowseNovels);
const loadArticleAccess = vi.mocked(publicLoad.loadArticleAccess);
const loadNovelDetail = vi.mocked(publicLoad.loadNovelDetail);
const loadChapterView = vi.mocked(publicLoad.loadChapterView);
const loadHreflangSiblings = vi.mocked(publicLoad.loadHreflangSiblings);

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
    { label: "首页", href: "/", current: true },
    { label: "全部作品", href: "/browse" },
  ],
  footerNote: "© test",
};

const CARD: NovelCardView = {
  id: "biz-1",
  title: "The Lantern Keeper's Daughter",
  coverUrl: "/covers/lantern.jpg",
  tags: [],
  href: "/novel/lantern-keepers-daughter-pabc123",
};

const DETAIL: NovelDetailView = {
  id: "biz-1",
  title: "The Lantern Keeper's Daughter",
  coverUrl: "/covers/lantern.jpg",
  description: "A coastal town keeps one lantern burning.",
  locale: { code: "en", label: "English" },
  totalChapterCount: 12,
  tags: [],
  previewChapters: [{ number: 1, title: "The Harbour", href: "/novel/lantern-keepers-daughter-pabc123/chapter/1" }],
};

const homeModule = await import("@/app/page");
const browseModule = await import("@/app/browse/page");
const novelModule = await import("@/app/novel/[slugParam]/page");
const chapterModule = await import("@/app/novel/[slugParam]/chapter/[chapterNumber]/page");
const chapterLayoutModule = await import("@/app/novel/[slugParam]/chapter/layout");
const novelNotFoundModule = await import("@/app/novel/[slugParam]/not-found");

const ORIGIN = "https://example.test";

beforeEach(() => {
  process.env.SITE_URL = ORIGIN;
  loadChrome.mockResolvedValue({ settings: SETTINGS, chrome: CHROME });
  loadHomeNovels.mockResolvedValue([CARD]);
  loadBrowseNovels.mockResolvedValue([CARD]);
  loadArticleAccess.mockReset();
  loadNovelDetail.mockReset();
  loadChapterView.mockReset();
  loadHreflangSiblings.mockReset();
  loadHreflangSiblings.mockResolvedValue([]);
});

afterEach(() => {
  delete process.env.SITE_URL;
});

describe("public home", () => {
  it("renders the grid and no featured block when the carousel service is empty", async () => {
    const tree = await homeModule.default();
    const { container } = render(tree);

    expect(screen.queryByTestId("featured-hero")).toBeNull();
    expect(screen.queryByText("本期主推")).toBeNull();
    expect(container.querySelector('[class*="skeleton"]')).toBeNull();
    expect(screen.getByTestId("book-grid")).toBeTruthy();
  });

  it("opens indexing with a home canonical", async () => {
    const metadata = await homeModule.generateMetadata();
    expect(metadata.robots).toEqual({ index: true, follow: true });
    expect(metadata.alternates).toEqual(
      expect.objectContaining({ canonical: `${ORIGIN}/` }),
    );
    expect(JSON.stringify(metadata)).not.toContain("PulseDrama");
    expect(JSON.stringify(metadata)).not.toContain("/drama/");
  });
});

describe("public browse", () => {
  it("places Pagination in the page glue for a multi-page list", async () => {
    loadBrowseNovels.mockResolvedValue(
      Array.from({ length: 21 }, (_, index) => ({ ...CARD, id: `biz-${index}`, href: `/novel/n${index}-pxx` })),
    );
    const tree = await browseModule.default({ searchParams: Promise.resolve({ page: "1" }) });
    const { container } = render(tree);
    expect(container.querySelector('[data-testid="pagination"]')).toBeTruthy();
    expect(tree.type).not.toBe(Pagination);
  });

  it("does not render Pagination on a single page", async () => {
    const tree = await browseModule.default({ searchParams: Promise.resolve({}) });
    const { container } = render(tree);
    expect(container.querySelector('[data-testid="pagination"]')).toBeNull();
  });

  it("noindexes page 2", async () => {
    loadBrowseNovels.mockResolvedValue(
      Array.from({ length: 21 }, (_, index) => ({ ...CARD, id: `biz-${index}`, href: `/novel/n${index}-pxx` })),
    );
    const metadata = await browseModule.generateMetadata({
      searchParams: Promise.resolve({ page: "2" }),
    });
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates).toEqual(
      expect.objectContaining({ canonical: `${ORIGIN}/browse?page=2` }),
    );
  });
});

describe("public novel detail", () => {
  it("renders the detail screen for a published article", async () => {
    loadArticleAccess.mockResolvedValue({
      kind: "published",
      articleId: "article-1",
      novelId: "novel-1",
      slugPart: "lantern-keepers-daughter",
      shortId: "abc123",
      title: DETAIL.title,
    });
    loadNovelDetail.mockResolvedValue(DETAIL);

    const tree = await novelModule.default({
      params: Promise.resolve({ slugParam: "lantern-keepers-daughter-pabc123" }),
    });
    render(tree);
    expect(screen.getByRole("heading", { name: DETAIL.title })).toBeTruthy();
    expect(screen.queryByText("前往正式阅读")).toBeNull();
  });

  it("renders UnavailableScreen for unpublished and calls notFound for takedown", async () => {
    loadArticleAccess.mockResolvedValue({ kind: "unavailable", title: DETAIL.title });
    const unpublished = await novelModule.default({
      params: Promise.resolve({ slugParam: "lantern-keepers-daughter-pabc123" }),
    });
    expect(unpublished.type).toBe(UnavailableScreen);
    expect(unpublished.props.reason).toBe("unpublished");

    loadArticleAccess.mockResolvedValue({ kind: "takedown", title: DETAIL.title });
    await expect(
      novelModule.default({
        params: Promise.resolve({ slugParam: "lantern-keepers-daughter-pabc123" }),
      }),
    ).rejects.toBe(NOT_FOUND);
  });

  it("calls notFound for missing articles", async () => {
    loadArticleAccess.mockResolvedValue({ kind: "not_found" });
    await expect(
      novelModule.default({
        params: Promise.resolve({ slugParam: "missing-pabc123" }),
      }),
    ).rejects.toBe(NOT_FOUND);
  });

  it("emits self-canonical Book JSON-LD metadata", async () => {
    loadArticleAccess.mockResolvedValue({
      kind: "published",
      articleId: "article-1",
      novelId: "novel-1",
      slugPart: "lantern-keepers-daughter",
      shortId: "abc123",
      title: DETAIL.title,
    });
    loadNovelDetail.mockResolvedValue(DETAIL);

    const metadata = await novelModule.generateMetadata({
      params: Promise.resolve({ slugParam: "lantern-keepers-daughter-pabc123" }),
    });
    expect(metadata.robots).toEqual({ index: true, follow: true });
    expect(metadata.alternates).toEqual(
      expect.objectContaining({
        canonical: `${ORIGIN}/novel/lantern-keepers-daughter-pabc123`,
      }),
    );
    expect(JSON.stringify(metadata)).not.toContain("PulseDrama");
    expect(JSON.stringify(metadata)).not.toContain("/drama/");
  });

  it("resolves hreflang alternates from the real Prisma novelId, not the businessId, and only from actual siblings (P0-S7a)", async () => {
    loadArticleAccess.mockResolvedValue({
      kind: "published",
      articleId: "article-1",
      novelId: "novel-1",
      slugPart: "lantern-keepers-daughter",
      shortId: "abc123",
      title: DETAIL.title,
    });
    loadNovelDetail.mockResolvedValue(DETAIL);
    loadHreflangSiblings.mockResolvedValue([
      { locale: "fr", slug: "la-fille-du-gardien-du-phare", publicPageShortId: "def456" },
    ]);

    const metadata = await novelModule.generateMetadata({
      params: Promise.resolve({ slugParam: "lantern-keepers-daughter-pabc123" }),
    });

    // Called with the Prisma UUID from `access.novelId` — never `DETAIL.id`
    // (`businessId`, "biz-1"), which is a structurally different identifier.
    expect(loadHreflangSiblings).toHaveBeenCalledWith("novel-1");
    expect(metadata.alternates?.languages).toEqual({
      en: `${ORIGIN}/novel/lantern-keepers-daughter-pabc123`,
      fr: `${ORIGIN}/fr/novel/la-fille-du-gardien-du-phare-pdef456`,
      "x-default": `${ORIGIN}/novel/lantern-keepers-daughter-pabc123`,
    });
  });

  it("never blindly enumerates the full registry when there is no published sibling (P0-S7a anti-regression)", async () => {
    loadArticleAccess.mockResolvedValue({
      kind: "published",
      articleId: "article-1",
      novelId: "novel-1",
      slugPart: "lantern-keepers-daughter",
      shortId: "abc123",
      title: DETAIL.title,
    });
    loadNovelDetail.mockResolvedValue(DETAIL);
    loadHreflangSiblings.mockResolvedValue([]);

    const metadata = await novelModule.generateMetadata({
      params: Promise.resolve({ slugParam: "lantern-keepers-daughter-pabc123" }),
    });

    // 15 registered locales; with zero published siblings only the current
    // locale + x-default may appear — never a dead link for `ja`/`ar`/etc.
    expect(Object.keys(metadata.alternates?.languages ?? {}).sort()).toEqual(["en", "x-default"]);
  });

  it("noindexes unavailable and takedown metadata", async () => {
    loadArticleAccess.mockResolvedValue({ kind: "unavailable", title: DETAIL.title });
    await expect(
      novelModule.generateMetadata({
        params: Promise.resolve({ slugParam: "lantern-keepers-daughter-pabc123" }),
      }),
    ).resolves.toEqual(expect.objectContaining({ robots: { index: false, follow: false } }));

    loadArticleAccess.mockResolvedValue({ kind: "takedown", title: DETAIL.title });
    await expect(
      novelModule.generateMetadata({
        params: Promise.resolve({ slugParam: "lantern-keepers-daughter-pabc123" }),
      }),
    ).resolves.toEqual(expect.objectContaining({ robots: { index: false, follow: false } }));
  });
});

describe("public chapter", () => {
  it("keeps ReaderSettingsProvider on the layout above the chapter segment", () => {
    const tree = chapterLayoutModule.default({ children: "CHILDREN" }) as {
      props: { children: readonly { type: unknown; props: Record<string, unknown> }[] };
    };
    const [script, provider] = tree.props.children;
    expect(script.type).toBe("script");
    expect(provider.type).toBe(ReaderSettingsProvider);
  });

  it("self-canonicalizes the chapter URL rather than the novel detail", async () => {
    loadArticleAccess.mockResolvedValue({
      kind: "published",
      articleId: "article-1",
      novelId: "novel-1",
      slugPart: "lantern-keepers-daughter",
      shortId: "abc123",
      title: DETAIL.title,
    });
    loadChapterView.mockResolvedValue({
      number: 1,
      title: "The Harbour",
      paragraphs: ["First paragraph."],
      novel: { id: "biz-1", title: DETAIL.title, href: CARD.href, coverUrl: DETAIL.coverUrl },
      previewPosition: { index: 1, total: 1 },
    });

    const metadata = await chapterModule.generateMetadata({
      params: Promise.resolve({ slugParam: "lantern-keepers-daughter-pabc123", chapterNumber: "1" }),
    });
    expect(metadata.alternates).toEqual(
      expect.objectContaining({
        canonical: `${ORIGIN}/novel/lantern-keepers-daughter-pabc123/chapter/1`,
      }),
    );
    expect(JSON.stringify(metadata.alternates)).not.toBe(
      JSON.stringify({ canonical: `${ORIGIN}/novel/lantern-keepers-daughter-pabc123` }),
    );
  });

  it("404s non-canonical chapter numbers", async () => {
    await expect(
      chapterModule.default({
        params: Promise.resolve({ slugParam: "lantern-keepers-daughter-pabc123", chapterNumber: "01" }),
      }),
    ).rejects.toBe(NOT_FOUND);
  });

  it("calls notFound for a takedown chapter URL", async () => {
    loadArticleAccess.mockResolvedValue({ kind: "takedown", title: DETAIL.title });
    await expect(
      chapterModule.default({
        params: Promise.resolve({ slugParam: "lantern-keepers-daughter-pabc123", chapterNumber: "1" }),
      }),
    ).rejects.toBe(NOT_FOUND);
  });
});

describe("novel segment not-found.tsx", () => {
  it("declares noindex and renders the unavailable explanation", () => {
    expect(novelNotFoundModule.metadata.robots).toEqual({ index: false, follow: false });
    render(novelNotFoundModule.default());
    expect(screen.getByTestId("unavailable-screen")).toBeTruthy();
  });
});

describe("empty featuredList contract", () => {
  it("HomeScreen with an empty featured list has no hero, no 本期主推, and no skeleton", () => {
    const { container } = render(<HomeScreen featuredList={[]} novels={[CARD]} browseAllHref="/browse" />);
    expect(screen.queryByTestId("featured-hero")).toBeNull();
    expect(screen.queryByText("本期主推")).toBeNull();
    expect(container.querySelector('[class*="skeleton"]')).toBeNull();
    expect(container.querySelector('[data-testid="skeleton"]')).toBeNull();
  });
});
