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

import {
  buildPrimaryArticleWhere,
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
 * accessibility. Precedence (most severe first): rights-blocked always wins;
 * then full public access; then the stable noindex removal state (either
 * side literally `unpublished`, or both sides `published` but the promo link
 * degraded after the publish-time gate passed); everything else (draft/ready,
 * or simply no matching row) is a plain 404.
 */
export async function checkNovelArticlePublicAccess(
  db: PrismaClient | Prisma.TransactionClient,
  input: NovelArticleAccessInput,
): Promise<NovelArticleAccessResult> {
  const article = await db.article.findFirst({
    where: buildPrimaryArticleWhere({ locale: input.locale, slug: input.slug }),
    select: {
      id: true,
      novelId: true,
      status: true,
      novel: { select: { status: true } },
      promoLink: { select: { status: true, webUrl: true, appUrl: true } },
    },
  });
  if (!article) return { kind: "not_found" };

  const novelState = article.novel;
  const articleState = { status: article.status };

  if (isRightsBlocked(novelState, articleState)) {
    return { kind: "takedown" };
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
