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
 * `getActiveLocales()` only answers "is this locale worth showing at all"
 * (gates the LocaleSwitcher entry — its sole consumer, per this round's §1
 * 清单① evidence pass; sitemap/hreflang/IndexNow stay on the STATIC layer,
 * `SITE_LOCALES`, exactly like their CPS counterparts do — see
 * `docs/governance/port-registry.md`'s P4 section, 清单① note: "CPS 用静态集
 * 的地方海阅不得换动态集"), never "which exact URLs exist". A locale
 * that clears this coarser bar but turns out to have zero rows that also
 * pass the row-level recheck simply renders an empty listing/empty sitemap
 * shard for that locale — a valid, already-anticipated state (see
 * `docs/governance/port-registry.md`'s P4 section, "cs 无内容" test case),
 * never a dead link or a 404.
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
 * `getActiveLocales()` signature (no arguments) exactly. Consumers: only
 * `src/lib/site/chrome.ts`'s `loadPublicChrome` (→ `SiteChrome.activeLocales`
 * → `SiteHeader` → `LocaleSwitcher`), matching CPS's own single real
 * consumer (`site-header.tsx`) per `docs/governance/port-registry.md`'s P4
 * §1 清单①. Do not add a second consumer here without first checking that
 * CPS's own equivalent boundary also reads the dynamic layer, not the
 * static one — see this repo's "CPS 用静态集的地方不得换动态集" discipline.
 */
export const getActiveLocales = unstable_cache(
  () => queryActiveLocales(),
  ["active-locales-v1"],
  {
    revalidate: 300,
    tags: [ACTIVE_LOCALES_CACHE_TAG],
  },
);
