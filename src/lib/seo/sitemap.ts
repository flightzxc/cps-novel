import {
  listPublishableLocales,
  type SiteLocale,
} from "@/lib/locale/locale-canonical";
import { toAbsoluteUrl } from "@/lib/seo/site-url";

export const SITEMAP_TYPES = ["mainpage", "novelpage"] as const;
export type SitemapType = (typeof SITEMAP_TYPES)[number];

export interface SitemapFamilySpec {
  type: SitemapType;
  locale: SiteLocale;
}

export type SitemapChangefreq =
  | "always"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly"
  | "never";

export interface SitemapEntry {
  loc: string;
  lastmod: string;
  changefreq?: SitemapChangefreq;
  priority?: number;
  imageUrl?: string;
  imageTitle?: string;
}

export interface SitemapFile {
  name: string;
  url: string;
  lastmod: string;
  entries: SitemapEntry[];
}

export type BuildSitemapFamily = (spec: SitemapFamilySpec) => Promise<SitemapFile[]>;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function getSitemapFileName(
  type: SitemapType,
  locale: SiteLocale,
  index: number,
): string {
  const baseName = `site_${type}_${locale}`;
  return index === 0 ? `${baseName}.xml` : `${baseName}_${index}.xml`;
}

export function parseSitemapFileName(fileName: string): {
  type: SitemapType;
  locale: SiteLocale;
  index: number;
} | null {
  const match = /^site_(mainpage|novelpage)_([a-zA-Z-]+)(?:_(\d+))?\.xml$/.exec(fileName);
  if (!match) return null;

  const locale = match[2];
  if (!listPublishableLocales().includes(locale as SiteLocale)) return null;

  return {
    type: match[1] as SitemapType,
    locale: locale as SiteLocale,
    index: match[3] ? Number.parseInt(match[3], 10) : 0,
  };
}

export function renderUrlSetXml(entries: SitemapEntry[]): string {
  const body = entries
    .map((entry) => {
      const absoluteImageUrl = toAbsoluteUrl(entry.imageUrl);
      const changefreqLine = entry.changefreq
        ? `\n    <changefreq>${escapeXml(entry.changefreq)}</changefreq>`
        : "";
      const priorityLine = entry.priority !== undefined
        ? `\n    <priority>${entry.priority.toFixed(1)}</priority>`
        : "";
      const imageLines = absoluteImageUrl
        ? `\n    <image:image>\n      <image:loc>${escapeXml(absoluteImageUrl)}</image:loc>`
          + (entry.imageTitle ? `\n      <image:title>${escapeXml(entry.imageTitle)}</image:title>` : "")
          + "\n    </image:image>"
        : "";
      return `  <url>
    <loc>${escapeXml(entry.loc)}</loc>
    <lastmod>${escapeXml(entry.lastmod)}</lastmod>${changefreqLine}${priorityLine}${imageLines}
  </url>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${body}
</urlset>`;
}

export function renderSitemapIndexXml(files: SitemapFile[]): string {
  const body = files
    .map(
      (file) => `  <sitemap>
    <loc>${escapeXml(file.url)}</loc>
    <lastmod>${escapeXml(file.lastmod)}</lastmod>
  </sitemap>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</sitemapindex>`;
}
