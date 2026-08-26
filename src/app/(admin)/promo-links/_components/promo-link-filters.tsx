import { PROMO_LINK_STATUS_LABELS, PROMO_LINK_STATUSES } from "../_lib/promo-link-copy";

export type PromoLinkFilterValues = {
  readonly status?: string;
  readonly novelId?: string;
  readonly limit?: string;
};

const LIMIT_OPTIONS = [20, 50, 100] as const;

/**
 * Same `method="GET"` filter-bar convention as `/tags` and `/tasks`.
 * `novelId` is a free-text UUID field, not a dropdown — there is no novel
 * picker here (`PromoLinkAdminDto` carries only the raw id, no joined
 * title), same "reached by pasting a real id, not guessed from a list"
 * shape `/novels?labelId=…` already uses.
 */
export function PromoLinkFilters({ values }: { values: PromoLinkFilterValues }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <form method="GET" className="flex flex-wrap items-center gap-3" role="search">
        <select
          name="status"
          defaultValue={values.status ?? ""}
          aria-label="推广链接状态"
          className="rounded-lg border border-gray-300 py-2 pl-3 pr-8 text-sm focus:border-blue-500 focus:outline-none"
        >
          <option value="">全部状态</option>
          {PROMO_LINK_STATUSES.map((status) => (
            <option key={status} value={status}>
              {PROMO_LINK_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
        <div className="relative min-w-[220px] flex-1">
          <input
            type="text"
            name="novelId"
            defaultValue={values.novelId ?? ""}
            aria-label="按 novelId 精确筛选"
            placeholder="novelId（精确匹配，选填）…"
            className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <select
          name="limit"
          defaultValue={values.limit ?? ""}
          aria-label="显示条数上限"
          className="rounded-lg border border-gray-300 py-2 pl-3 pr-8 text-sm focus:border-blue-500 focus:outline-none"
        >
          {LIMIT_OPTIONS.map((limit) => (
            <option key={limit} value={limit}>
              最近 {limit} 条
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
        >
          筛选
        </button>
      </form>
    </div>
  );
}
