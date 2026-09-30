import { describe, expect, it } from "vitest";

import { getPublicT } from "@/lib/locale/messages";
import { buildArticlePath } from "@/lib/slug/article-path";
import { buildChapterPath, buildChapterRoutePath } from "@/lib/seo/chapter-path";
import { toChapterView, toNovelCardView, toNovelDetailView } from "@/lib/site/mappers";

const article = {
  id: "article-1",
  title: "The Lantern Keeper's Daughter",
  slug: "lantern-keepers-daughter",
  locale: "en",
  publicPageShortId: "abc123",
  publishedAt: new Date("2026-01-01T00:00:00Z"),
  summary: "A concise article summary.",
  body: "Editorial body copy.",
  seoMetadata: {
    metaTitle: "Lantern Keeper SEO title",
    metaDescription: "Lantern Keeper SEO description",
  },
  novel: {
    id: "novel-1",
    businessId: "biz-1",
    title: "The Lantern Keeper's Daughter",
    description: "A coastal town keeps one lantern burning.\n\nSecond paragraph.",
    coverUrl: "/covers/lantern.jpg",
    locale: "en",
    totalChapterCount: 12,
  },
};

const previews = [
  { canonicalChapterNumber: 1, title: "The Harbour" },
  { canonicalChapterNumber: 2, title: "Fog" },
];

describe("public view mappers", () => {
  it("maps a card with a foundation path and no tags when none exist", () => {
    const card = toNovelCardView(article);
    expect(card).toEqual({
      id: "biz-1",
      title: article.title,
      coverUrl: "/covers/lantern.jpg",
      tags: [],
      locale: { code: "en", label: "English" },
      href: buildArticlePath({ locale: "en", slug: article.slug, shortId: article.publicPageShortId }),
      summary: "A concise article summary.",
    });
    expect(JSON.stringify(card)).not.toMatch(/webUrl|upstreamCode|author|readOnUpstreamHref/);
  });

  it("maps detail preview hrefs onto composed chapter paths", () => {
    const detail = toNovelDetailView(article, previews);
    expect(detail?.previewChapters[0]?.href).toBe(
      buildChapterPath({
        locale: "en",
        slug: article.slug,
        shortId: article.publicPageShortId,
        chapterNumber: 1,
      }),
    );
    expect(detail?.readOnUpstreamHref).toBeUndefined();
    expect(detail?.heroImageUrl).toBeUndefined();
    expect(detail?.tags).toEqual([]);
    expect(detail).toMatchObject({
      description: "A concise article summary.",
      contentBody: "Editorial body copy.",
      seoTitle: "Lantern Keeper SEO title",
      seoDescription: "Lantern Keeper SEO description",
    });
  });

  it("splits chapter body and wires prev/next without a go-link", () => {
    const chapter = toChapterView(
      article,
      { canonicalChapterNumber: 1, title: "The Harbour", body: "First.\n\nSecond." },
      previews,
    );
    expect(chapter?.paragraphs).toEqual(["First.", "Second."]);
    expect(chapter?.nextHref).toBe(
      buildChapterRoutePath({
        slug: article.slug,
        shortId: article.publicPageShortId,
        chapterNumber: 2,
      }),
    );
    expect(chapter?.previousHref).toBeUndefined();
    expect(chapter?.readOnUpstreamHref).toBeUndefined();
  });

  it("returns null when the chapter body has no paragraphs", () => {
    expect(
      toChapterView(article, { canonicalChapterNumber: 1, title: "Empty", body: "  \n" }, previews),
    ).toBeNull();
  });

  // TKD 对齐 CPS（Owner 2026-09-30）：章节名缺失时的兜底标题按语种走文案，
  // 不再是写死的英文 "Chapter N"。这个值同时是章节页 <title>、H1 与章节列表条目文字。
  describe("章节名缺失时的兜底标题按语种本地化", () => {
    const unnamed = [
      { canonicalChapterNumber: 1, title: null },
      { canonicalChapterNumber: 2, title: "   " },
      { canonicalChapterNumber: 3, title: "The Gate" },
    ];

    it("en：仍是 'Chapter N'（与改动前字节一致），有名字的章节不受影响", () => {
      const detail = toNovelDetailView(article, unnamed);
      expect(detail?.previewChapters.map((chapter) => chapter.title)).toEqual(["Chapter 1", "Chapter 2", "The Gate"]);
      const chapter = toChapterView(article, { canonicalChapterNumber: 1, title: null, body: "First." }, unnamed);
      expect(chapter?.title).toBe("Chapter 1");
    });

    it("非英语语种：走该语种的 novel.chapterHeading，且不再出现英文 'Chapter'", () => {
      for (const locale of ["ja", "ko", "zh-Hant", "ru", "ar", "de"] as const) {
        const localized = { ...article, locale, novel: { ...article.novel, locale } };
        const t = getPublicT(locale);
        const detail = toNovelDetailView(localized, unnamed);
        expect(detail?.previewChapters[0]?.title, locale).toBe(t("novel.chapterHeading", { number: 1 }));
        expect(detail?.previewChapters[2]?.title, locale).toBe("The Gate");
        const chapter = toChapterView(localized, { canonicalChapterNumber: 2, title: "", body: "First." }, unnamed);
        expect(chapter?.title, locale).toBe(t("novel.chapterHeading", { number: 2 }));
        expect(chapter?.title, locale).not.toMatch(/^Chapter /);
      }
    });
  });
});
