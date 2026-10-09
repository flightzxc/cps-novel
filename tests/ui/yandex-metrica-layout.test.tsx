import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 运营第二轮 · Yandex（Owner 2026-09-30，NOVEL_ONLY，无 CPS 对应）。
 *
 * 根布局 `src/app/layout.tsx` 读 `SiteSetting.yandexVerification` /
 * `yandexMetricaId`：
 * - 两项都没填：什么都不输出；
 * - 验证码：`<head>` 里输出 `<meta name="yandex-verification">`；
 * - Metrica ID：`<head>` 里输出运营给的固定脚本（ID 替换进去，其余一字不改），
 *   `<body>` 开头输出 `<noscript>`（里面是 `<div>`，放 `<head>` 不合法）；
 * - 渲染时再校验一次：ID 不是纯数字、验证码含非法字符，一律不输出；
 * - 后台站（admin host）不输出。
 *
 * 与 `root-layout-locale-dir.test.tsx` 同样的做法：mock 掉 `next/headers` /
 * `getSiteSetting`，直接调用 `RootLayout`，把返回的 React 元素渲染成静态 HTML 字符串来断言
 * ——读的是真实输出，不是源码字符串扫描。
 */

const state = vi.hoisted(() => ({
  host: null as string | null,
}));

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) => (name.toLowerCase() === "host" ? state.host : null),
  }),
}));

vi.mock("@/app/_lib/public-deps", () => ({ prisma: {} }));

const settings = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));

vi.mock("@/server/site-settings/service", () => ({
  getSiteSetting: vi.fn(async () => settings.current),
}));

const BASE_SETTINGS = {
  siteName: "cps-novel",
  siteDescription: "Overseas novels.",
  homeMetaTitle: "cps-novel",
  homeMetaDescription: "Read overseas novels.",
  defaultOgImage: "",
  googleSearchConsoleVerification: "",
  footerCopyrightText: "© test",
  footerDisclaimerText: "",
  friendLinks: [],
  indexNowHost: "",
  indexNowKey: "",
  indexNowKeyLocation: "",
  ga4MeasurementId: null,
  yandexVerification: "",
  yandexMetricaId: null as string | null,
  siteSearchEnabled: false,
  updatedAt: new Date("2026-09-30T00:00:00Z"),
};

const { default: RootLayout } = await import("@/app/layout");

async function renderHtml(overrides: Record<string, unknown> = {}): Promise<string> {
  settings.current = { ...BASE_SETTINGS, ...overrides };
  const tree = (await RootLayout({ children: <main id="page-body">page</main> })) as ReactElement;
  return renderToStaticMarkup(tree);
}

/** 运营提供的官方统计代码，`<ID>` 之外一字不改（含缩进）。逐字抄自开发单，不从实现里引用。 */
function expectedScript(id: string): string {
  return [
    "(function(m,e,t,r,i,k,a){",
    "    m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};",
    "    m[i].l=1*new Date();",
    "    for (var j = 0; j < document.scripts.length; j++) {if (document.scripts[j].src === r) { return; }}",
    "    k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)",
    `})(window, document,'script','https://mc.yandex.ru/metrika/tag.js?id=${id}', 'ym');`,
    `ym(${id}, 'init', {ssr:true, webvisor:true, clickmap:true, ecommerce:"dataLayer", referrer: document.referrer, url: location.href, accurateTrackBounce:true, trackLinks:true});`,
  ].join("\n");
}

function expectedNoscript(id: string): string {
  return `<noscript><div><img src="https://mc.yandex.ru/watch/${id}" style="position:absolute; left:-9999px;" alt="" /></div></noscript>`;
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  state.host = null;
  process.env.SITE_URL = "https://novel.example.com";
  process.env.ADMIN_CANONICAL_ORIGIN = "https://admin.example.com";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("RootLayout · Yandex 两项都没填", () => {
  it("什么都不输出：没有 yandex 字样、没有 mc.yandex.ru、没有 noscript", async () => {
    const html = await renderHtml();
    expect(html).not.toMatch(/yandex/i);
    expect(html).not.toContain("mc.yandex.ru");
    expect(html).not.toContain("<noscript");
    expect(html).toContain('<main id="page-body">page</main>');
  });

  it("空白字符串（验证码 '   '、ID '  '）同样视为没填", async () => {
    const html = await renderHtml({ yandexVerification: "   ", yandexMetricaId: "  " });
    expect(html).not.toMatch(/yandex/i);
  });
});

describe("RootLayout · 只填了站长验证码", () => {
  it("head 里输出 yandex-verification meta，且不输出任何统计代码", async () => {
    const html = await renderHtml({ yandexVerification: "1a2B3c_4-d5e6f7890" });
    expect(html).toContain('<meta name="yandex-verification" content="1a2B3c_4-d5e6f7890"/>');
    expect(html).not.toContain("mc.yandex.ru");
    expect(html).not.toContain("<noscript");
    // meta 在 <head> 里
    expect(html.indexOf("<head>")).toBeGreaterThanOrEqual(0);
    expect(html.indexOf("yandex-verification")).toBeGreaterThan(html.indexOf("<head>"));
    expect(html.indexOf("yandex-verification")).toBeLessThan(html.indexOf("</head>"));
  });

  it("与 google-site-verification 并存时两个 meta 都在 head 里", async () => {
    const html = await renderHtml({
      googleSearchConsoleVerification: "google-code",
      yandexVerification: "yandex-code",
    });
    const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
    expect(head).toContain('<meta name="google-site-verification" content="google-code"/>');
    expect(head).toContain('<meta name="yandex-verification" content="yandex-code"/>');
  });

  it("渲染时再校验：含非法字符的验证码（直接改库绕过了保存校验）不输出", async () => {
    const html = await renderHtml({ yandexVerification: 'abc" onload="alert(1)' });
    expect(html).not.toMatch(/yandex/i);
    expect(html).not.toContain("alert(1)");
  });
});

describe("RootLayout · 填了 Metrica 计数器 ID", () => {
  it("head 里输出固定脚本（ID 替换进去，其余一字不改），body 开头输出 noscript", async () => {
    const html = await renderHtml({ yandexMetricaId: "12345678" });

    const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
    expect(head).toContain(`<script>${expectedScript("12345678")}</script>`);
    // 脚本里的两处 ID 都是这个值
    expect(head).toContain("https://mc.yandex.ru/metrika/tag.js?id=12345678");
    expect(head).toContain("ym(12345678, 'init'");

    // noscript 不在 head 里（<div> 在 head 里不是合法 HTML），而是 body 开头、页面内容之前
    expect(head).not.toContain("<noscript");
    const bodyOpen = html.search(/<body[ >]/);
    const noscriptAt = html.indexOf(expectedNoscript("12345678"));
    expect(noscriptAt).toBeGreaterThan(bodyOpen);
    expect(noscriptAt).toBeLessThan(html.indexOf('<main id="page-body">'));
  });

  it("Metrica 与验证码可同时输出", async () => {
    const html = await renderHtml({ yandexVerification: "vcode", yandexMetricaId: "98765" });
    expect(html).toContain('<meta name="yandex-verification" content="vcode"/>');
    expect(html).toContain(expectedScript("98765"));
    expect(html).toContain(expectedNoscript("98765"));
  });

  it.each([
    ["含引号与分号的注入串", "12345678');alert(1);//"],
    ["带字母", "12ab"],
    ["带小数点", "123.45"],
    ["超过 12 位", "1234567890123"],
    ["负号", "-1"],
    ["全角数字", "１２３"],
    ["script 闭合标签", "1</script><script>alert(1)</script>"],
  ])("渲染时再校验：ID 不是纯数字（%s）→ 脚本、noscript 一律不输出", async (_label, badId) => {
    const html = await renderHtml({ yandexMetricaId: badId });
    expect(html).not.toContain("mc.yandex.ru");
    expect(html).not.toContain("ym(");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("<noscript");
  });
});

describe("RootLayout · 后台站不输出 Yandex", () => {
  const FILLED = { yandexVerification: "vcode", yandexMetricaId: "12345678" };

  it("请求主机是 admin host 时，验证码与统计代码都不输出", async () => {
    state.host = "admin.example.com";
    const html = await renderHtml(FILLED);
    expect(html).not.toMatch(/yandex/i);
    expect(html).not.toContain("mc.yandex.ru");
    expect(html).not.toContain("<noscript");
  });

  it("带端口的 admin host 同样识别为后台站", async () => {
    state.host = "admin.example.com:443";
    const html = await renderHtml(FILLED);
    expect(html).not.toMatch(/yandex/i);
  });

  it("请求主机是公开站主机时正常输出", async () => {
    state.host = "novel.example.com";
    const html = await renderHtml(FILLED);
    expect(html).toContain('<meta name="yandex-verification" content="vcode"/>');
    expect(html).toContain(expectedScript("12345678"));
  });

  it("读不到 Host 头时按公开站处理（不因检测失败吞掉公开站输出）", async () => {
    state.host = null;
    const html = await renderHtml(FILLED);
    expect(html).toContain('<meta name="yandex-verification" content="vcode"/>');
  });
});
