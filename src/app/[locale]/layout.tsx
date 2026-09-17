import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { getRoutableLocale } from "./_guard";

/**
 * Locale-prefixed public route tree — "as-needed" scheme (D-8): the default
 * locale (`en`) lives at the bare path (`src/app/page.tsx`,
 * `src/app/browse/page.tsx`, `src/app/novel/...`), every other registered
 * `SITE_LOCALES` member lives here, under `/{locale}/...` (L10N P4:
 * "registered即路由" — the D-7 publish whitelist that used to gate this
 * further was deleted). Next.js resolves static segments (`browse`,
 * `novel`) ahead of this dynamic `[locale]` segment at the same directory
 * level, so the two trees coexist without any route conflict or rewrite —
 * this is the standard App Router "as-needed" locale-prefix pattern,
 * confirmed against Next 16.1.6 by this project's own route tree (no
 * `next-intl` or other i18n routing library involved; see this unit's
 * report for why one was deliberately not introduced yet).
 *
 * This layout is the SOLE gate for the entire subtree — see `_guard.ts` for
 * exactly which locales are routable and why. Every leaf page underneath
 * trusts that this layout has already run and 404'd anything not routable;
 * leaf pages do not need to (and should not) re-derive locale eligibility.
 *
 * `force-dynamic` is inherited from each leaf page (same as every existing
 * bare-path public route — `src/app/page.tsx`, `src/app/browse/page.tsx`,
 * etc. each set `export const dynamic = "force-dynamic"` individually);
 * this layout itself declares nothing extra, since a layout's own
 * `dynamic` export does not need to match its pages' as long as neither
 * relies on static generation.
 */
export default async function LocalePublicLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!getRoutableLocale(locale)) notFound();
  return children;
}
