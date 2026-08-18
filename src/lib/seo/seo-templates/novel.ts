import { getHomeName } from "../breadcrumb-i18n";
import { buildHreflangAlternates } from "../seo-utils";
import {
  buildCanonical,
  buildLocaleCanonical,
  openGraphLocaleTag,
  resolveOgImage,
  truncateDescription,
} from "./_shared";

export interface NovelSeoData {
  title: string;
  description: string;
  canonicalPath: string;
  coverUrl?: string | null;
  defaultOgImage?: string | null;
  genres?: string[];
  chapterCount?: number;
  publishTime?: Date | null;
  siteName: string;
}

export function buildNovelSeoMeta(data: NovelSeoData, locale = "en") {
  const name = data.title.trim();
  const title = name;
  const description = truncateDescription(data.description);
  const canonical = buildCanonical(data.canonicalPath);
  const ogImage = resolveOgImage(data.coverUrl, data.defaultOgImage);
  const ogLocale = openGraphLocaleTag(locale);
  const genres = data.genres ?? [];

  const bookLd = {
    "@context": "https://schema.org",
    "@type": "Book",
    name,
    description: data.description,
    url: canonical,
    image: ogImage,
    genre: genres,
    inLanguage: locale,
    ...(data.chapterCount ? { numberOfChapters: data.chapterCount } : {}),
    ...(data.publishTime ? { datePublished: data.publishTime.toISOString() } : {}),
  };

  const homeName = getHomeName(locale);
  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: homeName, item: buildLocaleCanonical(locale, "/") },
      { "@type": "ListItem", position: 2, name, item: canonical },
    ],
  };

  return {
    title,
    description,
    canonical,
    openGraph: {
      type: "book" as const,
      title,
      description,
      url: canonical,
      siteName: data.siteName,
      locale: ogLocale,
      images: [{ url: ogImage, width: 1200, height: 630, alt: name }],
    },
    twitter: {
      card: "summary_large_image" as const,
      title,
      description,
      images: [ogImage],
    },
    alternates: {
      canonical,
      languages: buildHreflangAlternates(data.canonicalPath),
    },
    robots: undefined,
    other: {
      "application/ld+json": JSON.stringify([bookLd, breadcrumbLd]),
    },
  };
}
