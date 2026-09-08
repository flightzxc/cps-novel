/**
 * IndexNow candidate-page resolution: URL construction, revision, and
 * eligibility (Stream E, P2-11).
 *
 * Ported COPY_THEN_ADAPT from CPS `src/lib/indexnow.ts`'s `resolveIndexNowPath`
 * and `src/lib/indexnow-outbox.ts`'s `normalizeCanonicalUrl`/
 * `isIndexNowPageEligible`/`loadEligibleIndexNowPages`
 * (`P2-07-12-移植审计-2026-08-12/P2-11.md` §7 "B · COPY_THEN_ADAPT"). CPS's
 * `resolveIndexNowPath` branches on `BLOG_ARTICLE_TYPES`/`drama_article` and
 * warns+skips when `publicPageShortId` is missing (a real, historically-hit
 * case on the CPS side, per that file's comment). Neither branch exists here:
 * cps-novel `Article` has no blog/drama-article-type polymorphism, and
 * `Article.publicPageShortId` is `NOT NULL UNIQUE` from day one — so URL
 * resolution collapses to a single call to `buildArticlePath`
 * (`src/lib/slug/article-path.ts`, the project's sole URL-construction entry
 * point) and the missing-shortId branch has no reachable path to simplify to
 * an assertion for (see `port-registry.md`).
 */
import type { PrismaClient, Prisma } from "@prisma/client";

import { isArticleBlogEnabled } from "@/lib/flags";
import { buildArticlePath, buildBlogPath } from "@/lib/slug/article-path";
import { SITE_LOCALES, isPublishableLocale, type SiteLocale } from "@/lib/locale/locale-canonical";
import {
  isHiddenFromPublicView,
  isIndexNowEligible,
  type ArticlePublicationState,
  type ArticleSeoVisibilityState,
  type NovelPublicationState,
  type PromoLinkReadinessState,
} from "@/server/publication/visibility";

import { toAbsoluteUrl } from "@/lib/seo/site-url";

type Db = PrismaClient | Prisma.TransactionClient;

export type IndexNowCandidateArticle = {
  readonly id: string;
  readonly novelId: string;
  readonly locale: string;
  readonly slug: string;
  readonly publicPageShortId: string;
  readonly status: string;
  /** C-25: `Article.seoVisibility` — a `hidden` Article must never reach IndexNow. See `isNovelIndexNowEligible` below. */
  readonly seoVisibility: string;
  readonly updatedAt: Date;
  readonly novel: NovelPublicationState;
  readonly promoLink: PromoLinkReadinessState;
};

const ARTICLE_ELIGIBILITY_SELECT = {
  id: true,
  novelId: true,
  locale: true,
  slug: true,
  publicPageShortId: true,
  status: true,
  seoVisibility: true,
  updatedAt: true,
  novel: { select: { status: true } },
  promoLink: { select: { status: true, webUrl: true, appUrl: true } },
} satisfies Prisma.ArticleSelect;

export async function loadIndexNowCandidateArticle(
  db: Db,
  articleId: string,
): Promise<IndexNowCandidateArticle | null> {
  const row = await db.article.findFirst({
    where: { id: articleId, deletedAt: null },
    select: ARTICLE_ELIGIBILITY_SELECT,
  });
  return row as IndexNowCandidateArticle | null;
}

/**
 * IndexNow-specific eligibility on top of `isIndexNowEligible` (which only
 * answers the Novel/Article/PromoLink publication question). Adds the
 * locale-allowlist condition `visibility.ts`'s doc comment explicitly
 * reserves for this layer ("Stream E's outbox enqueue path is expected to
 * compose additional IndexNow-specific conditions on top ... e.g. locale
 * allowlist").
 *
 * Gates on `isPublishableLocale` (the SEO-publish-surface whitelist), not
 * the broader `SITE_LOCALES` registry — deliberately the same choice
 * Stream D's sitemap generator is documented as making
 * (`P2-07-12-移植审计-2026-08-12/P2-11.md` §9: "本任务的 `isSupportedSiteLocale`
 * 等价物同样会撞上这个问题"). U6 admitted `en` under D-7; other locales
 * remain blocked. Passing this locale check still requires the publication
 * and promo checks below, and enqueue separately enforces both write flags.
 * The optional predicate lets tests isolate these conditions; production
 * callers use the real whitelist.
 */
/**
 * `env` (C-25) is the same override pattern as `isLocalePublishable`: threaded
 * to `isHiddenFromPublicView` below so tests can exercise the
 * `FEATURE_ARTICLE_SEO_VISIBILITY`-on path without mutating global
 * `process.env`. Production callers (`outbox.ts`) never pass it.
 */
export type IndexNowEligibilityOptions = {
  isLocalePublishable?: (locale: string) => boolean;
  env?: NodeJS.ProcessEnv;
};

/**
 * `article`'s `locale`/`status` stay a plain `Pick` (unchanged contract);
 * `seoVisibility` is intersected in as *optional* rather than folded into
 * that `Pick` so every existing call site that does not carry it (this
 * file's own tests included) keeps compiling — "contract types gain optional
 * fields only". A missing value reads as "not hidden" (today's behavior),
 * same as `visibility.ts`'s `ArticleSeoVisibilityState`.
 */
export function isNovelIndexNowEligible(
  article: Pick<IndexNowCandidateArticle, "locale" | "status"> & ArticleSeoVisibilityState,
  novel: NovelPublicationState,
  promoLink: PromoLinkReadinessState,
  options: IndexNowEligibilityOptions = {},
): boolean {
  const localeGate = options.isLocalePublishable ?? isPublishableLocale;
  if (!localeGate(article.locale)) return false;
  // C-25: IndexNow is a collectability boundary — `hidden` must never be
  // submitted, `seo_only` still is. This lives here (this module's own
  // eligibility layer), not inside the shared `isIndexNowEligible`, per
  // `visibility.ts`'s own doc comment reserving this layer for IndexNow-
  // specific conditions (the locale allowlist above is the same pattern).
  if (isHiddenFromPublicView(article, options.env)) return false;
  return isIndexNowEligible(novel, article as ArticlePublicationState, promoLink);
}

/**
 * C-29 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-29):
 * "IndexNow 投递资格：博客走同一个语种白名单 + 可见性判定，但跳过书目/推广
 * 链接判定。落点在 IndexNow 自己那层...不下沉到通用谓词族" — this is that
 * predicate. Parallel to `isNovelIndexNowEligible` above rather than a
 * branch inside it: a blog Article has no `NovelPublicationState`/
 * `PromoLinkReadinessState` to pass in at all, so the two functions cannot
 * share a signature. Eligibility reduces to exactly `status === "published"`
 * (no promo-readiness re-check — a blog Article has no PromoLink, C-27),
 * gated by the same locale allowlist and `hidden` exclusion the Novel-side
 * function already applies.
 *
 * `FEATURE_ARTICLE_BLOG` is checked here too (unlike `isNovelIndexNowEligible`,
 * which carries no such flag — Novel-article IndexNow predates C-28/C-29
 * entirely) so this predicate is fail-closed by construction wherever it is
 * eventually wired to a live enqueue/recheck call site.
 *
 * 🟡 Not yet wired to a production call site this round. The natural wiring
 * point — `src/server/publish-gate/service.ts`'s `dispatchFirstPublicPublication`
 * call — is currently guarded by `txResult.novelId !== null` (skipping the
 * enqueue entirely for a blog Article's first publish; that file's own
 * inline comment already flags "Blog's own IndexNow/sitemap wiring is
 * C-29's job"). `publish-gate/{facts,evaluator,service}.ts` are reserved
 * for a concurrently-running workstream this round and were left untouched
 * per this round's own file-boundary rule — so the actual enqueue call
 * remains unwired; only this standalone, independently-tested predicate
 * ships. `worker/handlers/indexnow-delivery.ts`'s own drift-recheck
 * (`isNovelIndexNowEligible`) is likewise not extended to blog rows this
 * round, since no blog `IndexNowOutbox` row can exist yet for it to ever
 * recheck. Wiring this in is a mechanical follow-up once that file opens up.
 */
export type BlogIndexNowCandidateArticle = {
  readonly locale: string;
  readonly slug: string;
  readonly status: string;
};

export function isBlogIndexNowEligible(
  article: Pick<BlogIndexNowCandidateArticle, "locale" | "status"> & ArticleSeoVisibilityState,
  options: IndexNowEligibilityOptions = {},
): boolean {
  if (!isArticleBlogEnabled(options.env)) return false;
  const localeGate = options.isLocalePublishable ?? isPublishableLocale;
  if (!localeGate(article.locale)) return false;
  if (isHiddenFromPublicView(article, options.env)) return false;
  return article.status === "published";
}

/**
 * Revision is a net-new concept versus CPS — CPS's `idempotencyKey` was
 * `sha256(eventType\ncanonicalUrl)` with revision deliberately excluded
 * (`DECISION-CHECK.md` 核查1). This codebase's frozen idempotent identity is
 * `@@unique([url, revision])` instead (`docs/governance/database-governance.md`
 * §6), and `Article` carries no explicit version counter to source a
 * revision from. `updatedAt.getTime()` is the chosen source: it is
 * monotonically non-decreasing per row (bumped by Prisma's `@updatedAt` on
 * every write, including the publish transition itself), requires no new
 * column, and gives the intended behavior — a later edit to an already-
 * published Article produces a new `(url, revision)` pair and is resubmitted
 * to IndexNow, while a byte-identical retry of the same write is naturally
 * deduplicated by the unique constraint.
 *
 * 🟡 Known edge case, not a defect (`scratchpad/reports/E-REVIEW.md` §4b):
 * `@updatedAt` is generated application-side (Prisma reads `Date.now()` on
 * the process issuing the write), not by the database clock. If that
 * process's clock is stepped backward by NTP between two edits of the same
 * Article, the later edit can compute a *smaller* `updatedAt.getTime()` than
 * an earlier one. If that smaller value happens to collide exactly (to the
 * millisecond) with a `(url, revision)` pair that already exists, the write
 * is classified `duplicate` and silently not resubmitted — a missed
 * submission, not corrupted data, and it requires both a clock step-back and
 * a millisecond-exact historical collision to trigger.
 */
export function computeIndexNowRevision(updatedAt: Date): bigint {
  return BigInt(updatedAt.getTime());
}

/**
 * Ported ADAPT from CPS `normalizeCanonicalUrl` (`indexnow-outbox.ts`):
 * forces `https:`, lowercases host, strips default ports, rejects query/
 * fragment and apparent double-encoding. Uses the repo's single shared
 * `toAbsoluteUrl` (`src/lib/seo/site-url.ts`) — the former private duplicate
 * `internal-site-url.ts` was deleted at integration per its own directive
 * once Stream D's shared module landed.
 */
export function normalizeCanonicalUrl(input: string): string {
  const absolute = toAbsoluteUrl(input);
  const url = new URL(absolute);
  if (url.search || url.hash) {
    throw new Error("IndexNow canonical URL must not contain a query string or fragment");
  }
  if (/%25[0-9a-f]{2}/i.test(url.pathname)) {
    throw new Error("IndexNow canonical URL appears double-encoded");
  }
  url.protocol = "https:";
  url.hostname = url.hostname.toLowerCase();
  if (url.port === "443" || url.port === "80") url.port = "";
  return url.toString();
}

/** `buildArticlePath` + `normalizeCanonicalUrl`, in one call — the sole IndexNow URL-construction entry point for this Stream. */
export function buildIndexNowCanonicalUrl(article: Pick<IndexNowCandidateArticle, "locale" | "slug" | "publicPageShortId">): string {
  const path = buildArticlePath({
    locale: article.locale as SiteLocale,
    slug: article.slug,
    shortId: article.publicPageShortId,
  });
  return normalizeCanonicalUrl(path);
}

/** `buildBlogPath` + `normalizeCanonicalUrl` — the blog-family counterpart to `buildIndexNowCanonicalUrl` above. No short id (see `article-path.ts`'s header on why the blog family never carries one). */
export function buildBlogIndexNowCanonicalUrl(article: Pick<BlogIndexNowCandidateArticle, "locale" | "slug">): string {
  const path = buildBlogPath({ locale: article.locale as SiteLocale, slug: article.slug });
  return normalizeCanonicalUrl(path);
}

export function isRegisteredSiteLocale(locale: string): locale is SiteLocale {
  return (SITE_LOCALES as readonly string[]).includes(locale);
}
