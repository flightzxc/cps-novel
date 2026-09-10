import { describe, expect, it } from "vitest";

import { SITE_LOCALES } from "@/lib/locale/locale-canonical";
import { localePrefix } from "@/lib/slug/article-path";

/**
 * WO-2 (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §8.1): direct unit
 * coverage for `localePrefix`, the site's sole prefix-building rule. It was
 * previously private to `src/lib/slug/article-path.ts` and only exercised
 * indirectly (via `buildArticlePath`/`buildBlogPath`); this pass exports it
 * for reuse across `chrome.ts`, `public-taxonomy.ts`, every `_pages/*`
 * basePath/homeHref prop, and the locale switcher, so it gets its own direct
 * coverage rather than staying an implicit assumption of those call sites.
 */
describe("localePrefix — the site's sole as-needed URL-prefix rule (D-8)", () => {
  it("returns an empty string for the default locale (en) — every en link stays bare", () => {
    expect(localePrefix("en")).toBe("");
  });

  it("prefixes every other registered locale with /{locale}", () => {
    for (const locale of SITE_LOCALES) {
      if (locale === "en") continue;
      expect(localePrefix(locale), locale).toBe(`/${locale}`);
    }
  });

  it("preserves hyphenated locale codes verbatim (pt-BR, zh-Hant)", () => {
    expect(localePrefix("pt-BR")).toBe("/pt-BR");
    expect(localePrefix("zh-Hant")).toBe("/zh-Hant");
  });

  it("covers every registered SiteLocale — this test fails loudly if the registry ever grows without this table following", () => {
    const prefixes = SITE_LOCALES.map((locale) => [locale, localePrefix(locale)] as const);
    expect(prefixes).toHaveLength(SITE_LOCALES.length);
    for (const [locale, prefix] of prefixes) {
      expect(prefix === "" || prefix === `/${locale}`, `${locale} -> "${prefix}"`).toBe(true);
    }
  });
});
