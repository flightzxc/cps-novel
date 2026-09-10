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
 * — identical to the bare-path shell.
 *
 * 🔴 L10N P4 (2026-09-10): this was written when the whole `[locale]/...`
 * subtree was unreachable (`getRoutableLocale` 404'd every locale), which
 * made the `en` hardcode here harmless. That is no longer true —
 * `[locale]/_guard.ts` now routes every registered `SITE_LOCALES` member —
 * so a genuinely-missing novel under `/ru/novel/...` now hits THIS file and
 * renders it in `en`, not `ru`. This is a real, known gap the P4 construction
 * prompt's §2.E only scoped to `src/app/layout.tsx` (which does read the
 * per-request locale now, via `x-novel-locale` — see that file); this
 * shell was not included in that scope and was deliberately left
 * unchanged rather than fixed opportunistically — see
 * `docs/governance/port-registry.md`'s L10N P4 section (清单④) for the
 * full accounting. Solving this for real needs the same locale signal
 * `app/layout.tsx` now reads (`SITE_LOCALE_REQUEST_HEADER`, forwarded by
 * `src/proxy.ts`) threaded into this zero-props boundary.
 */
export const notFoundMetadata: Metadata = {
  robots: { index: false, follow: false },
};

export function NovelNotFoundBody({ locale }: { locale: SiteLocale }) {
  return (
    <UnavailableScreen locale={locale} reason="unpublished" homeHref={localePrefix(locale) || "/"} />
  );
}
