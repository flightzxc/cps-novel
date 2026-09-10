/**
 * Resolves a raw `[locale]` route-param string to a locale that is actually
 * reachable under a URL prefix.
 *
 * P0-S7a, "为公开站建立 locale 路由" — the guard half of this route tree.
 * `[locale]/layout.tsx` is the ONLY place that decides whether a
 * locale-prefixed request is reachable; every leaf page under this segment
 * trusts that decision instead of re-deriving it.
 *
 * A locale must clear BOTH gates to be routable here:
 *
 * 1. **Registered** — a member of `SITE_LOCALES` (`locale-canonical.ts`,
 *    15 entries, aligned to the short-drama site's registry per Owner
 *    decision). This is the mapping/registration gate.
 * 2. **Publishable** — `isPublishableLocale(locale)` (D-7's independent,
 *    fail-closed publish whitelist). Registered ≠ publishable: today
 *    `SITE_LOCALES` has 15 entries and `PUBLISHABLE_LOCALES` is `{en}`
 *    (U6 / Owner D-7). `en` is still excluded from this prefix tree by the
 *    third rule below (D-8 bare default-locale URLs).
 *
 * A THIRD, structural rule sits on top of both gates: the default locale
 * (`PUBLIC_SITE_LOCALE`, `en`) is deliberately EXCLUDED from ever resolving
 * here, even once/if it clears `isPublishableLocale`. This project's frozen
 * URL form (D-8: `buildLocaleCanonical`, `src/lib/slug/article-path.ts`)
 * serves the default locale at the bare, unprefixed path. Letting `/en/...`
 * ALSO resolve would create two indexable URLs for the same content — the
 * exact duplicate-content/dead-link surface this unit's hreflang work
 * (`novel-hreflang.ts`) exists to eliminate elsewhere. A request for
 * `/en/...` must 404, not redirect: no such prefixed URL has ever been
 * published or linked from anywhere in this codebase.
 *
 * Net effect today: `getRoutableLocale` still returns `null` for every input.
 * `en` is publishable but excluded as the default locale; the other 14
 * registered locales are not on the whitelist. `[locale]/layout.tsx` 404s
 * every request under this segment. That is the correct, intentional state
 * until a second locale is admitted **and** ships its `[locale]/...` leaf
 * pages in the same batch.
 *
 * 🔴 P0-S10 correction: adding a locale to `PUBLISHABLE_LOCALES` is
 * necessary but NOT sufficient to make that locale routable. WO-1
 * (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §6.2) shipped this
 * subtree's leaf-page *shape* — thin `page.tsx`/`not-found.tsx` shells under
 * `src/app/[locale]/...` that each resolve their `locale` route param and
 * delegate to the shared bodies in `src/app/_pages/*` — but this does not by
 * itself make anything reachable: `getRoutableLocale` still returns `null`
 * for every input (see above), so `[locale]/layout.tsx` 404s every request
 * before any leaf page's own code ever runs. Making `getRoutableLocale`
 * return non-null for a locale before its `PUBLISHABLE_LOCALES` entry is
 * genuinely admitted would not restore access either — the leaf pages exist
 * now, but any hreflang/sitemap entries pointing at `/{locale}/...` before
 * that locale is actually admitted would still be dead links pointing at a
 * page whose data layer has nothing published for that locale. Publishing
 * any second locale therefore MUST land alongside its
 * `PUBLISHABLE_LOCALES` admission — not as a follow-up — or hreflang/sitemap
 * will advertise URLs with no real content behind them yet.
 */
import { notFound } from "next/navigation";

import { isPublishableLocale, SITE_LOCALES, type SiteLocale } from "@/lib/locale/locale-canonical";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

export function getRoutableLocale(rawLocale: string): SiteLocale | null {
  if (!(SITE_LOCALES as readonly string[]).includes(rawLocale)) return null;
  const locale = rawLocale as SiteLocale;
  if (locale === PUBLIC_SITE_LOCALE) return null;
  if (!isPublishableLocale(locale)) return null;
  return locale;
}

/**
 * Type-narrowing helper for the `[locale]/...` leaf pages (WO-1 §6.2) — NOT
 * a second policy gate. The one and only policy decision ("is this locale
 * routable") still happens exactly once, in `[locale]/layout.tsx`, via
 * `getRoutableLocale` above; every leaf page under this segment renders only
 * after that layout has already let the request through. A leaf page still
 * receives its `locale` route param as a bare `string`, though, and needs a
 * real `SiteLocale` to hand down to `src/app/_pages/*`'s shared bodies — this
 * function exists purely to perform that type narrowing via the SAME source
 * of truth `layout.tsx` already consulted, so a leaf page never re-derives
 * or duplicates the eligibility decision itself. Because the layout has
 * already 404'd anything `getRoutableLocale` would reject, the `notFound()`
 * call below is normally unreachable in production — it exists as a
 * defensive fallback (e.g. a leaf page invoked in isolation, such as a unit
 * test that skips the layout) rather than as this file's real enforcement
 * point.
 */
export function requireRoutableLocale(rawLocale: string): SiteLocale {
  const locale = getRoutableLocale(rawLocale);
  if (!locale) notFound();
  return locale;
}
