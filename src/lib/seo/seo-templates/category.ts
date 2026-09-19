/**
 * Direct semantic port of CPS v8.3.6 `seo-templates/category.ts`: category
 * canonical includes `?page=N`, page 2+ is noindex/follow, and JSON-LD is a
 * CollectionPage plus BreadcrumbList. PulseDrama constants are replaced by
 * SiteSetting inputs and Novel's registered locale/canonical helpers.
 */
import { getHomeName } from "../breadcrumb-i18n";
import { buildHreflangAlternates, shouldNoIndex } from "../seo-utils";
import {
  buildCanonical,
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
}

export function buildCategorySeoMeta(
  data: CategorySeoData,
  pageNumber = 1,
  locale = "en",
) {
  const path = pageNumber >= 2
    ? `/category/${data.slug}?page=${pageNumber}`
    : `/category/${data.slug}`;
  const canonical = buildCanonical(path);
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
      languages: buildHreflangAlternates(`/category/${data.slug}`, locale),
    },
    robots: shouldNoIndex(pageNumber) ? { index: false, follow: true } : undefined,
    other: { "application/ld+json": JSON.stringify([collectionLd, breadcrumbLd]) },
  };
}
