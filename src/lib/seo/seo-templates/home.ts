import { buildHreflangAlternates, generateWebSiteJsonLd } from "../seo-utils";
import { buildLocaleCanonical, openGraphLocaleTag, resolveOgImage, truncateDescription } from "./_shared";

export interface HomeSeoData {
  siteName: string;
  title?: string;
  description: string;
  defaultOgImage?: string | null;
}

export function buildHomeSeoMeta(data: HomeSeoData, locale = "en") {
  const title = (data.title?.trim() || data.siteName).trim();
  const description = truncateDescription(data.description);
  const canonical = buildLocaleCanonical(locale, "/");
  const ogImage = resolveOgImage(null, data.defaultOgImage);
  const ogLocale = openGraphLocaleTag(locale);
  const websiteLd = generateWebSiteJsonLd(data.siteName, description);

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
      images: [{ url: ogImage, width: 1200, height: 630, alt: data.siteName }],
    },
    twitter: {
      card: "summary_large_image" as const,
      title,
      description,
      images: [ogImage],
    },
    alternates: {
      canonical,
      languages: buildHreflangAlternates("/"),
    },
    robots: undefined,
    other: {
      "application/ld+json": JSON.stringify(websiteLd),
    },
  };
}
