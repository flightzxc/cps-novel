import Link from "next/link";

import { getPublicT } from "@/lib/locale/messages";

/**
 * Public collection prev/next pager.
 *
 * Ported from CPS `src/components/site/pagination.tsx` (d77c3b9).
 * next-intl / i18n Link replaced with next/link + catalog copy via `t()`;
 * PulseDrama tokens replaced with novel-* tokens.
 * Hidden entirely when there is only one page.
 */

export interface PaginationProps {
  currentPage: number;
  totalPages: number;
  basePath: string;
}

export function Pagination({
  currentPage,
  totalPages,
  basePath,
}: PaginationProps) {
  if (totalPages <= 1) return null;

  const t = getPublicT();
  const prevPage = currentPage - 1;
  const nextPage = currentPage + 1;
  const prevUrl = prevPage <= 1 ? basePath : `${basePath}?page=${prevPage}`;
  const nextUrl = `${basePath}?page=${nextPage}`;

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
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>
      ) : (
        <div className="w-[5.5rem]" />
      )}
    </nav>
  );
}
