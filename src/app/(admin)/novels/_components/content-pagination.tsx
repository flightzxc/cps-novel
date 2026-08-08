import Link from "next/link";

/**
 * Pagination footer. CPS `(admin)/dramas/page.tsx:166-196` in behaviour — a
 * "第 x / y 页，共 n 条" line on the left, prev/next on the right, and the whole
 * block hidden when there is only one page.
 *
 * The one deliberate departure is how the href is built. CPS concatenates each
 * filter by hand, which is why its `search` values break on `&`. Here the
 * current parameters are cloned and only `page` is overwritten, so a filter this
 * component has never heard of still survives paging.
 */
export function ContentPagination({
  basePath,
  params,
  page,
  totalPages,
  total,
}: {
  basePath: string;
  params: Readonly<Record<string, string | undefined>>;
  page: number;
  totalPages: number;
  total: number;
}) {
  if (totalPages <= 1) return null;

  const href = (target: number): string => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "" && key !== "page") next.set(key, value);
    }
    next.set("page", String(target));
    return `${basePath}?${next.toString()}`;
  };

  return (
    <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-4 py-3">
      <p className="text-sm text-gray-500">
        第 {page} / {totalPages} 页，共 {total} 条
      </p>
      <div className="flex gap-2">
        {page > 1 && (
          <Link
            href={href(page - 1)}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
          >
            上一页
          </Link>
        )}
        {page < totalPages && (
          <Link
            href={href(page + 1)}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
          >
            下一页
          </Link>
        )}
      </div>
    </div>
  );
}
