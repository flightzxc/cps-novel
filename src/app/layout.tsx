import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { GoogleAnalytics } from "@next/third-parties/google";
import "@/styles/globals.css";
import { getPublicT } from "@/lib/locale/messages";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";
import { pickSiteLocale, SITE_LOCALE_REQUEST_HEADER } from "@/lib/site/request-locale";
import { getTextDirection } from "@/lib/site/text-direction";
import { prisma } from "@/app/_lib/public-deps";
import { getSiteSetting } from "@/server/site-settings/service";

// L10N P4: this top-level fallback (module-eval time, before any per-request
// header is available) still uses PUBLIC_SITE_LOCALE — it is what backs the
// `metadata.description` export below, which Next.js reads statically, not
// per-request. The per-request value used for <html lang dir> and the
// module-level `t` below is only a floor; RootLayout itself re-derives the
// real per-request locale from the forwarded header (see below).
const t = getPublicT(PUBLIC_SITE_LOCALE);

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "cps-novel",
  description: t("meta.siteDescription"),
  // Public pages override this from generateMetadata (innermost wins).
  // `dev-preview` and `(admin)` keep noindex via their own layouts.
  robots: { index: false, follow: false },
};

/**
 * 根布局。
 *
 * .site 加在 body 上：站点作用域恒为深色，不跟随系统。
 * 阅读作用域（.reader）只包住章节正文，由章节页自己开。
 *
 * WO-2 (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §8.2): `<html lang>`
 * reacts to the request locale `src/proxy.ts` forwards via
 * `SITE_LOCALE_REQUEST_HEADER`, and `<html dir>` is set alongside it (via
 * the shared `getTextDirection` helper). The whole read is wrapped in
 * try/catch: a missing header, an invalid value, or `headers()` itself
 * throwing all fall back to `PUBLIC_SITE_LOCALE` ("en") rather than ever
 * failing this request.
 *
 * L10N P4 (2026-09-10): this was the one real "唯一语种假设" site among all
 * `PUBLIC_SITE_LOCALE` consumers (`docs/governance/port-registry.md`'s P4
 * §1 清单④) — `pickPublishableLocale` used to fall every non-`en` header
 * value back to `"en"` because the D-7 publish whitelist admitted only
 * `en`. Now reading `pickSiteLocale` (`SITE_LOCALES` membership, the
 * whitelist's replacement), a `/{locale}/...` request's `<html lang>`
 * genuinely reflects that locale — `ar` renders `dir="rtl"`, etc. A
 * bare-path request still resolves to `"en"`/`"ltr"` exactly as before.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const settings = await getSiteSetting(prisma);

  let locale = PUBLIC_SITE_LOCALE;
  try {
    const requestHeaders = await headers();
    locale = pickSiteLocale(requestHeaders.get(SITE_LOCALE_REQUEST_HEADER));
  } catch {
    locale = PUBLIC_SITE_LOCALE;
  }
  const dir = getTextDirection(locale);

  return (
    <html lang={locale} dir={dir}>
      {settings.googleSearchConsoleVerification ? (
        <head><meta name="google-site-verification" content={settings.googleSearchConsoleVerification} /></head>
      ) : null}
      <body className="site">{children}</body>
      {settings.ga4MeasurementId ? <GoogleAnalytics gaId={settings.ga4MeasurementId} /> : null}
    </html>
  );
}
