import type { Metadata } from "next";

import { loadActiveLocales, loadChrome } from "@/app/_lib/public-load";
import { SiteShell } from "@/features/public-ui/layout/SiteShell";
import { PublicStatusPanel } from "@/features/public-ui/status/PublicStatusPanel";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";
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
export const notFoundMetadata: Metadata = {
  robots: { index: false, follow: false },
};

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
