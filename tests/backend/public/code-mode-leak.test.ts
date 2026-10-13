/**
 * v0.6.0 F.3：渠道真实口令码只出现在中间页。
 * 书页 / 文章页 / 章节页的视图模型（因而 HTML）里不能有它；口令码模式的入口标记只是一个模式 + App 名。
 * 现有的"渠道真实码不进页面"守卫（tests/backend/public/mappers.test.ts、tests/ui/site-query-select-boundaries.test.ts、
 * tests/ui/novel-detail.test.tsx）继续有效；这里补口令码模式的同类测试。
 */
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { toChapterView, toNovelCardView, toNovelDetailView } from "@/lib/site/mappers";
import { getPublicNovelDetail } from "@/lib/site/queries";

const SECRET = "ZX960031QQ";
const CODE_CONFIG = { promoMode: "code", agencyIds: ["1351"], appDisplayName: "PlotNovel", codeModeLocales: ["en"] };

const article = {
  id: "article-1",
  title: "Fifty Million For Ten Years",
  slug: "fifty-million",
  locale: "en",
  publicPageShortId: "1a2b3c4d",
  publishedAt: new Date("2026-01-01T00:00:00Z"),
  summary: "A wife, ten years, fifty million.",
  body: "<article><h1>Fifty Million For Ten Years</h1></article>",
  seoMetadata: {},
  novel: {
    id: "novel-1", businessId: "biz-1", title: "Fifty Million For Ten Years", description: "d", coverUrl: null, locale: "en", totalChapterCount: 20,
  },
};

function codeRow() {
  return {
    ...article,
    promoLink: {
      status: "fetched", webUrl: null, appUrl: null, upstreamCode: SECRET, publicRedirectCode: "abc123xy9z",
      channelApp: { config: CODE_CONFIG }, novel: { locale: "en" },
    },
  };
}

describe("口令码模式：渠道口令码不进视图模型", () => {
  it("getPublicNovelDetail：视图里有模式标记与 App 名、没有口令码；就绪判定放行（没有网址也放行）", async () => {
    const db = {
      article: { findFirst: vi.fn().mockResolvedValue(codeRow()) },
      novelChapter: { findMany: vi.fn().mockResolvedValue([{ canonicalChapterNumber: 1, title: "One" }]) },
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaClient;
    const view = await getPublicNovelDetail(db, "article-1");
    expect(view).not.toBeNull();
    expect(view).toMatchObject({
      readOnUpstreamHref: "/go/abc123xy9z",
      readOnUpstreamMode: "code",
      readOnUpstreamAppName: "PlotNovel",
    });
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toMatch(/upstream[_-]?code/i);
  });

  it("口令码模式但口令码空白 → 详情页不放行（返回 null）", async () => {
    const row = codeRow();
    row.promoLink.upstreamCode = "  ";
    const db = {
      article: { findFirst: vi.fn().mockResolvedValue(row) },
      novelChapter: { findMany: vi.fn() },
      $queryRaw: vi.fn(),
    } as unknown as PrismaClient;
    await expect(getPublicNovelDetail(db, "article-1")).resolves.toBeNull();
  });

  it("link 模式的详情视图：没有模式标记（逐字同改动前）", async () => {
    const row = {
      ...article,
      promoLink: { status: "fetched", webUrl: "https://upstream.example/x", appUrl: null, upstreamCode: "LINK1", publicRedirectCode: "abc123xy9z", channelApp: { config: { promoMode: "link" } }, novel: { locale: "en" } },
    };
    const db = {
      article: { findFirst: vi.fn().mockResolvedValue(row) },
      novelChapter: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaClient;
    const view = await getPublicNovelDetail(db, "article-1");
    expect(view?.readOnUpstreamHref).toBe("/go/abc123xy9z");
    expect(view).not.toHaveProperty("readOnUpstreamMode");
    expect(view).not.toHaveProperty("readOnUpstreamAppName");
    expect(JSON.stringify(view)).not.toContain("LINK1");
  });

  it("mappers：promoMode = code 带出模式 + App 名；缺省 / link 不带；卡片永远不带入口信息", () => {
    const previews = [{ canonicalChapterNumber: 1, title: "One" }];
    const code = toNovelDetailView({ ...article, promoLink: { publicRedirectCode: "abc123xy9z", promoMode: "code", appName: "PlotNovel" } }, previews);
    expect(code).toMatchObject({ readOnUpstreamMode: "code", readOnUpstreamAppName: "PlotNovel" });
    expect(toNovelDetailView({ ...article, promoLink: { publicRedirectCode: "abc123xy9z" } }, previews)).not.toHaveProperty("readOnUpstreamMode");
    expect(toNovelDetailView({ ...article, promoLink: { publicRedirectCode: "abc123xy9z", promoMode: "link" } }, previews)).not.toHaveProperty("readOnUpstreamMode");

    const chapter = toChapterView(
      { ...article, promoLink: { publicRedirectCode: "abc123xy9z", promoMode: "code", appName: "PlotNovel" } },
      { canonicalChapterNumber: 1, title: "One", body: "Para one.\n\nPara two." },
      previews,
    );
    expect(chapter).toMatchObject({ readOnUpstreamMode: "code", readOnUpstreamAppName: "PlotNovel" });

    const card = toNovelCardView(article);
    expect(JSON.stringify(card)).not.toMatch(/readOnUpstream|abc123xy9z|upstream/i);
  });

  it("没有站内跳转码（格式非法）时，模式标记不会单独撑起一个入口", () => {
    const view = toNovelDetailView({ ...article, promoLink: { publicRedirectCode: "bad", promoMode: "code", appName: "PlotNovel" } }, []);
    expect(view?.readOnUpstreamHref).toBeUndefined();
  });
});
