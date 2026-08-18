/**
 * SEO utilities — JSON-LD builders, canonical helpers, pagination robots.
 *
 * Ported from CPS `src/lib/seo-utils.ts` (d77c3b9).
 * Drama `/drama/${slug}` URLs and genre-JSON parsing are replaced with
 * caller-supplied `url` + `genres[]`. Locale set comes from `SITE_LOCALES`.
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
 * Includes x-default (→ en) and every registered site locale.
 * This is the same-path locale-prefix map, not cross-Novel sibling hreflang.
 */
export function buildHreflangAlternates(path: string): Record<string, string> {
  const result: Record<string, string> = {
    "x-default": buildLocaleCanonical("en", path),
  };
  for (const locale of SITE_LOCALES) {
    result[locale] = buildLocaleCanonical(locale, path);
  }
  return result;
}

export function shouldNoIndex(page: number): boolean {
  return page >= 2;
}
