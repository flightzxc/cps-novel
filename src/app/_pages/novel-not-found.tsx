import type { Metadata } from "next";

import { loadActiveLocales, loadChrome } from "@/app/_lib/public-load";
import { noIndexMetadata } from "@/app/_lib/seo-metadata";
import { SiteShell } from "@/features/public-ui/layout/SiteShell";
import { PublicStatusPanel } from "@/features/public-ui/status/PublicStatusPanel";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";
import { localePrefix } from "@/lib/slug/article-path";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

/**
 * Novel-segment not-found shared body (WO-1 §6.1): extracted verbatim out of
 * `src/app/novel/[slugParam]/not-found.tsx`, `PUBLIC_SITE_LOCALE` swapped
 * for the `locale` parameter. No other semantics changed.
 *
 * `notFoundMetadata` used to be locale-invariant (`{ index: false, follow: false }`
 * regardless of locale) and exported once so both shells re-exported the identical
 * object. It now also carries a localized `title` (see `buildNotFoundMetadata` below):
 * the bare-path shell re-exports the default-locale constant, the `[locale]`-prefixed
 * shell builds it per request (`generateMetadata`).
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
/**
 * TKD 对齐 CPS（Owner 2026-09-30，施工工单第二节验收表"404 → Not found | 站点名，仍为 noindex"）：
 * 真实渲染验证发现，`notFound()` 抛出后 Next 用的是 not-found 约定文件自己的元数据，页面
 * `generateMetadata` 返回的 "Not found" 标题不会出现在 404 响应里——此前 not-found 文件的元数据只有
 * robots，标题落到根布局的 `title.default`（站点名），与验收表不符。这里补上标题；品牌后缀仍由根布局
 * 的标题模板加。标题按语种取文案（`meta.notFound`），仍不带 description（不覆盖根布局继承的描述）。
 * 与下面新的 404 页正文（`notFoundPage.*`、带站名页头页脚）互不影响：正文是组件，这里只是 `<head>`。
 */
export function buildNotFoundMetadata(locale: SiteLocale): Metadata {
  return noIndexMetadata(getPublicT(locale)("meta.notFound"));
}

/** 默认语种（英文）版本，供不带语种前缀的 not-found 壳直接 `export const metadata` 使用。 */
export const notFoundMetadata: Metadata = buildNotFoundMetadata(PUBLIC_SITE_LOCALE);

/**
 * 2026-09-30（404 页面照搬 CPS，Owner 拍板）：这里以前渲染的是
 * `UnavailableScreen reason="unpublished"`——"暂时不可用，地址仍然有效"的下架
 * 文案，而且没传 `chrome`，`SiteShell` 默认 `{}`，页头页脚的品牌位就露出
 * `BRAND_PLACEHOLDER`。一个根本不存在的地址（或者被切换器送进死路的地址）
 * 既不是"暂时不可用"，也不该让读者看到未配置的占位字样。
 *
 * 现在是真正的 404 页：文案用现成的 `notFoundPage.*`（15 个语种都已翻译，不新增
 * 译文），页头页脚带上后台设置的站名与导航（`loadChrome` + `loadActiveLocales`，
 * 与站内其它页面同一条加载路径；`getSiteSetting` 有进程级缓存，`React.cache`
 * 又让同一次请求里页面已经加载过的 chrome 在这里直接命中）。真正的下架/撤回页
 * （`UnavailableScreen` 的正常分支）不受影响，仍由详情页/章节页自己渲染。
 *
 * chrome 加载失败（数据库不可用）时降级为无页头页脚的裸 404 面板——404 页自己
 * 不能因为取不到站名就变成 500；裸面板没有品牌位，也就不会出现占位符。HTTP
 * 状态码仍由 Next 的 `notFound()` 边界给 404，这里不涉及。
 */
export async function NovelNotFoundBody({ locale }: { locale: SiteLocale }) {
  const t = getPublicT(locale);

  let chrome: Awaited<ReturnType<typeof loadChrome>>["chrome"] | null = null;
  try {
    const activeLocales = await loadActiveLocales();
    ({ chrome } = await loadChrome(locale, undefined, undefined, activeLocales));
  } catch {
    chrome = null;
  }

  const panel = (bare: boolean) => (
    <PublicStatusPanel
      bare={bare}
      testId="public-not-found-panel"
      title={t("notFoundPage.title")}
      body={t("notFoundPage.body")}
      homeHref={localePrefix(locale) || "/"}
      homeLabel={t("unavailable.returnHome")}
    />
  );

  if (!chrome) return panel(true);
  return (
    <SiteShell locale={locale} chrome={chrome}>
      {panel(false)}
    </SiteShell>
  );
}
