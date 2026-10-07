import { describe, expect, it } from "vitest";

import type { NovelCardView, NovelDetailView, SiteTag } from "@/features/public-ui/types";
import {
  restrictTagLinks,
  restrictViewTagLinks,
  toLinkableCategorySlugs,
} from "@/lib/site/category-links";

/**
 * B-38 第二部分的纯函数闸门：标签只有 slug 属于"分类页返回 200 的分类集合"时才保留 `href`，其余去掉 `href`
 * （`Tag` 组件对没有 `href` 的标签渲染 `<span>`）。不查库、不看窗口——集合怎么来见
 * `category-link-set-equality.test.ts` 与 `tests/ui/novel-detail-category-links.test.tsx`。
 */

const romance: SiteTag = { slug: "romance", label: "Romance", href: "/category/romance" };
const adventure: SiteTag = { slug: "adventure", label: "Adventure", href: "/ko/category/adventure" };

describe("restrictTagLinks", () => {
  it("集合之内保留 href，集合之外去掉 href（key 也不留），顺序与其余字段不变", () => {
    const withExtras = Object.freeze({ ...adventure, id: "tag-1", sortOrder: 7 });
    const result = restrictTagLinks([romance, withExtras], new Set(["romance"]));
    expect(result.map((tag) => tag.slug)).toEqual(["romance", "adventure"]);
    expect(result[0]).toBe(romance);
    expect(result[1]).toEqual({ slug: "adventure", label: "Adventure", id: "tag-1", sortOrder: 7 });
    expect("href" in result[1]!).toBe(false);
  });

  it("空集合 = 全部去掉；本来就没有 href 的标签原样返回同一个对象", () => {
    const plain: SiteTag = { slug: "plain", label: "Plain" };
    const result = restrictTagLinks([romance, plain], new Set());
    expect(result[0]).toEqual({ slug: "romance", label: "Romance" });
    expect(result[1]).toBe(plain);
  });

  it("不改入参", () => {
    const input = [romance, adventure];
    restrictTagLinks(input, new Set(["romance"]));
    expect(input).toEqual([romance, adventure]);
    expect(adventure.href).toBe("/ko/category/adventure");
  });
});

describe("restrictViewTagLinks", () => {
  const card: NovelCardView = { id: "b1", title: "T", tags: [romance, adventure], href: "/novel/t-pabc" };
  const detail: NovelDetailView = {
    id: "b1", title: "T", description: "D", locale: { code: "en", label: "English" }, totalChapterCount: 3,
    tags: [romance, adventure], previewChapters: [],
  };

  it("卡片与详情视图都适用：只动 tags，其余字段与引用原样", () => {
    const linkable = toLinkableCategorySlugs([{ slug: "romance" }]);
    const restrictedCard = restrictViewTagLinks(card, linkable);
    expect(restrictedCard.tags.map((tag) => tag.href)).toEqual(["/category/romance", undefined]);
    expect({ ...restrictedCard, tags: card.tags }).toEqual(card);

    const restrictedDetail = restrictViewTagLinks(detail, linkable);
    expect(restrictedDetail.tags.map((tag) => tag.href)).toEqual(["/category/romance", undefined]);
    expect(restrictedDetail.previewChapters).toBe(detail.previewChapters);
  });

  it("没有任何标签需要改动时返回同一个对象（不白白复制）", () => {
    expect(restrictViewTagLinks(card, new Set(["romance", "adventure"]))).toBe(card);
    const empty = { ...card, tags: [] as SiteTag[] };
    expect(restrictViewTagLinks(empty, new Set())).toBe(empty);
  });
});

describe("toLinkableCategorySlugs", () => {
  it("把分类列表折成 slug 集合", () => {
    expect([...toLinkableCategorySlugs([{ slug: "a" }, { slug: "b" }, { slug: "a" }])].sort()).toEqual(["a", "b"]);
  });
});
