import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { GoogleAnalytics } from "@next/third-parties/google";
import "@/styles/globals.css";
import { getPublicT } from "@/lib/locale/messages";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";
import { resolveSiteBrandName } from "@/lib/seo/site-brand";
import {
  buildYandexMetricaNoscriptHtml,
  buildYandexMetricaScript,
  normalizeYandexMetricaId,
  normalizeYandexVerification,
} from "@/lib/seo/yandex-metrica";
import { isAdminHostRequest } from "@/lib/site/admin-origin";
import { pickSiteLocale, SITE_LOCALE_REQUEST_HEADER } from "@/lib/site/request-locale";
import { getTextDirection } from "@/lib/site/text-direction";
import { prisma } from "@/app/_lib/public-deps";
import { getSiteSetting } from "@/server/site-settings/service";

// L10N P4: this top-level fallback (module-eval time, before any per-request
// header is available) still uses PUBLIC_SITE_LOCALE — it is what backs the
// root `description` returned by `generateMetadata` below. The per-request
// value used for <html lang dir> and the module-level `t` below is only a
// floor; RootLayout itself re-derives the real per-request locale from the
// forwarded header (see below).
const t = getPublicT(PUBLIC_SITE_LOCALE);

export const dynamic = "force-dynamic";

/**
 * 品牌后缀统一挂在根布局（TKD 对齐 CPS，Owner 2026-09-30）：
 * `title.template = "%s | 站点名"`，下层页面只写不含品牌名的标题，由这里加上后缀。
 * 站点名读后台 `SiteSetting.siteName`，读不到时用 `PulseNovel`（取法见
 * `resolveSiteBrandName`，与"数据库来源标题先去重"那几处共用同一个函数）。
 * 站点设置有 30 秒进程缓存（`getSiteSetting`），不会给每个请求多加一次查库。
 *
 * 🔴 模板的作用范围由 Next 16.1.6 的合并规则决定（`resolve-metadata.js` 的
 * `accumulateMetadata`：模板只取自"倒数第二项之前"各项的合并结果），会带来三个
 * 连带影响，逐个处理——都由 `tests/ui/seo/real-metadata-merge.test.ts` 用 Next
 * 自己的合并函数钉住，不要只看模板函数的返回值：
 *  1. 首页（`_pages/home.tsx`）写成 `title.absolute`——英文首页与本布局同层不套模板，
 *     `/ja` 首页隔了一层 `[locale]` 布局会被套上，不写绝对标题 15 语首页就不一致；
 *  2. 后台与登录布局（`(admin)`/`(admin-auth)`）的"海外阅读后台"写成绝对标题；
 *  3. dev-preview 章节页的标题同理。
 * 另外：这里刻意不设 `openGraph`/`twitter`——og:title 与 twitter:title 不带后缀
 * （CPS 契约：品牌走 og:site_name），模板只作用于 `<title>`。
 *
 * `title.default` 只在页面没有自己的标题时生效（例如根 404），取站点名，与改动前的
 * 静态 `title: "PulseNovel"` 同义（站点名就是 PulseNovel 时字节一致）。
 *
 * L10N P4: `description` 仍是模块加载时求值的 `PUBLIC_SITE_LOCALE` 文案（英文），
 * 公开页都会用自己的 description 覆盖它；按请求语种取根描述属于工单第六块（可选，
 * 本轮不做）。
 */
export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSiteSetting(prisma);
  const siteName = resolveSiteBrandName(settings.siteName);
  return {
    title: { template: `%s | ${siteName}`, default: siteName },
    description: t("meta.siteDescription"),
    // Public pages override this from generateMetadata (innermost wins).
    // `dev-preview` and `(admin)` keep noindex via their own layouts.
    robots: { index: false, follow: false },
  };
}

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
  // 运营 V2（Owner 2026-09-30）：Yandex 只在公开站输出，后台站（admin host）不输出。
  // 读不到请求头时按"不是后台站"处理（与上面 locale 读取失败时回落到默认值同一姿态）。
  let adminHostRequest = false;
  try {
    const requestHeaders = await headers();
    locale = pickSiteLocale(requestHeaders.get(SITE_LOCALE_REQUEST_HEADER));
    adminHostRequest = isAdminHostRequest(requestHeaders.get("host"));
  } catch {
    locale = PUBLIC_SITE_LOCALE;
  }
  const dir = getTextDirection(locale);

  // 渲染时再校验一次（不信任"保存时校验过"）：不合法就整段不输出。
  const yandexVerification = adminHostRequest
    ? null
    : normalizeYandexVerification(settings.yandexVerification);
  const yandexMetricaId = adminHostRequest ? null : normalizeYandexMetricaId(settings.yandexMetricaId);
  const yandexScript = yandexMetricaId ? buildYandexMetricaScript(yandexMetricaId) : null;
  const yandexNoscript = yandexMetricaId ? buildYandexMetricaNoscriptHtml(yandexMetricaId) : null;

  return (
    <html lang={locale} dir={dir}>
      {settings.googleSearchConsoleVerification || yandexVerification || yandexScript ? (
        <head>
          {settings.googleSearchConsoleVerification ? (
            <meta name="google-site-verification" content={settings.googleSearchConsoleVerification} />
          ) : null}
          {yandexVerification ? <meta name="yandex-verification" content={yandexVerification} /> : null}
          {/* 运营要求脚本放 <head>。 */}
          {yandexScript ? <script dangerouslySetInnerHTML={{ __html: yandexScript }} /> : null}
        </head>
      ) : null}
      <body className="site">
        {/* noscript 里是 <div>，放在 <head> 里不是合法 HTML（浏览器会把它挪走），所以放 <body> 开头。 */}
        {yandexNoscript ? <noscript dangerouslySetInnerHTML={{ __html: yandexNoscript }} /> : null}
        {children}
      </body>
      {settings.ga4MeasurementId ? <GoogleAnalytics gaId={settings.ga4MeasurementId} /> : null}
    </html>
  );
}
