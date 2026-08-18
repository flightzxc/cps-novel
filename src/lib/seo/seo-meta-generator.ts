import { buildCollectionSeoMeta, type CollectionSeoData } from "./seo-templates/collection";
import { buildHomeSeoMeta, type HomeSeoData } from "./seo-templates/home";
import { buildNovelSeoMeta, type NovelSeoData } from "./seo-templates/novel";

export type { CollectionSeoData, HomeSeoData, NovelSeoData };

export type SeoInput =
  | { entity: "novel"; data: NovelSeoData; locale?: string }
  | { entity: "home"; data: HomeSeoData; locale?: string }
  | { entity: "collection"; data: CollectionSeoData; pageNumber?: number; locale?: string };

export interface SeoOutput {
  title: string;
  description: string;
  canonical: string;
  openGraph: {
    type: string;
    title: string;
    description: string;
    url: string;
    siteName: string;
    locale: string;
    images: { url: string; width: number; height: number; alt: string }[];
  };
  twitter: {
    card: "summary_large_image";
    title: string;
    description: string;
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
    case "home":
      return buildHomeSeoMeta(input.data, locale);
    case "collection":
      return buildCollectionSeoMeta(input.data, input.pageNumber, locale);
  }
}
