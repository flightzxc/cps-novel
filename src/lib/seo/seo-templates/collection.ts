import { getHomeName } from "../breadcrumb-i18n";
import { buildHreflangAlternates, generateItemListJsonLd, shouldNoIndex } from "../seo-utils";
import {
  buildLocaleCanonical,
  openGraphLocaleTag,
  resolveShareImage,
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
  /**
   * 站点默认图缺失时的兜底：本列表第一本书的封面。不要合并进 `defaultOgImage`——模板需要
   * 知道最终分享图是站点默认图还是书封，才能给出对应的卡片口径（B-37）。
   */
  fallbackCoverUrl?: string | null;
}

export function buildCollectionSeoMeta(
  data: CollectionSeoData,
  pageNumber = 1,
  locale = "en",
) {
  const title = data.title.trim();
  const description = truncateDescription(data.description);
  const pagePath = pageNumber > 1
    ? `${data.canonicalPath}${data.canonicalPath.includes("?") ? "&" : "?"}page=${pageNumber}`
    : data.canonicalPath;
  // 2026-09-30: locale-prefixed (`buildLocaleCanonical`) — same fix and same
  // reason as `category.ts`: `/ko/browse` and `/ko/blog` used to declare the
  // bare en path as their canonical.
  const canonical = buildLocaleCanonical(locale, pagePath);
  // 站点默认图优先，书封只是默认图缺失时的兜底（与此前 `default || novels[0].coverUrl` 同序）。
  const share = resolveShareImage({
    coverUrl: data.fallbackCoverUrl,
    defaultOgImage: data.defaultOgImage,
    prefer: "default",
    alt: title,
  });
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
      images: share.openGraphImages,
    },
    twitter: {
      card: share.twitterCard,
      title,
      description,
      images: [share.url],
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
