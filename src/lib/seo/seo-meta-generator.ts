import { buildBlogSeoMeta, type BlogSeoData } from "./seo-templates/blog";
import { buildChapterSeoMeta, type ChapterSeoData } from "./seo-templates/chapter";
import { buildCollectionSeoMeta, type CollectionSeoData } from "./seo-templates/collection";
import { buildCategorySeoMeta, type CategorySeoData } from "./seo-templates/category";
import { buildHomeSeoMeta, type HomeSeoData } from "./seo-templates/home";
import { buildNovelSeoMeta, type NovelSeoData } from "./seo-templates/novel";

export type { BlogSeoData, CategorySeoData, ChapterSeoData, CollectionSeoData, HomeSeoData, NovelSeoData };

export type SeoInput =
  | { entity: "novel"; data: NovelSeoData; locale?: string }
  /** D5: 章节页专用——三级 BreadcrumbList（首页/小说页/章节页），小说页本身仍用上面的 "novel"。 */
  | { entity: "chapter"; data: ChapterSeoData; locale?: string }
  | { entity: "home"; data: HomeSeoData; locale?: string }
  | { entity: "collection"; data: CollectionSeoData; pageNumber?: number; locale?: string }
  | { entity: "category"; data: CategorySeoData; pageNumber?: number; locale?: string }
  /** C-29: the `/blog/{slug}` detail page. No `pageNumber` — a blog detail page is never paginated. */
  | { entity: "blog"; data: BlogSeoData; locale?: string };

export interface SeoOutput {
  title: string;
  description: string;
  canonical: string;
  openGraph: {
    type: string;
    title: string;
    description?: string;
    url: string;
    siteName: string;
    locale: string;
    /** `width`/`height` 只在尺寸确知时声明（站点默认图 1200×630）；书封不声明。 */
    images: { url: string; width?: number; height?: number; alt: string }[];
  };
  twitter: {
    /** 站点默认图 → 大图卡片；书封（250×350，低于 X 大图卡片最小宽度 300）→ 小图卡片。 */
    card: "summary_large_image" | "summary";
    title: string;
    description?: string;
    images: string[];
  };
  alternates: {
    canonical: string;
    languages: Record<string, string>;
  };
  robots?: { index: boolean; follow: boolean };
  other?: { "application/ld+json": string };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeMetadataTitle(title: string, siteName: string): string {
  const normalizedTitle = title.trim();
  const normalizedSiteName = siteName.trim();

  if (!normalizedTitle || !normalizedSiteName) {
    return normalizedTitle;
  }

  const trailingSiteNamePattern = new RegExp(
    `(?:\\s*\\|\\s*${escapeRegExp(normalizedSiteName)})+$`,
  );

  return normalizedTitle.replace(trailingSiteNamePattern, "").trim();
}

/**
 * Unified SEO metadata factory.
 *
 * ```ts
 * const seo = generateSeoMeta({ entity: "novel", data: { ... } });
 * ```
 */
export function generateSeoMeta(input: SeoInput): SeoOutput {
  const locale = input.locale ?? "en";

  switch (input.entity) {
    case "novel":
      return buildNovelSeoMeta(input.data, locale);
    case "chapter":
      return buildChapterSeoMeta(input.data, locale);
    case "home":
      return buildHomeSeoMeta(input.data, locale);
    case "collection":
      return buildCollectionSeoMeta(input.data, input.pageNumber, locale);
    case "category":
      return buildCategorySeoMeta(input.data, input.pageNumber, locale);
    case "blog":
      return buildBlogSeoMeta(input.data, locale);
  }
}
