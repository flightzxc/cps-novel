/**
 * 站点品牌名的唯一取法（TKD 对齐 CPS，Owner 2026-09-30）。
 *
 * 根布局的标题模板（`%s | 站点名`）和"数据库来源的标题先去掉末尾已有的
 * `| 站点名` 再交给布局"这两处必须用同一个站点名，否则去重去掉的和布局
 * 加上的不是同一个词，重复就会漏过去。所以取法只写在这里：读后台
 * `SiteSetting.siteName`，去首尾空白，为空时用代码内置的 `PulseNovel`
 * ——照 CPS `[locale]/(site)/layout.tsx` 的 `settings?.siteName || "PulseDrama"`。
 *
 * 只用于页面 `<title>` 的品牌后缀，不用于 chrome 展示：`chromeFromSiteSetting`
 * 仍然把后台配置值原样透传（见 `tests/ui/site-chrome-brand-name.test.ts`）。
 */
export const FALLBACK_SITE_NAME = "PulseNovel";

export function resolveSiteBrandName(siteName: string | null | undefined): string {
  return siteName?.trim() || FALLBACK_SITE_NAME;
}
