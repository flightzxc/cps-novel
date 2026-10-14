import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  buildPrimaryArticleWhere,
  buildPrimaryNovelWhere,
  buildPublicArticleWhere,
  buildPublicBlogArticleWhere,
  buildPublicListArticleWhere,
  buildPublicListBlogArticleWhere,
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
  PUBLIC_BLOG_ARTICLE_RECORD,
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

/**
 * v0.6.0：就绪规则按推广所属剧场的 `config.promoMode` 二选一。两种模式互不相交——
 * link（缺省）逐字不变；code（PlotNovel）看口令码 + 语种白名单，不看网址。
 */
describe("isPromoReady · 剧场模式（v0.6.0）", () => {
  const CODE_THEATER = { config: { promoMode: "code", agencyIds: ["1351"], codeModeLocales: ["en"] } };
  const LINK_THEATER = { config: { promoMode: "link", agencyIds: ["3366"] } };
  function coded(overrides: Partial<Exclude<PromoLinkReadinessState, null>> = {}): PromoLinkReadinessState {
    return { status: "fetched", webUrl: null, appUrl: null, upstreamCode: "960031", channelApp: CODE_THEATER, novel: { locale: "en" }, ...overrides };
  }

  it("口令码模式：fetched + 口令码非空 + 语种在白名单 → 就绪（没有任何网址也就绪）", () => {
    expect(isPromoReady(coded())).toBe(true);
  });

  it("🔴 web_app 路径：口令码非空只看派生布尔列 upstreamCodePresent（web_app 读不到 upstream_code 本身），给了布尔列就以它为准", () => {
    const webRow = (upstreamCodePresent: boolean, overrides: Partial<Exclude<PromoLinkReadinessState, null>> = {}): PromoLinkReadinessState =>
      ({ status: "fetched", webUrl: null, appUrl: null, upstreamCodePresent, channelApp: CODE_THEATER, novel: { locale: "en" }, ...overrides });
    expect(isPromoReady(webRow(true))).toBe(true); // 行里根本没有 upstreamCode 字段
    expect(isPromoReady(webRow(false))).toBe(false);
    // 两个都给时以布尔列为准（布尔列是触发器按口令码算出来的权威值）
    expect(isPromoReady(webRow(false, { upstreamCode: "960031" }))).toBe(false);
    expect(isPromoReady(webRow(true, { upstreamCode: null }))).toBe(true);
    // 语种白名单、状态等其它条件照常
    expect(isPromoReady(webRow(true, { novel: { locale: "fr" } }))).toBe(false);
    expect(isPromoReady(webRow(true, { status: "pending" }))).toBe(false);
    // link 模式不看布尔列
    expect(isPromoReady(webRow(true, { channelApp: LINK_THEATER }))).toBe(false);
  });

  it("口令码模式：状态不是 fetched → 不就绪", () => {
    for (const status of ["pending", "failed", "registered_disabled"]) expect(isPromoReady(coded({ status }))).toBe(false);
  });

  it.each([null, undefined, "", "   ", "\u3000\u00a0\t\n"])("口令码模式：口令码 %j 视为空 → 不就绪", (upstreamCode) => {
    expect(isPromoReady(coded({ upstreamCode }))).toBe(false);
  });

  it("口令码模式：书的语种不在白名单 / 没带语种信息 → 不就绪（失败方向是看不见）", () => {
    expect(isPromoReady(coded({ novel: { locale: "fr" } }))).toBe(false);
    expect(isPromoReady(coded({ novel: null }))).toBe(false);
    expect(isPromoReady(coded({ novel: undefined }))).toBe(false);
  });

  it("口令码模式：白名单逐项原样比对（不 trim、不忽略大小写、不把字符串当数组）", () => {
    expect(isPromoReady(coded({ channelApp: { config: { promoMode: "code", codeModeLocales: [" en"] } } }))).toBe(false);
    expect(isPromoReady(coded({ channelApp: { config: { promoMode: "code", codeModeLocales: ["EN"] } } }))).toBe(false);
    expect(isPromoReady(coded({ channelApp: { config: { promoMode: "code", codeModeLocales: "en" } } }))).toBe(false);
    expect(isPromoReady(coded({ channelApp: { config: { promoMode: "code" } } }))).toBe(false);
  });

  it("口令码模式：空语种边界——白名单含 \"\" 且书的语种也是 \"\" 时仍不就绪（SQL 侧有 coalesce(locale,'') <> '' 与之对应）", () => {
    for (const codeModeLocales of [[""], ["", "en"]]) {
      expect(isPromoReady(coded({ channelApp: { config: { promoMode: "code", codeModeLocales } }, novel: { locale: "" } }))).toBe(false);
    }
    // 白名单里有 "" 不影响正常语种
    expect(isPromoReady(coded({ channelApp: { config: { promoMode: "code", codeModeLocales: ["", "en"] } }, novel: { locale: "en" } }))).toBe(true);
  });

  it("口令码模式不看网址：有网址但口令码为空 → 仍不就绪", () => {
    expect(isPromoReady(coded({ upstreamCode: null, webUrl: "https://example.com/w" }))).toBe(false);
  });

  it("🔴 防误伤：link 模式（MoboReader）下有口令码、没有网址 → 不就绪（规则逐字不变）", () => {
    expect(isPromoReady({ status: "fetched", webUrl: null, appUrl: null, upstreamCode: "ABC123", channelApp: LINK_THEATER, novel: { locale: "en" } })).toBe(false);
  });

  it("🔴 防误伤：旧记录 config = {} 和没带剧场信息的调用点，一律按 link 处理——口令码模式的推广对它们不可见", () => {
    expect(isPromoReady({ status: "fetched", webUrl: null, appUrl: null, upstreamCode: "ABC123", channelApp: { config: {} }, novel: { locale: "en" } })).toBe(false);
    expect(isPromoReady({ status: "fetched", webUrl: null, appUrl: null, upstreamCode: "960031" })).toBe(false);
    expect(isPromoReady({ status: "fetched", webUrl: null, appUrl: null, upstreamCode: "960031", channelApp: null })).toBe(false);
  });

  it("link 模式：有网址照旧就绪，不受剧场信息的有无影响", () => {
    expect(isPromoReady({ status: "fetched", webUrl: "https://a", appUrl: null, channelApp: LINK_THEATER })).toBe(true);
    expect(isPromoReady({ status: "fetched", webUrl: null, appUrl: "app://a", channelApp: { config: {} } })).toBe(true);
    expect(isPromoReady({ status: "fetched", webUrl: "https://a", appUrl: null })).toBe(true);
  });

  it("promoMode 拼错（Code / codes / 非字符串）→ 按 link 处理", () => {
    for (const promoMode of ["Code", "codes", true, 1]) {
      expect(isPromoReady(coded({ channelApp: { config: { promoMode, codeModeLocales: ["en"] } } }))).toBe(false);
    }
  });

  it("两种模式互不相交：口令码模式的推广有网址也不会因为'有网址'这条被认可（只认口令码规则）", () => {
    expect(isPromoReady(coded({ webUrl: "https://example.com/w", upstreamCode: null }))).toBe(false);
    expect(isPromoReady(coded({ webUrl: "https://example.com/w", novel: { locale: "fr" } }))).toBe(false);
  });

  it("isPubliclyAccessible / isIndexNowEligible 沿用同一个判定（口令码模式的推广 + 已发布 = 可访问 / 可推送）", () => {
    expect(isPubliclyAccessible(published, published, coded())).toBe(true);
    expect(isIndexNowEligible(published, published, coded())).toBe(true);
    expect(isPubliclyAccessible(published, published, coded({ upstreamCode: null }))).toBe(false);
  });
});

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

/**
 * C-29 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-29):
 * the blog-family mirror of the C-25 nine-cell truth table above — same
 * `seoVisibilityClauseAllows` structural inspection (not a mock-`findMany`
 * round-trip, which cannot distinguish a correct `where` fragment from a
 * broken one when the mock ignores `where` entirely — this is the layer
 * that actually catches a broken `buildPublicListBlogArticleWhere`, unlike
 * `tests/backend/site/blog-queries.test.ts`'s own where-equality check,
 * which only proves the right function was *called*, not that the
 * function's own body is correct).
 */
describe("C-29: 博客系列 SEO 可见性三层真值表 (public / seo_only / hidden × 详情 / 列表 / 收录)", () => {
  const FLAG_ON = Object.freeze({ FEATURE_ARTICLE_SEO_VISIBILITY: "true" }) as unknown as NodeJS.ProcessEnv;
  const FLAG_OFF = Object.freeze({}) as unknown as NodeJS.ProcessEnv;
  const VALUES = ["public", "seo_only", "hidden"] as const;

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

  it.each(VALUES)("flag 开启时，博客 %s 的三层可达性符合契约（与小说系列同一张表）", (value) => {
    const article: ArticleSeoVisibilityState = { seoVisibility: value };
    const detail = !isHiddenFromPublicView(article, FLAG_ON);
    const list = seoVisibilityClauseAllows(buildPublicListBlogArticleWhere({}, FLAG_ON), value);
    const collect = seoVisibilityClauseAllows(buildPublicBlogArticleWhere({}, FLAG_ON), value)
      && !isHiddenFromPublicView(article, FLAG_ON);
    expect({ detail, list, collect }).toEqual(EXPECTED_WHEN_ON[value]);
  });

  it.each(VALUES)(
    "flag 关闭时，博客 %s 一律按 public 处理（详情可达、列表可见、可收录）",
    (value) => {
      const article: ArticleSeoVisibilityState = { seoVisibility: value };
      expect(isHiddenFromPublicView(article, FLAG_OFF)).toBe(false);
      expect(seoVisibilityClauseAllows(buildPublicListBlogArticleWhere({}, FLAG_OFF), value)).toBe(true);
      expect(seoVisibilityClauseAllows(buildPublicBlogArticleWhere({}, FLAG_OFF), value)).toBe(true);
    },
  );

  it("flag 关闭时两个博客片段的形状与 flag 未加时逐字相同（未定义 seoVisibility 子句）", () => {
    expect(buildPublicBlogArticleWhere({ locale: "en" }, FLAG_OFF)).toEqual({
      AND: [PUBLIC_BLOG_ARTICLE_RECORD, { locale: "en" }],
    });
    expect(buildPublicListBlogArticleWhere({ locale: "en" }, FLAG_OFF)).toEqual({
      AND: [PUBLIC_BLOG_ARTICLE_RECORD, { locale: "en" }],
    });
  });

  it("博客列表层片段比博客收录层片段更严格：收录层保留 seo_only，列表层不保留", () => {
    const listWhere = buildPublicListBlogArticleWhere({}, FLAG_ON) as { AND: [Record<string, unknown>, unknown] };
    const collectWhere = buildPublicBlogArticleWhere({}, FLAG_ON) as { AND: [Record<string, unknown>, unknown] };
    expect(listWhere.AND[0]).toMatchObject({ seoVisibility: "public" });
    expect(collectWhere.AND[0]).toMatchObject({ seoVisibility: { not: "hidden" } });
  });

  it("PUBLIC_BLOG_ARTICLE_RECORD requires status=published, novelId=null, and articleType in the blog family — never the Novel-shaped novel/promoLink relation filters", () => {
    expect(PUBLIC_BLOG_ARTICLE_RECORD.status).toBe("published");
    expect(PUBLIC_BLOG_ARTICLE_RECORD.novelId).toBeNull();
    expect(PUBLIC_BLOG_ARTICLE_RECORD.articleType).toEqual({ in: ["blog_article", "listicle", "guide"] });
    expect(PUBLIC_BLOG_ARTICLE_RECORD).not.toHaveProperty("novel");
    expect(PUBLIC_BLOG_ARTICLE_RECORD).not.toHaveProperty("promoLink");
  });
});
