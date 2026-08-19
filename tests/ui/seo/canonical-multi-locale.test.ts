import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildCanonical, buildLocaleCanonical } from "@/lib/seo/seo-templates/_shared";

const ORIGIN = "https://example.test";

/**
 * P0-S7a item 5: canonical must stay correct once `SiteLocale` widens to 15
 * registered locales, and must keep routing through the single
 * `getSiteUrl`/`toAbsoluteUrl` source (`src/lib/seo/site-url.ts` — see
 * `tests/backend/seo/site-url-single-source.test.ts` for the repo-wide
 * duplicate-implementation guard; this file only checks the *values*).
 *
 * D-8's frozen URL form (already implemented in `buildLocaleCanonical`
 * before this unit — see `src/lib/slug/article-path.ts`'s identical
 * `localePrefix` logic): the default locale (`en`) is served bare, every
 * other registered locale gets a `/<locale>/` prefix ("as-needed" scheme).
 */
describe("buildLocaleCanonical · multi-locale (P0-S7a, 15-locale registry)", () => {
  beforeEach(() => {
    process.env.SITE_URL = ORIGIN;
  });
  afterEach(() => {
    delete process.env.SITE_URL;
  });

  it("serves the default locale (en) bare, with no locale segment", () => {
    expect(buildLocaleCanonical("en", "/novel/lantern-pabc123")).toBe(
      `${ORIGIN}/novel/lantern-pabc123`,
    );
    expect(buildLocaleCanonical("en", "/")).toBe(`${ORIGIN}/`);
  });

  it("prefixes every other registered locale, single-segment codes", () => {
    expect(buildLocaleCanonical("fr", "/novel/lantern-pabc123")).toBe(
      `${ORIGIN}/fr/novel/lantern-pabc123`,
    );
    expect(buildLocaleCanonical("ja", "/browse")).toBe(`${ORIGIN}/ja/browse`);
    expect(buildLocaleCanonical("ru", "/")).toBe(`${ORIGIN}/ru`);
  });

  it("prefixes hyphenated locale codes without mangling the hyphen (pt-BR, zh-Hant)", () => {
    expect(buildLocaleCanonical("pt-BR", "/novel/lantern-pabc123")).toBe(
      `${ORIGIN}/pt-BR/novel/lantern-pabc123`,
    );
    expect(buildLocaleCanonical("zh-Hant", "/browse")).toBe(`${ORIGIN}/zh-Hant/browse`);
  });

  it("locale-independent buildCanonical never injects any locale segment", () => {
    expect(buildCanonical("/novel/lantern-pabc123")).toBe(`${ORIGIN}/novel/lantern-pabc123`);
  });

  it("normalizes a bare relative path the same way regardless of locale", () => {
    expect(buildLocaleCanonical("es", "novel/no-leading-slash")).toBe(
      `${ORIGIN}/es/novel/no-leading-slash`,
    );
  });
});
