import { describe, expect, it } from "vitest";

import {
  buildPrimaryArticleWhere,
  buildPrimaryNovelWhere,
  buildPublicArticleWhere,
  buildPublicNovelWhere,
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
