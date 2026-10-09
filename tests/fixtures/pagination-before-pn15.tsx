/**
 * 冻结参照：PN-15 给 `Pagination` 加可选 `prefetch` 之前的原样实现（基线 0afab4e920ad007e68c8ad1b66b0f04e22e04ae0，
 * `src/features/public-ui/collection/Pagination.tsx` 逐字拷贝，仅把导出组件改名为 `PaginationBeforePn15`）。
 *
 * 用途：`tests/ui/pagination-prefetch.test.tsx` 拿它与现在的 `Pagination` 逐字节比较渲染结果——
 * 浏览 / 分类 / 博客列表的翻页链接在网址冻结下必须与改动前一字不差。这是测试夹具，不是产品代码，不要"顺手同步"。
 */
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
 */

export interface PaginationPropsBeforePn15 {
  locale: SiteLocale;
  currentPage: number;
  totalPages: number;
  basePath: string;
  searchParams?: Readonly<Record<string, string>>;
}

export function PaginationBeforePn15({
  locale,
  currentPage,
  totalPages,
  basePath,
  searchParams = {},
}: PaginationPropsBeforePn15) {
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
