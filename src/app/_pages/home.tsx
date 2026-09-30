import type { Metadata } from "next";

import { JsonLd } from "@/app/_components/json-ld";
import { loadActiveLocales, loadChrome, loadHomeCarousel, loadHomeNovels, loadPublicCategories } from "@/app/_lib/public-load";
import { toNextMetadata } from "@/app/_lib/seo-metadata";
import { HomeScreen } from "@/features/public-ui/home/HomeScreen";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";
import { generateSeoMeta } from "@/lib/seo/seo-meta-generator";
import { localePrefix } from "@/lib/slug/article-path";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

/**
 * Home page shared body (WO-1 `施工工单_WO1-3_多语种公开站地基_2026-09-08.md`
 * §6.1): extracted verbatim out of `src/app/page.tsx`, `PUBLIC_SITE_LOCALE`
 * swapped for the `locale` parameter — no other line's semantics changed
 * (query order, `Promise.all` grouping, SEO field construction all as they
 * were). `src/app/page.tsx` (bare path) and `src/app/[locale]/page.tsx`
 * (locale-prefixed) are now both thin shells over `buildHomeMetadata` /
 * `HomeBody` below.
 *
 * N-9 (lane D): both `buildHomeMetadata` and `HomeBody` below fetch
 * categories via `loadPublicCategories(locale)` — a `React.cache()`-scoped
 * call that dedupes to one `listPublicCategories` round-trip per request —
 * and hand the same array into `loadChrome(locale, "home", categories)`,
 * which is itself request-deduped the same way. Previously each function
 * called `loadChrome("home")` alone (which ran its own internal, un-deduped-
 * relative-to-this categories query) *and* `HomePage` separately called
 * `loadPublicCategories` again for `HomeScreen`'s prop — two independent
 * `listPublicCategories` round-trips for identical data. See
 * `tests/backend/site/public-query-budget.test.ts` for the regression gate.
 */
/**
 * CPS parity fix (公开页 description 补齐, 2026-09-10): CPS's
 * `[locale]/(site)/layout.tsx` `generateMetadata` guarantees a non-empty
 * home description via `(useSettingsMetadata && settings?.homeMetaDescription)
 * || t("homeDescriptionFallback")` — a message-catalog string is always the
 * last fallback tier. This file's own two-tier chain (`settings.
 * homeMetaDescription || settings.siteDescription`) had no such floor: with
 * both SiteSetting fields empty (the actual production state today),
 * `description` resolved to `""`. Next's `Meta()` helper
 * (`node_modules/next/dist/lib/metadata/generate/meta.js`) explicitly skips
 * rendering a tag whose `content` is `""` — not just `null`/`undefined` — so
 * the emitted `<head>` had no `<meta name="description">` at all, even
 * though the root layout (`src/app/layout.tsx`) sets one: a child segment's
 * `generateMetadata` returning `description: ""` overrides the parent's
 * value with that empty string rather than being skipped (`resolve-
 * metadata.js`'s per-field merge is `metadata[key] ?? null`, and `"" ?? null`
 * is `""`). Threading the existing `meta.siteDescription` catalog key in as
 * a third tier closes that gap without inventing new copy — the same
 * sentence root layout already uses.
 */
/**
 * 首页 SEO 输入的唯一取法（`buildHomeMetadata` 与 `HomeBody` 共用，复核 A3）：
 *
 * 后台"首页标题/首页描述/站点描述"只有一个值（不分语种），运营一填，15 语的首页都会显示同一句
 * 英文——所以只有默认语种（英文）读它们，其余语种直接读各自的文案（TKD 对齐 CPS，Owner
 * 2026-09-30；照 CPS `(site)/page.tsx` 的 `useSettingsMetadata = locale === "en"`）。判断用仓库
 * 现成的默认语种常量 `PUBLIC_SITE_LOCALE`，不另写字面量。
 *
 * `HomeBody` 里的 WebSite JSON-LD 曾经保留旧的后台值链（为"本轮不动结构化数据"），结果 `/ja`
 * 首页的 `<meta description>` 是 ja 文案、JSON-LD 的 description 却是英文后台值。两处现在共用
 * 这个函数，不会再分叉；`tests/ui/seo/default-locale-only-settings.test.ts` 钉住 meta 与 JSON-LD
 * 两侧。
 */
function homeSeoData(
  locale: SiteLocale,
  settings: Awaited<ReturnType<typeof loadChrome>>["settings"],
  novels: Awaited<ReturnType<typeof loadHomeNovels>>,
) {
  const t = getPublicT(locale);
  const useSettingsMetadata = locale === PUBLIC_SITE_LOCALE;
  return {
    siteName: settings.siteName,
    title: (useSettingsMetadata && settings.homeMetaTitle) || t("meta.homeTitleFallback"),
    description:
      (useSettingsMetadata && (settings.homeMetaDescription || settings.siteDescription)) ||
      t("meta.siteDescription"),
    defaultOgImage: settings.defaultOgImage.trim() || novels[0]?.coverUrl || null,
  };
}

export async function buildHomeMetadata(locale: SiteLocale): Promise<Metadata> {
  const categories = await loadPublicCategories(locale);
  const [{ settings }, novels] = await Promise.all([
    loadChrome(locale, "home", categories),
    loadHomeNovels(locale),
  ]);
  const seo = generateSeoMeta({ entity: "home", locale, data: homeSeoData(locale, settings, novels) });
  // 🔴 `title.absolute`，不是字符串：根布局有 `%s | 站点名` 模板（TKD 对齐 CPS，
  // Owner 2026-09-30），首页标题不套模板（CPS 首页同样不带后缀）。英文首页与根布局
  // 同层、本来就不套；`/ja` 等非英语首页隔了一层 `[locale]` 布局，会被 Next 16.1.6
  // 套上后缀，不写绝对标题 15 语首页就不一致。og:title/twitter:title 本来就不带后缀，
  // 沿用 `seo.openGraph.title`。见 `tests/ui/seo/real-metadata-merge.test.ts`。
  return { ...toNextMetadata(seo), title: { absolute: seo.title } };
}

export async function HomeBody({ locale }: { locale: SiteLocale }) {
  const categories = await loadPublicCategories(locale);
  const activeLocales = await loadActiveLocales();
  const [{ settings, chrome }, novels, featuredList] = await Promise.all([
    loadChrome(locale, "home", categories, activeLocales),
    loadHomeNovels(locale),
    loadHomeCarousel(locale),
  ]);
  // 与 `buildHomeMetadata` 同一个 `homeSeoData`：这里的 `seo` 只取 JSON-LD（`seo.other`），不输出
  // <title>/<meta>，但 WebSite JSON-LD 的 description 必须与 meta 一致（复核 A3）。
  const seo = generateSeoMeta({ entity: "home", locale, data: homeSeoData(locale, settings, novels) });

  return (
    <>
      {seo.other ? <JsonLd json={seo.other["application/ld+json"]} /> : null}
      <HomeScreen
        locale={locale}
        chrome={chrome}
        featuredList={featuredList}
        novels={novels}
        browseAllHref={`${localePrefix(locale)}/browse`}
        categories={categories}
      />
    </>
  );
}
