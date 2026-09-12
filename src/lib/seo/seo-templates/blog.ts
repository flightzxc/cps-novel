/**
 * C-29 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-29):
 * SEO metadata template for the `/blog/{slug}` detail page — the blog-side
 * counterpart to `./novel.ts`. JSON-LD is `Article` + `BreadcrumbList`
 * (CPS's own blog detail page uses the same pair, adapted to this repo's
 * SEO-factory shape).
 *
 * `robots` is deliberately `undefined` (not a noindex branch) — same as
 * `./novel.ts` — matching the plan's explicit instruction: "robots 为
 * index, follow（走既有的元数据工厂默认值，不加 noindex 分支）".
 *
 * `alternates.languages` is deliberately self + `x-default` ONLY, not
 * `../seo-utils.ts`'s `buildHreflangAlternates`. That helper's own doc
 * comment forbids exactly this use: "A page whose path varies per locale
 * (slug, short id — i.e. any Novel/Article detail page) must NOT use this
 * function ... blind enumeration there would produce dead links for
 * locales that have no sibling Article at all." A blog Article is exactly
 * such a page (keyed by slug, no DB-verified per-locale sibling lookup
 * built this round — see this round's own hreflang ruling: "本轮博客不做
 * 跨语种 hreflang，只输出自指的 canonical 与 x-default").
 *
 * L10N P4 (2026-09-10): this is no longer a merely-defensive, "harmless
 * today" guard — `listPublishableLocales()`/the whitelist layer it read is
 * deleted, and blog creation (`src/server/content-creation/blog.ts`'s
 * `requireLocale`) now accepts every `SITE_LOCALES` member (15 today), not
 * `{en}` alone. Calling `buildHreflangAlternates` here would blindly
 * enumerate all 15 and actually produce dead links for the (typical) blog
 * post that has no sibling in most of them — inlining self+x-default is now
 * load-bearing, not prophylactic.
 */
import { getHomeName } from "../breadcrumb-i18n";
import {
  buildCanonical,
  buildLocaleCanonical,
  openGraphLocaleTag,
  resolveOgImage,
  truncateDescription,
} from "./_shared";

export interface BlogSeoData {
  title: string;
  description: string;
  canonicalPath: string;
  coverUrl?: string | null;
  defaultOgImage?: string | null;
  siteName: string;
  publishedAt?: Date | null;
  updatedAt?: Date | null;
}

export function buildBlogSeoMeta(data: BlogSeoData, locale = "en") {
  const title = data.title.trim();
  const description = truncateDescription(data.description);
  const canonical = buildCanonical(data.canonicalPath);
  const ogImage = resolveOgImage(data.coverUrl, data.defaultOgImage);
  const ogLocale = openGraphLocaleTag(locale);
  const homeName = getHomeName(locale);

  const articleLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: title,
    description: data.description,
    url: canonical,
    image: ogImage,
    inLanguage: locale,
    ...(data.publishedAt ? { datePublished: data.publishedAt.toISOString() } : {}),
    ...(data.updatedAt ? { dateModified: data.updatedAt.toISOString() } : {}),
  };

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
      type: "article" as const,
      title,
      description,
      url: canonical,
      siteName: data.siteName,
      locale: ogLocale,
      images: [{ url: ogImage, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: "summary_large_image" as const,
      title,
      description,
      images: [ogImage],
    },
    alternates: {
      canonical,
      languages: { [locale]: canonical, "x-default": canonical },
    },
    robots: undefined,
    other: {
      "application/ld+json": JSON.stringify([articleLd, breadcrumbLd]),
    },
  };
}
