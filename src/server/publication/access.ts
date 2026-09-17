/**
 * Public access-check entry point (v0.2.0 foundation, Stream F). Adapted
 * from CPS `src/proxy.ts`'s `checkDramaSlugAccess` (~70-line slice), which
 * this project's `src/lib/redirect/README.md` boundary rule keeps separate
 * from promo redirect codes: this module answers "should the public Article
 * route render, and as what" — not "what does /go/{code} resolve to".
 *
 * Two structural differences from the CPS original, both deliberate:
 *
 * 1. CPS returns a `NextResponse | null` because it runs inside a global
 *    proxy/middleware. cps-novel has no such middleware wired for public
 *    Article routes yet (Stream B/public-ui owns building the real
 *    `/[locale]/novel/[slug]` route). Returning a small discriminated result
 *    instead keeps this function framework-agnostic — a future proxy layer
 *    or a page Server Component can both act on it without depending on
 *    `next/server`.
 * 2. CPS's `checkDramaSlugAccess` never read `promoUrl` at all — not a
 *    drift, that invariant was simply never implemented at this boundary
 *    (`P2-07-12-移植审计-2026-08-12/DECISION-CHECK.md` 核查3). This function
 *    re-verifies promo readiness via `isPubliclyAccessible`, an Owner-
 *    approved net-new invariant for this project — see
 *    docs/p2/V020_FOUNDATION_INTERFACES.md.
 *
 * Slug-alias resolution (CPS's `findSlugAlias` step, for 301/308 redirects
 * after a title/slug change) is out of scope here — cps-novel has no
 * slug-alias table yet. That remains `src/lib/slug/`'s concern; once it
 * exists, its caller resolves an alias to a canonical slug first and then
 * calls this function, exactly as CPS layers it.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

import { isArticleBlogEnabled } from "@/lib/flags";

import {
  buildPrimaryArticleWhere,
  isHiddenFromPublicView,
  isNoIndexRemovalState,
  isPublicationStatePublic,
  isPubliclyAccessible,
  isRightsBlocked,
} from "./visibility";

export type NovelArticleAccessResult =
  | { readonly kind: "published"; readonly articleId: string; readonly novelId: string }
  /** Stable noindex removal page — route to the `unavailable` screen (HTTP 200, noindex), not a 404. */
  | { readonly kind: "unavailable" }
  /** Rights/safety removal — route to the `takedown` screen and respond HTTP 410 Gone. */
  | { readonly kind: "takedown" }
  /** No stable URL was ever public here — respond plain HTTP 404. */
  | { readonly kind: "not_found" };

export type NovelArticleAccessInput = {
  readonly locale: string;
  readonly slug: string;
};

/**
 * Looks up the Article by (locale, slug) — matching the migration-only
 * partial unique index `article(locale, slug) WHERE deleted_at IS NULL`
 * (docs/governance/database-governance.md §5 item 5) — and classifies public
 * accessibility. Precedence (most severe/earliest-checked first): a
 * null-novel (non-`novel_article`) Article resolves as a plain 404 before
 * any of the steps below even run (C-27 — this function is Novel-article
 * ONLY, permanently, not merely "until C-29"; see the inline comment at
 * that check) — a blog/listicle/guide Article's real public path is
 * `checkBlogArticlePublicAccess` below (C-29), a deliberately separate
 * function rather than a branch grafted into this one, because this
 * function's own result type (`NovelArticleAccessResult`) is
 * Novel-shaped (`novelId: string`, non-null) and every caller of THIS
 * function (`/novel/[slugParam]`) already depends on that non-null
 * guarantee; then, for a `novel_article`, rights-blocked always wins; then
 * `seoVisibility: "hidden"` (C-25 — a plain 404, checked before public
 * access so a hidden-but-otherwise-published Article never renders); then
 * full public access; then the stable noindex removal state (either side
 * literally `unpublished`, or both sides `published` but the promo link
 * degraded after the publish-time gate passed); everything else
 * (draft/ready, or simply no matching row) is a plain 404.
 */
export async function checkNovelArticlePublicAccess(
  db: PrismaClient | Prisma.TransactionClient,
  input: NovelArticleAccessInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NovelArticleAccessResult> {
  const article = await db.article.findFirst({
    where: buildPrimaryArticleWhere({ locale: input.locale, slug: input.slug }),
    select: {
      id: true,
      novelId: true,
      status: true,
      seoVisibility: true,
      novel: { select: { status: true } },
      promoLink: { select: { status: true, webUrl: true, appUrl: true } },
    },
  });
  if (!article) return { kind: "not_found" };

  // C-27/C-29: `Article.novel` is nullable as of C-27 (blog/listicle/guide
  // articles have no Novel). THIS function stays Novel-article-only
  // permanently — a blog Article's real public path is
  // `checkBlogArticlePublicAccess` below (C-29), not a branch here, per
  // this function's own doc comment above. A non-novel Article therefore
  // resolves as a plain 404 here — the same final outcome every downstream
  // branch below would produce for it anyway
  // (it cannot be rights-blocked via a Novel it does not have, and
  // `isPubliclyAccessible`/`isNoIndexRemovalState`/`isPublicationStatePublic`
  // all require a real `NovelPublicationState`), just resolved before
  // needing one. Every existing row today is `novel_article` with a Novel,
  // so this is a no-op for all of them. Checked on both `novelId` and
  // `novel` (always in sync per the `article_novel_id_by_type_check` CHECK)
  // so both are narrowed non-null below — `novelId` feeds the "published"
  // result, `novel` feeds the rights/visibility predicates.
  if (article.novelId === null || article.novel === null) return { kind: "not_found" };

  const novelState = article.novel;
  const articleState = { status: article.status };

  if (isRightsBlocked(novelState, articleState)) {
    return { kind: "takedown" };
  }
  // C-25: hidden is a pure 404 — deliberately checked before
  // `isPubliclyAccessible` so a published, promo-ready Article that has been
  // marked `hidden` still 404s instead of rendering. See `visibility.ts`'s
  // `isHiddenFromPublicView` doc comment for why this is not "noindex".
  if (isHiddenFromPublicView(article, env)) {
    return { kind: "not_found" };
  }
  if (isPubliclyAccessible(novelState, articleState, article.promoLink)) {
    return { kind: "published", articleId: article.id, novelId: article.novelId };
  }
  if (isNoIndexRemovalState(novelState, articleState)) {
    return { kind: "unavailable" };
  }
  if (isPublicationStatePublic(novelState, articleState)) {
    // Both sides published but the promo link degraded after the
    // publish-time gate passed (see isPubliclyAccessible's doc comment).
    // Real content exists; a plain 404 would be wrong.
    return { kind: "unavailable" };
  }
  return { kind: "not_found" };
}

// ---------------------------------------------------------------------------
// C-29 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-29):
// blog's own public access-check, parallel to `checkNovelArticlePublicAccess`
// above rather than a branch inside it (see that function's own doc comment
// for why). Structurally much simpler: a blog Article has no Novel and no
// PromoLink at all, so there is no rights-cascade-from-Novel step and no
// promo-readiness re-check — public accessibility for a blog Article is
// exactly `status === "published"` (plus not `hidden`), matching this
// round's plan text verbatim: "软删为空 + 状态已发布 + 类型属于博客系列 +
// 可见性不为 hidden".
// ---------------------------------------------------------------------------

export type BlogArticleAccessResult =
  | { readonly kind: "published"; readonly articleId: string; readonly title: string }
  /** Stable noindex removal page — same HTTP/UX contract as the Novel-article branch above (200, noindex). */
  | { readonly kind: "unavailable"; readonly title: string }
  /** Rights/safety removal — an Owner/ops takedown action on a blog post is exactly as real as on a novel_article (see `publish-gate/evaluator.ts`'s own comment on this). */
  | { readonly kind: "takedown"; readonly title: string }
  /** No stable URL was ever public here (includes: `FEATURE_ARTICLE_BLOG` off, no matching row, a `novel_article`/listicle/guide row, or draft). */
  | { readonly kind: "not_found" };

export type BlogArticleAccessInput = {
  readonly locale: string;
  readonly slug: string;
};

/**
 * Looks up the Article by (locale, slug) — same primary where-fragment and
 * partial unique index as `checkNovelArticlePublicAccess` above (the two
 * article "families" share one slug namespace, see
 * `docs/governance/database-governance.md` §5 item 5) — but only ever
 * resolves a `blog_article` row. A `novel_article` row (or a `listicle`/
 * `guide` row — registered for CPS-enum parity per C-26 but with no public
 * route of their own yet, "不建任何入口、不建任何专属渲染") both fall
 * through to the same plain 404 as "no matching row at all".
 *
 * `FEATURE_ARTICLE_BLOG` is checked FIRST, before even querying — the same
 * fail-closed-before-the-query posture `createBlogArticle`
 * (`src/server/content-creation/blog.ts`) uses for the write side. Per the
 * plan's C-29 "开关" section: "关闭时 /blog 两条路由返回 404".
 */
export async function checkBlogArticlePublicAccess(
  db: PrismaClient | Prisma.TransactionClient,
  input: BlogArticleAccessInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BlogArticleAccessResult> {
  if (!isArticleBlogEnabled(env)) return { kind: "not_found" };

  const article = await db.article.findFirst({
    where: buildPrimaryArticleWhere({ locale: input.locale, slug: input.slug }),
    select: { id: true, title: true, articleType: true, status: true, seoVisibility: true },
  });
  if (!article || article.articleType !== "blog_article") return { kind: "not_found" };

  // Rights-blocked always wins, same precedence as the Novel-article branch
  // above (checked before `hidden`, before publication state). C-29b:
  // routed through `visibility.ts`'s `isRightsBlocked` (with a `null`
  // Novel — a blog Article has none, C-27) instead of an inline
  // `article.status === "takedown"` comparison, same predicate the
  // Novel-article branch above already calls — this file's own header
  // discipline ("Do not add a fifth ad hoc visibility check anywhere else
  // in the codebase — extend this module instead") applied to this
  // function too. Behavior unchanged: `isRightsBlocked(null, article)` is
  // exactly `article.status === "takedown"`.
  if (isRightsBlocked(null, article)) return { kind: "takedown", title: article.title };
  // C-25: hidden is a pure 404 — see `checkNovelArticlePublicAccess`'s
  // identical check above for why this is not "noindex". Already routed
  // through `visibility.ts`'s `isHiddenFromPublicView`, unchanged by C-29b.
  if (isHiddenFromPublicView(article, env)) return { kind: "not_found" };
  if (article.status === "published") return { kind: "published", articleId: article.id, title: article.title };
  if (article.status === "unpublished") return { kind: "unavailable", title: article.title };
  // `draft` (the only remaining ARTICLE_STATUSES value) — a blog Article's
  // create-time status (`src/server/content-creation/blog.ts`'s
  // `createBlogArticle`) and the common case immediately after creation.
  return { kind: "not_found" };
}
