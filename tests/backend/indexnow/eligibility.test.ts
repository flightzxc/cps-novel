import { describe, expect, it } from "vitest";

import {
  buildIndexNowCanonicalUrl,
  computeIndexNowRevision,
  isNovelIndexNowEligible,
  isRegisteredSiteLocale,
  normalizeCanonicalUrl,
} from "@/lib/indexnow/eligibility";

describe("computeIndexNowRevision", () => {
  it("is the millisecond epoch of updatedAt", () => {
    const updatedAt = new Date("2026-03-01T12:00:00.000Z");
    expect(computeIndexNowRevision(updatedAt)).toBe(BigInt(updatedAt.getTime()));
  });

  it("is monotonically non-decreasing across successive writes", () => {
    const first = computeIndexNowRevision(new Date("2026-03-01T00:00:00.000Z"));
    const second = computeIndexNowRevision(new Date("2026-03-01T00:00:01.000Z"));
    expect(second).toBeGreaterThan(first);
  });
});

describe("normalizeCanonicalUrl", () => {
  it("absolutizes a site-relative path and forces https", () => {
    const url = normalizeCanonicalUrl("/novel/my-title-pabc123");
    expect(url).toMatch(/^https:\/\//);
    expect(url).toContain("/novel/my-title-pabc123");
  });

  it("lowercases the host and strips default ports", () => {
    const url = normalizeCanonicalUrl("http://Example.COM:443/novel/x-p1");
    expect(url).toBe("https://example.com/novel/x-p1");
  });

  it("rejects a query string", () => {
    expect(() => normalizeCanonicalUrl("https://example.com/novel/x-p1?ref=abc")).toThrow(/query/);
  });

  it("rejects a fragment", () => {
    expect(() => normalizeCanonicalUrl("https://example.com/novel/x-p1#top")).toThrow(/query/);
  });

  it("rejects an apparently double-encoded path", () => {
    expect(() => normalizeCanonicalUrl("https://example.com/novel/%2520x")).toThrow(/double-encoded/);
  });
});

describe("buildIndexNowCanonicalUrl", () => {
  it("builds through the sole slug/article-path entry point", () => {
    const url = buildIndexNowCanonicalUrl({ locale: "en", slug: "great-novel", publicPageShortId: "abc123" });
    expect(url).toBe("https://enpulsedrama.com/novel/great-novel-pabc123");
  });
});

describe("isRegisteredSiteLocale", () => {
  it("accepts en, rejects everything else", () => {
    expect(isRegisteredSiteLocale("en")).toBe(true);
    expect(isRegisteredSiteLocale("EN")).toBe(false);
    expect(isRegisteredSiteLocale("fr")).toBe(false);
  });
});

const PUBLISHED_NOVEL = { status: "published" };
const PUBLISHED_ARTICLE = { locale: "en", status: "published" };
const READY_PROMO = { status: "fetched", webUrl: "https://x.example/w", appUrl: null };

describe("isNovelIndexNowEligible", () => {
  it("is eligible when publication state, promo readiness, and locale gate all pass", () => {
    expect(isNovelIndexNowEligible(PUBLISHED_ARTICLE, PUBLISHED_NOVEL, READY_PROMO, { isLocalePublishable: () => true })).toBe(true);
  });

  it("is ineligible when the locale gate rejects (production default: the D-7 whitelist is empty)", () => {
    // No override passed — exercises the real `isPublishableLocale`, which
    // is `Object.freeze([])` today (`src/lib/locale/locale-canonical.ts`).
    // This is the documented, currently-a-no-op production behavior, not a
    // bug in this test.
    expect(isNovelIndexNowEligible(PUBLISHED_ARTICLE, PUBLISHED_NOVEL, READY_PROMO)).toBe(false);
  });

  it("is ineligible when the Novel is not published", () => {
    expect(
      isNovelIndexNowEligible(PUBLISHED_ARTICLE, { status: "draft" }, READY_PROMO, { isLocalePublishable: () => true }),
    ).toBe(false);
  });

  it("is ineligible when the promo link is not ready (delegates to isPromoReady's trim authority)", () => {
    const whitespaceOnly = { status: "fetched", webUrl: "   ", appUrl: null };
    expect(
      isNovelIndexNowEligible(PUBLISHED_ARTICLE, PUBLISHED_NOVEL, whitespaceOnly, { isLocalePublishable: () => true }),
    ).toBe(false);
  });

  it("is ineligible when the Novel is takedown, even if Article status is published", () => {
    expect(
      isNovelIndexNowEligible(PUBLISHED_ARTICLE, { status: "takedown" }, READY_PROMO, { isLocalePublishable: () => true }),
    ).toBe(false);
  });
});
