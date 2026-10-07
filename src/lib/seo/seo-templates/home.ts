import { buildHreflangAlternates, generateWebSiteJsonLd } from "../seo-utils";
import { buildLocaleCanonical, openGraphLocaleTag, resolveShareImage, truncateDescription } from "./_shared";

export interface HomeSeoData {
  siteName: string;
  title?: string;
  description: string;
  defaultOgImage?: string | null;
  /**
   * 站点默认图缺失时的兜底：首页列表第一本书的封面。注意不要把它合并进 `defaultOgImage`——
   * 模板需要知道最终分享图是站点默认图还是书封，才能给出对应的卡片口径（B-37）。
   */
  fallbackCoverUrl?: string | null;
}

export function buildHomeSeoMeta(data: HomeSeoData, locale = "en") {
  const title = (data.title?.trim() || data.siteName).trim();
  const description = truncateDescription(data.description);
  const canonical = buildLocaleCanonical(locale, "/");
  // 站点默认图优先，书封只是默认图缺失时的兜底（与此前 `default || novels[0].coverUrl` 同序）。
  const share = resolveShareImage({
    coverUrl: data.fallbackCoverUrl,
    defaultOgImage: data.defaultOgImage,
    prefer: "default",
    alt: data.siteName,
  });
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
      languages: buildHreflangAlternates("/", locale),
    },
    robots: undefined,
    other: {
      "application/ld+json": JSON.stringify(websiteLd),
    },
  };
}
