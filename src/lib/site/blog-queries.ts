/**
 * C-29 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-29):
 * public blog queries — the blog-side counterpart to `./queries.ts`,
 * "落在公开查询模块里，与既有的小说查询并列" (a parallel module, not a
 * branch grafted into the Novel-shaped one — `queries.ts`'s own
 * `ListedArticleWithNovel`/`toPublicArticle` etc. are all Novel-shaped and
 * a blog Article structurally cannot fill them, see that file's C-27
 * comments). B-38 (v0.5.13): the list is database-paginated (`skip`/`take` +
 * `count`, CPS `blog-queries` shape) with no cap — every published post is
 * reachable and the total is the real total.
 *
 * `access.ts`'s `checkBlogArticlePublicAccess` (C-29) answers "is this
 * (locale, slug) reachable, and as what" — this module answers "load the
 * data to render it" once that access check already said `published`. Same
 * two-step split `queries.ts` uses for the Novel side
 * (`resolvePublicArticleBySlugParam` + `getPublicNovelDetail`).
 */
import type { Prisma, PrismaClient } from "@prisma/client";

import { asSiteLocale, PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { buildBlogPath } from "@/lib/slug/article-path";
import { buildPrimaryArticleWhere, buildPublicListBlogArticleWhere } from "@/server/publication/visibility";

import { BROWSE_PAGE_SIZE } from "./queries";

const BLOG_CARD_SELECT = {
  id: true,
  title: true,
  slug: true,
  locale: true,
  summary: true,
  publishedAt: true,
  updatedAt: true,
} as const satisfies Prisma.ArticleSelect;

const BLOG_DETAIL_SELECT = {
  ...BLOG_CARD_SELECT,
  body: true,
  seoMetadata: true,
} as const satisfies Prisma.ArticleSelect;

type BlogCardRow = Prisma.ArticleGetPayload<{ select: typeof BLOG_CARD_SELECT }>;
type BlogDetailRow = Prisma.ArticleGetPayload<{ select: typeof BLOG_DETAIL_SELECT }>;

export type BlogCardView = {
  id: string;
  title: string;
  slug: string;
  summary?: string;
  /** Falls back to `updatedAt` in the (should-never-happen) case a published row has no `publishedAt` — same defensive posture as `queries.ts`'s own nullable-`publishedAt` handling. */
  publishedAt: Date;
  href: string;
};

/**
 * `Article.seoMetadata`'s blog-only keys consumed by the public read side:
 * `coverUrl`/`metaTitle`/`metaDescription` — same free-form JSON shape
 * `src/server/content-creation/blog.ts`'s `createBlogArticle` writes and
 * `src/app/(admin)/articles/_components/article-blog-editor.tsx` reads,
 * copied here rather than imported because both of those live under admin
 * write-side directories this round's boundary keeps separate from the
 * public read side (same reasoning `queries.ts`'s own mappers stay
 * self-contained). Blank/missing keys normalize to `undefined`, never an
 * empty string, matching this codebase's "optional means omitted, not
 * blank" convention (`MetaList`'s own doc comment).
 *
 * C-29b review low: `metaKeywords` is a fourth key the admin editor writes,
 * but no public render path ever reads it — `src/app/blog/[slug]/page.tsx`'s
 * `generateMetadata` only consumes `metaTitle`/`metaDescription`/`coverUrl`,
 * and `src/lib/seo/seo-templates/blog.ts`'s `buildBlogSeoMeta`/`BlogSeoData`
 * has no `keywords` field at all — verified against CPS's own blog SEO
 * (`cps-admin-v851-admin-host/src/lib/blog-seo.ts` and its
 * `[locale]/(site)/blog/[slug]/page.tsx`'s `generateMetadata`): CPS's blog
 * detail page never emits a `keywords` meta tag either (unlike its Drama
 * detail page, which does — a different page family, not a precedent this
 * one follows). Parsing and carrying a value nothing ever renders was dead
 * code; dropped rather than wired to a `keywords` field CPS's own blog SEO
 * does not have.
 */
function parseBlogSeoMetadata(value: unknown): {
  coverUrl?: string;
  metaTitle?: string;
  metaDescription?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const pick = (key: string): string | undefined => {
    const raw = record[key];
    if (typeof raw !== "string") return undefined;
    const trimmed = raw.trim();
    return trimmed ? trimmed : undefined;
  };
  return {
    coverUrl: pick("coverUrl"),
    metaTitle: pick("metaTitle"),
    metaDescription: pick("metaDescription"),
  };
}

export type BlogDetailView = BlogCardView & {
  body: string;
  updatedAt: Date;
  coverUrl?: string;
  metaTitle?: string;
  metaDescription?: string;
};

function hrefFor(row: Pick<BlogCardRow, "locale" | "slug">): string {
  const locale: SiteLocale = asSiteLocale(row.locale) ?? PUBLIC_SITE_LOCALE;
  return buildBlogPath({ locale, slug: row.slug });
}

function toBlogCardView(row: BlogCardRow): BlogCardView {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    summary: row.summary ?? undefined,
    publishedAt: row.publishedAt ?? row.updatedAt,
    href: hrefFor(row),
  };
}

function toBlogDetailView(row: BlogDetailRow): BlogDetailView {
  const meta = parseBlogSeoMetadata(row.seoMetadata);
  return {
    ...toBlogCardView(row),
    body: row.body,
    updatedAt: row.updatedAt,
    ...meta,
  };
}

export type BlogListPageResult = {
  posts: BlogCardView[];
  page: number;
  totalPages: number;
  totalCount: number;
};

/**
 * One page of the public blog list, newest first (`publishedAt` desc, `id` asc), with the real total —
 * database `skip`/`take` plus a `count` over the same `where` (`buildPublicListBlogArticleWhere`: excludes
 * `hidden` and `seo_only`). No cap: every published post is reachable. Same page semantics as the novel list
 * (`public-list.ts`'s `listPublicNovelPage`): an invalid page number reads as page 1, a page past the end
 * returns no posts with the real `totalPages` (the page 404s on that), and zero posts forces `totalPages` to 1.
 */
export async function listPublicBlogArticles(
  db: PrismaClient | Prisma.TransactionClient,
  locale: SiteLocale,
  page: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BlogListPageResult> {
  const where = buildPublicListBlogArticleWhere({ locale }, env);
  const currentPage = Number.isInteger(page) && page > 0 ? page : 1;
  const skip = (currentPage - 1) * BROWSE_PAGE_SIZE;
  const [rows, totalCount] = await Promise.all([
    // A page number so large that `skip` is no longer a safe integer is simply past the end.
    Number.isSafeInteger(skip)
      ? db.article.findMany({
          where,
          orderBy: [{ publishedAt: "desc" }, { id: "asc" }],
          skip,
          take: BROWSE_PAGE_SIZE,
          select: BLOG_CARD_SELECT,
        })
      : Promise.resolve([] as BlogCardRow[]),
    db.article.count({ where }),
  ]);
  return {
    posts: rows.map(toBlogCardView),
    page: currentPage,
    totalPages: totalCount === 0 ? 1 : Math.max(1, Math.ceil(totalCount / BROWSE_PAGE_SIZE)),
    totalCount,
  };
}

/**
 * Loads the render-ready detail for a `published` blog Article whose
 * accessibility was already confirmed by `access.ts`'s
 * `checkBlogArticlePublicAccess`. Deliberately re-scoped to
 * `articleType: "blog_article"` (not merely `id`) as defense-in-depth
 * against a stale/forged id reaching this function directly — the same
 * belt-and-suspenders posture `queries.ts`'s `getPublicNovelDetail` applies
 * with its own `row.novel === null` re-check.
 */
export async function getPublicBlogDetail(
  db: PrismaClient | Prisma.TransactionClient,
  articleId: string,
): Promise<BlogDetailView | null> {
  const row = await db.article.findFirst({
    where: buildPrimaryArticleWhere({ id: articleId, articleType: "blog_article" }),
    select: BLOG_DETAIL_SELECT,
  });
  if (!row) return null;
  return toBlogDetailView(row);
}
