import { NOVEL_STATUSES } from "@/domain/database-statuses";
import { NOVEL_STATUS_BADGES } from "@/features/admin-ui/content-view";
import { SITE_LOCALES } from "@/lib/locale/locale-canonical";

export type NovelFilterValues = {
  readonly search?: string;
  readonly status?: string;
  readonly locale?: string;
};

/**
 * Filter bar. CPS `(admin)/dramas/page.tsx:93-160` in form and behaviour: a
 * plain `method="GET"` form whose field names *are* the query parameters, so the
 * filtered URL is shareable and the back button works without any client state.
 *
 * `page` is deliberately not a field. Submitting a new filter drops it, which is
 * the correct reset — staying on page 7 of a result set that now has two pages
 * would show an empty table.
 */
export function NovelFilters({ values }: { values: NovelFilterValues }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <form method="GET" className="flex flex-wrap items-center gap-3" role="search">
        <div className="relative min-w-[200px] flex-1">
          <input
            type="text"
            name="search"
            defaultValue={values.search ?? ""}
            aria-label="搜索书名、业务 ID、slug"
            placeholder="搜索书名、业务 ID、slug…"
            className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <select
          name="status"
          defaultValue={values.status ?? ""}
          aria-label="生命周期状态"
          className="rounded-lg border border-gray-300 py-2 pl-3 pr-8 text-sm focus:border-blue-500 focus:outline-none"
        >
          <option value="">全部状态</option>
          {NOVEL_STATUSES.map((status) => (
            <option key={status} value={status}>
              {NOVEL_STATUS_BADGES[status].label}
            </option>
          ))}
        </select>
        <select
          name="locale"
          defaultValue={values.locale ?? ""}
          aria-label="语种"
          className="rounded-lg border border-gray-300 py-2 pl-3 pr-8 text-sm focus:border-blue-500 focus:outline-none"
        >
          <option value="">全部语种</option>
          {SITE_LOCALES.map((locale) => (
            <option key={locale} value={locale}>
              {locale}
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
