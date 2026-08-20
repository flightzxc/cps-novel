import { getHomeName } from "../breadcrumb-i18n";
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
  /**
   * Pre-computed, DB-verified hreflang alternates for this Novel's Article
   * siblings — REQUIRED, not optional. Every other seo-template in this
   * directory stays DB-free by design; this is the one field a Novel/Article
   * detail page cannot compute here, because it needs a Prisma read (see
   * `../novel-hreflang.ts`'s `buildNovelHreflangAlternatesByPublishedArticles`).
   *
   * Making this required (rather than optional-with-a-blind-enumeration
   * fallback) is deliberate: `buildNovelSeoMeta` used to fall back to
   * `seo-utils.ts#buildHreflangAlternates(data.canonicalPath)`, which is
   * unsafe for a per-locale-slugged page (see that function's doc comment).
   * A required field turns "caller forgot to pass sibling data" into a
   * compile error instead of a silent blind-enumeration regression — see
   * `tests/ui/seo/novel-hreflang-regression.test.ts` for the accompanying
   * static guard that this file never re-imports `buildHreflangAlternates`.
   */
  hreflangAlternates: Record<string, string>;
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
      languages: data.hreflangAlternates,
    },
    robots: undefined,
    other: {
      "application/ld+json": JSON.stringify([bookLd, breadcrumbLd]),
    },
  };
}
