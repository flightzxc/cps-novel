import { describe, expect, it } from "vitest";

import { toChapterView, toNovelDetailView } from "@/lib/site/mappers";

/**
 * R1-1 断点复现与回归覆盖。
 *
 * 断点：`queries.ts` 从未 select `promoLink.publicRedirectCode`、`mappers.ts`
 * 从未计算 `readOnUpstreamHref`——UI 侧（`NovelDetailScreen`/`ChapterScreen`）
 * 与 `/go/[code]/route.ts` 各自完整，唯独中间这段接线不存在，导致该字段对
 * 100% 已发布内容恒为 undefined。
 *
 * `tests/backend/public/mappers.test.ts`（Codex 独占）的既有夹具不带任何
 * `promoLink` 数据，因此无法覆盖「码存在 → 算出 /go/<code>」这条正路径；
 * 这里直接测 `toNovelDetailView`/`toChapterView`，补上这段此前完全没有
 * 测试覆盖、也正是本轮实际改动的逻辑。
 */

const baseArticle = {
  id: "article-1",
  title: "The Lantern Keeper's Daughter",
  slug: "lantern-keepers-daughter",
  locale: "en",
  publicPageShortId: "abc123",
  publishedAt: new Date("2026-01-01T00:00:00Z"),
  novel: {
    id: "novel-1",
    businessId: "biz-1",
    title: "The Lantern Keeper's Daughter",
    description: "A coastal town keeps one lantern burning.",
    coverUrl: null,
    locale: "en",
    totalChapterCount: 12,
  },
};

const previews = [
  { canonicalChapterNumber: 1, title: "The Harbour" },
  { canonicalChapterNumber: 2, title: "Fog" },
];

/** 10 位、小写字母 + 数字，匹配 `PUBLIC_REDIRECT_CODE_FORMAT`。 */
const VALID_CODE = "abc123xy9z";

describe("toNovelDetailView · readOnUpstreamHref", () => {
  it("公开跳转码存在且格式合法时，算出 /go/<code>", () => {
    const detail = toNovelDetailView(
      { ...baseArticle, promoLink: { publicRedirectCode: VALID_CODE } },
      previews,
    );
    expect(detail?.readOnUpstreamHref).toBe(`/go/${VALID_CODE}`);
  });

  it("promoLink 为 null（码缺失）时留 undefined，不抛错", () => {
    const detail = toNovelDetailView({ ...baseArticle, promoLink: null }, previews);
    expect(detail?.readOnUpstreamHref).toBeUndefined();
  });

  it("promoLink 字段整个缺失时同样留 undefined，不抛错", () => {
    const detail = toNovelDetailView(baseArticle, previews);
    expect(detail?.readOnUpstreamHref).toBeUndefined();
  });

  it("码格式非法时留 undefined，不拼出坏链接", () => {
    const tooShort = toNovelDetailView(
      { ...baseArticle, promoLink: { publicRedirectCode: "short" } },
      previews,
    );
    expect(tooShort?.readOnUpstreamHref).toBeUndefined();

    const withSlash = toNovelDetailView(
      { ...baseArticle, promoLink: { publicRedirectCode: "abc/def123" } },
      previews,
    );
    expect(withSlash?.readOnUpstreamHref).toBeUndefined();

    const upperCase = toNovelDetailView(
      { ...baseArticle, promoLink: { publicRedirectCode: "ABC123XY9Z" } },
      previews,
    );
    expect(upperCase?.readOnUpstreamHref).toBeUndefined();
  });
});

describe("toChapterView · readOnUpstreamHref", () => {
  const chapterRecord = { canonicalChapterNumber: 1, title: "The Harbour", body: "First.\n\nSecond." };

  it("公开跳转码存在且格式合法时，算出 /go/<code>", () => {
    const chapter = toChapterView(
      { ...baseArticle, promoLink: { publicRedirectCode: VALID_CODE } },
      chapterRecord,
      previews,
    );
    expect(chapter?.readOnUpstreamHref).toBe(`/go/${VALID_CODE}`);
  });

  it("promoLink 为 null（码缺失）时留 undefined", () => {
    const chapter = toChapterView({ ...baseArticle, promoLink: null }, chapterRecord, previews);
    expect(chapter?.readOnUpstreamHref).toBeUndefined();
  });

  it("promoLink 字段整个缺失时同样留 undefined", () => {
    const chapter = toChapterView(baseArticle, chapterRecord, previews);
    expect(chapter?.readOnUpstreamHref).toBeUndefined();
  });
});
