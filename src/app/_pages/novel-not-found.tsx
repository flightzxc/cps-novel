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
 * cannot read its own `locale` route param the way a `page.tsx` can.
 * `src/app/novel/[slugParam]/not-found.tsx` (the bare-path shell — outside
 * the `[locale]` prefix tree entirely) still pins `PUBLIC_SITE_LOCALE`, on
 * purpose: a bare path has no request locale to read.
 *
 * L10N P4 fix (2026-09-10, review B-1): the `[locale]`-prefixed shell no
 * longer pins `PUBLIC_SITE_LOCALE` either. It works around the same
 * zero-props constraint the way `src/app/layout.tsx` already does — neither
 * file has a `[locale]` route segment of its own, so both read the resolved
 * locale back out of the `x-novel-locale` request header `src/proxy.ts`
 * forwards (`SITE_LOCALE_REQUEST_HEADER`), via `pickSiteLocale`, wrapped in
 * try/catch with `PUBLIC_SITE_LOCALE` as the fallback. See that shell file
 * for the actual read. `docs/governance/port-registry.md`'s L10N P4 section
 * (清单④) has the full accounting.
 */
export const notFoundMetadata: Metadata = {
  robots: { index: false, follow: false },
};

export function NovelNotFoundBody({ locale }: { locale: SiteLocale }) {
  return (
    <UnavailableScreen locale={locale} reason="unpublished" homeHref={localePrefix(locale) || "/"} />
  );
}
