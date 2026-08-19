/**
 * SEO utilities — JSON-LD builders, canonical helpers, pagination robots.
 *
 * Ported from CPS `src/lib/seo-utils.ts` (d77c3b9).
 * Drama `/drama/${slug}` URLs and genre-JSON parsing are replaced with
 * caller-supplied `url` + `genres[]`. Locale set comes from `SITE_LOCALES`.
 */

import { listPublishableLocales } from "@/lib/locale/locale-canonical";

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
 * Enumerates `listPublishableLocales()`, never the full `SITE_LOCALES`
 * registry. `SITE_LOCALES` only records that a locale is *mapped*
 * (`locale-canonical.ts`'s upstream registry); it says nothing about
 * whether that locale has a live, indexable route today. `SITE_LOCALES` is
 * already 15 entries wide while `listPublishableLocales()` is empty (D-7
 * still open) — iterating the wider set here would advertise hreflang
 * alternates for locales this site has never actually served a page for.
 * This is exactly the blind-enumeration failure mode this project's sibling
 * short-drama site had to hotfix after `next-intl`'s default response-header
 * `Link` enumeration walked its full registered-locale set instead of its
 * live one.
 *
 * `currentLocale` is always included regardless of the whitelist — this is
 * the URL the caller is actually rendering right now (self-referencing
 * hreflang is expected practice, not an extra promise about readiness), and
 * omitting it would be a regression versus today's single-locale behavior.
 * `x-default` prefers the site default locale's entry, falling back to the
 * current page when the default locale itself has not (yet) cleared the
 * whitelist — see `locale-canonical.ts`'s `PUBLISHABLE_LOCALES` for why that
 * is true even for `en` today.
 */
export function buildHreflangAlternates(
  path: string,
  currentLocale: string = "en",
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const locale of listPublishableLocales()) {
    result[locale] = buildLocaleCanonical(locale, path);
  }
  result[currentLocale] = buildLocaleCanonical(currentLocale, path);
  result["x-default"] = result.en ?? result[currentLocale]!;
  return result;
}

export function shouldNoIndex(page: number): boolean {
  return page >= 2;
}
