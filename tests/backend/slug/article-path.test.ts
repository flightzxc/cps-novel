import { describe, expect, it } from "vitest";

import {
  buildArticlePath,
  buildArticleRoutePath,
  buildArticleUrlSuffix,
  parseArticleSlugParam,
} from "@/lib/slug/article-path";

describe("buildArticleUrlSuffix", () => {
  it("prefixes the short id with p", () => {
    expect(buildArticleUrlSuffix("1a2b3c4d")).toBe("p1a2b3c4d");
  });
});

describe("buildArticleRoutePath", () => {
  it("builds a locale-independent /novel/ path with the short-id suffix", () => {
    expect(buildArticleRoutePath({ slug: "my-title", shortId: "1a2b3c4d" })).toBe(
      "/novel/my-title-p1a2b3c4d",
    );
  });

  it("always includes the short id — no flagOn/optional branch (unlike CPS)", () => {
    const path = buildArticleRoutePath({ slug: "x", shortId: "zz11" });
    expect(path).toContain("-pzz11");
  });

  it("URL-encodes the composed slug", () => {
    expect(buildArticleRoutePath({ slug: "a b", shortId: "cd12" })).toBe(
      "/novel/a%20b-pcd12",
    );
  });
});

describe("buildArticlePath", () => {
  it("has no locale prefix for en (the only registered SiteLocale today)", () => {
    expect(buildArticlePath({ locale: "en", slug: "my-title", shortId: "1a2b3c4d" })).toBe(
      "/novel/my-title-p1a2b3c4d",
    );
  });
});

describe("parseArticleSlugParam", () => {
  it("splits slug and short id back out", () => {
    expect(parseArticleSlugParam("my-title-p1a2b3c4d")).toEqual({
      slugPart: "my-title",
      shortId: "1a2b3c4d",
    });
  });

  it("round-trips with buildArticleRoutePath", () => {
    const built = buildArticleRoutePath({ slug: "round-trip", shortId: "ab12cd34" });
    const param = decodeURIComponent(built.replace(/^\/novel\//, ""));
    expect(parseArticleSlugParam(param)).toEqual({
      slugPart: "round-trip",
      shortId: "ab12cd34",
    });
  });

  it("returns null when there is no -p<id> suffix", () => {
    expect(parseArticleSlugParam("no-suffix-here")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseArticleSlugParam("")).toBeNull();
  });

  it("does not assume a fixed 8-character short id length (unlike CPS)", () => {
    expect(parseArticleSlugParam("x-p12")).toEqual({ slugPart: "x", shortId: "12" });
    expect(parseArticleSlugParam("x-p123456789012")).toEqual({
      slugPart: "x",
      shortId: "123456789012",
    });
  });

  it("only matches lowercase alphanumeric short ids", () => {
    expect(parseArticleSlugParam("x-pABC123")).toBeNull();
  });
});
