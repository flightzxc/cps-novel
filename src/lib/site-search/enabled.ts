/**
 * 前台站内搜索开关（PN-15）。
 *
 * 开关是后台"站点设置"里的一个布尔字段 `siteSearchEnabled`（`site_setting.site_search_enabled`，默认关；
 * 字段由"后台开关"分支加进站点设置快照）。**不用环境变量**（Owner 2026-10-09）。
 * 读到的值不是 `true`（缺字段、`false`、`undefined`）一律按关——所以在字段还没有合入的分支上，
 * 生产路径恒为"关"，合并后自动生效。
 *
 * 参数类型写成 `object & {…}` 而不是裸的 `{ siteSearchEnabled?: boolean }`：后者是 TypeScript 的"弱类型"
 * （全部属性可选），把一个**还没有**这个字段的站点设置快照传进来会报 TS2559；字段合入之后两种写法等价。
 */
export function isSiteSearchEnabled(settings: object & { readonly siteSearchEnabled?: boolean }): boolean {
  return settings.siteSearchEnabled === true;
}
