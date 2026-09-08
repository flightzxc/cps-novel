import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { GoogleAnalytics } from "@next/third-parties/google";
import "@/styles/globals.css";
import { getPublicT } from "@/lib/locale/messages";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";
import { pickPublishableLocale, SITE_LOCALE_REQUEST_HEADER } from "@/lib/site/request-locale";
import { getTextDirection } from "@/lib/site/text-direction";
import { prisma } from "@/app/_lib/public-deps";
import { getSiteSetting } from "@/server/site-settings/service";

// 根布局不是逐语种路由（没有 [locale] 路由段），本仓库首发也只有 en 一个
// 可发布语种，因此这里是站点唯一的语种硬编码锚点——D-8 定案语种段路由结构
// 之后，这一行是需要跟着改的地方。其余调用点一律从这里或各页面自己的
// PUBLIC_SITE_LOCALE 显式往下传，不再各自默认。
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
 * now reacts to the request locale `src/proxy.ts` forwards via
 * `SITE_LOCALE_REQUEST_HEADER`, and `<html dir>` is newly set alongside it
 * (via the shared `getTextDirection` helper) — this layout previously
 * emitted no `dir` attribute at all. The whole read is wrapped in try/catch:
 * a missing header, an invalid value, or `headers()` itself throwing all
 * fall back to `PUBLIC_SITE_LOCALE` ("en") rather than ever failing this
 * request. For every request today that resolves to anything other than
 * `"en"` — which is all of them, since `PUBLISHABLE_LOCALES` is still
 * `{"en"}` — `lang` stays exactly `"en"` as before; `dir="ltr"` is the one
 * new, explicitly accepted DOM difference on the English site (see this
 * work order's own regression checklist item for it).
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const settings = await getSiteSetting(prisma);

  let locale = PUBLIC_SITE_LOCALE;
  try {
    const requestHeaders = await headers();
    locale = pickPublishableLocale(requestHeaders.get(SITE_LOCALE_REQUEST_HEADER));
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
