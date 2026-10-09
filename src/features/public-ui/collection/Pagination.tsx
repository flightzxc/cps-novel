import Link from "next/link";

import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";

/**
 * Public collection prev/next pager.
 *
 * Ported from CPS `src/components/site/pagination.tsx` (d77c3b9).
 * next-intl / i18n Link replaced with next/link + catalog copy via `t()`;
 * PulseDrama tokens replaced with novel-* tokens.
 * Hidden entirely when there is only one page.
 *
 * PN-15（站内搜索）：可选 `prefetch`，原样透传给两个 `next/link` 的 `Link`。**不传时行为与此前完全一致**
 * （不向 `Link` 传 `prefetch`，浏览/分类/博客的翻页链接逐字节不变）。搜索结果页传 `false`：否则每显示一页结果，
 * 浏览器会在后台顺带请求下一页，多跑一次搜索查询。
 */

export interface PaginationProps {
  locale: SiteLocale;
  currentPage: number;
  totalPages: number;
  basePath: string;
  searchParams?: Readonly<Record<string, string>>;
  /** 透传给翻页链接的 `prefetch`；省略 = 不传（`next/link` 的默认行为）。 */
  prefetch?: boolean;
}

export function Pagination({
  locale,
  currentPage,
  totalPages,
  basePath,
  searchParams = {},
  prefetch,
}: PaginationProps) {
  if (totalPages <= 1) return null;

  const t = getPublicT(locale);
  const prevPage = currentPage - 1;
  const nextPage = currentPage + 1;
  const pageUrl = (page: number) => {
    const params = new URLSearchParams(searchParams);
    if (page > 1) params.set("page", String(page));
    else params.delete("page");
    const query = params.toString();
    return query ? `${basePath}?${query}` : basePath;
  };
  // 只有调用方传了才带上这个属性；不传时两个 `Link` 的 props 与改动前完全相同。
  const prefetchProp = prefetch === undefined ? {} : { prefetch };
  const prevUrl = pageUrl(prevPage);
  const nextUrl = pageUrl(nextPage);

  return (
    <nav
      aria-label={t("pagination.label")}
      data-testid="pagination"
      className="mt-8 flex items-center justify-center gap-3"
    >
      {currentPage > 1 ? (
        <Link
          href={prevUrl}
          {...prefetchProp}
          className="inline-flex items-center gap-1.5 rounded-novel-md border border-novel-border-strong bg-transparent px-5 py-2.5 text-sm font-medium text-novel-fg transition-colors hover:bg-novel-bg-raised"
        >
          <svg className="h-4 w-4 rtl:-scale-x-100" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          {t("pagination.previous")}
        </Link>
      ) : (
        <div className="w-[5.5rem]" />
      )}

      <span className="text-sm text-novel-fg-subtle tabular-nums">
        {t("pagination.pageOf", { current: currentPage, total: totalPages })}
      </span>

      {currentPage < totalPages ? (
        <Link
          href={nextUrl}
          {...prefetchProp}
          className="inline-flex items-center gap-1.5 rounded-novel-md border border-novel-border-strong bg-transparent px-5 py-2.5 text-sm font-medium text-novel-fg transition-colors hover:bg-novel-bg-raised"
        >
          {t("pagination.next")}
          <svg className="h-4 w-4 rtl:-scale-x-100" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>
      ) : (
        <div className="w-[5.5rem]" />
      )}
    </nav>
  );
}
