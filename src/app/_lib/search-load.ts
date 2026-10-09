import { cache } from "react";

import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { searchSiteCached } from "@/lib/site-search/site-search-service";
import type { SiteSearchInput, SiteSearchResponse } from "@/lib/site-search/types";

/**
 * 搜索页的请求内去重加载器（照 CPS `search-page-state.ts` 的 `createSearchPageResultLoader`）。
 *
 * `generateMetadata` 与页面正文会在同一次 RSC 请求里各自需要搜索结果。`React.cache` 以三个原始值参数
 * （语种、原始 `q`、页码）作请求内的键，所以即便进程级缓存没命中（例如刚过期），同一次请求也只执行一次底层搜索——
 * 与 `public-load.ts` 里 `loadBrowsePage` 等加载器同一个做法。
 *
 * 为什么不放进 `public-load.ts`：这里要把 `memoize` 与 `search` 作为参数暴露出来给用例注入（`React.cache`
 * 在 RSC 之外不去重，没法直接测"同一次请求只查一次"），而 `public-load.ts` 的导出集合被若干用例按固定工厂 mock。
 */
type SearchPageLoader = (locale: SiteLocale, rawQuery: string, page: number) => Promise<SiteSearchResponse>;

type Memoize = <Args extends unknown[], Result>(fn: (...args: Args) => Result) => (...args: Args) => Result;

type SearchFn = (input: SiteSearchInput) => Promise<SiteSearchResponse>;

export function createSearchPageLoader(memoize: Memoize = cache, search: SearchFn = searchSiteCached): SearchPageLoader {
  return memoize((locale: SiteLocale, rawQuery: string, page: number) => search({ locale, query: rawQuery, page }));
}

export const loadSearchPage: SearchPageLoader = createSearchPageLoader();
