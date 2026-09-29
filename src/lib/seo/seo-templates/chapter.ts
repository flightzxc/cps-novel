import { getHomeName } from "../breadcrumb-i18n";
import {
  buildCanonical,
  buildLocaleCanonical,
  openGraphLocaleTag,
  resolveOgImage,
  truncateDescription,
} from "./_shared";

/**
 * D5: 章节页专用 SEO 数据 —— 章节页与小说页此前共用 `novel.ts` 的两级
 * `BreadcrumbList`（首页、当前页），缺了小说页这一级。这个模板补上第三级：
 * 首页(1) → 小说页(2) → 章节页(3)。小说页自己保持两级（`novel.ts` 不变）。
 *
 * 除面包屑外，其余字段与输出形状照抄 `novel.ts` 的 `NovelSeoData` /
 * `buildNovelSeoMeta`——章节页此前就是拿 `entity: "novel"` 在用同一套逻辑，
 * 这里只是把"章节页需要小说页这一级"的信息显式建模成输入字段，不改变
 * Book JSON-LD / OpenGraph / Twitter 卡片本身的形状。
 */
export interface ChapterSeoData {
  /** 页面标题（章节标题 + 小说标题的组合），沿用调用方此前的拼接方式。 */
  title: string;
  description: string;
  /** 章节页自己的路径，全部通过 getSiteUrl/toAbsoluteUrl 转绝对地址。 */
  canonicalPath: string;
  /** 小说标题——面包屑第 2 级的 name。 */
  novelTitle: string;
  /** 小说页自己的路径（不是章节路径）——面包屑第 2 级的 item。 */
  novelCanonicalPath: string;
  coverUrl?: string | null;
  defaultOgImage?: string | null;
  siteName: string;
  /** 与 `NovelSeoData.hreflangAlternates` 同一条约束：必填，DB 校验过的章节页兄弟语种。 */
  hreflangAlternates: Record<string, string>;
}

export function buildChapterSeoMeta(data: ChapterSeoData, locale = "en") {
  const name = data.title.trim();
  const title = name;
  const description = truncateDescription(data.description);
  const canonical = buildCanonical(data.canonicalPath);
  const novelCanonical = buildCanonical(data.novelCanonicalPath);
  const ogImage = resolveOgImage(data.coverUrl, data.defaultOgImage);
  const ogLocale = openGraphLocaleTag(locale);

  const bookLd = {
    "@context": "https://schema.org",
    "@type": "Book",
    name,
    description: data.description,
    url: canonical,
    image: ogImage,
    inLanguage: locale,
  };

  const homeName = getHomeName(locale);
  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: homeName, item: buildLocaleCanonical(locale, "/") },
      { "@type": "ListItem", position: 2, name: data.novelTitle, item: novelCanonical },
      { "@type": "ListItem", position: 3, name, item: canonical },
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
      languages: data.hreflangAlternates,
    },
    robots: undefined,
    other: {
      "application/ld+json": JSON.stringify([bookLd, breadcrumbLd]),
    },
  };
}
