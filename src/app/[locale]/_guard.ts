/**
 * Resolves a raw `[locale]` route-param string to a locale that is actually
 * reachable under a URL prefix.
 *
 * P0-S7a, "为公开站建立 locale 路由" — the guard half of this route tree.
 * `[locale]/layout.tsx` is the ONLY place that decides whether a
 * locale-prefixed request is reachable; every leaf page under this segment
 * trusts that decision instead of re-deriving it.
 *
 * L10N P4 (2026-09-10): "registered即路由" — matches CPS's own
 * `[locale]/(site)/layout.tsx` semantics
 * (`3a76877:src/app/[locale]/(site)/layout.tsx:43-48`, `hasLocale(routing.
 * locales, locale)`). A locale need only clear ONE gate to be routable here:
 *
 * 1. **Registered** — a member of `SITE_LOCALES` (`locale-canonical.ts`,
 *    15 entries, aligned to the short-drama site's registry per Owner
 *    decision).
 *
 * The independent D-7 publish whitelist (`PUBLISHABLE_LOCALES`/
 * `isPublishableLocale`) that used to sit on top of this as a second gate
 * was deleted this round (矩阵 #9 GAP 收口) — CPS's own routing layer never
 * had a second, narrower gate here; "is this locale worth showing content
 * for" is now the dynamic layer's question (`getActiveLocales()`), answered
 * at the data layer (empty listings, hidden LocaleSwitcher entry, empty
 * sitemap shard), never at the routing layer (a registered locale is never
 * a 404 for THIS reason alone).
 *
 * A SECOND, structural rule still sits on top of the registration gate: the
 * default locale (`PUBLIC_SITE_LOCALE`, `en`) is deliberately EXCLUDED from
 * ever resolving here. This project's frozen URL form (D-8:
 * `buildLocaleCanonical`, `src/lib/slug/article-path.ts`) serves the default
 * locale at the bare, unprefixed path. Letting `/en/...` ALSO resolve would
 * create two indexable URLs for the same content — the exact duplicate-
 * content/dead-link surface this unit's hreflang work (`novel-hreflang.ts`)
 * exists to eliminate elsewhere. A request for `/en/...` must 404, not
 * redirect at this layer — `src/proxy.ts`'s `/en/*` -> bare-path 308 already
 * intercepts every real `/en/...` request before it ever reaches this guard,
 * so this branch is a defense-in-depth backstop, not the primary handler.
 *
 * Net effect today: `getRoutableLocale` returns every one of the 14 non-`en`
 * `SITE_LOCALES` members, `null` only for `en` and for anything not in
 * `SITE_LOCALES`. WO-1 (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §6.2)
 * already shipped this subtree's leaf-page *shape* — thin `page.tsx`/
 * `not-found.tsx` shells under `src/app/[locale]/...` that each resolve
 * their `locale` route param and delegate to the shared bodies in
 * `src/app/_pages/*` — so every registered locale now actually renders
 * through those existing shells; nothing else in this subtree needed to
 * change for that to become true.
 */
import { notFound } from "next/navigation";

import { SITE_LOCALES, type SiteLocale } from "@/lib/locale/locale-canonical";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

export function getRoutableLocale(rawLocale: string): SiteLocale | null {
  if (!(SITE_LOCALES as readonly string[]).includes(rawLocale)) return null;
  const locale = rawLocale as SiteLocale;
  if (locale === PUBLIC_SITE_LOCALE) return null;
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
