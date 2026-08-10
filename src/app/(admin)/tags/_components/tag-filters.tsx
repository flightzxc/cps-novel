import { LABEL_KINDS } from "@/domain/database-statuses";
import { LABEL_KIND_BADGES } from "@/features/admin-ui/content-view";

export type TagActivityFilter = "current" | "history" | "all";

export type TagFilterValues = {
  readonly search?: string;
  readonly labelKind?: string;
  readonly activity?: string;
};

/**
 * Three-state activity filter. `current` is listed first and is the kernel's
 * own default (`normalizeAdminSourceLabelListInput` in
 * `src/server/admin-content/service.ts` falls back to `"current"` when the
 * query string carries no `activity`), so leaving the field unset and
 * defaulting the `<select>` to it are the same behaviour, not two
 * independently-maintained defaults.
 */
const ACTIVITY_OPTIONS: readonly { value: TagActivityFilter; label: string }[] = [
  { value: "current", label: "当前有效" },
  { value: "history", label: "历史记录" },
  { value: "all", label: "全部" },
];

/**
 * Filter bar for the `/tags` dictionary. Same `method="GET"` form, same
 * field-name-is-query-param wiring, and the same `page` omission as CPS parity
 * `NovelFilters` — see that file's doc comment for why `page` is not a field.
 */
export function TagFilters({ values }: { values: TagFilterValues }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <form method="GET" className="flex flex-wrap items-center gap-3" role="search">
        <div className="relative min-w-[200px] flex-1">
          <input
            type="text"
            name="search"
            defaultValue={values.search ?? ""}
            aria-label="搜索标签原值"
            placeholder="搜索标签原值…"
            className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <select
          name="labelKind"
          defaultValue={values.labelKind ?? ""}
          aria-label="标签类型"
          className="rounded-lg border border-gray-300 py-2 pl-3 pr-8 text-sm focus:border-blue-500 focus:outline-none"
        >
          <option value="">全部类型</option>
          {LABEL_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {LABEL_KIND_BADGES[kind].label}
            </option>
          ))}
        </select>
        <select
          name="activity"
          defaultValue={values.activity ?? "current"}
          aria-label="标签状态"
          className="rounded-lg border border-gray-300 py-2 pl-3 pr-8 text-sm focus:border-blue-500 focus:outline-none"
        >
          {ACTIVITY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
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
