/**
 * v0.6.0 F.1：`/go/<站内码>/app` 中间页——取数判定、元数据、整页渲染。
 * 约束：noindex/nofollow、不缓存（动态渲染）、站内码找不到 / 不是口令码模式 / 不就绪 → 404、口令码只在这个页面出现。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));

vi.mock("@/app/_lib/public-deps", () => ({ prisma: { promoLink: { findUnique } } }));
vi.mock("@/server/site-settings/service", () => ({ getSiteSetting: async () => ({ siteName: "PulseNovel" }) }));

import CodeModeInterstitialPage, { dynamic, generateMetadata } from "@/app/go/[code]/app/page";
import { loadCodeModePageData } from "@/app/go/_lib/code-mode-page-data";

const PUBLIC_CODE = "abc123xy9z";
const UPSTREAM = "ZX960031QQ";
const CODE_CONFIG = {
  promoMode: "code",
  agencyIds: ["1351"],
  appDisplayName: "PlotNovel",
  codeModeLocales: ["en"],
  appStoreUrl: "https://apps.apple.com/app/plotnovel/id123",
  googlePlayUrl: "https://play.google.com/store/apps/details?id=com.plotnovel",
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    status: "fetched",
    webUrl: null,
    appUrl: null,
    upstreamCode: UPSTREAM,
    deletedAt: null,
    channelApp: { config: CODE_CONFIG },
    novel: { locale: "en", title: "Fifty Million For Ten Years", coverUrl: "https://img.example/c.jpg" },
    articles: [{ locale: "en", slug: "fifty-million", publicPageShortId: "1a2b3c4d" }],
    ...overrides,
  };
}

async function notFoundDigest(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return String((error as { digest?: string }).digest ?? error);
  }
  return "rendered";
}

describe("loadCodeModePageData", () => {
  beforeEach(() => findUnique.mockReset());

  it("口令码模式 + 就绪：给出口令码、App 名、商店链接、书名、封面、回书页的站内路径", async () => {
    findUnique.mockResolvedValue(row());
    const data = await loadCodeModePageData({ promoLink: { findUnique } } as never, PUBLIC_CODE);
    expect(data).toEqual({
      code: UPSTREAM,
      appName: "PlotNovel",
      appStoreUrl: CODE_CONFIG.appStoreUrl,
      googlePlayUrl: CODE_CONFIG.googlePlayUrl,
      title: "Fifty Million For Ten Years",
      coverUrl: "https://img.example/c.jpg",
      backHref: "/novel/fifty-million-p1a2b3c4d",
    });
  });

  it.each([
    ["不存在", null],
    ["已软删除", row({ deletedAt: new Date() })],
    ["link 模式（MoboReader）", row({ channelApp: { config: { promoMode: "link" } } })],
    ["旧记录 config = {}", row({ channelApp: { config: {} } })],
    ["状态不是 fetched", row({ status: "pending" })],
    ["口令码空白", row({ upstreamCode: "   " })],
    ["口令码缺失", row({ upstreamCode: null })],
    ["书的语种不在白名单", row({ novel: { locale: "fr", title: "x", coverUrl: null } })],
  ])("%s → null（页面 404）", async (_name, value) => {
    findUnique.mockResolvedValue(value);
    expect(await loadCodeModePageData({ promoLink: { findUnique } } as never, PUBLIC_CODE)).toBeNull();
  });

  it("商店链接配错（javascript: / http:）解析成 null，页面不渲染那个按钮", async () => {
    findUnique.mockResolvedValue(row({ channelApp: { config: { ...CODE_CONFIG, appStoreUrl: "javascript:alert(1)", googlePlayUrl: "http://play.google.com/x" } } }));
    const data = await loadCodeModePageData({ promoLink: { findUnique } } as never, PUBLIC_CODE);
    expect(data).toMatchObject({ appStoreUrl: null, googlePlayUrl: null });
  });

  it("没有已发布文章时没有返回链接", async () => {
    findUnique.mockResolvedValue(row({ articles: [] }));
    expect((await loadCodeModePageData({ promoLink: { findUnique } } as never, PUBLIC_CODE))?.backHref).toBeUndefined();
  });
});

describe("/go/[code]/app 页面", () => {
  beforeEach(() => findUnique.mockReset());

  it("元数据：noindex、nofollow、标题通用（不含书名与口令码）；动态渲染（不缓存）", () => {
    const metadata = generateMetadata();
    expect(metadata.robots).toMatchObject({ index: false, follow: false });
    expect(JSON.stringify(metadata)).not.toContain(UPSTREAM);
    expect(metadata.title).toBe("Continue reading in the app");
    expect(dynamic).toBe("force-dynamic");
  });

  it("就绪的口令码模式推广：渲染整页，口令码在页面里（唯一出现的地方）", async () => {
    findUnique.mockResolvedValue(row());
    const element = await CodeModeInterstitialPage({ params: Promise.resolve({ code: PUBLIC_CODE }) });
    const html = renderToStaticMarkup(element);
    expect(html).toContain(UPSTREAM);
    expect(html).toContain("Continue reading on PlotNovel");
    expect(html).toContain("Fifty Million For Ten Years");
    expect(html).toContain('href="https://apps.apple.com/app/plotnovel/id123"');
    expect(html).toContain("PlotNovel is a third-party app. PulseNovel may earn a commission.");
  });

  it("按站内码精确查库（不是按口令码）", async () => {
    findUnique.mockResolvedValue(row());
    await CodeModeInterstitialPage({ params: Promise.resolve({ code: PUBLIC_CODE }) });
    expect(findUnique).toHaveBeenCalledOnce();
    expect(findUnique.mock.calls[0]![0].where).toEqual({ publicRedirectCode: PUBLIC_CODE });
  });

  it.each([
    ["找不到", () => findUnique.mockResolvedValue(null), PUBLIC_CODE],
    ["不是口令码模式", () => findUnique.mockResolvedValue(row({ channelApp: { config: {} } })), PUBLIC_CODE],
    ["口令码空白", () => findUnique.mockResolvedValue(row({ upstreamCode: " " })), PUBLIC_CODE],
    ["站内码为空", () => findUnique.mockResolvedValue(row()), ""],
    ["站内码畸形（超长）", () => findUnique.mockResolvedValue(row()), "x".repeat(65)],
    ["站内码是坏的百分号编码", () => findUnique.mockResolvedValue(row()), "%E0%A4%A"],
  ])("%s → 404", async (_name, arrange, code) => {
    arrange();
    const digest = await notFoundDigest(CodeModeInterstitialPage({ params: Promise.resolve({ code }) }));
    expect(digest).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });
});
