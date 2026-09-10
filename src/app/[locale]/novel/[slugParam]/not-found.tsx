import { NovelNotFoundBody, notFoundMetadata } from "@/app/_pages/novel-not-found";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

export const metadata = notFoundMetadata;

/**
 * Shared 404 shell for this novel segment under the `[locale]` prefix tree
 * (WO-1 §6.2). `PUBLIC_SITE_LOCALE`, not the route's own `locale` param, on
 * purpose: Next 16.1.6 renders `not-found.tsx` with zero props (see
 * `@/app/_pages/novel-not-found`'s doc comment for the confirmed framework
 * behavior), so this file cannot read the request's own locale the way
 * `page.tsx` can. Moot in practice today — this whole subtree 404s before
 * any leaf page's code runs (`[locale]/_guard.ts`'s `getRoutableLocale`
 * rejects every locale).
 */
export default function LocaleNovelNotFoundPage() {
  return NovelNotFoundBody({ locale: PUBLIC_SITE_LOCALE });
}
