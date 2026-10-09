/**
 * 搜索页的收录口径与分享卡片（PN-15）。纯函数，不碰数据库、不碰 React。
 *
 * 口径 = CPS v8.1.2 / v8.4.0（Owner 2026-10-09 拍板，方案第〇·五、第四节第 5 条）：
 *
 * | 状态                          | robots            | canonical                            | 标题 / 描述 / 分享卡片        |
 * | ----------------------------- | ----------------- | ------------------------------------ | ----------------------------- |
 * | ok 且本页有书                 | index, follow     | `/search?q=<词>`；第 2 页起 `&page=N` | 动态（`metaTitle` / `metaDescription`） |
 * | ok 零结果                     | noindex, follow   | 裸 `/search`                         | 动态（照 CPS v8.4.0）          |
 * | idle / too_short / too_long   | noindex, follow   | 裸 `/search`                         | 站点级                         |
 * | unavailable / 开关关闭        | noindex, nofollow | 裸 `/search`                         | 站点级                         |
 *
 * - 任何状态都**不声明 hreflang**（`alternates` 只有 canonical）；不进站点地图；robots.txt 不动。
 * - canonical **只声明，不做规范化跳转**；`q` 是归一后的词（保留大小写），由 `URLSearchParams` 生成
 *   （空格为 `+`，参数顺序 q 在前 page 在后，与翻页组件 `Pagination` 的拼法一致）。
 * - 标题不带品牌：品牌后缀由根布局的标题模板（`%s | 站点名`）加，og:title / twitter:title 不带后缀、
 *   品牌走 `og:site_name`（CPS 契约）。
 * - "站点级"分享卡片：海阅根布局没有站点级分享卡片默认值（CPS 有），所以这里自己输出同口径的值——
 *   标题 = 站点名、描述 = 站点描述（默认语种读后台 `siteDescription`，其它语种读 `meta.siteDescription`，
 *   照"全部作品"页的规则）、图 = 站点默认分享图（`resolveShareImage`，不自己拼）。
 */
import type { Metadata } from "next";

import type { SiteLocale } from "@/lib/locale/locale-canonical";
import type { Translator } from "@/lib/locale/messages";
import { buildLocaleCanonical, openGraphLocaleTag, resolveShareImage } from "@/lib/seo/seo-templates/_shared";
import { resolveSiteBrandName } from "@/lib/seo/site-brand";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

import type { SiteSearchStatus } from "./types";

export type SearchMetadataResult = Readonly<{
  status: SiteSearchStatus;
  displayQuery: string;
  /** 本页的书（只用数量判断"有结果"）。 */
  itemCount: number;
  page: number;
}>;

export type SearchMetadataInput = Readonly<{
  /** 后台开关；关闭时 `result` 不会被用到。 */
  enabled: boolean;
  locale: SiteLocale;
  result: SearchMetadataResult | null;
  t: Translator;
  settings: Readonly<{ siteName: string; siteDescription: string; defaultOgImage: string }>;
}>;

/** 搜索页的 canonical：第 1 页 `?q=`，第 2 页起 `&page=N`。 */
export function buildSearchCanonical(locale: SiteLocale, query: string, page: number): string {
  const params = new URLSearchParams({ q: query });
  if (page > 1) params.set("page", String(page));
  return `${buildLocaleCanonical(locale, "/search")}?${params.toString()}`;
}

type CardImages = Readonly<{
  openGraph: NonNullable<Metadata["openGraph"]>["images"];
  twitter: readonly string[];
  twitterCard: "summary_large_image" | "summary";
}>;

/**
 * 站点默认分享图。后台"默认分享图"是必填的（保存时校验），但全新的库里它是空串；其它公开页在这种情况下
 * 直接抛错（fail closed）。搜索页在开关关闭时是 404 页——一个 404 不该因为分享图没配而变成 500，
 * 所以这里没有图就不输出图，而不是抛错。
 */
function shareImages(defaultOgImage: string, alt: string): CardImages | null {
  try {
    const share = resolveShareImage({ defaultOgImage: defaultOgImage.trim() || null, prefer: "default", alt });
    return { openGraph: share.openGraphImages, twitter: [share.url], twitterCard: share.twitterCard };
  } catch {
    return null;
  }
}

function card(args: {
  title: string;
  description: string;
  url: string;
  locale: SiteLocale;
  siteName: string;
  defaultOgImage: string;
}): Pick<Metadata, "openGraph" | "twitter"> {
  const images = shareImages(args.defaultOgImage, args.title);
  return {
    openGraph: {
      type: "website",
      title: args.title,
      description: args.description,
      url: args.url,
      siteName: args.siteName,
      locale: openGraphLocaleTag(args.locale),
      ...(images ? { images: images.openGraph } : {}),
    },
    twitter: {
      card: images?.twitterCard ?? "summary_large_image",
      title: args.title,
      description: args.description,
      ...(images ? { images: [...images.twitter] } : {}),
    },
  };
}

export function buildSearchPageMetadata(input: SearchMetadataInput): Metadata {
  const { locale, t, settings } = input;
  const baseCanonical = buildLocaleCanonical(locale, "/search");
  const brandName = resolveSiteBrandName(settings.siteName);
  // 后台"站点描述"只有一个值（不分语种），只有默认语种读它，其余语种走文案（同"全部作品"页）。
  const siteDescription =
    (locale === PUBLIC_SITE_LOCALE && settings.siteDescription.trim()) || t("meta.siteDescription");
  const pageTitle = t("search.title");

  const siteLevel = (): Metadata => ({
    title: pageTitle,
    description: siteDescription,
    ...card({
      title: brandName,
      description: siteDescription,
      url: baseCanonical,
      locale,
      siteName: brandName,
      defaultOgImage: settings.defaultOgImage,
    }),
  });

  const result = input.result;
  if (!input.enabled || !result || result.status === "unavailable") {
    return {
      ...siteLevel(),
      robots: { index: false, follow: false },
      alternates: { canonical: baseCanonical },
    };
  }

  if (result.status === "ok") {
    const indexable = result.itemCount > 0;
    const canonical = indexable ? buildSearchCanonical(locale, result.displayQuery, result.page) : baseCanonical;
    const title = t("search.metaTitle", { query: result.displayQuery });
    const description = t("search.metaDescription", { query: result.displayQuery });
    return {
      title,
      description,
      ...card({ title, description, url: canonical, locale, siteName: brandName, defaultOgImage: settings.defaultOgImage }),
      robots: { index: indexable, follow: true },
      alternates: { canonical },
    };
  }

  // idle / too_short / too_long
  return {
    ...siteLevel(),
    robots: { index: false, follow: true },
    alternates: { canonical: baseCanonical },
  };
}
