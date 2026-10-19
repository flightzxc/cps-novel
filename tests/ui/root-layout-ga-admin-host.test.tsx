import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SITE_LOCALE_REQUEST_HEADER } from "@/lib/site/request-locale";

/**
 * B-51（v0.6.4）：后台站（admin host，生产 zbcwf.pulsenovels.com）的任何页面都不加载 GA；
 * 公开站——英文根路径与 `[locale]/` 下的其它语种——照常加载。
 *
 * GA 只挂在根布局 `src/app/layout.tsx` 一处，公开站与后台（`(admin)`、`(admin-auth)`）都在
 * 它下面，所以"给不给 GA"完全由根布局决定。判断复用 Yandex 已有的 `isAdminHostRequest`
 * （同一个 `adminHostRequest` 变量），不新增动态 API。
 *
 * `@next/third-parties` 的 `<GoogleAnalytics>` 走 `next/script`（afterInteractive），脱离 Next
 * 运行时用 `renderToStaticMarkup` 渲染时什么都不输出，所以这里把它换成一个带标记的替身：
 * 测的是根布局"给不给、给的是哪个编号"，不是 GA 组件本身。其余照 `yandex-metrica-layout.test.tsx`：
 * mock `next/headers` / `getSiteSetting`，直接调用 `RootLayout` 渲染成静态 HTML 断言。
 */

const state = vi.hoisted(() => ({
  host: null as string | null,
  locale: null as string | null,
}));

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) => {
      const key = name.toLowerCase();
      if (key === "host") return state.host;
      if (key === SITE_LOCALE_REQUEST_HEADER.toLowerCase()) return state.locale;
      return null;
    },
  }),
}));

vi.mock("@next/third-parties/google", () => ({
  GoogleAnalytics: ({ gaId }: { gaId: string }) => <script data-ga-marker={gaId} />,
}));

vi.mock("@/app/_lib/public-deps", () => ({ prisma: {} }));

const settings = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));

vi.mock("@/server/site-settings/service", () => ({
  getSiteSetting: vi.fn(async () => settings.current),
}));

const GA_ID = "G-ABC123XYZ";

const BASE_SETTINGS = {
  siteName: "PulseNovel",
  siteDescription: "Overseas novels.",
  homeMetaTitle: "PulseNovel",
  homeMetaDescription: "Read overseas novels.",
  defaultOgImage: "",
  googleSearchConsoleVerification: "",
  footerCopyrightText: "© test",
  footerDisclaimerText: "",
  friendLinks: [],
  indexNowHost: "",
  indexNowKey: "",
  indexNowKeyLocation: "",
  ga4MeasurementId: GA_ID as string | null,
  yandexVerification: "",
  yandexMetricaId: null as string | null,
  siteSearchEnabled: false,
  updatedAt: new Date("2026-10-19T00:00:00Z"),
};

const { default: RootLayout } = await import("@/app/layout");

async function renderHtml(overrides: Record<string, unknown> = {}): Promise<string> {
  settings.current = { ...BASE_SETTINGS, ...overrides };
  const tree = (await RootLayout({ children: <main id="page-body">page</main> })) as ReactElement;
  return renderToStaticMarkup(tree);
}

const GA_MARKER = `<script data-ga-marker="${GA_ID}"></script>`;

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  state.host = null;
  state.locale = null;
  process.env.SITE_URL = "https://pulsenovels.com";
  process.env.ADMIN_CANONICAL_ORIGIN = "https://zbcwf.pulsenovels.com";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("RootLayout · 公开站照常加载 GA", () => {
  it("英文根路径（无语种前缀）：输出 GA，编号取自站点设置", async () => {
    state.host = "pulsenovels.com";
    state.locale = "en";
    const html = await renderHtml();
    expect(html).toContain(GA_MARKER);
    expect(html).toContain('<main id="page-body">page</main>');
  });

  it.each(["ja", "ko", "ar", "zh-Hant"])("[locale]/ 下的其它语种（%s）：输出 GA", async (locale) => {
    state.host = "pulsenovels.com";
    state.locale = locale;
    const html = await renderHtml();
    // 确认渲染的确是该语种的页面外壳（根布局读到了 proxy 转发的语种头）
    expect(html).toContain(`<html lang="${locale}"`);
    expect(html).toContain(GA_MARKER);
  });

  it("主机名带端口或大小写不同仍算公开站", async () => {
    for (const host of ["pulsenovels.com:443", "PulseNovels.com"]) {
      state.host = host;
      expect(await renderHtml(), host).toContain(GA_MARKER);
    }
  });

  it("读不到 Host 头时按公开站处理（不因检测失败吞掉公开站 GA）", async () => {
    state.host = null;
    expect(await renderHtml()).toContain(GA_MARKER);
  });

  it("站点设置没填 GA 编号时，公开站也不输出", async () => {
    state.host = "pulsenovels.com";
    const html = await renderHtml({ ga4MeasurementId: null });
    expect(html).not.toContain("data-ga-marker");
  });
});

describe("RootLayout · 后台站不加载 GA", () => {
  it("请求主机是后台主机：不输出 GA", async () => {
    state.host = "zbcwf.pulsenovels.com";
    const html = await renderHtml();
    expect(html).not.toContain("data-ga-marker");
    expect(html).not.toContain(GA_ID);
    // 页面本身照常渲染
    expect(html).toContain('<main id="page-body">page</main>');
  });

  it("后台主机带端口、大写同样识别为后台站", async () => {
    for (const host of ["zbcwf.pulsenovels.com:443", "ZBCWF.PulseNovels.com"]) {
      state.host = host;
      expect(await renderHtml(), host).not.toContain("data-ga-marker");
    }
  });

  it("与 Yandex 用同一个判断：后台站两者都不输出，公开站两者都输出", async () => {
    const both = { yandexMetricaId: "12345678" };
    state.host = "zbcwf.pulsenovels.com";
    const admin = await renderHtml(both);
    expect(admin).not.toContain("data-ga-marker");
    expect(admin).not.toContain("mc.yandex.ru");

    state.host = "pulsenovels.com";
    const publicHtml = await renderHtml(both);
    expect(publicHtml).toContain(GA_MARKER);
    expect(publicHtml).toContain("mc.yandex.ru");
  });
});

describe("GA 只挂在根布局一处", () => {
  const appDir = resolve(process.cwd(), "src");

  function listSourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
      else if (/\.(?:ts|tsx|js|jsx|mjs)$/.test(name)) out.push(full);
    }
    return out;
  }

  it("src/ 下只有 src/app/layout.tsx 引用 @next/third-parties（后台布局不会另挂一份）", () => {
    const importers = listSourceFiles(appDir)
      .filter((file) => readFileSync(file, "utf8").includes("@next/third-parties"))
      .map((file) => relative(process.cwd(), file));
    expect(importers).toEqual(["src/app/layout.tsx"]);
  });
});
