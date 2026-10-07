import { getHomeName } from "../breadcrumb-i18n";
import { buildHreflangAlternates, generateItemListJsonLd } from "../seo-utils";
import {
  buildLocaleCanonical,
  openGraphLocaleTag,
  paginatedRobots,
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

/**
 * 列表页（书库 `/browse`、博客列表 `/blog`）SEO 元数据。
 *
 * 分页页口径（PN-01 / PN-08，2026-10-07，Owner 确认"分页页允许收录，对齐 CPS"），
 * 与分类模板 `category.ts` 同一口径：
 *  - 第 2 页起不再 noindex：`robots: paginatedRobots(pageNumber)`（恒 `undefined`，CPS
 *    v8.7.2 `_shared.ts:43-47`）；canonical 仍是自身（带 `page=N`）。此前误接 `shouldNoIndex`
 *    （CPS 里已无调用方的废弃函数）。
 *  - 第 2 页起 `alternates.languages` 为空对象 `{}`：不输出任何跨语种 hreflang（含
 *    x-default）。`buildHreflangAlternates` 不带页码，会让各语种都指向第 1 页——CPS 同款
 *    缺陷，有意不照抄。第 1 页不变。
 */
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

  // 第 2 页起不输出任何跨语种 hreflang（含 x-default）。显式标注类型以保持返回类型不变。
  const languages: Record<string, string> =
    pageNumber >= 2 ? {} : buildHreflangAlternates(data.canonicalPath, locale);

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
      languages,
    },
    robots: paginatedRobots(pageNumber),
    other: {
      "application/ld+json": JSON.stringify([itemListLd, breadcrumbLd]),
    },
  };
}
