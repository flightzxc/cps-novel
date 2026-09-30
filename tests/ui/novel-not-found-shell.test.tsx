import "./setup-cleanup";
import { existsSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { BRAND_PLACEHOLDER_TEXT } from "@/components/BrandMark";
import { getPublicT } from "@/lib/locale/messages";
import { chromeFromSiteSetting } from "@/lib/site/chrome";

/**
 * 2026-09-30 404 页面照搬 CPS（开发单第 6 条）：novel 段的两个 not-found 壳
 * （bare `src/app/novel/[slugParam]/not-found.tsx` 与
 * `src/app/[locale]/novel/[slugParam]/not-found.tsx`）
 *
 * - 渲染真正的 404 页——`notFoundPage.*` 文案，不是"暂时不可用，地址仍然有效"的
 *   `UnavailableScreen`；
 * - 页头页脚带**后台设置的站名**（此前没传 chrome，`SiteShell` 默认 `{}`，
 *   品牌位露出 `BRAND_PLACEHOLDER`）。
 *
 * 这份用例走**真实的** `chromeFromSiteSetting` 生成 chrome（站名怎么从设置流进
 * 页头页脚，是生产上的同一条路径），只 mock 掉数据库读取（`loadChrome` /
 * `loadActiveLocales`）。守卫：配置了站名时，两个壳里都不得出现
 * `BRAND_PLACEHOLDER`——把 not-found 壳里的 chrome 去掉，这里必须变红。
 */

const headerState = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: () => headerState.value }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/novel/whatever-pabc12345",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/app/_lib/public-load", () => ({
  loadChrome: vi.fn(),
  loadActiveLocales: vi.fn(),
}));

const publicLoad = await import("@/app/_lib/public-load");
const loadChrome = vi.mocked(publicLoad.loadChrome);
const loadActiveLocales = vi.mocked(publicLoad.loadActiveLocales);

const SETTINGS = {
  siteName: "PulseNovel",
  siteDescription: "",
  homeMetaTitle: "",
  homeMetaDescription: "",
  defaultOgImage: "https://example.test/og.png",
  googleSearchConsoleVerification: "",
  footerCopyrightText: "© PulseNovel",
  footerDisclaimerText: "",
  friendLinks: [],
  indexNowHost: "",
  indexNowKey: "",
  indexNowKeyLocation: "",
  ga4MeasurementId: null,
  updatedAt: new Date("2026-09-30T00:00:00Z"),
};

const bareShell = await import("@/app/novel/[slugParam]/not-found");
const localeShell = await import("@/app/[locale]/novel/[slugParam]/not-found");

beforeEach(() => {
  headerState.value = null;
  loadActiveLocales.mockReset();
  loadActiveLocales.mockResolvedValue(["en", "ko"]);
  loadChrome.mockReset();
  loadChrome.mockImplementation(async (locale, current, categories, activeLocales) => ({
    settings: SETTINGS,
    chrome: chromeFromSiteSetting(SETTINGS, locale, current, categories ?? [], activeLocales),
  }));
});

function expectBrandedNotFound(locale: "en" | "ko") {
  const t = getPublicT(locale);
  // 站名：页头、页脚各一处，占位符一处都不能有。
  expect(screen.queryByText(BRAND_PLACEHOLDER_TEXT)).toBeNull();
  expect(screen.getAllByText("PulseNovel").length).toBeGreaterThanOrEqual(2);
  // 文案是 notFoundPage.*，不是下架页。
  expect(screen.getByTestId("public-not-found-panel")).toBeTruthy();
  expect(screen.getByRole("heading", { name: t("notFoundPage.title") })).toBeTruthy();
  expect(screen.getByText(t("notFoundPage.body"))).toBeTruthy();
  expect(screen.queryByTestId("unavailable-screen")).toBeNull();
  expect(screen.queryByText(t("unavailable.unpublishedTitle"))).toBeNull();
  expect(screen.queryByText(t("unavailable.unpublishedBody"))).toBeNull();
  // 真的有页头页脚（不是无壳的裸面板）。
  expect(screen.getByTestId("site-header")).toBeTruthy();
}

describe("novel 段 not-found 壳：真正的 404 页，页头页脚带后台设置的站名", () => {
  it("bare 壳（en）：站名而非 BRAND_PLACEHOLDER，notFoundPage.* 文案，回首页链接是 /", async () => {
    render(await bareShell.default());
    expectBrandedNotFound("en");
    const panel = screen.getByTestId("public-not-found-panel");
    expect(within(panel).getByRole("link", { name: "Back to home" }).getAttribute("href")).toBe("/");
  });

  it("[locale] 壳（x-novel-locale: ko）：同样带站名，文案是韩语 notFoundPage.*，回首页链接是 /ko", async () => {
    headerState.value = "ko";
    render(await localeShell.default());
    expectBrandedNotFound("ko");
    const panel = screen.getByTestId("public-not-found-panel");
    expect(within(panel).getByRole("link", { name: getPublicT("ko")("unavailable.returnHome") }).getAttribute("href")).toBe("/ko");
  });

  it("[locale] 壳缺 x-novel-locale 头时回落 en，仍然带站名", async () => {
    headerState.value = null;
    render(await localeShell.default());
    expectBrandedNotFound("en");
  });

  it("两个壳走的是同一条 chrome 加载路径：先 loadActiveLocales，再把它传给 loadChrome（语言切换器要靠它出现）", async () => {
    render(await bareShell.default());
    expect(loadActiveLocales).toHaveBeenCalledTimes(1);
    expect(loadChrome).toHaveBeenCalledWith("en", undefined, undefined, ["en", "ko"]);
    // 活跃语种 ≥2 时页头里有语言切换入口。
    expect(screen.getByRole("button", { name: "Language" })).toBeTruthy();
  });

  it("chrome 加载失败（数据库不可用）：降级为无页头页脚的裸 404 面板——仍是 404 文案，不出现占位符，页面本身不因此 500", async () => {
    loadChrome.mockRejectedValue(new Error("db down"));
    render(await bareShell.default());
    expect(screen.queryByText(BRAND_PLACEHOLDER_TEXT)).toBeNull();
    expect(screen.getByRole("heading", { name: getPublicT("en")("notFoundPage.title") })).toBeTruthy();
    expect(screen.queryByTestId("site-header")).toBeNull();
  });

  // 裸路径壳导出默认语种的 `metadata` 常量；[locale] 壳改为 `generateMetadata`，按 x-novel-locale 取本语种
  // 的 "Not found" 标题（TKD 对齐 CPS：真 404 响应用的是 not-found 文件自己的元数据，标题此前只有站名）。
  it("元数据仍是 noindex,nofollow，并带本语种的 Not found 标题（品牌后缀由根布局加）", async () => {
    expect(bareShell.metadata.robots).toEqual({ index: false, follow: false });
    expect(bareShell.metadata.title).toBe(getPublicT("en")("meta.notFound"));
    headerState.value = "ko";
    const ko = await localeShell.generateMetadata();
    expect(ko.robots).toEqual({ index: false, follow: false });
    expect(ko.title).toBe(getPublicT("ko")("meta.notFound"));
    headerState.value = null;
    const fallback = await localeShell.generateMetadata();
    expect(fallback.robots).toEqual({ index: false, follow: false });
    expect(fallback.title).toBe(getPublicT("en")("meta.notFound"));
  });

  it("HTTP 404 由 Next 的 not-found 边界给出（notFound() → 404 由 tests/backend/public/not-found-status.test.ts 钉住）；这里钉的是两棵路由树里确实各有 novel 段的 not-found.tsx 边界文件", () => {
    const root = process.cwd();
    expect(existsSync(path.join(root, "src/app/novel/[slugParam]/not-found.tsx"))).toBe(true);
    expect(existsSync(path.join(root, "src/app/[locale]/novel/[slugParam]/not-found.tsx"))).toBe(true);
  });
});
