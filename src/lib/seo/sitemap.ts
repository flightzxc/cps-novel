import {
  listPublishableLocales,
  type SiteLocale,
} from "@/lib/locale/locale-canonical";
import type { Prisma, PrismaClient } from "@prisma/client";

import { getSiteUrl, toAbsoluteUrl } from "@/lib/seo/site-url";
import { buildArticlePath } from "@/lib/slug/article-path";
import {
  buildPublicArticleWhere,
  isPromoReady,
  isPublicationStatePublic,
} from "@/server/publication/visibility";
import { getSiteSetting } from "@/server/site-settings/service";

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

export const SITEMAP_SHARD_SIZE = 10_000;

type SitemapDb = PrismaClient | Prisma.TransactionClient;

const ARTICLE_SITEMAP_SELECT = {
  id: true,
  locale: true,
  slug: true,
  publicPageShortId: true,
  title: true,
  status: true,
  deletedAt: true,
  updatedAt: true,
  novel: {
    select: {
      status: true,
      deletedAt: true,
      coverUrl: true,
    },
  },
  promoLink: {
    select: {
      status: true,
      webUrl: true,
      appUrl: true,
      deletedAt: true,
    },
  },
} as const satisfies Prisma.ArticleSelect;

type ArticleSitemapCandidate = Prisma.ArticleGetPayload<{
  select: typeof ARTICLE_SITEMAP_SELECT;
}>;

function articleSitemapWhere(locale: SiteLocale): Prisma.ArticleWhereInput {
  return buildPublicArticleWhere({
    locale,
    promoLink: {
      is: {
        deletedAt: null,
        // Index-friendly SUPERSET only. isPromoReady below remains authoritative
        // and excludes whitespace-only URLs after trimming.
        OR: [{ webUrl: { not: "" } }, { appUrl: { not: "" } }],
      },
    },
  });
}

function isVisibleCandidate(candidate: ArticleSitemapCandidate): boolean {
  return candidate.deletedAt === null
    && candidate.novel.deletedAt === null
    && candidate.promoLink?.deletedAt === null
    && isPublicationStatePublic(candidate.novel, candidate)
    && isPromoReady(candidate.promoLink);
}

function latestDate(dates: readonly Date[]): Date {
  if (dates.length === 0) throw new Error("Cannot calculate sitemap lastmod from an empty set");
  let latest = dates[0]!.valueOf();
  for (let index = 1; index < dates.length; index += 1) {
    latest = Math.max(latest, dates[index]!.valueOf());
  }
  return new Date(latest);
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function buildNovelPageFiles(
  locale: SiteLocale,
  candidates: readonly ArticleSitemapCandidate[],
): SitemapFile[] {
  const entries = candidates.map((candidate): SitemapEntry => ({
    loc: toAbsoluteUrl(buildArticlePath({
      locale,
      slug: candidate.slug,
      shortId: candidate.publicPageShortId,
    })),
    lastmod: candidate.updatedAt.toISOString(),
    changefreq: "weekly",
    priority: 0.9,
    imageUrl: candidate.novel.coverUrl ?? undefined,
    imageTitle: candidate.title,
  }));

  return chunks(entries, SITEMAP_SHARD_SIZE).map((shardEntries, index) => {
    const name = getSitemapFileName("novelpage", locale, index);
    return {
      name,
      url: toAbsoluteUrl(`/sitemap/${name}`),
      lastmod: latestDate(shardEntries.map((entry) => new Date(entry.lastmod))).toISOString(),
      entries: shardEntries,
    };
  });
}

/**
 * Production DB builder injected into the PR1 filesystem generator. Database
 * reads happen only in the refresh worker; request routes remain static-only.
 */
export function createSitemapFamilyBuilder(db: SitemapDb): BuildSitemapFamily {
  const visibleByLocale = new Map<SiteLocale, Promise<ArticleSitemapCandidate[]>>();
  const loadVisible = (locale: SiteLocale) => {
    const existing = visibleByLocale.get(locale);
    if (existing) return existing;
    const pending = db.article.findMany({
      where: articleSitemapWhere(locale),
      select: ARTICLE_SITEMAP_SELECT,
      orderBy: { id: "asc" },
    }).then((rows) => rows.filter(isVisibleCandidate));
    visibleByLocale.set(locale, pending);
    return pending;
  };

  return async ({ type, locale }) => {
    const candidates = await loadVisible(locale);
    if (type === "novelpage") return buildNovelPageFiles(locale, candidates);

    const settings = await getSiteSetting(db, { ttlMs: 0 });
    const lastmod = latestDate([
      settings.updatedAt,
      ...candidates.map((candidate) => candidate.updatedAt),
    ]).toISOString();
    const name = getSitemapFileName("mainpage", locale, 0);
    return [{
      name,
      url: toAbsoluteUrl(`/sitemap/${name}`),
      lastmod,
      entries: [{
        loc: locale === "en" ? getSiteUrl() : toAbsoluteUrl(`/${locale}`),
        lastmod,
        changefreq: "daily",
        priority: 1,
      }],
    }];
  };
}

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
