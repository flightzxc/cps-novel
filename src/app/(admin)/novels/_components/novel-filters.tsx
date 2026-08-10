import Link from "next/link";

import { NOVEL_STATUSES } from "@/domain/database-statuses";
import { NOVEL_STATUS_BADGES } from "@/features/admin-ui/content-view";
import { SITE_LOCALES } from "@/lib/locale/locale-canonical";

export type NovelFilterValues = {
  readonly search?: string;
  readonly status?: string;
  readonly locale?: string;
  /** Set only when the page was reached via `/novels?labelId=…` from `/tags`. */
  readonly labelId?: string;
};

/**
 * Builds the "清除" href by re-serialising the *other* filter values this
 * component already has, minus `labelId`. It deliberately does not read the
 * live `URLSearchParams` — `values` already mirrors every query param this
 * page forwards, and going through it keeps this helper honest: a filter this
 * component does not know about cannot leak into or out of the clear link.
 */
function clearLabelHref(values: NovelFilterValues): string {
  const next = new URLSearchParams();
  if (values.search) next.set("search", values.search);
  if (values.status) next.set("status", values.status);
  if (values.locale) next.set("locale", values.locale);
  const query = next.toString();
  return query ? `/novels?${query}` : "/novels";
}

/**
 * Filter bar. CPS `(admin)/dramas/page.tsx:93-160` in form and behaviour: a
 * plain `method="GET"` form whose field names *are* the query parameters, so the
 * filtered URL is shareable and the back button works without any client state.
 *
 * `page` is deliberately not a field. Submitting a new filter drops it, which is
 * the correct reset — staying on page 7 of a result set that now has two pages
 * would show an empty table.
 *
 * `labelId` (P2-06) is the one exception to "field name is the only wiring":
 * there is no dropdown for it — a novel arrives here already filtered by a
 * specific `/tags` row, and offering a picker would imply there is a list of
 * labels to choose from on this screen, which there is not; that browsing
 * experience lives on `/tags` itself. When present it renders as a plain
 * notice above the form and travels through the form as a hidden field, so
 * submitting the visible filters does not silently drop it.
 */
export function NovelFilters({ values }: { values: NovelFilterValues }) {
  return (
    <div className="space-y-3">
      {values.labelId && (
        <div
          className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-800"
          data-testid="novel-label-filter-banner"
        >
          已按来源标签筛选
          <span className="mx-1.5 text-blue-300">·</span>
          <Link
            href={clearLabelHref(values)}
            className="font-medium underline-offset-2 hover:underline"
            data-testid="novel-label-filter-clear"
          >
            清除
          </Link>
        </div>
      )}
      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <form method="GET" className="flex flex-wrap items-center gap-3" role="search">
          {values.labelId && <input type="hidden" name="labelId" value={values.labelId} />}
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
    </div>
  );
}
