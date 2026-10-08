/**
 * Dynamic locale layer — L10N P4 (矩阵 #9), the two-layer split's second
 * half. `ADAPT` from CPS `3a76877:src/lib/active-locales.ts:12-41`
 * (`getActiveLocales`, `unstable_cache`-wrapped `Drama.groupBy({by:
 * ["locale"], where: {status: "active"}})`).
 *
 * Definition: the set of `SITE_LOCALES` members for which at least one
 * publicly-visible Article exists — "publicly-visible" being this project's
 * own established predicate family (`isPublicationStatePublic` ∧
 * `isPromoReady` ∧ Novel/PromoLink not soft-deleted), the SAME one
 * `src/lib/seo/sitemap.ts`'s `loadVisible`/`isVisibleCandidate` and
 * `src/lib/seo/novel-hreflang.ts`'s `isVisibleSibling` already use. This
 * module does NOT invent a second visibility `where` or a
 * `Novel.status === "active"`-shaped check — `Novel.status` in this schema
 * is a different, unrelated status vocabulary from CPS's `Drama.status`,
 * and reusing it here would be exactly the kind of "第二份可见性 where" the
 * construction prompt forbids. The `where` fragment below is
 * `sitemap.ts`'s own exported `activePublicArticleWhere` — the identical
 * function `articleSitemapWhere` delegates to — imported, not re-derived.
 *
 * `en` is always included regardless of data (matching CPS's own
 * `active.add("en")` unconditional seed), the result is bounded to and
 * ordered by `SITE_LOCALES`, and the whole thing is `unstable_cache`d for
 * 300s under tag `"active-locales"` — invalidated from the existing publish-
 * state-transition broadcast point (`src/server/publication/revalidate.ts`'s
 * `revalidatePublicListings()`), not a new invalidation mechanism.
 *
 * `groupBy` (not `distinct`) per the construction prompt: a single
 * aggregate query over the coarse DB-level collectability `where`, not a
 * `findMany` + per-row JS recheck. This is a deliberately looser bar than
 * `sitemap.ts`'s own per-locale `isVisibleCandidate` (which additionally
 * re-verifies `isPromoReady`'s exact whitespace-trim semantics per row) —
 * `getActiveLocales()` only answers "is this locale worth showing at all",
 * never "which exact URLs exist".
 *
 * PN-09 (Owner 2026-10-08: 没有书时连入口也隐藏) — THIS SET IS ALSO THE ONE AND ONLY
 * DEFINITION OF "EMPTY LOCALE": a locale not in it (`isEmptyLocale`,
 * `./empty-locale.ts`) has no publicly-visible published book. The same set
 * now drives, besides the LocaleSwitcher entry: `robots: noindex,follow` and "no
 * hreflang at all" on that locale's home / `/browse` / `/blog` list pages, and the
 * hreflang cluster of those pages for every other locale (only active locales
 * are listed, `src/lib/seo/empty-locale-seo.ts`). This supersedes the earlier
 * "sitemap/hreflang stay on the STATIC layer, `SITE_LOCALES`" note (L10N P4,
 * `docs/governance/port-registry.md`'s P4 section, 清单① note: "CPS 用静态集的地方
 * 海阅不得换动态集") for those surfaces only — CPS never has an empty locale,
 * so CPS never needed this; the deviation is recorded in that same section and
 * in `docs/adr/ADR-PN09-EMPTY-LOCALE-HIDDEN.md`. Route reachability does NOT
 * change: a registered locale is never a 404 for being empty (`/cs` stays HTTP
 * 200, just noindex).
 *
 * The sitemap is NOT a consumer of this function (the refresh worker has no
 * Next.js cache context): its `mainpage` gate reads `loadVisible(locale)`
 * built from the SAME `activePublicArticleWhere` fragment imported above, plus
 * one row-level recheck. So "sitemap lists the locale's home" ⊆ "locale is
 * active" always holds (exact ⊆ coarse) — a locale can be active yet absent
 * from the sitemap (only whitespace-only promo links / only `en` without
 * books), never the reverse, and the sitemap never lists a noindex home.
 *
 * Accepted approximation, unchanged from before: a locale that clears this
 * coarser bar but has zero rows passing the row-level recheck (all promo URLs
 * whitespace-only) stays active — indexable, in the menu, absent from the
 * sitemap — until a real book appears. No such data exists in practice and the
 * failure direction is the safe one (an extra visible locale, never a hidden
 * populated one).
 */
import { unstable_cache } from "next/cache";
import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma } from "@/app/_lib/public-deps";
import { activePublicArticleWhere } from "@/lib/seo/sitemap";
import { ACTIVE_LOCALES_CACHE_TAG } from "./active-locales-tag";
import { SITE_LOCALES, type SiteLocale } from "./locale-canonical";

export { ACTIVE_LOCALES_CACHE_TAG };

type ActiveLocalesDb = PrismaClient | Prisma.TransactionClient;

/**
 * Un-cached core query — exported separately from `getActiveLocales` so
 * tests can call it directly against a fixture `db`, bypassing
 * `unstable_cache` entirely (which depends on Next.js request/build-time
 * runtime machinery `vitest` does not provide).
 *
 * L10N P5 (矩阵 #13): that same "no Next.js runtime" reasoning is also why
 * `scheduler/index.ts`'s standalone process (`node scheduler/index.ts`,
 * no Next.js request/build-time context of its own) calls THIS function
 * directly — once per scheduler tick, via its own already-open `PrismaClient`
 * — instead of `getActiveLocales()`, to resolve the home-carousel cron's
 * active-locale set (`buildHomeCarouselCronTaskInput`'s own doc comment,
 * `src/server/home-carousel/service.ts`). Within the Next.js app itself
 * (any Server Component, Route Handler, or Server Action), still call
 * `getActiveLocales()` below, never this function directly — the "never"
 * in the previous version of this comment was written before the
 * scheduler process existed as a second, legitimately non-Next-runtime
 * caller class; it was never meant to rule that class out, only to keep
 * ordinary in-app code on the cached path.
 */
export async function queryActiveLocales(
  db: ActiveLocalesDb = prisma,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SiteLocale[]> {
  const rows = await db.article.groupBy({
    by: ["locale"],
    where: activePublicArticleWhere({ in: [...SITE_LOCALES] }, env),
    _count: { _all: true },
  });

  const active = new Set<string>(["en"]);
  for (const row of rows) {
    if ((SITE_LOCALES as readonly string[]).includes(row.locale)) {
      active.add(row.locale);
    }
  }

  return SITE_LOCALES.filter((locale) => active.has(locale));
}

/**
 * The real, cached, production entry point — mirrors CPS's own
 * `getActiveLocales()` signature (no arguments) exactly. Consumers (all through
 * `loadActiveLocales()` in `src/app/_lib/public-load.ts`, the request-deduped
 * wrapper — never call this from a page directly):
 * `src/lib/site/chrome.ts`'s `loadPublicChrome` (→ `SiteChrome.activeLocales`
 * → `SiteHeader` → `LocaleSwitcher`, CPS's own single consumer
 * `site-header.tsx`); and, since PN-09, the home / browse / blog-list metadata
 * builders (`src/app/_pages/{home,browse,blog-list}.tsx` → `emptyLocaleRobots` /
 * `buildActiveLocaleAlternates`) — a deliberate deviation from CPS's "static set
 * outside the header", see the module header. Do not add another decision
 * consumer, and never re-derive "does this locale have books" from a second query.
 *
 * 2026-09-30 one bounded, cost-only exception (not a second decision
 * consumer): `src/app/_pages/category.tsx`'s `hreflangLocalesFor` uses this
 * set to bound WHICH locales get probed when computing a category page's
 * hreflang (each probe is a full `getPublicCategoryPage`). Correctness never
 * comes from this set — a locale is listed in hreflang only if
 * `getPublicCategoryPage(…, 1)` itself returns a page, i.e. the page really
 * is HTTP 200; a locale missing here merely postpones its hreflang entry by at
 * most this cache's 300s (the safe direction). The set is a superset of every
 * locale that can have a list-visible category (collectability ⊇ list).
 */
export const getActiveLocales = unstable_cache(
  () => queryActiveLocales(),
  ["active-locales-v1"],
  {
    revalidate: 300,
    tags: [ACTIVE_LOCALES_CACHE_TAG],
  },
);
