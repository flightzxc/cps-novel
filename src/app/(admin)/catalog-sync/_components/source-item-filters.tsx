import { NOVEL_SOURCE_ITEM_STATUSES } from "@/domain/database-statuses";
import { NOVEL_SOURCE_ITEM_STATUS_BADGES } from "@/features/admin-ui/content-view";

export type SourceItemFilterValues = {
  readonly search?: string;
  readonly status?: string;
};

/**
 * Plain `method="GET"` filter bar — `src/app/(admin)/novels/_components/
 * novel-filters.tsx`'s pattern verbatim: field names are the query params, so
 * the filtered URL is shareable and back/forward work with no client state.
 * `page` is not a field for the same reason novel-filters drops it: a new
 * filter invalidates whatever page number was showing.
 */
export function SourceItemFilters({ values }: { values: SourceItemFilterValues }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <form method="GET" className="flex flex-wrap items-center gap-3" role="search">
        <div className="relative min-w-[200px] flex-1">
          <input
            type="text"
            name="search"
            defaultValue={values.search ?? ""}
            aria-label="搜索标题"
            placeholder="搜索来源条目标题…"
            className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <select
          name="status"
          defaultValue={values.status ?? "pending"}
          aria-label="来源条目状态"
          className="rounded-lg border border-gray-300 py-2 pl-3 pr-8 text-sm focus:border-blue-500 focus:outline-none"
        >
          {NOVEL_SOURCE_ITEM_STATUSES.map((status) => (
            <option key={status} value={status}>
              {NOVEL_SOURCE_ITEM_STATUS_BADGES[status].label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
        >
          搜索
        </button>
      </form>
    </div>
  );
}
