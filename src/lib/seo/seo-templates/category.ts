/**
 * Direct semantic port of CPS v8.3.6 `seo-templates/category.ts`: category
 * canonical includes `?page=N`, page 2+ is noindex/follow, and JSON-LD is a
 * CollectionPage plus BreadcrumbList. PulseDrama constants are replaced by
 * SiteSetting inputs and Novel's registered locale/canonical helpers.
 *
 * TKD 对齐 CPS（Owner 2026-09-30 裁定，照 CPS v8.5.1 `category.ts:29-31`）：
 *  - `<title>` = 分类名 + （第 2 页起）本地化翻页后缀，不加 "novels" 之类的词；
 *    品牌后缀由根布局的标题模板加，这里不含品牌名；og:title/twitter:title 同此。
 *  - `<meta description>` = 分类自己的描述 || 一句固定的本地化兜底文案（所有分类共用
 *    同一句式，不是逐个分类生成）。
 * 这推翻了本文件此前"没有分类描述就整体省略、绝不合成描述"的旧决定——旧顾虑是
 * 英文句子混进非英语页面，现在兜底句在 15 语都有译文（`meta.categoryDescriptionFallback`），
 * 顾虑不存在了。翻页后缀与兜底句都由调用方按请求语种解析好再传进来
 * （`pageSuffix`/`descriptionFallback`），模板本身保持无文案目录依赖。
 *
 * 本轮不动结构化数据：CollectionPage JSON-LD 的 `description` 仍然只在分类自己有描述时
 * 才输出（CPS 会把兜底句也写进去，这里没有跟）。
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
   * Locale-specific category description (标签资产，按语种)。缺失时 `<meta description>`
   * 与 og/twitter 描述改用 `descriptionFallback`（见下）；JSON-LD 仍然省略
   * `description`。永远不回退到中文 `canonical_definition`。
   */
  description?: string | null;
  /**
   * 分类没有自己的描述时的固定兜底句，已按请求语种解析好（调用方传
   * `t("meta.categoryDescriptionFallback", { name })`）。所有分类共用同一句式，不是逐个
   * 分类生成的描述。旧决定"绝不合成描述"已被 Owner 2026-09-30 推翻，照 CPS 分类页。
   * 不传则退回旧行为（描述为空）。
   */
  descriptionFallback?: string;
  /**
   * 已本地化的翻页后缀（例如 " - Page 2"），调用方只在第 2 页起传入，第 1 页不传或传空。
   * 拼在 `<title>`/og:title/twitter:title 的分类名之后；JSON-LD 的 `name` 不带。
   */
  pageSuffix?: string;
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
  const title = `${data.name}${data.pageSuffix ?? ""}`;
  const trimmedDescription = data.description?.trim() ?? "";
  // JSON-LD 只用分类自己的描述（本轮不动结构化数据）；meta/og/twitter 的描述另外允许兜底句。
  const structuredDescription = trimmedDescription ? truncateDescription(trimmedDescription) : undefined;
  const trimmedFallback = data.descriptionFallback?.trim() ?? "";
  const description =
    structuredDescription ?? (trimmedFallback ? truncateDescription(trimmedFallback) : undefined);
  const image = resolveOgImage(null, data.defaultOgImage);
  const collectionLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: data.name,
    url: canonical,
    ...(structuredDescription ? { description: structuredDescription } : {}),
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
    title,
    description: description ?? "",
    canonical,
    openGraph: {
      type: "website" as const,
      title,
      ...(description ? { description } : {}),
      url: canonical,
      siteName: data.siteName,
      locale: openGraphLocaleTag(locale),
      images: [{ url: image, width: 1200, height: 630, alt: data.name }],
    },
    twitter: {
      card: "summary_large_image" as const,
      title,
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
