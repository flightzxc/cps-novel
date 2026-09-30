import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 运营 V2（Owner 2026-09-30）：章节页要写进站点地图，前提是"返回 200、可索引、canonical 指向自身"。
 * 这里把这三条前提钉成可回归的事实（核实结论：章节页**没有** noindex）：
 *
 * - 文章已发布、章节存在 → `robots` 是 `{ index: true, follow: true }`（页面没有自己的 robots
 *   覆盖，`toNextMetadata` 兜底成 index,follow；根布局的 `noindex` 被最内层覆盖）；
 * - canonical 是该章节页自己的绝对地址（带语种前缀，en 不带）；
 * - 反面：章节不存在 / 文章不可用 / 章节号非法 → `noindex`，这些页面本来就不返回 200，
 *   也就不能进站点地图（站点地图那侧靠同一个章节 where 片段保证）。
 */

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("next-not-found");
  },
  permanentRedirect: () => {
    throw new Error("next-redirect");
  },
}));

vi.mock("@/app/_lib/public-load", () => ({
  loadChrome: vi.fn(),
  loadActiveLocales: vi.fn(),
  loadArticleAccess: vi.fn(),
  loadNovelDetail: vi.fn(),
  loadChapterView: vi.fn(),
  loadHreflangSiblings: vi.fn(),
  loadRelatedAndNewReleases: vi.fn().mockResolvedValue({ related: [], newReleases: [] }),
}));

const publicLoad = await import("@/app/_lib/public-load");
const loadChrome = vi.mocked(publicLoad.loadChrome);
const loadArticleAccess = vi.mocked(publicLoad.loadArticleAccess);
const loadChapterView = vi.mocked(publicLoad.loadChapterView);
const loadHreflangSiblings = vi.mocked(publicLoad.loadHreflangSiblings);

const { buildChapterMetadata } = await import("@/app/_pages/chapter");

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
  yandexVerification: "",
  yandexMetricaId: null,
  updatedAt: new Date("2026-08-18T00:00:00Z"),
};

const PUBLISHED = {
  kind: "published" as const,
  articleId: "article-1",
  novelId: "novel-1",
  slugPart: "deungdae",
  shortId: "kor12345",
  title: "등대",
};

const CHAPTER = {
  number: 1,
  title: "첫 번째 장",
  paragraphs: ["바다가 일찍 밀려왔다."],
  novel: {
    id: "biz-1",
    title: "등대",
    href: "/ko/novel/deungdae-pkor12345",
    coverUrl: "/covers/x.jpg",
  },
  previewPosition: { index: 1, total: 3 },
  totalChapterCount: 12,
  previewChapters: [],
};

beforeEach(() => {
  process.env.SITE_URL = ORIGIN;
  loadChrome.mockReset();
  loadChrome.mockResolvedValue({ settings: SETTINGS, chrome: {} } as never);
  loadArticleAccess.mockReset();
  loadChapterView.mockReset();
  loadHreflangSiblings.mockReset();
  loadHreflangSiblings.mockResolvedValue([]);
});

afterEach(() => {
  delete process.env.SITE_URL;
  vi.clearAllMocks();
});

describe("chapter page indexability (precondition for listing it in the sitemap)", () => {
  it("a published article's existing free chapter is index,follow with a self canonical (locale-prefixed)", async () => {
    loadArticleAccess.mockResolvedValue(PUBLISHED);
    loadChapterView.mockResolvedValue(CHAPTER as never);

    const metadata = await buildChapterMetadata("ko", Promise.resolve({ slugParam: "deungdae-pkor12345", chapterNumber: "1" }));

    expect(metadata.robots).toEqual({ index: true, follow: true });
    expect(metadata.alternates?.canonical).toBe(`${ORIGIN}/ko/novel/deungdae-pkor12345/chapter/1`);
  });

  it("the default locale's canonical carries no /en prefix", async () => {
    loadArticleAccess.mockResolvedValue(PUBLISHED);
    loadChapterView.mockResolvedValue(CHAPTER as never);

    const metadata = await buildChapterMetadata("en", Promise.resolve({ slugParam: "deungdae-pkor12345", chapterNumber: "1" }));

    expect(metadata.robots).toEqual({ index: true, follow: true });
    expect(metadata.alternates?.canonical).toBe(`${ORIGIN}/novel/deungdae-pkor12345/chapter/1`);
  });

  it("the flip side: a chapter that does not exist, an unavailable article, or an invalid chapter number is noindex (never a sitemap candidate)", async () => {
    loadArticleAccess.mockResolvedValue(PUBLISHED);
    loadChapterView.mockResolvedValue(null);
    const missingChapter = await buildChapterMetadata("ko", Promise.resolve({ slugParam: "deungdae-pkor12345", chapterNumber: "99" }));
    expect(missingChapter.robots).toEqual({ index: false, follow: false });

    loadArticleAccess.mockResolvedValue({ kind: "unavailable", title: "등대" });
    const unavailable = await buildChapterMetadata("ko", Promise.resolve({ slugParam: "deungdae-pkor12345", chapterNumber: "1" }));
    expect(unavailable.robots).toEqual({ index: false, follow: false });

    const badNumber = await buildChapterMetadata("ko", Promise.resolve({ slugParam: "deungdae-pkor12345", chapterNumber: "0" }));
    expect(badNumber.robots).toEqual({ index: false, follow: false });
  });
});
