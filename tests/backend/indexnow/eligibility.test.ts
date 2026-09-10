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
    // `isNovelIndexNowEligible` still calls `isPublishableLocale` — U6
    // admitted `en`, so only `en` reaches IndexNow; `fr` remains blocked.
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

  it("is eligible under the real D-7 whitelist for en", () => {
    // No override — exercises the real `isPublishableLocale`. U6 admitted `en`.
    expect(isNovelIndexNowEligible(PUBLISHED_ARTICLE, PUBLISHED_NOVEL, READY_PROMO)).toBe(true);
  });

  it("is ineligible when the locale has not cleared D-7", () => {
    expect(
      isNovelIndexNowEligible({ ...PUBLISHED_ARTICLE, locale: "es" }, PUBLISHED_NOVEL, READY_PROMO),
    ).toBe(false);
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

  /**
   * C-25 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-25):
   * "IndexNow：投递资格判定追加「排除 hidden」。放在该模块自己那层…不要下沉到通用
   * 谓词族" — pins that `hidden` is excluded, `seo_only` stays eligible (same
   * collectability contract as sitemap), and that the flag being off
   * reproduces pre-C-25 behavior exactly.
   */
  describe("C-25: seoVisibility", () => {
    // Same `as unknown as NodeJS.ProcessEnv` convention as this repo's other
    // env-override tests: Next.js's global augmentation makes
    // `NodeJS.ProcessEnv` require `NODE_ENV`, which a plain single-key test
    // literal never carries.
    const FLAG_ON = { FEATURE_ARTICLE_SEO_VISIBILITY: "true" } as unknown as NodeJS.ProcessEnv;
    const FLAG_OFF = {} as unknown as NodeJS.ProcessEnv;

    it("is ineligible when seoVisibility is hidden and the flag is on", () => {
      expect(
        isNovelIndexNowEligible(
          { ...PUBLISHED_ARTICLE, seoVisibility: "hidden" },
          PUBLISHED_NOVEL,
          READY_PROMO,
          { isLocalePublishable: () => true, env: FLAG_ON },
        ),
      ).toBe(false);
    });

    it("stays eligible when seoVisibility is seo_only (collectability keeps seo_only, same as sitemap)", () => {
      expect(
        isNovelIndexNowEligible(
          { ...PUBLISHED_ARTICLE, seoVisibility: "seo_only" },
          PUBLISHED_NOVEL,
          READY_PROMO,
          { isLocalePublishable: () => true, env: FLAG_ON },
        ),
      ).toBe(true);
    });

    it("hidden has no effect while the flag is off (pre-C-25 behavior)", () => {
      expect(
        isNovelIndexNowEligible(
          { ...PUBLISHED_ARTICLE, seoVisibility: "hidden" },
          PUBLISHED_NOVEL,
          READY_PROMO,
          { isLocalePublishable: () => true, env: FLAG_OFF },
        ),
      ).toBe(true);
    });

    it("a row with no seoVisibility field at all (pre-C-25 caller shape) stays eligible", () => {
      expect(
        isNovelIndexNowEligible(PUBLISHED_ARTICLE, PUBLISHED_NOVEL, READY_PROMO, {
          isLocalePublishable: () => true,
          env: FLAG_ON,
        }),
      ).toBe(true);
    });
  });
});
