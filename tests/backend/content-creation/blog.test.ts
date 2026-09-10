/**
 * C-28 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-28):
 * `createBlogArticle` (`src/server/content-creation/blog.ts`) unit tests
 * against a minimal hand-rolled fake — same "one method per real call
 * shape, not a general query engine" discipline as
 * `tests/backend/content-creation/fake-db.ts` (this file's fake is smaller
 * and purpose-built for `createBlogArticle` alone, since its call shape —
 * `article.findFirst`/`article.create`/`operationAudit.create` inside one
 * `$transaction` — is much narrower than `createContentFromSourceItem`'s).
 *
 * Covers exactly what the plan's own "测试" bullet for C-28's
 * `tests/backend/`（内容创建服务的测试文件）item asks for: 创建落值断言（六个
 * 固定值逐一断言）；状态一律 draft；slug 撞了报既有错误码；双闸各自关闭时
 * fail-closed；短码扫描测试仍通过（covered separately by
 * `tests/backend/slug/short-id-sole-source.test.ts`, unchanged by this file
 * since `createBlogArticle` lives under the one authorized directory).
 */
import { describe, expect, it } from "vitest";

import { BlogArticleInputError, createBlogArticle, type CreateBlogArticleInput } from "@/server/content-creation/blog";

import { FakeBlogArticleDb } from "./blog-fake-db";

function baseInput(overrides: Partial<CreateBlogArticleInput> = {}): CreateBlogArticleInput {
  return {
    locale: "en",
    title: "A Great Blog Post",
    slug: "a-great-blog-post",
    body: "<p>Body</p>",
    seoVisibility: "public",
    actor: { type: "admin", adminId: "admin-1" },
    requestId: "req-1",
    ...overrides,
  };
}

const ENABLED = { FEATURE_ARTICLE_BLOG: "true", ARTICLE_BLOG_ALLOW_WRITE: "true" } as unknown as NodeJS.ProcessEnv;
const FEATURE_ONLY = { FEATURE_ARTICLE_BLOG: "true", ARTICLE_BLOG_ALLOW_WRITE: "false" } as unknown as NodeJS.ProcessEnv;
const DISABLED = {} as unknown as NodeJS.ProcessEnv;

describe("createBlogArticle", () => {
  it("creates with exactly the six fixed values the plan pins, plus operator-supplied fields verbatim", async () => {
    const db = new FakeBlogArticleDb();
    const result = await createBlogArticle(db.asPrismaClient(), baseInput(), ENABLED);
    expect(result.outcome).toBe("created");
    expect(db.createCalls).toHaveLength(1);
    const written = db.createCalls[0]!;
    // The six fixed values the plan pins, asserted individually:
    expect(written.articleType).toBe("blog_article");
    expect(written.contentMode).toBe("manual");
    expect(written.novelId).toBeNull();
    expect(written.templateId).toBeNull();
    expect(written.promoLinkId).toBeNull();
    expect(written).not.toHaveProperty("status"); // draft is the column default, never spelled — see module header.
    // Operator-supplied fields land verbatim.
    expect(written.locale).toBe("en");
    expect(written.slug).toBe("a-great-blog-post");
    expect(written.title).toBe("A Great Blog Post");
    expect(written.seoVisibility).toBe("public");
  });

  it("sanitizes the body through the same whitelist as the manual-edit path", async () => {
    const db = new FakeBlogArticleDb();
    await createBlogArticle(db.asPrismaClient(), baseInput({ body: '<p onclick="evil()">Body</p><script>bad()</script>' }), ENABLED);
    const written = db.createCalls[0]!;
    expect(written.body).not.toContain("<script>");
    expect(written.body).not.toContain("onclick");
  });

  it("stores coverUrl/metaTitle/metaDescription/metaKeywords inside seoMetadata (no schema change this round)", async () => {
    const db = new FakeBlogArticleDb();
    await createBlogArticle(
      db.asPrismaClient(),
      baseInput({
        metaTitle: "  Meta Title  ",
        metaDescription: "Meta Description",
        metaKeywords: "keyword-one, keyword-two",
        coverUrl: "https://example.com/cover.jpg",
      }),
      ENABLED,
    );
    const written = db.createCalls[0]!;
    expect(written.seoMetadata).toEqual({
      metaTitle: "Meta Title",
      metaDescription: "Meta Description",
      metaKeywords: "keyword-one, keyword-two",
      coverUrl: "https://example.com/cover.jpg",
    });
  });

  it("omits blank/absent optional seoMetadata keys entirely rather than storing empty strings", async () => {
    const db = new FakeBlogArticleDb();
    await createBlogArticle(db.asPrismaClient(), baseInput({ metaTitle: "   " }), ENABLED);
    expect(db.createCalls[0]!.seoMetadata).toEqual({});
  });

  it("FEATURE_ARTICLE_BLOG off: fail-closed before any validation or write, regardless of input shape", async () => {
    const db = new FakeBlogArticleDb();
    const result = await createBlogArticle(db.asPrismaClient(), baseInput({ title: "" }), DISABLED);
    expect(result).toEqual({ outcome: "feature_disabled" });
    expect(db.createCalls).toHaveLength(0);
  });

  it("ARTICLE_BLOG_ALLOW_WRITE off: input is still validated, but zero writes happen", async () => {
    const db = new FakeBlogArticleDb();
    const result = await createBlogArticle(db.asPrismaClient(), baseInput(), FEATURE_ONLY);
    expect(result).toEqual({ outcome: "write_disabled" });
    expect(db.createCalls).toHaveLength(0);
    expect(db.audits).toHaveLength(0);

    // Still validated: a malformed field throws even though the write is
    // disabled -- the write-disable gate does not mask a genuinely bad
    // request as if it were merely "not authorized yet".
    await expect(createBlogArticle(db.asPrismaClient(), baseInput({ title: "" }), FEATURE_ONLY)).rejects.toThrow(
      BlogArticleInputError,
    );
  });

  it("slug pre-check conflict: a different active row already occupies (locale, slug) -- no auto-suffix, no write", async () => {
    const db = new FakeBlogArticleDb().seed({ locale: "en", slug: "taken-slug" });
    const result = await createBlogArticle(db.asPrismaClient(), baseInput({ slug: "taken-slug" }), ENABLED);
    expect(result).toEqual({ outcome: "slug_conflict", locale: "en", slug: "taken-slug" });
    expect(db.createCalls).toHaveLength(0);
  });

  it("slug race conflict: pre-check clear, but the insert itself hits the unique index -- same slug_conflict outcome, not a raw throw", async () => {
    const db = new FakeBlogArticleDb();
    db.forceCreateConflict = "locale_slug";
    const result = await createBlogArticle(db.asPrismaClient(), baseInput(), ENABLED);
    expect(result).toEqual({ outcome: "slug_conflict", locale: "en", slug: "a-great-blog-post" });
  });

  it("a soft-deleted row at the same (locale, slug) does not block creation", async () => {
    const db = new FakeBlogArticleDb().seed({ locale: "en", slug: "a-great-blog-post", deletedAt: null });
    // Simulate the soft-deleted row by directly mutating deletedAt after seeding non-null.
    (db.articles[0] as { deletedAt: Date | null }).deletedAt = new Date();
    const result = await createBlogArticle(db.asPrismaClient(), baseInput(), ENABLED);
    expect(result.outcome).toBe("created");
  });

  describe("input validation (BlogArticleInputError, thrown — malformed input, not a business state)", () => {
    it.each([
      ["invalid_locale", baseInput({ locale: "not-a-real-locale" })],
      ["invalid_title", baseInput({ title: "   " })],
      ["invalid_slug", baseInput({ slug: "Not A Valid Slug!" })],
      ["invalid_slug (blank)", baseInput({ slug: "" })],
      ["invalid_body", baseInput({ body: "   " })],
      ["invalid_seo_visibility", baseInput({ seoVisibility: "not-a-real-value" })],
    ])("rejects %s", async (expectedCode, input) => {
      const db = new FakeBlogArticleDb();
      const code = expectedCode.split(" ")[0]!;
      await expect(createBlogArticle(db.asPrismaClient(), input, ENABLED)).rejects.toMatchObject({
        name: "BlogArticleInputError",
        code,
      });
      expect(db.createCalls).toHaveLength(0);
    });

    it("L10N P4: accepts any registered SITE_LOCALES member, not just en (the D-7 publish whitelist this used to gate on — PUBLISHABLE_LOCALES/isPublishableLocale — was deleted; requireLocale now checks only SITE_LOCALES membership, same as CPS's own isSupportedSiteLocale gate at this boundary)", async () => {
      const db = new FakeBlogArticleDb();
      // "ja" is a real, registered SiteLocale (SITE_LOCALES) that used to be
      // rejected here as "registered but not publishable" — that second gate
      // no longer exists.
      const result = await createBlogArticle(db.asPrismaClient(), baseInput({ locale: "ja" }), ENABLED);
      expect(result).toMatchObject({ outcome: "created", locale: "ja" });
    });

    it("rejects a slug carrying stray uppercase instead of silently lower-casing it (would otherwise save something the operator never typed)", async () => {
      const db = new FakeBlogArticleDb();
      await expect(createBlogArticle(db.asPrismaClient(), baseInput({ slug: "MySlug" }), ENABLED)).rejects.toMatchObject({
        name: "BlogArticleInputError",
        code: "invalid_slug",
      });
      expect(db.createCalls).toHaveLength(0);
    });

    it("rejects an underscore-separated slug (only hyphens are a valid separator)", async () => {
      const db = new FakeBlogArticleDb();
      await expect(createBlogArticle(db.asPrismaClient(), baseInput({ slug: "has_underscore" }), ENABLED)).rejects.toThrow(
        BlogArticleInputError,
      );
    });
  });
});
