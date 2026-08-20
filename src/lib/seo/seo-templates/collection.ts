import { getHomeName } from "../breadcrumb-i18n";
import { buildHreflangAlternates, generateItemListJsonLd, shouldNoIndex } from "../seo-utils";
import {
  buildCanonical,
  buildLocaleCanonical,
  openGraphLocaleTag,
  resolveOgImage,
  truncateDescription,
} from "./_shared";

export interface CollectionSeoItem {
  name: string;
  url: string;
}

export interface CollectionSeoData {
  title: string;
  description: string;
  canonicalPath: string;
  items: CollectionSeoItem[];
  siteName: string;
  defaultOgImage?: string | null;
}

export function buildCollectionSeoMeta(
  data: CollectionSeoData,
  pageNumber = 1,
  locale = "en",
) {
  const title = data.title.trim();
  const description = truncateDescription(data.description);
  const pagePath =
    pageNumber > 1 ? `${data.canonicalPath}?page=${pageNumber}` : data.canonicalPath;
  const canonical = buildCanonical(pagePath);
  const ogImage = resolveOgImage(null, data.defaultOgImage);
  const ogLocale = openGraphLocaleTag(locale);
  const homeName = getHomeName(locale);

  const itemListLd = generateItemListJsonLd(
    title,
    data.items.map((item, index) => ({
      name: item.name,
      url: item.url,
      position: index + 1,
    })),
  );
  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: homeName, item: buildLocaleCanonical(locale, "/") },
      { "@type": "ListItem", position: 2, name: title, item: canonical },
    ],
  };

  return {
    title,
    description,
    canonical,
    openGraph: {
      type: "website" as const,
      title,
      description,
      url: canonical,
      siteName: data.siteName,
      locale: ogLocale,
      images: [{ url: ogImage, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: "summary_large_image" as const,
      title,
      description,
      images: [ogImage],
    },
    alternates: {
      canonical,
      languages: buildHreflangAlternates(data.canonicalPath, locale),
    },
    robots: shouldNoIndex(pageNumber) ? { index: false, follow: true } : undefined,
    other: {
      "application/ld+json": JSON.stringify([itemListLd, breadcrumbLd]),
    },
  };
}
