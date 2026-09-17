import { headers } from "next/headers";

import { NovelNotFoundBody, notFoundMetadata } from "@/app/_pages/novel-not-found";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";
import { pickSiteLocale, SITE_LOCALE_REQUEST_HEADER } from "@/lib/site/request-locale";

export const metadata = notFoundMetadata;

/**
 * Shared 404 shell for this novel segment under the `[locale]` prefix tree
 * (WO-1 §6.2). Next 16.1.6 renders `not-found.tsx` with zero props (see
 * `@/app/_pages/novel-not-found`'s doc comment for the confirmed framework
 * behavior), so this file cannot read the request's own `locale` route
 * param the way `page.tsx` can.
 *
 * L10N P4 fix (2026-09-10, review B-1): that zero-props constraint is not
 * actually a dead end — `src/app/layout.tsx` sits in exactly the same spot
 * (no `[locale]` segment of its own) and solves it by reading the resolved
 * locale back out of the `x-novel-locale` request header `src/proxy.ts`
 * forwards (`SITE_LOCALE_REQUEST_HEADER`), via the same `pickSiteLocale`
 * gate `app/layout.tsx` uses. This file now does the same: since
 * `[locale]/_guard.ts`'s `getRoutableLocale` routes every registered
 * `SITE_LOCALES` member (not just `en`), a genuinely-missing novel under
 * `/ru/novel/...` reaches this file and must render `ru`, not fall back to
 * `PUBLIC_SITE_LOCALE`. The whole read is wrapped in try/catch exactly like
 * `app/layout.tsx`'s: a missing header, an invalid value, or `headers()`
 * itself throwing all fall back to `PUBLIC_SITE_LOCALE` ("en") rather than
 * ever failing this boundary.
 */
export default async function LocaleNovelNotFoundPage() {
  let locale = PUBLIC_SITE_LOCALE;
  try {
    const requestHeaders = await headers();
    locale = pickSiteLocale(requestHeaders.get(SITE_LOCALE_REQUEST_HEADER));
  } catch {
    locale = PUBLIC_SITE_LOCALE;
  }
  return NovelNotFoundBody({ locale });
}
