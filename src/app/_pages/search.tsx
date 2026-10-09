import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { loadActiveLocales, loadChrome } from "@/app/_lib/public-load";
import { loadSearchPage } from "@/app/_lib/search-load";
import { SearchScreen } from "@/features/public-ui/search/SearchScreen";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";
import { isSiteSearchEnabled } from "@/lib/site-search/enabled";
import { buildSearchPageMetadata } from "@/lib/site-search/metadata";
import type { SiteSearchResponse } from "@/lib/site-search/types";

/**
 * 站内搜索页共享正文（PN-15）：`src/app/search/page.tsx`（英语，裸路径）与
 * `src/app/[locale]/search/page.tsx`（其它 14 个语种）都是薄壳，委托这里，结构照 `browse.tsx`。
 *
 * ## 网址与参数（方案第〇节，写死）
 *
 * - `q`：重复时取第一个；`page`：空 = 第 1 页，其余必须匹配 `^[1-9]\d*$`（同"全部作品"页），否则 404；
 *   其它参数一律忽略。
 * - 页码越界 404：`ok` 且 `page > totalPages`（没有结果时 `totalPages` 恒为 1，所以只有第 1 页合法）；
 *   没输入 / 太短 / 太长的状态没有"页"，`page > 1` 同样 404。数据库出错（`unavailable`）不判页码——
 *   此时不知道总页数，读者看到的是"暂不可用"提示而不是 404。
 * - 后台开关（`siteSearchEnabled`）关闭 → `notFound()`，元数据 `noindex,nofollow`；开关先于查询判断，
 *   关闭时不碰数据库的搜索路径。
 *
 * ## 请求内去重
 *
 * `generateMetadata` 与正文共用 `loadSearchPage`（`React.cache`，按 语种/原始 q/页码 分键），同一次请求只查一次。
 * `loadChrome`/`loadActiveLocales` 同样是请求内去重的，两处用同样的实参调用。
 */

export type SearchSearchParams = { q?: string | string[]; page?: string | string[] };

function firstValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

function parsePageParam(raw: string | string[] | undefined): number | null {
  const value = firstValue(raw);
  if (value === undefined || value === "") return 1;
  if (!/^[1-9]\d*$/.test(value)) return null;
  return Number(value);
}

type SearchPageState =
  | { kind: "disabled"; settings: Awaited<ReturnType<typeof loadChrome>>["settings"] }
  | { kind: "not-found" }
  | {
      kind: "ready";
      settings: Awaited<ReturnType<typeof loadChrome>>["settings"];
      chrome: Awaited<ReturnType<typeof loadChrome>>["chrome"];
      result: SiteSearchResponse;
    };

async function loadSearchState(locale: SiteLocale, searchParams: SearchSearchParams): Promise<SearchPageState> {
  const activeLocales = await loadActiveLocales();
  // current = "search"：页头的搜索入口按"当前页"高亮（PN-15 第二批页头接线）。
  const { settings, chrome } = await loadChrome(locale, "search", undefined, activeLocales);
  if (!isSiteSearchEnabled(settings)) return { kind: "disabled", settings };

  const requestedPage = parsePageParam(searchParams.page);
  if (requestedPage === null) return { kind: "not-found" };

  const result = await loadSearchPage(locale, firstValue(searchParams.q) ?? "", requestedPage);
  // 用解析出的 `requestedPage` 比，不用 `result.page`：服务层把装不进安全整数的页码当第 1 页查，
  // 越界判定必须看读者真正请求的页码（同 `browse.tsx`）。
  if (result.status === "ok" && requestedPage > result.totalPages) return { kind: "not-found" };
  if ((result.status === "idle" || result.status === "too_short" || result.status === "too_long") && requestedPage > 1) {
    return { kind: "not-found" };
  }
  return { kind: "ready", settings, chrome, result };
}

export async function buildSearchMetadata(
  locale: SiteLocale,
  searchParams: Promise<SearchSearchParams>,
): Promise<Metadata> {
  const state = await loadSearchState(locale, await searchParams);
  const t = getPublicT(locale);

  if (state.kind === "not-found") {
    return { title: t("meta.notFound"), robots: { index: false, follow: false } };
  }

  return buildSearchPageMetadata({
    enabled: state.kind === "ready",
    locale,
    t,
    settings: state.settings,
    result:
      state.kind === "ready"
        ? {
            status: state.result.status,
            displayQuery: state.result.displayQuery,
            itemCount: state.result.items.length,
            page: state.result.page,
          }
        : null,
  });
}

export async function SearchBody({
  locale,
  searchParams,
}: {
  locale: SiteLocale;
  searchParams: Promise<SearchSearchParams>;
}) {
  const state = await loadSearchState(locale, await searchParams);
  if (state.kind !== "ready") notFound();
  return <SearchScreen locale={locale} chrome={state.chrome} result={state.result} />;
}
