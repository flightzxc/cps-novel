import {
  SITE_LOCALES,
  type SiteLocale,
} from "@/lib/locale/locale-canonical";
import type { Prisma, PrismaClient } from "@prisma/client";

import { BLOG_FAMILY_ARTICLE_TYPES } from "@/domain/database-statuses";
import { isArticleBlogEnabled } from "@/lib/flags";
import { getSiteUrl, toAbsoluteUrl } from "@/lib/seo/site-url";
import { buildArticlePath, buildBlogPath } from "@/lib/slug/article-path";
import {
  buildPublicArticleWhere,
  buildPublicBlogArticleWhere,
  isHiddenFromPublicView,
  isPromoReady,
  isPublicationStatePublic,
} from "@/server/publication/visibility";
import { getSiteSetting } from "@/server/site-settings/service";
import {
  listDistinctPublicTaxonomy,
  loadPublicTaxonomyByNovelIds,
} from "@/lib/site/public-taxonomy";
import { BROWSE_PAGE_SIZE } from "@/lib/site/queries";

/**
 * C-29 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-29):
 * `blogpage` is the fourth sitemap family — the blog-family counterpart to
 * `novelpage`. File-name pattern (`getSitemapFileName`/
 * `parseSitemapFileName` below) and family dispatch
 * (`createSitemapFamilyBuilder`) both had to change in lockstep — the plan's
 * own risk note for this exact spot: "sitemap 文件名正则改漏一处（解析、
 * 分发、生成三处），表现是 sitemap 索引里有博客家族但请求那个文件返回
 * 404，或者反过来。三处必须同改并有测试。" `tests/backend/seo/
 * sitemap-blog.test.ts` covers all three.
 */
export const SITEMAP_TYPES = ["mainpage", "novelpage", "categorypage", "blogpage"] as const;
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
  seoVisibility: true,
  deletedAt: true,
  updatedAt: true,
  novel: {
    select: {
      id: true,
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

/**
 * C-27: `Article.novel` is nullable as of this round (blog articles have
 * none). Novel/category sitemap families are specifically Novel-page
 * families — a row with no Novel is out of scope for both, the same way
 * `isVisibleCandidate` below already excludes it. Narrowing here (a type
 * predicate `isVisibleCandidate` filters into) lets `buildNovelPageFiles`/
 * `buildCategoryPageFiles` keep reading `candidate.novel.*` without a `!`
 * assertion — blog sitemap coverage is C-29's job, on its own family.
 */
type ArticleSitemapCandidateWithNovel = ArticleSitemapCandidate & {
  novel: NonNullable<ArticleSitemapCandidate["novel"]>;
};

/**
 * L10N P4: extracted from this file's own former private `articleSitemapWhere`
 * so `src/lib/locale/active-locales.ts` can build its `groupBy` `where` from
 * the exact same collectability fragment instead of hand-rolling a second one
 * (the construction prompt's explicit ban on "另造... 第二份可见性 where").
 * `locale` accepts either one `SiteLocale` (sitemap's per-locale query) or an
 * `{ in: [...] }` filter (active-locales' single cross-locale query) — same
 * `Prisma.ArticleWhereInput["locale"]` field, two different narrowing shapes.
 *
 * C-25: `buildPublicArticleWhere` is the "collectability" fragment —
 * excludes `hidden`, keeps `seo_only` (sitemap/active-locales are both
 * exactly a collectability boundary, same as IndexNow). This DB-side
 * condition is a pre-filter only; `isVisibleCandidate` below re-checks it per
 * row for sitemap generation, per this file's own "DB filter is a superset,
 * application layer is authoritative" discipline. `active-locales.ts` does
 * not have per-row rows to recheck (it only reads a `groupBy` locale
 * breakdown) — see that module's own header for why the coarser superset is
 * an accepted, bounded approximation there.
 */
export function activePublicArticleWhere(
  locale: Prisma.ArticleWhereInput["locale"],
  env: NodeJS.ProcessEnv,
): Prisma.ArticleWhereInput {
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
  }, env);
}

function articleSitemapWhere(locale: SiteLocale, env: NodeJS.ProcessEnv): Prisma.ArticleWhereInput {
  return activePublicArticleWhere(locale, env);
}

function isVisibleCandidate(
  candidate: ArticleSitemapCandidate,
  env: NodeJS.ProcessEnv,
): candidate is ArticleSitemapCandidateWithNovel {
  // C-27: no Novel means this cannot be a novel-page sitemap candidate,
  // full stop — see `ArticleSitemapCandidateWithNovel`'s doc comment.
  if (candidate.novel === null) return false;
  return candidate.deletedAt === null
    && candidate.novel.deletedAt === null
    && candidate.promoLink?.deletedAt === null
    && isPublicationStatePublic(candidate.novel, candidate)
    && isPromoReady(candidate.promoLink)
    // C-25: application-layer recheck for `hidden` — the DB `where` above is
    // only a pre-filter (never authoritative alone, per this file's header
    // convention), so a `hidden` row must also be caught here.
    && !isHiddenFromPublicView(candidate, env);
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
  candidates: readonly ArticleSitemapCandidateWithNovel[],
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

async function buildCategoryPageFiles(
  db: SitemapDb,
  locale: SiteLocale,
  candidates: readonly ArticleSitemapCandidateWithNovel[],
): Promise<SitemapFile[]> {
  const tagsByNovel = await loadPublicTaxonomyByNovelIds(
    db,
    candidates.map((candidate) => candidate.novel.id),
    locale,
  );
  const categories = listDistinctPublicTaxonomy(tagsByNovel);
  if (categories.length === 0) return [];

  const entries: SitemapEntry[] = [];
  for (const category of categories) {
    const matching = candidates.filter((candidate) =>
      (tagsByNovel.get(candidate.novel.id) ?? []).some((tag) => tag.id === category.id));
    if (matching.length === 0) continue;
    const lastmod = latestDate([
      category.updatedAt,
      ...matching.map((candidate) => candidate.updatedAt),
    ]).toISOString();
    const pageCount = Math.max(1, Math.ceil(matching.length / BROWSE_PAGE_SIZE));
    for (let page = 1; page <= pageCount; page += 1) {
      const path = page === 1
        ? `/category/${category.slug}`
        : `/category/${category.slug}?page=${page}`;
      entries.push({
        loc: toAbsoluteUrl(path),
        lastmod,
        changefreq: "weekly",
        priority: page === 1 ? 0.7 : 0.5,
      });
    }
  }

  return chunks(entries, SITEMAP_SHARD_SIZE).map((shardEntries, index) => {
    const name = getSitemapFileName("categorypage", locale, index);
    return {
      name,
      url: toAbsoluteUrl(`/sitemap/${name}`),
      lastmod: latestDate(shardEntries.map((entry) => new Date(entry.lastmod))).toISOString(),
      entries: shardEntries,
    };
  });
}

// ---------------------------------------------------------------------------
// C-29 blog family. Separate SELECT/candidate-type/where/filter/builder set
// from the Novel-page family above — a blog Article structurally cannot
// satisfy `ArticleSitemapCandidateWithNovel` (no Novel, no PromoLink), same
// reasoning `access.ts`'s `checkBlogArticlePublicAccess` documents for why
// it is a parallel function rather than a branch inside the Novel one.
// ---------------------------------------------------------------------------

const BLOG_ARTICLE_SITEMAP_SELECT = {
  id: true,
  locale: true,
  slug: true,
  title: true,
  status: true,
  articleType: true,
  seoVisibility: true,
  deletedAt: true,
  updatedAt: true,
} as const satisfies Prisma.ArticleSelect;

type BlogArticleSitemapCandidate = Prisma.ArticleGetPayload<{
  select: typeof BLOG_ARTICLE_SITEMAP_SELECT;
}>;

function blogArticleSitemapWhere(locale: SiteLocale, env: NodeJS.ProcessEnv): Prisma.ArticleWhereInput {
  // C-25: same "collectability" fragment discipline as `articleSitemapWhere`
  // above (excludes `hidden`, keeps `seo_only`) — just the blog-family
  // record shape (`PUBLIC_BLOG_ARTICLE_RECORD`) instead of the Novel one.
  return buildPublicBlogArticleWhere({ locale }, env);
}

function isVisibleBlogCandidate(
  candidate: BlogArticleSitemapCandidate,
  env: NodeJS.ProcessEnv,
): boolean {
  return candidate.deletedAt === null
    && candidate.status === "published"
    && (BLOG_FAMILY_ARTICLE_TYPES as readonly string[]).includes(candidate.articleType)
    // C-25: application-layer recheck for `hidden`, same "DB filter is a
    // superset, application layer is authoritative" discipline as
    // `isVisibleCandidate` above.
    && !isHiddenFromPublicView(candidate, env);
}

function buildBlogPageFiles(
  locale: SiteLocale,
  candidates: readonly BlogArticleSitemapCandidate[],
): SitemapFile[] {
  const entries = candidates.map((candidate): SitemapEntry => ({
    loc: toAbsoluteUrl(buildBlogPath({ locale, slug: candidate.slug })),
    lastmod: candidate.updatedAt.toISOString(),
    changefreq: "weekly",
    priority: 0.6,
    // No `imageUrl`/`imageTitle` — a blog Article's optional cover (C-28's
    // `seoMetadata.coverUrl`) is not selected here; `renderUrlSetXml` only
    // emits the `<image:image>` block when `imageUrl` is present, so this
    // is simply "no image", not a gap versus the Novel family above.
  }));

  return chunks(entries, SITEMAP_SHARD_SIZE).map((shardEntries, index) => {
    const name = getSitemapFileName("blogpage", locale, index);
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
 *
 * `env` (C-25, default `process.env`) threads `FEATURE_ARTICLE_SEO_VISIBILITY`
 * down to both the DB pre-filter and the per-row recheck — an explicit
 * override lets tests exercise the flag-on path without mutating global
 * `process.env`.
 */
export function createSitemapFamilyBuilder(
  db: SitemapDb,
  env: NodeJS.ProcessEnv = process.env,
): BuildSitemapFamily {
  const candidateCacheByRoute = new Map<SiteLocale, Promise<ArticleSitemapCandidateWithNovel[]>>();
  const loadVisible = (locale: SiteLocale) => {
    const existing = candidateCacheByRoute.get(locale);
    if (existing) return existing;
    const pending = db.article.findMany({
      where: articleSitemapWhere(locale, env),
      select: ARTICLE_SITEMAP_SELECT,
      orderBy: { id: "asc" },
    }).then((rows) => rows.filter((row) => isVisibleCandidate(row, env)));
    candidateCacheByRoute.set(locale, pending);
    return pending;
  };

  // C-29: separate cache from the Novel-page one above — different SELECT
  // shape, different candidate type, never shares a Map key/value shape
  // with `candidateCacheByRoute`.
  const blogCandidateCacheByRoute = new Map<SiteLocale, Promise<BlogArticleSitemapCandidate[]>>();
  const loadVisibleBlog = (locale: SiteLocale) => {
    const existing = blogCandidateCacheByRoute.get(locale);
    if (existing) return existing;
    const pending = db.article.findMany({
      where: blogArticleSitemapWhere(locale, env),
      select: BLOG_ARTICLE_SITEMAP_SELECT,
      orderBy: { id: "asc" },
    }).then((rows) => rows.filter((row) => isVisibleBlogCandidate(row, env)));
    blogCandidateCacheByRoute.set(locale, pending);
    return pending;
  };

  return async ({ type, locale }) => {
    if (type === "blogpage") {
      // C-29 "开关": `FEATURE_ARTICLE_BLOG` off -> the blog family emits
      // zero files (not merely zero URLs inside one empty file) — matching
      // the plan's "关闭时 ... sitemap 不生成博客家族" and keeping the
      // sitemap in lockstep with `access.ts`'s `checkBlogArticlePublicAccess`
      // (which also fails closed on this same flag before querying), so a
      // `/blog/{slug}` URL is never listed in a sitemap while the route
      // that URL points at would itself 404.
      if (!isArticleBlogEnabled(env)) return [];
      const blogCandidates = await loadVisibleBlog(locale);
      return buildBlogPageFiles(locale, blogCandidates);
    }

    const candidates = await loadVisible(locale);
    if (type === "novelpage") return buildNovelPageFiles(locale, candidates);
    if (type === "categorypage") return buildCategoryPageFiles(db, locale, candidates);

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
  const match = /^site_(mainpage|novelpage|categorypage|blogpage)_([a-zA-Z-]+)(?:_(\d+))?\.xml$/.exec(fileName);
  if (!match) return null;

  const locale = match[2];
  if (!(SITE_LOCALES as readonly string[]).includes(locale)) return null;

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
