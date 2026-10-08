import { buildActiveLocaleAlternates, emptyLocaleRobots } from "../empty-locale-seo";
import { generateWebSiteJsonLd } from "../seo-utils";
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
  /**
   * 动态层活跃语种集合（`getActiveLocales()`，页面层 `loadActiveLocales()` 传入）。必填：
   * 首页的 hreflang 只列活跃语种，当前语种不在集合里（= 空语种，PN-09）时输出 noindex 且不
   * 声明 hreflang。不要传 `SITE_LOCALES`——那就是盲目枚举全部 15 个登记语种。
   */
  activeLocales: readonly string[];
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
      languages: buildActiveLocaleAlternates("/", locale, data.activeLocales),
    },
    // 空语种（没有任何公开可见的已发布书）→ noindex,follow；否则不覆盖（落成 index,follow）。
    robots: emptyLocaleRobots(locale, data.activeLocales),
    other: {
      "application/ld+json": JSON.stringify(websiteLd),
    },
  };
}
