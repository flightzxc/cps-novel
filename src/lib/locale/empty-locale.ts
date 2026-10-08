/**
 * "空语种"的唯一判定（PN-09，Owner 2026-10-08：没有书时连入口也隐藏）。
 *
 * 空语种 = 该语种当前没有任何公开可见的已发布书——也就是它**不在**动态层的活跃语种集合里
 * （`getActiveLocales()` / `queryActiveLocales()`，`./active-locales.ts`；那份集合用
 * `sitemap.ts#activePublicArticleWhere` 判"公开可见"，站内所有"这个语种有没有书"的问题
 * 都由它回答）。本模块**不查数据库、不另写一份"有没有书"的谓词**，只把"不在集合里"这件事
 * 命名成一个函数，让菜单、robots、hreflang 三处消费方共用同一个口径。
 *
 * 默认语种 `en` 永远不算空：它是根路径 `/` 与 `x-default` 的落点，隐藏它没有意义，也与
 * `queryActiveLocales` 无条件把 `en` 种入集合的做法一致（CPS `active.add("en")`）。
 *
 * 零依赖模块（只读一个常量）：SEO 模板与 `"use client"` 的语言菜单都可以安全引入，
 * 不会把 `prisma` / `unstable_cache` 拖进客户端包——同 `active-locales-tag.ts` 单独拆出的理由。
 */
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

export function isEmptyLocale(locale: string, activeLocales: readonly string[]): boolean {
  if (locale === PUBLIC_SITE_LOCALE) return false;
  return !activeLocales.includes(locale);
}
