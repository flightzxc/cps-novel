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
 *    `SITE_LOCALES` has 15 entries and `PUBLISHABLE_LOCALES` has zero (see
 *    that file's inline evidence — no messages catalog, no template engine
 *    wiring, so not even `en` clears the bar yet).
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
 * Net effect today: `getRoutableLocale` returns `null` for every input,
 * because `PUBLISHABLE_LOCALES` is empty — so `[locale]/layout.tsx` 404s
 * every request under this segment. That is the correct, intentional state,
 * matching sitemap generation and hreflang's shared fail-closed posture
 * (`sitemap.ts`, `novel-hreflang.ts`) — not a bug to "fix" by loosening this
 * function. Flipping a second locale on is then a pure registry/content
 * change (add it to `PUBLISHABLE_LOCALES`); no route-tree change is
 * required, because the tree already exists here.
 */
import { isPublishableLocale, SITE_LOCALES, type SiteLocale } from "@/lib/locale/locale-canonical";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

export function getRoutableLocale(rawLocale: string): SiteLocale | null {
  if (!(SITE_LOCALES as readonly string[]).includes(rawLocale)) return null;
  const locale = rawLocale as SiteLocale;
  if (locale === PUBLIC_SITE_LOCALE) return null;
  if (!isPublishableLocale(locale)) return null;
  return locale;
}
