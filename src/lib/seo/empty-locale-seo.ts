/**
 * 空语种的收录策略（PN-09，Owner 2026-10-08：没有书时连入口也隐藏）。
 *
 * 首页、书库 `/browse`、博客列表 `/blog` 这三类"每个已登记语种都会返回 200"的入口页，
 * 在语种为空（`isEmptyLocale`，即不在动态层活跃语种集合里）时：
 *
 *  - `robots` 输出 `{ index: false, follow: true }`——不收录，但允许跟随页内链接；
 *  - `alternates.languages` 输出空对象 `{}`——不再声明任何跨语种 hreflang（含自指与
 *    `x-default`）。不收录的页面不该出现在别的语种页面的 hreflang 里，也不该自己宣告
 *    语种集群；canonical 仍保留自身。
 *
 * 语种一旦有了书，活跃语种集合就会包含它（`revalidatePublicListings()` 在每次发布状态变更时
 * 立刻让集合缓存失效，最长也只等 300 秒），这两个函数随即回到 `undefined` / 正常 hreflang，
 * 不需要任何人工操作。
 *
 * 非空语种：`robots` 保持各模板原有取值（`undefined`，由 `toNextMetadata` 落成
 * `{ index: true, follow: true }`），hreflang 只列活跃语种（外加当前页自己的语种，
 * 见 `buildHreflangAlternates`），不再盲目枚举全部 15 个登记语种。
 *
 * 本文件不读数据库：活跃语种集合由调用方（页面层的 `loadActiveLocales()`）传入。
 */
import { isEmptyLocale } from "@/lib/locale/empty-locale";

import { buildHreflangAlternates } from "./seo-utils";

export const NOINDEX_FOLLOW_ROBOTS = { index: false, follow: true } as const;

/** 空语种 → noindex；否则 `undefined`（调用方沿用自己原有的 robots 取值）。 */
export function emptyLocaleRobots(
  locale: string,
  activeLocales: readonly string[],
): { index: boolean; follow: boolean } | undefined {
  return isEmptyLocale(locale, activeLocales) ? { ...NOINDEX_FOLLOW_ROBOTS } : undefined;
}

/**
 * 同相对路径页面（首页 `/`、`/browse`、`/blog`）的 hreflang：空语种 → `{}`；
 * 否则只枚举活跃语种。路径随语种变化的页面（小说、章节、分类）不要用它，见
 * `buildHreflangAlternates` 的说明。
 */
export function buildActiveLocaleAlternates(
  path: string,
  currentLocale: string,
  activeLocales: readonly string[],
): Record<string, string> {
  if (isEmptyLocale(currentLocale, activeLocales)) return {};
  return buildHreflangAlternates(path, currentLocale, activeLocales);
}
