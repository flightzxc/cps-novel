import "./setup-cleanup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

import { CoverPreconnect } from "@/components/CoverPreconnect";
import { collectCoverPreconnectOrigins } from "@/lib/site/cover-preconnect";
import type { NovelDetailView } from "@/features/public-ui/types";

/**
 * 封面图床预连接（B-37 阶段 0）。
 *
 * 范围刻意最小：只在「本页首屏一定会加载这张封面」的两处输出——小说详情页（该书封面）、
 * 首页（初始激活轮播项的封面）。只认 https:// 绝对地址，按 origin 去重，不加 crossorigin。
 */

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("next-not-found");
  },
}));

vi.mock("@/app/_lib/public-load", () => ({
  loadChrome: vi.fn(),
  loadActiveLocales: vi.fn(),
  loadHomeNovels: vi.fn(),
  loadHomeCarousel: vi.fn(),
  loadPublicCategories: vi.fn(),
  loadBrowsePage: vi.fn(),
  loadCategoryPage: vi.fn(),
  loadArticleAccess: vi.fn(),
  loadNovelDetail: vi.fn(),
  loadChapterView: vi.fn(),
  loadHreflangSiblings: vi.fn(),
  loadRelatedAndNewReleases: vi.fn().mockResolvedValue({ related: [], newReleases: [] }),
}));

const publicLoad = await import("@/app/_lib/public-load");
const loadChrome = vi.mocked(publicLoad.loadChrome);
const loadActiveLocales = vi.mocked(publicLoad.loadActiveLocales);
const loadHomeNovels = vi.mocked(publicLoad.loadHomeNovels);
const loadHomeCarousel = vi.mocked(publicLoad.loadHomeCarousel);
const loadPublicCategories = vi.mocked(publicLoad.loadPublicCategories);
const loadArticleAccess = vi.mocked(publicLoad.loadArticleAccess);
const loadNovelDetail = vi.mocked(publicLoad.loadNovelDetail);
const loadHreflangSiblings = vi.mocked(publicLoad.loadHreflangSiblings);

const homeModule = await import("@/app/page");
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
  yandexVerification: "",
  yandexMetricaId: null,
  siteSearchEnabled: false,
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

function detail(id: string, coverUrl?: string): NovelDetailView {
  return {
    id,
    title: `Novel ${id}`,
    coverUrl,
    description: "A coastal town keeps one lantern burning.",
    locale: { code: "en", label: "English" },
    totalChapterCount: 12,
    tags: [],
    previewChapters: [],
  };
}

function preconnectLinks(): HTMLLinkElement[] {
  return [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="preconnect"]')];
}

beforeEach(() => {
  process.env.SITE_URL = "https://example.test";
  loadChrome.mockResolvedValue({ settings: SETTINGS, chrome: CHROME });
  loadActiveLocales.mockResolvedValue(["en"] as never);
  loadHomeNovels.mockResolvedValue([]);
  loadPublicCategories.mockResolvedValue([]);
  loadHreflangSiblings.mockResolvedValue([]);
  loadArticleAccess.mockResolvedValue(ACCESS);
});

afterEach(() => {
  delete process.env.SITE_URL;
});

describe("collectCoverPreconnectOrigins", () => {
  it("取 https 绝对地址的 origin（去掉路径与查询串）", () => {
    expect(
      collectCoverPreconnectOrigins(["https://img.cdreader.example/cover/1/250x350.jpg?x=1"]),
    ).toEqual(["https://img.cdreader.example"]);
  });

  it("同 origin 去重，保持首次出现的顺序", () => {
    expect(
      collectCoverPreconnectOrigins([
        "https://a.example/1.jpg",
        "https://b.example/1.jpg",
        "https://a.example/2.jpg",
      ]),
    ).toEqual(["https://a.example", "https://b.example"]);
  });

  it("端口属于 origin 的一部分：不同端口不去重", () => {
    expect(
      collectCoverPreconnectOrigins(["https://a.example/1.jpg", "https://a.example:8443/1.jpg"]),
    ).toEqual(["https://a.example", "https://a.example:8443"]);
  });

  it("只处理 https 绝对地址：相对路径、协议相对、http、data、乱写、空值全部跳过", () => {
    expect(
      collectCoverPreconnectOrigins([
        "/covers/local.jpg",
        "//img.example/protocol-relative.jpg",
        "http://img.example/insecure.jpg",
        "data:image/svg+xml;utf8,%3Csvg%3E%3C/svg%3E",
        "https:no-slashes.example/x.jpg",
        "https://",
        "not a url",
        "",
        "   ",
        null,
        undefined,
      ]),
    ).toEqual([]);
  });
});

describe("CoverPreconnect 组件", () => {
  it("输出 rel=preconnect 的 link，且没有 crossorigin 属性", () => {
    // 完整文档：React 19 会把 body 里渲染的 <link> 提升进 <head>。
    const html = renderToStaticMarkup(
      <html>
        {/* 测试里手搭一个文档骨架，不是页面代码；next/head 在 App Router 下不适用 */}
        {/* eslint-disable-next-line @next/next/no-head-element */}
        <head />
        <body>
          <CoverPreconnect urls={["https://img.example/cover/1.jpg"]} />
          <main>content</main>
        </body>
      </html>,
    );

    const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
    expect(head).toContain('<link rel="preconnect" href="https://img.example"/>');
    expect(html).not.toMatch(/crossorigin/i);
  });

  it("没有可用的 https 地址时什么都不输出", () => {
    expect(renderToStaticMarkup(<CoverPreconnect urls={["/covers/a.jpg", undefined]} />)).toBe("");
  });
});

describe("小说详情页预连接", () => {
  it("给该书封面的 origin 输出一次 preconnect", async () => {
    loadNovelDetail.mockResolvedValue(detail("n1", "https://img.example/cover/n1.jpg"));

    const tree = await novelModule.default({
      params: Promise.resolve({ slugParam: "lantern-keepers-daughter-pabc123" }),
    });
    render(tree);

    const links = preconnectLinks();
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["https://img.example"]);
    expect(links[0].hasAttribute("crossorigin")).toBe(false);
  });

  it("封面是相对路径或缺失时不输出", async () => {
    loadNovelDetail.mockResolvedValue(detail("n2", "/covers/local.jpg"));
    const tree = await novelModule.default({
      params: Promise.resolve({ slugParam: "lantern-keepers-daughter-pabc123" }),
    });
    render(tree);

    expect(preconnectLinks()).toHaveLength(0);
  });
});

describe("首页预连接", () => {
  function entry(novel: NovelDetailView) {
    return { novel, detailHref: `/novel/${novel.id}`, startReadingHref: undefined };
  }

  it("只给初始激活轮播项（第 1 项）封面的 origin 输出 preconnect，不管后面的项在哪个图床", async () => {
    loadHomeCarousel.mockResolvedValue([
      entry(detail("h1", "https://img-one.example/cover/h1.jpg")),
      entry(detail("h2", "https://img-two.example/cover/h2.jpg")),
      entry(detail("h3", "https://img-three.example/cover/h3.jpg")),
    ] as never);

    const tree = await homeModule.default();
    render(tree);

    expect(preconnectLinks().map((link) => link.getAttribute("href"))).toEqual([
      "https://img-one.example",
    ]);
  });

  it("没有主推项时不输出", async () => {
    loadHomeCarousel.mockResolvedValue([]);

    const tree = await homeModule.default();
    render(tree);

    expect(preconnectLinks()).toHaveLength(0);
  });
});
