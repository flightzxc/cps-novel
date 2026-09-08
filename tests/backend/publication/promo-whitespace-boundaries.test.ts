import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isNovelIndexNowEligible } from "@/lib/indexnow/eligibility";
import { createSitemapFamilyBuilder } from "@/lib/seo/sitemap";
import { evaluatePublishGate, type PublishGateFacts } from "@/server/publish-gate/evaluator";
import { checkNovelArticlePublicAccess } from "@/server/publication/access";
import { invalidateSiteSettingCache } from "@/server/site-settings/service";

const WHITESPACE_PROMO = {
  status: "fetched",
  webUrl: "   ",
  appUrl: null,
};

function publishedRow() {
  return {
    id: "article-blank-promo",
    novelId: "novel-blank-promo",
    locale: "en",
    slug: "blank-promo",
    publicPageShortId: "blank12",
    title: "Blank promo",
    status: "published",
    deletedAt: null,
    updatedAt: new Date("2026-08-18T12:00:00.000Z"),
    novel: {
      status: "published",
      deletedAt: null,
      coverUrl: null,
    },
    promoLink: { ...WHITESPACE_PROMO, deletedAt: null },
  };
}

afterEach(() => {
  delete process.env.SITE_URL;
  invalidateSiteSettingCache();
});

describe("P2-12 promo whitespace regression", () => {
  it("rejects promoUrl='   ' at publish, public access, sitemap, and IndexNow boundaries", async () => {
    const facts: PublishGateFacts = {
      novel: { status: "ready", locale: "en" },
      article: { status: "draft", locale: "en", title: "Blank promo", slug: "blank-promo", body: "body" },
      promoLink: WHITESPACE_PROMO,
      preview: { hasPreviewChapter: true, hasPreviewBody: true },
      pageIdentity: { conflicting: false },
    };
    const publishGate = evaluatePublishGate(facts, { isPublishableLocale: () => true });
    expect(publishGate).toMatchObject({ publishable: false, reasons: ["promo_link_not_ready"] });

    const publicDb = {
      article: { findFirst: vi.fn().mockResolvedValue(publishedRow()) },
    } as unknown as PrismaClient;
    await expect(checkNovelArticlePublicAccess(publicDb, { locale: "en", slug: "blank-promo" }))
      .resolves.toEqual({ kind: "unavailable" });

    process.env.SITE_URL = "https://acceptance.example";
    const sitemapDb = {
      article: { findMany: vi.fn().mockResolvedValue([publishedRow()]) },
      siteSetting: { findUnique: vi.fn() },
    } as unknown as PrismaClient;
    await expect(createSitemapFamilyBuilder(sitemapDb)({ type: "novelpage", locale: "en" }))
      .resolves.toEqual([]);

    expect(isNovelIndexNowEligible(
      { locale: "en", status: "published" },
      { status: "published" },
      WHITESPACE_PROMO,
      { isLocalePublishable: () => true },
    )).toBe(false);
  });
});
