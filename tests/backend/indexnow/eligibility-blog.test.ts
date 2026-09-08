import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildBlogIndexNowCanonicalUrl,
  isBlogIndexNowEligible,
} from "@/lib/indexnow/eligibility";
import { enqueueIndexNowFirstPublish } from "@/lib/indexnow/outbox";

import { FakeIndexNowDb, testEnv } from "./fake-db";

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

/**
 * C-29b outbox round-trip: `outbox.ts`'s `enqueueIndexNowFirstPublish` now
 * branches by `articleType` (`loadIndexNowCandidateArticle`'s discriminated
 * `IndexNowCandidateArticleRow`) — a blog Article takes the
 * `isBlogIndexNowEligible`/`buildBlogIndexNowCanonicalUrl` path this file's
 * other `describe` blocks test in isolation, all the way through to a real
 * `IndexNowOutbox` row. This is the end-to-end proof that the wiring holds:
 * before C-29b, `publish-gate/service.ts` never called
 * `dispatchFirstPublicPublication` at all for a `novelId === null` Article
 * (see that file's now-removed guard), so this code path was unreachable in
 * production even though `isBlogIndexNowEligible` itself already had unit
 * coverage above.
 */
describe("enqueueIndexNowFirstPublish — blog outbox round-trip (C-29b)", () => {
  const BLOG_ENABLED_ENV = testEnv({
    FEATURE_INDEXNOW_OUTBOX: "true",
    INDEXNOW_OUTBOX_ALLOW_WRITE: "true",
    FEATURE_ARTICLE_BLOG: "true",
  });
  // `env` (3rd positional arg to `enqueueIndexNowFirstPublish`, gating
  // `isIndexNowOutboxEnabled`/`isIndexNowOutboxWriteAllowed`) and
  // `eligibilityOptions.env` (4th arg, gating `isBlogIndexNowEligible`'s own
  // `isArticleBlogEnabled` read) are two independent env sources — in
  // production both default to the same live `process.env` (`dispatch-
  // handler.ts` passes neither), but a test that fakes one without the
  // other silently falls back to the real `process.env.FEATURE_ARTICLE_BLOG`
  // for the eligibility check. Threading the same fake env into both below
  // (rather than a single shared `LOCALE_OK` with no `env` at all) is what
  // makes `FEATURE_ARTICLE_BLOG` actually toggle these tests' outcome.
  function eligibilityOptions(env: NodeJS.ProcessEnv) {
    return { isLocalePublishable: () => true, env };
  }

  function seedBlogArticle(fake: FakeIndexNowDb, overrides: Partial<Parameters<FakeIndexNowDb["seedArticle"]>[0]> = {}) {
    fake.seedArticle({
      id: "blog-1",
      articleType: "blog_article",
      locale: "en",
      slug: "my-post",
      status: "published",
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      ...overrides,
    });
  }

  it("enqueues a blog Article's first publish with a /blog/{slug} canonical URL — no Novel/PromoLink involved", async () => {
    const fake = new FakeIndexNowDb();
    seedBlogArticle(fake);

    const result = await enqueueIndexNowFirstPublish(
      fake.asPrismaClient(),
      { articleId: "blog-1", source: "test" },
      BLOG_ENABLED_ENV,
      eligibilityOptions(BLOG_ENABLED_ENV),
    );

    expect(result.outcome).toBe("enqueued");
    expect(fake.outbox.size).toBe(1);
    const row = [...fake.outbox.values()][0]!;
    expect(row.url).toBe(`${TEST_SITE_URL}/blog/my-post`);
    expect(row.articleId).toBe("blog-1");
  });

  it("C-29 开关: FEATURE_ARTICLE_BLOG off -> ineligible even though status/locale/hidden all qualify", async () => {
    const fake = new FakeIndexNowDb();
    seedBlogArticle(fake);

    const offEnv = testEnv({ FEATURE_INDEXNOW_OUTBOX: "true", INDEXNOW_OUTBOX_ALLOW_WRITE: "true" });
    const result = await enqueueIndexNowFirstPublish(
      fake.asPrismaClient(),
      { articleId: "blog-1", source: "test" },
      offEnv,
      eligibilityOptions(offEnv),
    );

    expect(result).toEqual({ outcome: "ineligible" });
    expect(fake.outbox.size).toBe(0);
  });

  it("a draft blog Article is ineligible (never reaches the outbox)", async () => {
    const fake = new FakeIndexNowDb();
    seedBlogArticle(fake, { status: "draft" });

    const result = await enqueueIndexNowFirstPublish(
      fake.asPrismaClient(),
      { articleId: "blog-1", source: "test" },
      BLOG_ENABLED_ENV,
      eligibilityOptions(BLOG_ENABLED_ENV),
    );

    expect(result).toEqual({ outcome: "ineligible" });
    expect(fake.outbox.size).toBe(0);
  });
});
