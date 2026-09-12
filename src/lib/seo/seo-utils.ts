/**
 * SEO utilities — JSON-LD builders, canonical helpers, pagination robots.
 *
 * Ported from CPS `src/lib/seo-utils.ts` (d77c3b9).
 * Drama `/drama/${slug}` URLs and genre-JSON parsing are replaced with
 * caller-supplied `url` + `genres[]`. Locale set for hreflang enumeration
 * (`buildHreflangAlternates` below) is `SITE_LOCALES` (L10N P4) — matching
 * CPS's own `3a76877:src/lib/seo-utils.ts:132`
 * (`for (const locale of SUPPORTED_SITE_LOCALES)`), the static registry, not
 * a narrower "active" set. See that function's own doc comment for why this
 * is safe for same-relative-path pages specifically.
 */

import { SITE_LOCALES } from "@/lib/locale/locale-canonical";

import { buildCanonical, buildLocaleCanonical, getSiteUrl, toAbsoluteUrl } from "./seo-templates/_shared";

export function generateWebSiteJsonLd(siteName: string, description: string) {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: siteName,
    url: getSiteUrl(),
    description,
  };
}

export interface CreativeWorkInput {
  name: string;
  description: string;
  url: string;
  genres: string[];
  chapterCount: number;
  coverUrl?: string | null;
  publishTime: Date | null;
}

export function generateCreativeWorkJsonLd(input: CreativeWorkInput) {
  return {
    "@context": "https://schema.org",
    "@type": "Book",
    name: input.name,
    description: input.description,
    url: input.url.startsWith("http") ? input.url : buildCanonical(input.url),
    image: toAbsoluteUrl(input.coverUrl),
    genre: input.genres,
    ...(input.chapterCount ? { numberOfChapters: input.chapterCount } : {}),
    ...(input.publishTime && {
      datePublished: input.publishTime.toISOString(),
    }),
  };
}

export interface BreadcrumbItem {
  name: string;
  href: string;
}

export function generateBreadcrumbJsonLd(items: BreadcrumbItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: item.href.startsWith("http") ? item.href : `${getSiteUrl()}${item.href}`,
    })),
  };
}

export interface ItemListEntry {
  name: string;
  url: string;
  position: number;
}

export function generateItemListJsonLd(listName: string, items: ItemListEntry[]) {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: listName,
    numberOfItems: items.length,
    itemListElement: items.map((item) => ({
      "@type": "ListItem",
      position: item.position,
      url: item.url.startsWith("http") ? item.url : `${getSiteUrl()}${item.url}`,
      name: item.name,
    })),
  };
}

export function canonicalUrl(path: string) {
  return buildCanonical(path);
}

/**
 * Build a complete alternates.languages map for a given canonical path.
 *
 * Safe ONLY for same-relative-path pages: every locale renders the exact
 * same path shape (home `/`, collection `/browse`), so enumerating a whole
 * locale set here can never point at a URL that doesn't structurally exist.
 * A page whose path varies per locale (slug, short id — i.e. any Novel/
 * Article detail page) must NOT use this function; it must resolve its real
 * sibling set from the DB instead (`novel-hreflang.ts`,
 * `buildNovelHreflangAlternates`), because blind enumeration there would
 * produce dead links for locales that have no sibling Article at all.
 *
 * L10N P4: enumerates `SITE_LOCALES` (the full 15-entry registry), matching
 * CPS's own `buildHreflangAlternates` equivalent
 * (`3a76877:src/lib/seo-utils.ts:132`, `for (const locale of
 * SUPPORTED_SITE_LOCALES)`) exactly — CPS has no narrower "publishable"
 * layer to prefer here, and the whitelist that previously narrowed this
 * project's own version (`PUBLISHABLE_LOCALES`/`listPublishableLocales()`)
 * was deleted this round. Safe specifically because this function is
 * reserved for same-relative-path pages (this file's own header/doc comment
 * above): once the P4 route guard admits every `SITE_LOCALES` member
 * (`[locale]/_guard.ts`), `/{locale}` and `/{locale}/browse` are real,
 * non-404 routes for all 15 — an empty listing there is a valid page, not a
 * dead link, which is exactly the difference from a detail page's sibling
 * enumeration (`novel-hreflang.ts`, which stays a real DB lookup).
 *
 * `currentLocale` is always included regardless — this is the URL the
 * caller is actually rendering right now (self-referencing hreflang is
 * expected practice), and omitting it would be a regression versus today's
 * behavior. `x-default` prefers the site default locale's entry (`en`),
 * falling back to the current page when that locale's URL is not among the
 * built alternates.
 */
export function buildHreflangAlternates(
  path: string,
  currentLocale: string = "en",
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const locale of SITE_LOCALES) {
    result[locale] = buildLocaleCanonical(locale, path);
  }
  result[currentLocale] = buildLocaleCanonical(currentLocale, path);
  result["x-default"] = result.en ?? result[currentLocale]!;
  return result;
}

export function shouldNoIndex(page: number): boolean {
  return page >= 2;
}
