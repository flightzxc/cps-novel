/**
 * Direct semantic port of CPS `seo-templates/category.ts` (v8.3.6 shape, `robots`
 * aligned to v8.7.2): category canonical includes `?page=N`, page 2+ stays indexable
 * (`robots` comes from `paginatedRobots`, which always returns `undefined`, exactly like
 * CPS v8.7.2 `category.ts:93`), and JSON-LD is a CollectionPage plus BreadcrumbList.
 * PulseDrama constants are replaced by SiteSetting inputs and Novel's registered
 * locale/canonical helpers.
 *
 * 分页页口径（PN-01 / PN-08，2026-10-07，Owner 确认"分页页允许收录，对齐 CPS"）：
 *  - 第 2 页起不再 noindex：`robots: paginatedRobots(pageNumber)`（恒 `undefined`），
 *    与 CPS v8.7.2 一致；此前误接 `shouldNoIndex`（CPS 里已无调用方的废弃函数）。
 *  - 第 2 页起 `alternates.languages` 为空对象 `{}`，不输出任何跨语种 hreflang（含
 *    x-default）；第 1 页不变。这是**有意偏离** CPS——CPS 的 `buildHreflangAlternates`
 *    不带页码，第 2 页的各语种 hreflang 都指向第 1 页，是 CPS 的同款缺陷，不照抄。
 *    canonical 仍是自身（带 `?page=N`）；`hreflangLocales` 在第 2 页起不再被使用，调用方
 *    可以不做逐语种探测（见 `_pages/category.tsx` 的 `buildCategoryMetadata`）。
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
 * CollectionPage JSON-LD 的 `description` 与 meta 同源（复核 A2，照 CPS `category.ts:31`：
 * `rawDesc = description || fallback`，meta 与 JSON-LD 用同一个值）：分类自己的描述，
 * 没有时用兜底句。JSON-LD 的 `name` 仍是纯分类名，不带翻页后缀。
 */
import { getHomeName } from "../breadcrumb-i18n";
import { buildHreflangAlternates } from "../seo-utils";
import {
  buildLocaleCanonical,
  openGraphLocaleTag,
  paginatedRobots,
  resolveShareImage,
  truncateDescription,
} from "./_shared";

export interface CategorySeoData {
  name: string;
  slug: string;
  /**
   * Locale-specific category description (标签资产，按语种)。缺失时 `<meta description>`、
   * og/twitter 描述与 CollectionPage JSON-LD 的 `description` 都改用 `descriptionFallback`
   * （见下，同一个值）。永远不回退到中文 `canonical_definition`。
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
  /**
   * 站点默认图缺失时的兜底：本分类列表第一本书的封面。不要合并进 `defaultOgImage`——模板需要
   * 知道最终分享图是站点默认图还是书封，才能给出对应的卡片口径（B-37）。
   */
  fallbackCoverUrl?: string | null;
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
  const title = `${data.name}${data.pageSuffix ?? ""}`;
  const trimmedDescription = data.description?.trim() ?? "";
  const trimmedFallback = data.descriptionFallback?.trim() ?? "";
  // 分类自己的描述 || 兜底句；meta、og、twitter 与 JSON-LD 共用这一个值（CPS 同）。
  const rawDescription = trimmedDescription || trimmedFallback;
  const description = rawDescription ? truncateDescription(rawDescription) : undefined;
  // 站点默认图优先，书封只是默认图缺失时的兜底（与此前 `default || novels[0].coverUrl` 同序）。
  const share = resolveShareImage({
    coverUrl: data.fallbackCoverUrl,
    defaultOgImage: data.defaultOgImage,
    prefer: "default",
    alt: data.name,
  });
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
  // 第 2 页起不输出任何跨语种 hreflang（含 x-default）：`buildHreflangAlternates` 不带页码，
  // 会让各语种都指向第 1 页（PN-08）。显式标注类型以保持返回类型不变。
  const languages: Record<string, string> =
    pageNumber >= 2
      ? {}
      : buildHreflangAlternates(`/category/${data.slug}`, locale, data.hreflangLocales);
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
      images: share.openGraphImages,
    },
    twitter: {
      card: share.twitterCard,
      title,
      ...(description ? { description } : {}),
      images: [share.url],
    },
    alternates: {
      canonical,
      languages,
    },
    robots: paginatedRobots(pageNumber),
    other: { "application/ld+json": JSON.stringify([collectionLd, breadcrumbLd]) },
  };
}
