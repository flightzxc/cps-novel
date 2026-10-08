import "./setup-cleanup";

import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TagList } from "@/components/Tag";
import { BookCard } from "@/features/public-ui/book/BookCard";
import { NovelDetailScreen } from "@/features/public-ui/novel/NovelDetailScreen";
import type { NovelCardView, NovelDetailView, SiteTag } from "@/features/public-ui/types";
import { restrictViewTagLinks, toLinkableCategorySlugs } from "@/lib/site/category-links";

/**
 * B-38 第二部分：标签渲染成链接还是纯文字，由"该语种分类页返回 200 的分类集合"决定。
 * 这里在**组件层**钉死渲染结果（数据层怎么得到这个集合见 `category-link-set-equality.test.ts` 与
 * `novel-detail-category-links.test.tsx`）：
 *   - 集合之内的分类 → `<a href="/category/{slug}">`；
 *   - 集合之外的分类 → `<span>`，没有 href；
 *   - 推荐卡片同理（`BookCard` 非 minimal 档）；而详情页 / 章节页实际用的 `minimal` 档整块不渲染标签。
 */

const IN_WINDOW: SiteTag = { slug: "fantasy", label: "Fantasy", href: "/category/fantasy" };
const OUT_OF_WINDOW: SiteTag = { slug: "adventure", label: "Adventure", href: "/category/adventure" };
/** 页面返回 200 的分类集合：只有 fantasy。 */
const LINKABLE = toLinkableCategorySlugs([{ slug: "fantasy" }]);

function tagNodes(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[data-testid="tag-list"] li > *')].map((node) => ({
    text: node.textContent,
    tag: node.tagName.toLowerCase(),
    href: node.getAttribute("href"),
  }));
}

const DETAIL: NovelDetailView = {
  id: "b-1",
  title: "The Lantern Keeper's Daughter",
  description: "A coastal town keeps one lantern burning.",
  locale: { code: "en", label: "English" },
  totalChapterCount: 12,
  tags: [OUT_OF_WINDOW, IN_WINDOW],
  previewChapters: [{ number: 1, title: "The Harbour", href: "/novel/lantern-p1/chapter/1" }],
};

const CARD: NovelCardView = {
  id: "c-1",
  title: "Nine Winters in the Glass House",
  tags: [OUT_OF_WINDOW, IN_WINDOW],
  href: "/novel/glass-house-p2",
};

describe("TagList：有 href 渲染成链接，没有 href 渲染成纯文字", () => {
  it("集合之内保留链接，集合之外是 span 且没有 href 属性", () => {
    const { container } = render(<TagList tags={restrictViewTagLinks({ tags: DETAIL.tags }, LINKABLE).tags} />);
    expect(tagNodes(container)).toEqual([
      { text: "Adventure", tag: "span", href: null },
      { text: "Fantasy", tag: "a", href: "/category/fantasy" },
    ]);
    expect(container.querySelector('a[href="/category/adventure"]')).toBeNull();
    expect(container.querySelector("span[href]")).toBeNull();
  });
});

describe("详情页（NovelDetailScreen）", () => {
  it("可链接集合里的分类渲染为链接、不在集合里的渲染为纯文字", () => {
    const { container } = render(
      <NovelDetailScreen locale="en" novel={restrictViewTagLinks(DETAIL, LINKABLE)} />,
    );
    expect(tagNodes(container)).toEqual([
      { text: "Adventure", tag: "span", href: null },
      { text: "Fantasy", tag: "a", href: "/category/fantasy" },
    ]);
    expect(container.querySelector('a[href*="/category/adventure"]')).toBeNull();
  });

  it("未收口的视图（对照）：两个标签都带 href，不在集合里的那个就是死链——这正是要收口的现象", () => {
    const { container } = render(<NovelDetailScreen locale="en" novel={DETAIL} />);
    expect(container.querySelector('a[href="/category/adventure"]')).not.toBeNull();
  });

  it("推荐区（minimal 卡片）只显示封面与书名，不渲染任何标签——即使卡片携带带 href 的标签", () => {
    const { container } = render(
      <NovelDetailScreen locale="en" novel={{ ...DETAIL, tags: [] }} related={[CARD]} newReleases={[CARD]} />,
    );
    const sections = [...container.querySelectorAll("section")].filter((section) =>
      section.getAttribute("aria-labelledby")?.match(/related-works|new-releases/));
    expect(sections).toHaveLength(2);
    for (const section of sections) {
      expect(within(section).queryByTestId("tag-list")).toBeNull();
      expect(section.querySelector('a[href*="/category/"]')).toBeNull();
    }
  });
});

describe("推荐卡片（BookCard 非 minimal 档）同理", () => {
  it("收口后的卡片：可链接集合里的是链接，不在集合里的是没有 href 的纯文字", () => {
    const { container } = render(<BookCard locale="en" novel={restrictViewTagLinks(CARD, LINKABLE)} />);
    expect(tagNodes(container)).toEqual([
      { text: "Adventure", tag: "span", href: null },
      { text: "Fantasy", tag: "a", href: "/category/fantasy" },
    ]);
  });

  it("minimal 档（详情页 / 章节页的推荐区实际用的）不渲染标签，所以不会产生任何分类链接", () => {
    const { container } = render(<BookCard locale="en" novel={CARD} minimal />);
    expect(container.querySelector('[data-testid="tag-list"]')).toBeNull();
    expect(container.querySelector('a[href*="/category/"]')).toBeNull();
  });
});
