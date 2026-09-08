import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildBlogIndexNowCanonicalUrl,
  isBlogIndexNowEligible,
} from "@/lib/indexnow/eligibility";

const TEST_SITE_URL = "https://cps-novel.example";

let previousSiteUrl: string | undefined;

beforeEach(() => {
  previousSiteUrl = process.env.SITE_URL;
  process.env.SITE_URL = TEST_SITE_URL;
});

afterEach(() => {
  if (previousSiteUrl === undefined) delete process.env.SITE_URL;
  else process.env.SITE_URL = previousSiteUrl;
});

/**
 * C-29 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-29):
 * "IndexNow 对博客跳过书目判定但不跳过语种与可见性判定" — this predicate has
 * no Novel/PromoLink parameter at all (unlike `isNovelIndexNowEligible`), so
 * "skips the book/promo-link判定" is true by construction; this file's job
 * is to pin that the locale allowlist, `hidden` exclusion, and
 * `FEATURE_ARTICLE_BLOG` gate are NOT skipped.
 */
const PUBLISHED_ARTICLE = { locale: "en", status: "published" };
const ARTICLE_ON = { FEATURE_ARTICLE_BLOG: "true" } as unknown as NodeJS.ProcessEnv;

describe("isBlogIndexNowEligible", () => {
  it("eligible: published, allowed locale, not hidden, flag on", () => {
    expect(
      isBlogIndexNowEligible(PUBLISHED_ARTICLE, { isLocalePublishable: () => true, env: ARTICLE_ON }),
    ).toBe(true);
  });

  it("C-29 开关: FEATURE_ARTICLE_BLOG off -> ineligible even though everything else qualifies", () => {
    expect(
      isBlogIndexNowEligible(PUBLISHED_ARTICLE, {
        isLocalePublishable: () => true,
        env: {} as NodeJS.ProcessEnv,
      }),
    ).toBe(false);
  });

  it("locale allowlist is NOT skipped — an unpublishable locale is ineligible regardless of status", () => {
    expect(
      isBlogIndexNowEligible(PUBLISHED_ARTICLE, { isLocalePublishable: () => false, env: ARTICLE_ON }),
    ).toBe(false);
  });

  it("draft is ineligible", () => {
    expect(
      isBlogIndexNowEligible(
        { locale: "en", status: "draft" },
        { isLocalePublishable: () => true, env: ARTICLE_ON },
      ),
    ).toBe(false);
  });

  it("unpublished is ineligible", () => {
    expect(
      isBlogIndexNowEligible(
        { locale: "en", status: "unpublished" },
        { isLocalePublishable: () => true, env: ARTICLE_ON },
      ),
    ).toBe(false);
  });

  it("takedown is ineligible", () => {
    expect(
      isBlogIndexNowEligible(
        { locale: "en", status: "takedown" },
        { isLocalePublishable: () => true, env: ARTICLE_ON },
      ),
    ).toBe(false);
  });

  it("C-25: hidden is NOT skipped — excluded when FEATURE_ARTICLE_SEO_VISIBILITY is on", () => {
    const env = { FEATURE_ARTICLE_BLOG: "true", FEATURE_ARTICLE_SEO_VISIBILITY: "true" } as unknown as NodeJS.ProcessEnv;
    expect(
      isBlogIndexNowEligible(
        { ...PUBLISHED_ARTICLE, seoVisibility: "hidden" },
        { isLocalePublishable: () => true, env },
      ),
    ).toBe(false);
  });

  it("C-25: seo_only is still eligible (collectability keeps seo_only, same as sitemap)", () => {
    const env = { FEATURE_ARTICLE_BLOG: "true", FEATURE_ARTICLE_SEO_VISIBILITY: "true" } as unknown as NodeJS.ProcessEnv;
    expect(
      isBlogIndexNowEligible(
        { ...PUBLISHED_ARTICLE, seoVisibility: "seo_only" },
        { isLocalePublishable: () => true, env },
      ),
    ).toBe(true);
  });
});

describe("buildBlogIndexNowCanonicalUrl", () => {
  it("builds the blog path with no short id, normalized to https", () => {
    const url = buildBlogIndexNowCanonicalUrl({ locale: "en", slug: "my-post" });
    expect(url).toBe("https://cps-novel.example/blog/my-post");
  });

  it("adds a locale prefix for a non-default locale", () => {
    const url = buildBlogIndexNowCanonicalUrl({ locale: "ja", slug: "my-post" });
    expect(url).toBe("https://cps-novel.example/ja/blog/my-post");
  });
});
