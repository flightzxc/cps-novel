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

import { buildArticlePath } from "@/lib/slug/article-path";
import { SITE_LOCALES, isPublishableLocale, type SiteLocale } from "@/lib/locale/locale-canonical";
import {
  isIndexNowEligible,
  type ArticlePublicationState,
  type NovelPublicationState,
  type PromoLinkReadinessState,
} from "@/server/publication/visibility";

import { toAbsoluteSiteUrl } from "./internal-site-url";

type Db = PrismaClient | Prisma.TransactionClient;

export type IndexNowCandidateArticle = {
  readonly id: string;
  readonly novelId: string;
  readonly locale: string;
  readonly slug: string;
  readonly publicPageShortId: string;
  readonly status: string;
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
 * 等价物同样会撞上这个问题"). `listPublishableLocales()` is empty pending the
 * D-7 whitelist decision, so **IndexNow enqueue is currently a real no-op
 * for every locale** — this is a shared, already-documented blocker, not a
 * defect introduced here; see this Stream's report / wiring notes. Accepts
 * an injectable predicate so tests are not permanently red against the
 * production-empty whitelist.
 */
export type IndexNowEligibilityOptions = { isLocalePublishable?: (locale: string) => boolean };

export function isNovelIndexNowEligible(
  article: Pick<IndexNowCandidateArticle, "locale" | "status">,
  novel: NovelPublicationState,
  promoLink: PromoLinkReadinessState,
  options: IndexNowEligibilityOptions = {},
): boolean {
  const localeGate = options.isLocalePublishable ?? isPublishableLocale;
  if (!localeGate(article.locale)) return false;
  return isIndexNowEligible(novel, article as ArticlePublicationState, promoLink);
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
 * fragment and apparent double-encoding. `toAbsoluteSiteUrl` replaces CPS's
 * `toAbsoluteUrl` import (see `internal-site-url.ts`'s header for why this is
 * a private duplicate, not the shared module CPS had).
 */
export function normalizeCanonicalUrl(input: string): string {
  const absolute = toAbsoluteSiteUrl(input);
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

export function isRegisteredSiteLocale(locale: string): locale is SiteLocale {
  return (SITE_LOCALES as readonly string[]).includes(locale);
}
