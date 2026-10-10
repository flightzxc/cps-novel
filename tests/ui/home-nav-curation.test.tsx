import "./setup-cleanup";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";

import { buildHomeMetadata, HomeBody } from "@/app/_pages/home";
import { toLinkableCategorySlugs } from "@/lib/site/category-links";
import { chromeFromSiteSetting } from "@/lib/site/chrome";
import type { PublicCategoryTag } from "@/lib/site/public-taxonomy";

import { renderWithMessages } from "./render-with-messages";

/**
 * v0.5.15 首页题材导航只显示运营勾选的分类（H1 / H3 / H4 / H9）。
 *
 * `HomeBody` 拿到的是"该语种有书的全部分类"（每项带 `homepageVisible`）。只有交给 `HomeScreen` 的那一刻按勾选
 * 过滤；`loadChrome`（页脚）拿到的仍是**未过滤**的同一份数组；`buildHomeMetadata` 不受影响。
 * 页脚本身（`chromeFromSiteSetting` 取前 8 个）与详情页可链接集合（`toLinkableCategorySlugs`）也直接钉一遍：
 * 同样的输入，勾选不同，输出逐项相同。
 *
 * 反向自检：把 `home.tsx` 里 `selectHomepageNavCategories(categories)` 换回 `categories`，"只显示勾选的"几条会红；
 * 把 `loadChrome` 的实参换成过滤后的数组，"页脚拿未过滤的"几条会红。
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
  loadHomeNovels: vi.fn(),
  loadHomeCarousel: vi.fn(),
  loadPublicCategories: vi.fn(),
}));

const publicLoad = await import("@/app/_lib/public-load");
const loadChrome = vi.mocked(publicLoad.loadChrome);
const loadActiveLocales = vi.mocked(publicLoad.loadActiveLocales);
const loadHomeNovels = vi.mocked(publicLoad.loadHomeNovels);
const loadHomeCarousel = vi.mocked(publicLoad.loadHomeCarousel);
const loadPublicCategories = vi.mocked(publicLoad.loadPublicCategories);

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
  navItems: [
    { label: "Home", href: "/", current: true },
    { label: "All works", href: "/browse" },
  ],
  footerNote: "© test",
};

function tag(slug: string, sortOrder: number, homepageVisible: boolean, prefix = ""): PublicCategoryTag {
  return Object.freeze({
    id: `id-${slug}`,
    slug,
    label: `Label ${slug}`,
    href: `${prefix}/category/${slug}`,
    sortOrder,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    homepageVisible,
  });
}

/** 排序号决定顺序；勾选：a、c、e 勾上，b、d 没勾。 */
const MIXED: readonly PublicCategoryTag[] = Object.freeze([
  tag("a-adventure", 1, true),
  tag("b-betrayal", 2, false),
  tag("c-contract", 3, true),
  tag("d-divorce", 4, false),
  tag("e-epic", 5, true),
]);

const ACTIVE_SITES = ["en", "ja"] as const;

beforeEach(() => {
  process.env.SITE_URL = "https://example.test";
  loadChrome.mockResolvedValue({ settings: SETTINGS, chrome: CHROME });
  loadActiveLocales.mockResolvedValue([...ACTIVE_SITES]);
  loadHomeNovels.mockResolvedValue([]);
  loadHomeCarousel.mockResolvedValue([]);
  loadPublicCategories.mockResolvedValue(MIXED as never);
});

afterEach(() => {
  delete process.env.SITE_URL;
  vi.clearAllMocks();
});

function navLinks(): Array<{ href: string | null; text: string | null }> {
  const nav = screen.getByTestId("home-category-nav");
  return within(nav).getAllByRole("link").map((link) => ({ href: link.getAttribute("href"), text: link.textContent }));
}

describe("首页题材导航 = 勾选的 ∩ 该语种有书的（HomeBody）", () => {
  it("只渲染勾选的分类，顺序不变（H3），链接一个字符不变（H9）", async () => {
    renderWithMessages(await HomeBody({ locale: "en" }));
    expect(navLinks()).toEqual([
      { href: "/category/a-adventure", text: "Label a-adventure" },
      { href: "/category/c-contract", text: "Label c-contract" },
      { href: "/category/e-epic", text: "Label e-epic" },
    ]);
  });

  it("H1·页脚拿未过滤的：loadChrome 收到的就是 loadPublicCategories 返回的那一份（同一个引用，5 项，含没勾的）", async () => {
    renderWithMessages(await HomeBody({ locale: "en" }));
    expect(loadChrome).toHaveBeenCalledTimes(1);
    const [locale, current, categories, activeLocales] = loadChrome.mock.calls[0]!;
    expect(locale).toBe("en");
    expect(current).toBe("home");
    expect(categories).toBe(MIXED);
    expect(categories).toHaveLength(5);
    expect(categories!.map((item) => item.slug)).toEqual(MIXED.map((item) => item.slug));
    expect(activeLocales).toEqual([...ACTIVE_SITES]);
  });

  it("H1·buildHomeMetadata 同样只拿完整列表喂 loadChrome，不受勾选影响", async () => {
    await buildHomeMetadata("en");
    expect(loadChrome).toHaveBeenCalledTimes(1);
    expect(loadChrome.mock.calls[0]![2]).toBe(MIXED);
  });

  it("H4·勾选与有书的交集为空：不显示这一排，也不回退成全部", async () => {
    loadPublicCategories.mockResolvedValue(MIXED.map((item) => ({ ...item, homepageVisible: false })) as never);
    renderWithMessages(await HomeBody({ locale: "en" }));
    expect(screen.queryByTestId("home-category-nav")).toBeNull();
    // 页脚那一份依然是 5 项完整列表。
    expect(loadChrome.mock.calls[0]![2]).toHaveLength(5);
  });

  it("全部勾选（上线默认）：导航与改前逐项相同", async () => {
    loadPublicCategories.mockResolvedValue(MIXED.map((item) => ({ ...item, homepageVisible: true })) as never);
    renderWithMessages(await HomeBody({ locale: "en" }));
    expect(navLinks().map((link) => link.href)).toEqual(MIXED.map((item) => item.href));
  });

  it("非默认语种：链接仍带语种前缀，一个字符不变（H9）", async () => {
    loadPublicCategories.mockResolvedValue([tag("a-adventure", 1, true, "/ja"), tag("b-betrayal", 2, false, "/ja")] as never);
    renderWithMessages(await HomeBody({ locale: "ja" }));
    expect(navLinks().map((link) => link.href)).toEqual(["/ja/category/a-adventure"]);
  });
});

describe("页脚与详情页可链接集合不读勾选（H1）", () => {
  it("chromeFromSiteSetting：勾选不同，页脚链接逐项相同（取前 8 个，含没勾的）", () => {
    const many = Array.from({ length: 10 }, (_, index) => tag(`cat-${String(index).padStart(2, "0")}`, index, index % 2 === 0));
    const allVisible = many.map((item) => ({ ...item, homepageVisible: true }));
    const noneVisible = many.map((item) => ({ ...item, homepageVisible: false }));
    const mixed = chromeFromSiteSetting(SETTINGS, "en", "home", many).footerLinks ?? [];
    expect(mixed).toEqual(chromeFromSiteSetting(SETTINGS, "en", "home", allVisible).footerLinks);
    expect(mixed).toEqual(chromeFromSiteSetting(SETTINGS, "en", "home", noneVisible).footerLinks);
    expect(mixed.map((link) => link.href)).toEqual(many.slice(0, 8).map((item) => item.href));
    // 第 2 项（index 1）没勾选，仍在页脚里。
    expect(mixed.map((link) => link.href)).toContain("/category/cat-01");
  });

  it("toLinkableCategorySlugs：没勾选的分类仍在可链接集合里（详情页的标签仍可点）", () => {
    expect([...toLinkableCategorySlugs(MIXED)].sort()).toEqual(MIXED.map((item) => item.slug).sort());
  });
});
