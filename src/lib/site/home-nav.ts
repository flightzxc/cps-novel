/**
 * 首页题材导航的选择规则（v0.5.15，运营勾选）。
 *
 * 前台首页那一排题材按钮 = 运营在后台"分类管理"勾选的（`canonical_tag.is_homepage_visible = true`）
 * **且**该语种有书的分类。"该语种有书"这一半已经由 `listPublicCategories` 给出（每语种每分类本数矩阵里本数 > 0
 * 的分类），这里只补"勾选"那一半：把每一项上搭车读出来的 `homepageVisible` 为 true 的留下。
 *
 * 规则（方案决定 1/4/5，H3/H4）：
 *   - 只保留 `homepageVisible === true` 的项；严格比较，缺失（undefined）当作未勾选，宁可少显示也不误显示；
 *   - 顺序不变——沿用调用方给的顺序（`listPublicCategories` 已按分类自身排序号、再 slug 排好），过滤不重排；
 *   - 交集为空就返回空数组，**不回退**成"显示全部有书的分类"（`HomeScreen` 对空数组不渲染这一排）。
 *
 * 🔴 只有首页 `HomeBody` 调用它。页脚（`chrome.ts` 的 `categories.slice(0, 8)`）、详情页"可链接分类集合"
 * （`public-load.ts` 的 `withLinkableTagHrefs`）、分类页、站点地图一律拿未过滤的那一份——网址冻结期内这些
 * 链接与收录都不能因运营勾选而变（方案第五节）。
 */
export function selectHomepageNavCategories<T extends Readonly<{ homepageVisible: boolean }>>(
  categories: readonly T[],
): T[] {
  return categories.filter((category) => category.homepageVisible === true);
}
