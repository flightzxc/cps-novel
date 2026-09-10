import type { Metadata } from "next";

import { UnavailableScreen } from "@/features/public-ui/status/UnavailableScreen";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { localePrefix } from "@/lib/slug/article-path";

/**
 * Novel-segment not-found shared body (WO-1 §6.1): extracted verbatim out of
 * `src/app/novel/[slugParam]/not-found.tsx`, `PUBLIC_SITE_LOCALE` swapped
 * for the `locale` parameter. No other semantics changed.
 *
 * `notFoundMetadata` is locale-invariant (`{ index: false, follow: false }`
 * regardless of locale) and is exported here once so both the bare-path and
 * `[locale]`-prefixed `not-found.tsx` shells re-export the identical object
 * instead of each re-typing it.
 *
 * WO-1 note (framework constraint, not a choice made here): Next 16.1.6
 * renders a `not-found.tsx` boundary with zero props — confirmed against
 * `node_modules/next/dist/server/app-render/create-component-tree.js`'s
 * `createBoundaryConventionElement`, which instantiates the not-found
 * component via `createElement(Component, null)`. This holds for a nested
 * `not-found.tsx` too, so `src/app/[locale]/novel/[slugParam]/not-found.tsx`
 * cannot read its own `locale` route param the way a `page.tsx` can. That
 * shell therefore also calls `NovelNotFoundBody({ locale: PUBLIC_SITE_LOCALE })`
 * — identical to the bare-path shell — same as today (this whole subtree is
 * unreachable: `getRoutableLocale` 404s every locale, see `[locale]/_guard.ts`).
 * Solving this for real needs a locale signal not derived from route
 * params — e.g. the request-locale header WO-2 §8.2 adds for `<html lang>`
 * — which is out of WO-1's scope by the work order's own boundary ("do NOT
 * implement WO-2 or WO-3").
 */
export const notFoundMetadata: Metadata = {
  robots: { index: false, follow: false },
};

export function NovelNotFoundBody({ locale }: { locale: SiteLocale }) {
  return (
    <UnavailableScreen locale={locale} reason="unpublished" homeHref={localePrefix(locale) || "/"} />
  );
}
