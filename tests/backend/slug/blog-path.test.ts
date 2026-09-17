import { describe, expect, it } from "vitest";

import { buildBlogPath, buildBlogRoutePath } from "@/lib/slug/article-path";

/**
 * C-29 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-29):
 * blog path family — same "default locale no prefix / other locale has
 * prefix / no short id" truth table the plan's own test list requires:
 * "博客路径构造器的分支（默认语种无前缀、其他语种有前缀、不带短码）".
 */
describe("buildBlogRoutePath", () => {
  it("builds a locale-independent /blog/ path with no short-id suffix", () => {
    expect(buildBlogRoutePath({ slug: "my-post" })).toBe("/blog/my-post");
  });

  it("URL-encodes the slug", () => {
    expect(buildBlogRoutePath({ slug: "a b" })).toBe("/blog/a%20b");
  });

  it("never appends a -p{shortId} suffix, unlike buildArticleRoutePath", () => {
    // Deliberately not "my-post" here — that slug's own trailing "-post"
    // would coincidentally match the -p{alnum}+ pattern being asserted
    // absent (p + "ost"), producing a false failure unrelated to the real
    // behavior under test.
    const path = buildBlogRoutePath({ slug: "my-title" });
    expect(path).not.toMatch(/-p[a-z0-9]+$/);
  });
});

describe("buildBlogPath", () => {
  it("has no locale prefix for en (the default locale)", () => {
    expect(buildBlogPath({ locale: "en", slug: "my-post" })).toBe("/blog/my-post");
  });

  it("adds a /{locale} prefix for any other registered SiteLocale", () => {
    expect(buildBlogPath({ locale: "ja", slug: "my-post" })).toBe("/ja/blog/my-post");
    expect(buildBlogPath({ locale: "fr", slug: "my-post" })).toBe("/fr/blog/my-post");
  });
});
