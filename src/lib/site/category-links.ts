/**
 * 站内 `/category/{slug}` 链接的唯一闸门（B-38 第二部分，2026-10-07）。
 *
 * 问题：标签的 `href` 在 `public-taxonomy.ts` 的投影里一律拼成 `{前缀}/category/{slug}`，只要标签是
 * active 的就有；而分类页（`getPublicCategoryPage`）只在 `listPublicArticles` 的最新 `PUBLIC_LIST_CAP`
 * （240）本里按分类过滤、结果为 0 就 404。列表卡片（首页、浏览、分类页）的标签来自这 240 本自己，
 * 天然在窗口里，链接一定是 200；但详情页的标签来自**这本书**的全部 active 分类（不看窗口），
 * en 的书 98% 以上在窗口之外，冷门分类在窗口里一本都没有时，详情页上的标签链接就是 404，
 * 会被搜索引擎顺着抓、浪费抓取预算。详情页的推荐候选池（500 本）里的卡片同理。
 *
 * 规则：一个标签只有在它的 slug 属于"该语种分类页返回 200 的分类集合"时才保留 `href`；
 * 否则去掉 `href`，`Tag` 组件对没有 `href` 的标签本来就渲染成 `<span>`（纯文字）。
 *
 * 🔴 "分类页返回 200 的分类集合"的来源不在这里另写——这里只做"拿到集合之后怎么用"。集合取自
 * `listPublicCategories`（页脚与首页题材导航用的那一份，`loadPublicCategories`，同一请求内已被页脚
 * 取过，复用它新增 0 次数据库查询）。它与 `category-queries.ts` 的唯一谓词 `cardsInCategory`
 * （`getPublicCategoryPage` 与 `listPublicCategoryPageCounts` 共用）是同一个窗口、同一套标签投影，
 * 两者的 slug 集合恒等；这一点由
 * `tests/backend/site/category-link-set-equality.test.ts`（默认 `npm test`）与
 * `tests/integration/tasks/sitemap-category-cap-postgres.test.ts`（真实库）钉死——改动其中任何一个的
 * 窗口 / 过滤 / 标签投影，必须让这两条用例继续成立，否则详情页会重新出现 404 链接。
 */
import type { SiteTag } from "@/features/public-ui/types";

export type LinkableCategorySlugs = ReadonlySet<string>;

/** 把"该语种有书的分类列表"（`listPublicCategories` 的结果）折成 slug 集合。 */
export function toLinkableCategorySlugs(categories: readonly Pick<SiteTag, "slug">[]): LinkableCategorySlugs {
  return new Set(categories.map((category) => category.slug));
}

function withoutHref<T extends SiteTag>(tag: T): T {
  // 复制后删掉 `href` 这个 key（不是置成 undefined）：`Tag` 按 `tag.href` 真假分链接 / 纯文字，
  // 且断言"没有 href"的用例看的是 key 不存在。投影出来的标签是冻结的，这里保持同样的不可变。
  const copy: SiteTag = { ...tag };
  delete copy.href;
  return Object.freeze(copy) as unknown as T;
}

/** 窗口之外的标签去掉 `href`（渲染成纯文字），窗口之内的原样保留；标签的顺序与其余字段不变。 */
export function restrictTagLinks<T extends SiteTag>(tags: readonly T[], linkable: LinkableCategorySlugs): T[] {
  return tags.map((tag) => (tag.href === undefined || linkable.has(tag.slug) ? tag : withoutHref(tag)));
}

/**
 * 对带 `tags` 的视图（详情页 `NovelDetailView`、卡片 `NovelCardView`）应用 {@link restrictTagLinks}。
 * 没有任何标签需要改动时原样返回同一个对象。
 */
export function restrictViewTagLinks<V extends { tags: readonly SiteTag[] }>(
  view: V,
  linkable: LinkableCategorySlugs,
): V {
  const tags = restrictTagLinks(view.tags, linkable);
  return tags.every((tag, index) => tag === view.tags[index]) ? view : { ...view, tags };
}
