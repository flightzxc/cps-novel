import "./setup-cleanup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

import { BlogListScreen } from "@/features/public-ui/blog/BlogListScreen";
import { CollectionScreen } from "@/features/public-ui/collection/CollectionScreen";
import type { NovelCardView } from "@/features/public-ui/types";

/**
 * PN-06（`评估_PulseNovel前端SEO审计_2026-10-07.md` 施工单四）：书库 / 分类 / 博客列表三类页面，
 * 分页条必须落在「作品网格（或博客列表）之后、页脚之前」，并且在 `<main>` 之内。
 *
 * 此前三个页面把 `<Pagination/>` 写在整个页面壳 `SiteShell` **之外**，DOM 顺序成了
 * 「网格 → 页脚 → 分页」：读者要滚过页脚才看得到下一页，键盘 Tab 也是先过页脚链接。
 * 现在分页条经 `pagination` 插槽进入屏幕组件，渲染在 `Container` 内、网格之后。
 *
 * jsdom 没有布局，视觉顺序用 DOM 顺序（`compareDocumentPosition`）与 Tab 顺序
 * （可聚焦元素的文档序）两个角度证明；两者在这里是同一个事实。
 *
 * mock 方式与 `tests/ui/locale-aware-page-links.test.tsx` 一致：直接调用各页面的 `*Body`。
 */

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

vi.mock("@/app/_lib/public-load", () => ({
  loadChrome: vi.fn(),
  loadActiveLocales: vi.fn(),
  loadBrowseNovels: vi.fn(),
  loadBlogList: vi.fn(),
}));

vi.mock("@/lib/site/category-queries", () => ({
  getPublicCategoryPage: vi.fn(),
}));

const publicLoad = await import("@/app/_lib/public-load");
const loadChrome = vi.mocked(publicLoad.loadChrome);
const loadActiveLocales = vi.mocked(publicLoad.loadActiveLocales);
const loadBrowseNovels = vi.mocked(publicLoad.loadBrowseNovels);
const loadBlogList = vi.mocked(publicLoad.loadBlogList);

const categoryQueries = await import("@/lib/site/category-queries");
const getPublicCategoryPage = vi.mocked(categoryQueries.getPublicCategoryPage);

const { BrowseBody } = await import("@/app/_pages/browse");
const { CategoryBody } = await import("@/app/_pages/category");
const { BlogListBody } = await import("@/app/_pages/blog-list");

const SETTINGS = {
  siteName: "cps-novel",
  siteDescription: "Overseas novels.",
  homeMetaTitle: "cps-novel",
  homeMetaDescription: "Read overseas novels.",
  defaultOgImage: "https://example.test/og.png",
  googleSearchConsoleVerification: "",
  footerCopyrightText: "",
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

// 页脚里放一条链接：Tab 顺序的断言需要一个「页脚内的可聚焦元素」做参照。
const CHROME = {
  brandHref: "/",
  navItems: [{ label: "Home", href: "/", current: true }],
  footerLinks: [{ label: "Footer-Link", href: "/footer-link" }],
  footerNote: undefined,
};

function card(id: string): NovelCardView {
  return { id, title: `Novel ${id}`, coverUrl: "/cover.jpg", tags: [], href: `/novel/n${id}-pabc123` };
}

function posts(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `p${i}`,
    title: `Post ${i}`,
    slug: `post-${i}`,
    summary: undefined,
    publishedAt: new Date("2026-08-01T00:00:00Z"),
    href: `/blog/post-${i}`,
  }));
}

function categoryPage() {
  return {
    novels: Array.from({ length: 20 }, (_, i) => card(`c${i}`)),
    page: 1,
    totalPages: 2,
    totalCount: 40,
    category: {
      id: "cat-1",
      slug: "fantasy",
      name: "Fantasy",
      description: "Fantasy novels.",
      sortOrder: 1,
      updatedAt: new Date("2026-08-01T00:00:00Z"),
    },
  };
}

/** `a` 在文档序上位于 `b` 之前，且互不包含。 */
function isBefore(a: Element, b: Element): boolean {
  if (a.contains(b) || b.contains(a)) return false;
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/**
 * 分页条（唯一一个）必须：在 `<main>` 内；位于 `anchor`（网格 / 博客列表）之后；位于 `<footer>` 之前；
 * Tab 顺序里「下一页」链接先于页脚链接。
 */
function expectPaginationBetweenContentAndFooter(
  container: HTMLElement,
  anchorTestId: string,
  nextLabel = "Next",
) {
  const main = container.querySelector("main");
  const footer = container.querySelector("footer");
  const pagination = container.querySelectorAll('[data-testid="pagination"]');
  const anchor = container.querySelector(`[data-testid="${anchorTestId}"]`);
  expect(main, "main").toBeTruthy();
  expect(footer, "footer").toBeTruthy();
  expect(anchor, anchorTestId).toBeTruthy();
  expect(pagination).toHaveLength(1);

  const nav = pagination[0]!;
  expect(main!.contains(nav), "分页条应在 <main> 之内").toBe(true);
  expect(footer!.contains(nav), "分页条不应在 <footer> 之内").toBe(false);
  expect(isBefore(anchor!, nav), "分页条应在作品网格 / 列表之后").toBe(true);
  expect(isBefore(nav, footer!), "分页条应在页脚之前").toBe(true);

  const tabbables = Array.from(container.querySelectorAll<HTMLElement>("a[href], button"));
  const nextLink = tabbables.find((el) => nav.contains(el) && el.textContent?.includes(nextLabel));
  const footerLink = tabbables.find((el) => footer!.contains(el));
  expect(nextLink, "下一页链接").toBeTruthy();
  expect(footerLink, "页脚链接").toBeTruthy();
  expect(tabbables.indexOf(nextLink!)).toBeLessThan(tabbables.indexOf(footerLink!));
}

beforeEach(() => {
  process.env.SITE_URL = "https://example.test";
  process.env.FEATURE_ARTICLE_BLOG = "true";
  loadChrome.mockResolvedValue({ settings: SETTINGS, chrome: CHROME });
  loadActiveLocales.mockResolvedValue(["en"]);
  loadBrowseNovels.mockResolvedValue(Array.from({ length: 21 }, (_, i) => card(String(i))));
  loadBlogList.mockResolvedValue(posts(21));
  getPublicCategoryPage.mockReset();
});

afterEach(() => {
  delete process.env.SITE_URL;
  delete process.env.FEATURE_ARTICLE_BLOG;
});

describe("PN-06 · 分页条在作品网格之后、页脚之前", () => {
  it("书库 /browse：分页条在 book-grid 之后、footer 之前，且在 main 之内", async () => {
    const tree = await BrowseBody({ locale: "en", searchParams: Promise.resolve({ page: "1" }) });
    const { container } = render(tree);
    expectPaginationBetweenContentAndFooter(container, "book-grid");
  });

  it("书库 /browse?category=：同样在网格之后、页脚之前，且分类参数照常带进翻页链接", async () => {
    getPublicCategoryPage.mockResolvedValue(categoryPage());
    const tree = await BrowseBody({
      locale: "en",
      searchParams: Promise.resolve({ page: "1", category: "fantasy" }),
    });
    const { container } = render(tree);
    expectPaginationBetweenContentAndFooter(container, "book-grid");
    const next = container.querySelector('[data-testid="pagination"] a[href*="page=2"]');
    expect(next?.getAttribute("href")).toBe("/browse?category=fantasy&page=2");
  });

  it("分类 /category/[slug]：分页条在 book-grid 之后、footer 之前，且在 main 之内", async () => {
    getPublicCategoryPage.mockResolvedValue(categoryPage());
    const tree = await CategoryBody({
      locale: "en",
      params: Promise.resolve({ slug: "fantasy" }),
      searchParams: Promise.resolve({ page: "1" }),
    });
    const { container } = render(tree);
    expectPaginationBetweenContentAndFooter(container, "book-grid");
  });

  it("博客列表 /blog：分页条在 blog-list 之后、footer 之前，且在 main 之内", async () => {
    const tree = await BlogListBody({ locale: "en", searchParams: Promise.resolve({ page: "1" }) });
    const { container } = render(tree);
    expectPaginationBetweenContentAndFooter(container, "blog-list");
  });

  it("非默认语种同样成立（es：翻页链接带 /es 前缀，位置不变）", async () => {
    const tree = await BrowseBody({ locale: "es", searchParams: Promise.resolve({ page: "1" }) });
    const { container } = render(tree);
    expectPaginationBetweenContentAndFooter(container, "book-grid", "Siguiente");
    const next = container.querySelector('[data-testid="pagination"] a[href*="page=2"]');
    expect(next?.getAttribute("href")).toBe("/es/browse?page=2");
  });

  it("单页时不渲染分页条（插槽收到 null 的 Pagination，不留空壳）", async () => {
    loadBrowseNovels.mockResolvedValue([card("1")]);
    const tree = await BrowseBody({ locale: "en", searchParams: Promise.resolve({}) });
    const { container } = render(tree);
    expect(container.querySelector('[data-testid="pagination"]')).toBeNull();
    expect(container.querySelector('[data-testid="book-grid"]')).toBeTruthy();
  });
});

describe("PN-06 · 屏幕组件的 pagination 插槽", () => {
  const CHROME_WITH_FOOTER = { footerLinks: [{ label: "Footer-Link", href: "/footer-link" }] };

  it("CollectionScreen：插槽内容渲染在网格之后、页脚之前；不传插槽时输出与改前一致", () => {
    const withSlot = render(
      <CollectionScreen
        locale="en"
        title="All"
        novels={[card("1")]}
        chrome={CHROME_WITH_FOOTER}
        pagination={<nav data-testid="slot-marker" />}
      />,
    );
    const marker = withSlot.container.querySelector('[data-testid="slot-marker"]')!;
    expect(withSlot.container.querySelector("main")!.contains(marker)).toBe(true);
    expect(isBefore(withSlot.container.querySelector('[data-testid="book-grid"]')!, marker)).toBe(true);
    expect(isBefore(marker, withSlot.container.querySelector("footer")!)).toBe(true);
    withSlot.unmount();

    const without = render(
      <CollectionScreen locale="en" title="All" novels={[card("1")]} chrome={CHROME_WITH_FOOTER} />,
    );
    expect(without.container.querySelector('[data-testid="slot-marker"]')).toBeNull();
    expect(without.container.querySelector('[data-testid="book-grid"]')).toBeTruthy();
  });

  it("BlogListScreen：插槽内容渲染在列表之后、页脚之前", () => {
    const { container } = render(
      <BlogListScreen
        locale="en"
        posts={posts(2)}
        chrome={CHROME_WITH_FOOTER}
        pagination={<nav data-testid="slot-marker" />}
      />,
    );
    const marker = container.querySelector('[data-testid="slot-marker"]')!;
    expect(container.querySelector("main")!.contains(marker)).toBe(true);
    expect(isBefore(container.querySelector('[data-testid="blog-list"]')!, marker)).toBe(true);
    expect(isBefore(marker, container.querySelector("footer")!)).toBe(true);
  });
});
