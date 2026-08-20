import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildIndexNowCanonicalUrl,
  computeIndexNowRevision,
  isNovelIndexNowEligible,
  isRegisteredSiteLocale,
  normalizeCanonicalUrl,
} from "@/lib/indexnow/eligibility";
import { SiteUrlConfigurationError } from "@/lib/seo/site-url";

const TEST_SITE_URL = "https://cps-novel.example";

// `normalizeCanonicalUrl`/`buildIndexNowCanonicalUrl` read `process.env.SITE_URL`
// via the shared `src/lib/seo/site-url.ts` with no injectable override (unlike
// `toAbsoluteSiteUrl` itself) — snapshot/restore around every test in this
// file so the negative-path tests below can freely unset/mutate it without
// leaking into `isNovelIndexNowEligible`'s unrelated tests.
let previousSiteUrl: string | undefined;
let previousPublicSiteUrl: string | undefined;

beforeEach(() => {
  previousSiteUrl = process.env.SITE_URL;
  previousPublicSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  process.env.SITE_URL = TEST_SITE_URL;
  delete process.env.NEXT_PUBLIC_SITE_URL;
});

afterEach(() => {
  if (previousSiteUrl === undefined) delete process.env.SITE_URL;
  else process.env.SITE_URL = previousSiteUrl;
  if (previousPublicSiteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = previousPublicSiteUrl;
});

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

  describe("SITE_URL configuration — fail-closed, no default domain (merge-review §4c)", () => {
    it("throws when SITE_URL is not set at all", () => {
      delete process.env.SITE_URL;
      expect(() => normalizeCanonicalUrl("/novel/x-p1")).toThrow(SiteUrlConfigurationError);
    });

    it("does NOT fall back to NEXT_PUBLIC_SITE_URL — throws even when only that is set", () => {
      delete process.env.SITE_URL;
      process.env.NEXT_PUBLIC_SITE_URL = "https://should-not-be-used.example";
      expect(() => normalizeCanonicalUrl("/novel/x-p1")).toThrow(SiteUrlConfigurationError);
    });

    it("never falls back to a hardcoded default domain (e.g. CPS's own production domain)", () => {
      delete process.env.SITE_URL;
      let error: unknown;
      try {
        normalizeCanonicalUrl("/novel/x-p1");
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(SiteUrlConfigurationError);
      expect(String(error)).not.toContain("enpulsedrama.com");
    });

    it.each([
      ["https://x.example/some/path"],
      ["https://x.example/?q=1"],
      ["https://x.example/#frag"],
      ["https://user:pass@x.example"],
      ["not-a-url"],
      ["ftp://x.example"],
    ])("rejects SITE_URL=%s (path, query, fragment, credentials, or non-HTTP(S) scheme)", (bad) => {
      process.env.SITE_URL = bad;
      expect(() => normalizeCanonicalUrl("/novel/x-p1")).toThrow(SiteUrlConfigurationError);
    });
  });
});

describe("buildIndexNowCanonicalUrl", () => {
  it("builds through the sole slug/article-path entry point", () => {
    const url = buildIndexNowCanonicalUrl({ locale: "en", slug: "great-novel", publicPageShortId: "abc123" });
    expect(url).toBe(`${TEST_SITE_URL}/novel/great-novel-pabc123`);
  });

  it("throws rather than silently using a default domain when SITE_URL is missing", () => {
    delete process.env.SITE_URL;
    expect(() => buildIndexNowCanonicalUrl({ locale: "en", slug: "great-novel", publicPageShortId: "abc123" })).toThrow(
      SiteUrlConfigurationError,
    );
  });
});

describe("isRegisteredSiteLocale", () => {
  it("accepts every registered SITE_LOCALES member, rejects everything else", () => {
    // P0-S7a expanded `SITE_LOCALES` from `["en"]` to the short-drama site's
    // 15-locale registry (Owner decision) — `fr` is now registered, so this
    // must now be `true`. Registered is not the same gate as publishable:
    // `isNovelIndexNowEligible` below still calls `isPublishableLocale`
    // (currently empty, D-7 open), so this widening does not, by itself,
    // let any additional locale reach IndexNow.
    expect(isRegisteredSiteLocale("en")).toBe(true);
    expect(isRegisteredSiteLocale("fr")).toBe(true);
    expect(isRegisteredSiteLocale("EN")).toBe(false);
    expect(isRegisteredSiteLocale("Fr")).toBe(false);
    expect(isRegisteredSiteLocale("xx")).toBe(false);
    expect(isRegisteredSiteLocale("en-US")).toBe(false);
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
