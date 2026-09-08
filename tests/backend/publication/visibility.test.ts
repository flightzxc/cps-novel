import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  buildPrimaryArticleWhere,
  buildPrimaryNovelWhere,
  buildPublicArticleWhere,
  buildPublicListArticleWhere,
  buildPublicNovelWhere,
  isHiddenFromPublicView,
  isIndexNowEligible,
  isNoIndexRemovalState,
  isPromoReady,
  isPubliclyAccessible,
  isPublicationStatePublic,
  isRightsBlocked,
  PRIMARY_ARTICLE_RECORD,
  PRIMARY_NOVEL_RECORD,
  PUBLIC_ARTICLE_RECORD,
  PUBLIC_NOVEL_RECORD,
  type ArticleSeoVisibilityState,
  type PromoLinkReadinessState,
} from "@/server/publication/visibility";

const published = { status: "published" } as const;
const draft = { status: "draft" } as const;
const ready = { status: "ready" } as const;
const unpublished = { status: "unpublished" } as const;
const takedown = { status: "takedown" } as const;

function promo(overrides: Partial<Exclude<PromoLinkReadinessState, null>> = {}): PromoLinkReadinessState {
  return { status: "fetched", webUrl: "https://example.com/w", appUrl: null, ...overrides };
}

describe("isPromoReady", () => {
  it("is false for null", () => {
    expect(isPromoReady(null)).toBe(false);
  });

  it("is false when status is not fetched", () => {
    expect(isPromoReady(promo({ status: "pending" }))).toBe(false);
    expect(isPromoReady(promo({ status: "failed" }))).toBe(false);
    expect(isPromoReady(promo({ status: "registered_disabled" }))).toBe(false);
  });

  it("is true when fetched and webUrl is non-blank", () => {
    expect(isPromoReady(promo({ webUrl: "https://a", appUrl: null }))).toBe(true);
  });

  it("is true when fetched and only appUrl is non-blank", () => {
    expect(isPromoReady(promo({ webUrl: null, appUrl: "app://a" }))).toBe(true);
  });

  it("is false when fetched but both URLs are null", () => {
    expect(isPromoReady(promo({ webUrl: null, appUrl: null }))).toBe(false);
  });

  it("is false when fetched but webUrl is an empty string", () => {
    expect(isPromoReady(promo({ webUrl: "", appUrl: null }))).toBe(false);
  });

  it("is false when fetched but webUrl is pure whitespace (trim-authoritative)", () => {
    expect(isPromoReady(promo({ webUrl: "   ", appUrl: null }))).toBe(false);
  });

  it("is false when fetched but both URLs are pure whitespace", () => {
    expect(isPromoReady(promo({ webUrl: "  \t", appUrl: "\n " }))).toBe(false);
  });

  it("is true when webUrl is whitespace but appUrl is non-blank", () => {
    expect(isPromoReady(promo({ webUrl: "   ", appUrl: "app://ok" }))).toBe(true);
  });
});

describe("isPublicationStatePublic", () => {
  it("is true only when both novel and article are published", () => {
    expect(isPublicationStatePublic(published, published)).toBe(true);
  });

  it("is false when novel is not published", () => {
    expect(isPublicationStatePublic(draft, published)).toBe(false);
    expect(isPublicationStatePublic(ready, published)).toBe(false);
    expect(isPublicationStatePublic(unpublished, published)).toBe(false);
    expect(isPublicationStatePublic(takedown, published)).toBe(false);
  });

  it("is false when article is not published", () => {
    expect(isPublicationStatePublic(published, draft)).toBe(false);
    expect(isPublicationStatePublic(published, unpublished)).toBe(false);
    expect(isPublicationStatePublic(published, takedown)).toBe(false);
  });
});

describe("isRightsBlocked", () => {
  it("is true when novel is takedown regardless of article status", () => {
    expect(isRightsBlocked(takedown, published)).toBe(true);
    expect(isRightsBlocked(takedown, draft)).toBe(true);
  });

  it("is true when article is takedown regardless of novel status", () => {
    expect(isRightsBlocked(published, takedown)).toBe(true);
  });

  it("is false when neither is takedown", () => {
    expect(isRightsBlocked(published, published)).toBe(false);
    expect(isRightsBlocked(unpublished, unpublished)).toBe(false);
    expect(isRightsBlocked(draft, ready)).toBe(false);
  });
});

describe("isNoIndexRemovalState", () => {
  it("is true when novel is unpublished and not rights-blocked", () => {
    expect(isNoIndexRemovalState(unpublished, published)).toBe(true);
  });

  it("is true when article is unpublished and not rights-blocked", () => {
    expect(isNoIndexRemovalState(published, unpublished)).toBe(true);
  });

  it("is false when takedown takes precedence over unpublished", () => {
    expect(isNoIndexRemovalState(takedown, unpublished)).toBe(false);
    expect(isNoIndexRemovalState(unpublished, takedown)).toBe(false);
  });

  it("is false for draft/ready (plain 404, not a removal page)", () => {
    expect(isNoIndexRemovalState(draft, published)).toBe(false);
    expect(isNoIndexRemovalState(ready, published)).toBe(false);
  });

  it("is false when both are published", () => {
    expect(isNoIndexRemovalState(published, published)).toBe(false);
  });
});

describe("isPubliclyAccessible", () => {
  it("is true when published and promo is ready", () => {
    expect(isPubliclyAccessible(published, published, promo())).toBe(true);
  });

  it("is false when published but promo link is null", () => {
    expect(isPubliclyAccessible(published, published, null)).toBe(false);
  });

  it("is false when published but promo is not fetched", () => {
    expect(isPubliclyAccessible(published, published, promo({ status: "pending" }))).toBe(false);
  });

  it("is false when published but promo URLs are blank whitespace", () => {
    expect(
      isPubliclyAccessible(published, published, promo({ webUrl: " ", appUrl: " " })),
    ).toBe(false);
  });

  it("is false when publication state is not public even if promo is ready", () => {
    expect(isPubliclyAccessible(draft, published, promo())).toBe(false);
    expect(isPubliclyAccessible(published, unpublished, promo())).toBe(false);
    expect(isPubliclyAccessible(takedown, published, promo())).toBe(false);
  });
});

describe("isIndexNowEligible", () => {
  it("matches isPubliclyAccessible today", () => {
    expect(isIndexNowEligible(published, published, promo())).toBe(true);
    expect(isIndexNowEligible(draft, published, promo())).toBe(false);
    expect(isIndexNowEligible(published, published, null)).toBe(false);
    expect(isIndexNowEligible(published, published, promo({ webUrl: " ", appUrl: null }))).toBe(false);
  });
});

describe("DB pre-filter where-fragment helpers", () => {
  it("buildPrimaryNovelWhere wraps extra with the soft-delete guard", () => {
    expect(buildPrimaryNovelWhere({ locale: "en" })).toEqual({
      AND: [PRIMARY_NOVEL_RECORD, { locale: "en" }],
    });
  });

  it("buildPrimaryNovelWhere defaults extra to {}", () => {
    expect(buildPrimaryNovelWhere()).toEqual({ AND: [PRIMARY_NOVEL_RECORD, {}] });
  });

  it("buildPublicNovelWhere wraps extra with the published+soft-delete guard", () => {
    expect(buildPublicNovelWhere({ locale: "en" })).toEqual({
      AND: [PUBLIC_NOVEL_RECORD, { locale: "en" }],
    });
    expect(PUBLIC_NOVEL_RECORD.status).toBe("published");
    expect(PUBLIC_NOVEL_RECORD.deletedAt).toBeNull();
  });

  it("buildPrimaryArticleWhere wraps extra with the soft-delete guard", () => {
    expect(buildPrimaryArticleWhere({ slug: "x" })).toEqual({
      AND: [PRIMARY_ARTICLE_RECORD, { slug: "x" }],
    });
  });

  it("buildPublicArticleWhere wraps extra with the published+promo pre-filter", () => {
    expect(buildPublicArticleWhere({ slug: "x" })).toEqual({
      AND: [PUBLIC_ARTICLE_RECORD, { slug: "x" }],
    });
    expect(PUBLIC_ARTICLE_RECORD.status).toBe("published");
    expect(PUBLIC_ARTICLE_RECORD.promoLink).toEqual({ is: { status: "fetched" } });
  });
});

/**
 * C-25 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-25):
 * "这是本工单的承重测试，务必写成表驱动，把三个取值 × 三个层次九格全覆盖" — the
 * three `Article.seoVisibility` values (`public`/`seo_only`/`hidden`) against
 * the three layers this module's own header distinguishes:
 *   - 详情层 (`isHiddenFromPublicView`, consumed by `access.ts`'s
 *     `checkNovelArticlePublicAccess`): only `hidden` is unreachable.
 *   - 列表层 (`buildPublicListArticleWhere`, consumed by `queries.ts`'s
 *     `listPublicArticles`/`listPublicCategories` and the home carousel):
 *     both `hidden` and `seo_only` are excluded — only `public` is listed.
 *   - 收录层 (`buildPublicArticleWhere`, consumed by `sitemap.ts`/
 *     `eligibility.ts`): only `hidden` is excluded — `seo_only` stays
 *     collectable, same as `public`.
 *
 * The 🔴 risk this whole test exists for: swapping which layer excludes
 * `seo_only` turns "仅 SEO" into "隐藏" (worse than not shipping the feature —
 * search engines index a page that then 404s on click-through).
 */
describe("C-25: SEO 可见性三层真值表 (public / seo_only / hidden × 详情 / 列表 / 收录)", () => {
  const FLAG_ON = Object.freeze({ FEATURE_ARTICLE_SEO_VISIBILITY: "true" }) as unknown as NodeJS.ProcessEnv;
  const FLAG_OFF = Object.freeze({}) as unknown as NodeJS.ProcessEnv;
  const VALUES = ["public", "seo_only", "hidden"] as const;

  /**
   * Reads the `seoVisibility` sub-clause off `{AND:[base, extra]}`'s `base`
   * half and evaluates it the same way Prisma's `WhereInput` would against
   * one candidate value: no clause at all (flag off) means unconstrained
   * (every value passes), a bare string clause is equality, and `{ not }` is
   * inequality — the exact two shapes `buildPublicArticleWhere`/
   * `buildPublicListArticleWhere` emit.
   */
  function seoVisibilityClauseAllows(where: Prisma.ArticleWhereInput, value: string): boolean {
    const base = (where as { AND: [Record<string, unknown>, unknown] }).AND[0];
    const clause = base.seoVisibility as string | { not?: string } | undefined;
    if (clause === undefined) return true;
    if (typeof clause === "string") return clause === value;
    return clause.not !== value;
  }

  const EXPECTED_WHEN_ON: Readonly<Record<(typeof VALUES)[number], { detail: boolean; list: boolean; collect: boolean }>> =
    Object.freeze({
      public: { detail: true, list: true, collect: true },
      seo_only: { detail: true, list: false, collect: true },
      hidden: { detail: false, list: false, collect: false },
    });

  it.each(VALUES)("flag 开启时，%s 的三层可达性符合契约", (value) => {
    const article: ArticleSeoVisibilityState = { seoVisibility: value };
    const detail = !isHiddenFromPublicView(article, FLAG_ON);
    const list = seoVisibilityClauseAllows(buildPublicListArticleWhere({}, FLAG_ON), value);
    // Collectability is the DB pre-filter clause AND the app-layer recheck
    // together (`sitemap.ts`'s `isVisibleCandidate`, `eligibility.ts`'s
    // `isNovelIndexNowEligible`, both of which call `isHiddenFromPublicView`
    // in addition to relying on the `where` fragment) — see those files' own
    // dedicated tests for the two-sided defense-in-depth proof; this table
    // only needs the composed boolean to be right.
    const collect = seoVisibilityClauseAllows(buildPublicArticleWhere({}, FLAG_ON), value)
      && !isHiddenFromPublicView(article, FLAG_ON);
    expect({ detail, list, collect }).toEqual(EXPECTED_WHEN_ON[value]);
  });

  it.each(VALUES)(
    "flag 关闭时，%s 一律按 public 处理（详情可达、列表可见、可收录——即 C-25 之前的行为）",
    (value) => {
      const article: ArticleSeoVisibilityState = { seoVisibility: value };
      expect(isHiddenFromPublicView(article, FLAG_OFF)).toBe(false);
      expect(seoVisibilityClauseAllows(buildPublicListArticleWhere({}, FLAG_OFF), value)).toBe(true);
      expect(seoVisibilityClauseAllows(buildPublicArticleWhere({}, FLAG_OFF), value)).toBe(true);
    },
  );

  it("flag 关闭时两个片段的形状与 C-25 之前逐字相同（未定义 seoVisibility 子句）", () => {
    expect(buildPublicArticleWhere({ locale: "en" }, FLAG_OFF)).toEqual({
      AND: [PUBLIC_ARTICLE_RECORD, { locale: "en" }],
    });
    expect(buildPublicListArticleWhere({ locale: "en" }, FLAG_OFF)).toEqual({
      AND: [PUBLIC_ARTICLE_RECORD, { locale: "en" }],
    });
  });

  it("列表层片段比收录层片段更严格：收录层保留 seo_only，列表层不保留", () => {
    const listWhere = buildPublicListArticleWhere({}, FLAG_ON) as { AND: [Record<string, unknown>, unknown] };
    const collectWhere = buildPublicArticleWhere({}, FLAG_ON) as { AND: [Record<string, unknown>, unknown] };
    expect(listWhere.AND[0]).toMatchObject({ seoVisibility: "public" });
    expect(collectWhere.AND[0]).toMatchObject({ seoVisibility: { not: "hidden" } });
  });

  it("isHiddenFromPublicView 缺省值（未携带 seoVisibility 字段）按未隐藏处理", () => {
    expect(isHiddenFromPublicView({}, FLAG_ON)).toBe(false);
  });
});
