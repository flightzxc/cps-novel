/**
 * Direct semantic port of CPS v8.3.6 `seo-templates/category.ts`: category
 * canonical includes `?page=N`, page 2+ is noindex/follow, and JSON-LD is a
 * CollectionPage plus BreadcrumbList. PulseDrama constants are replaced by
 * SiteSetting inputs and Novel's registered locale/canonical helpers.
 */
import { getHomeName } from "../breadcrumb-i18n";
import { buildHreflangAlternates, shouldNoIndex } from "../seo-utils";
import {
  buildLocaleCanonical,
  openGraphLocaleTag,
  resolveOgImage,
  truncateDescription,
} from "./_shared";

export interface CategorySeoData {
  name: string;
  slug: string;
  /**
   * Locale-specific category description. When missing, metadata and
   * JSON-LD omit `description` entirely — never synthesize
   * `${name} novels.` (that would mix English into non-en pages) and
   * never fall back to Chinese `canonical_definition`.
   */
  description?: string | null;
  siteName: string;
  defaultOgImage?: string | null;
  /**
   * The locales in which this category page really returns 200 (has public
   * content) — `listCategoryPublicLocales` in `@/lib/site/category-locales`,
   * plus the page's own locale. Required, no default: a category page that
   * blind-enumerates all 15 registered locales advertises hreflang URLs that
   * are 404 (an empty category is a 404 here), which is exactly the defect
   * this field exists to prevent — same "no silent default" reasoning as
   * `SiteShell`'s required `locale`.
   */
  hreflangLocales: readonly string[];
}

export function buildCategorySeoMeta(
  data: CategorySeoData,
  pageNumber = 1,
  locale = "en",
) {
  const path = pageNumber >= 2
    ? `/category/${data.slug}?page=${pageNumber}`
    : `/category/${data.slug}`;
  // 2026-09-30: locale-prefixed, like CPS's `buildLocaleCanonical(locale, path)`
  // (`v8.5.1:src/lib/seo-templates/category.ts`). This used to be the
  // locale-blind `buildCanonical(path)`, so `/ko/category/x` declared the
  // bare (en) `/category/x` as its canonical — a URL that is a 404 whenever
  // the category has no en content (an empty category is a 404 here) — and
  // contradicted the page's own hreflang self-entry below.
  const canonical = buildLocaleCanonical(locale, path);
  const trimmedDescription = data.description?.trim() ?? "";
  const description = trimmedDescription ? truncateDescription(trimmedDescription) : undefined;
  const image = resolveOgImage(null, data.defaultOgImage);
  const collectionLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: data.name,
    url: canonical,
    ...(description ? { description } : {}),
  };
  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: getHomeName(locale), item: buildLocaleCanonical(locale, "/") },
      { "@type": "ListItem", position: 2, name: data.name, item: buildLocaleCanonical(locale, `/category/${data.slug}`) },
    ],
  };
  return {
    title: data.name,
    description: description ?? "",
    canonical,
    openGraph: {
      type: "website" as const,
      title: data.name,
      ...(description ? { description } : {}),
      url: canonical,
      siteName: data.siteName,
      locale: openGraphLocaleTag(locale),
      images: [{ url: image, width: 1200, height: 630, alt: data.name }],
    },
    twitter: {
      card: "summary_large_image" as const,
      title: data.name,
      ...(description ? { description } : {}),
      images: [image],
    },
    alternates: {
      canonical,
      languages: buildHreflangAlternates(`/category/${data.slug}`, locale, data.hreflangLocales),
    },
    robots: shouldNoIndex(pageNumber) ? { index: false, follow: true } : undefined,
    other: { "application/ld+json": JSON.stringify([collectionLd, breadcrumbLd]) },
  };
}
