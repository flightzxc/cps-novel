/**
 * C-29 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-29):
 * public blog queries — the blog-side counterpart to `./queries.ts`,
 * "落在公开查询模块里，与既有的小说查询并列" (a parallel module, not a
 * branch grafted into the Novel-shaped one — `queries.ts`'s own
 * `ListedArticleWithNovel`/`toPublicArticle` etc. are all Novel-shaped and
 * a blog Article structurally cannot fill them, see that file's C-27
 * comments). Reuses `PUBLIC_LIST_CAP` from `./queries.ts` rather than a
 * second cap constant — same collection-size discipline, one source.
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

import { PUBLIC_LIST_CAP, BROWSE_PAGE_SIZE } from "./queries";

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
 * `Article.seoMetadata`'s blog-only keys (`coverUrl`/`metaTitle`/
 * `metaDescription`/`metaKeywords`) — same free-form JSON shape
 * `src/server/content-creation/blog.ts`'s `createBlogArticle` writes and
 * `src/app/(admin)/articles/_components/article-blog-editor.tsx` reads,
 * copied here rather than imported because both of those live under admin
 * write-side directories this round's boundary keeps separate from the
 * public read side (same reasoning `queries.ts`'s own mappers stay
 * self-contained). Blank/missing keys normalize to `undefined`, never an
 * empty string, matching this codebase's "optional means omitted, not
 * blank" convention (`MetaList`'s own doc comment).
 */
function parseBlogSeoMetadata(value: unknown): {
  coverUrl?: string;
  metaTitle?: string;
  metaDescription?: string;
  metaKeywords?: string;
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
    metaKeywords: pick("metaKeywords"),
  };
}

export type BlogDetailView = BlogCardView & {
  body: string;
  updatedAt: Date;
  coverUrl?: string;
  metaTitle?: string;
  metaDescription?: string;
  metaKeywords?: string;
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

/**
 * Full capped candidate set for one locale, newest first — same
 * "load-all-then-paginate-in-memory" shape `queries.ts`'s
 * `listPublicArticles`/`category-queries.ts`'s `getPublicCategoryPage` both
 * use (`PUBLIC_LIST_CAP`'s own doc comment: accepted V1 limitation, not
 * fixed here).
 */
export async function listPublicBlogArticles(
  db: PrismaClient | Prisma.TransactionClient,
  locale: SiteLocale,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BlogCardView[]> {
  const rows = await db.article.findMany({
    where: buildPublicListBlogArticleWhere({ locale }, env),
    orderBy: [{ publishedAt: "desc" }, { id: "asc" }],
    take: PUBLIC_LIST_CAP,
    select: BLOG_CARD_SELECT,
  });
  return rows.map(toBlogCardView);
}

export type BlogListPageResult = {
  posts: BlogCardView[];
  page: number;
  totalPages: number;
  totalCount: number;
};

/** Same in-memory slicing shape as `queries.ts`'s `paginateCards`, kept as its own function rather than genericizing that one — this round's file-boundary discipline (§C-29) keeps the blog family additive-only, never editing `queries.ts`'s existing exports. */
export function paginateBlogCards(cards: BlogCardView[], page: number): BlogListPageResult {
  const totalCount = cards.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / BROWSE_PAGE_SIZE) || 1);
  const currentPage = Number.isInteger(page) && page > 0 ? page : 1;
  const start = (currentPage - 1) * BROWSE_PAGE_SIZE;
  return {
    posts: cards.slice(start, start + BROWSE_PAGE_SIZE),
    page: currentPage,
    totalPages: totalCount === 0 ? 1 : totalPages,
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
