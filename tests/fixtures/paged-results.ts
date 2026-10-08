/**
 * UI 用例里把一组卡片 / 文章包成"数据库分页的一页"（B-38 第二段）。
 *
 * 改造前页面自己拿到一整个列表再 `paginateCards` / `paginateBlogCards` 切片；现在加载器
 * （`loadBrowsePage` / `loadCategoryPage` / `loadBlogList`）直接返回一页 + 真实总数，页面只判 404 和渲染。
 * UI 用例 mock 的是加载器，所以需要这个小助手把"这个语种共有这些卡片"翻译成加载器按页码返回的形状。
 * 只是夹具：切片逻辑在真实代码里是数据库的 `OFFSET` / `LIMIT`，由真实库用例证明。
 */
export const TEST_PAGE_SIZE = 20;

export type PagedNovels<T> = { novels: T[]; page: number; totalPages: number; totalCount: number };
export type PagedPosts<T> = { posts: T[]; page: number; totalPages: number; totalCount: number };

function windowOf<T>(items: readonly T[], page: number) {
  const totalCount = items.length;
  const currentPage = Number.isInteger(page) && page > 0 ? page : 1;
  const start = (currentPage - 1) * TEST_PAGE_SIZE;
  return {
    slice: items.slice(start, start + TEST_PAGE_SIZE),
    page: currentPage,
    totalPages: totalCount === 0 ? 1 : Math.max(1, Math.ceil(totalCount / TEST_PAGE_SIZE)),
    totalCount,
  };
}

/** 全部作品页的一页：`items` 是该语种列表的全部卡片（顺序即列表顺序）。 */
export function pagedNovels<T>(items: readonly T[], page = 1): PagedNovels<T> {
  const { slice, ...rest } = windowOf(items, page);
  return { novels: slice, ...rest };
}

/** 博客列表的一页。 */
export function pagedPosts<T>(items: readonly T[], page = 1): PagedPosts<T> {
  const { slice, ...rest } = windowOf(items, page);
  return { posts: slice, ...rest };
}
