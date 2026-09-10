import { SITE_LOCALES, type SiteLocale } from "@/lib/locale/locale-canonical";

import { PUBLIC_SITE_LOCALE } from "./locale-label";

/**
 * Request header `src/proxy.ts` forwards the resolved site locale on
 * (WO-2 `施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §8.2). The root layout
 * (`src/app/layout.tsx`) has no `[locale]` route segment of its own — it
 * sits above both the bare-path and locale-prefixed public trees, and also
 * covers the admin/dev-preview segments — so it cannot read a route param
 * the way a `page.tsx` under `[locale]/` can. This header is how the two
 * sides of the proxy boundary agree on which locale a request resolved to.
 */
export const SITE_LOCALE_REQUEST_HEADER = "x-novel-locale";

/**
 * Picks a `SiteLocale` for a request out of an untrusted `candidate` value,
 * checked against `SITE_LOCALES` — the static registration gate, L10N P4's
 * replacement for the deleted `isPublishableLocale`/`PUBLISHABLE_LOCALES`
 * whitelist (the narrower gate this function used to read was removed this
 * round; `SITE_LOCALES` membership is now the only static-layer check any
 * exit gate reads). Anything that fails — missing, not a string, or outright
 * garbage — falls back to `PUBLIC_SITE_LOCALE` ("en"). Never throws.
 *
 * 🔴 Deliberately NOT named with a `resolve`/`normalize`/`to`/`map`/`coerce`
 * prefix (see `tests/ui/locale-canonical.test.ts`'s "no second locale
 * normalize implementation" scan) — this function does no independent
 * mapping of its own; it only checks membership in the canonical
 * `SITE_LOCALES` registry and substitutes the canonical default otherwise.
 *
 * Two callers share this one rule rather than each re-deriving it:
 *
 * - `src/proxy.ts` applies it to the request path's first segment, to
 *   decide what to put INTO the `SITE_LOCALE_REQUEST_HEADER` header.
 * - `src/app/layout.tsx` applies it to the header value it reads BACK OUT,
 *   as its own defense-in-depth (a header is just another untrusted string
 *   by the time it reaches a Server Component — this function doesn't care
 *   which side is calling it).
 */
export function pickSiteLocale(candidate: unknown): SiteLocale {
  if (typeof candidate === "string" && (SITE_LOCALES as readonly string[]).includes(candidate)) {
    return candidate as SiteLocale;
  }
  return PUBLIC_SITE_LOCALE;
}
