export type CanonicalTagFilterValues = {
  readonly search?: string;
  readonly active?: string;
};

/**
 * Three-state active filter, mirroring `normalizeCanonicalTagGet`'s own
 * default: an unset `active` query param and this `<select>` defaulting to
 * `"all"` are the same behaviour, not two independently-maintained defaults
 * (see `TagFilters`' doc comment on `/tags` for the same discipline applied
 * to the source-label screen's `activity` filter).
 */
const ACTIVE_OPTIONS: readonly { readonly value: "all" | "active" | "inactive"; readonly label: string }[] =
  Object.freeze([
    { value: "all", label: "全部" },
    { value: "active", label: "启用" },
    { value: "inactive", label: "停用" },
  ]);

/**
 * Filter bar for `/tags/canonical`. Same `method="GET"` form and field-name
 * -is-query-param wiring as `TagFilters` on `/tags`, and the same deliberate
 * omission of a `page` field so submitting a new filter always lands back on
 * page 1.
 */
export function CanonicalTagFilters({ values }: { values: CanonicalTagFilterValues }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <form method="GET" className="flex flex-wrap items-center gap-3" role="search">
        <div className="relative min-w-[200px] flex-1">
          <input
            type="text"
            name="search"
            defaultValue={values.search ?? ""}
            aria-label="搜索 Canonical Tag"
            placeholder="搜索 slug / stableId / 定义 / 展示名…"
            className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <select
          name="active"
          defaultValue={values.active ?? "all"}
          aria-label="Canonical Tag 状态"
          className="rounded-lg border border-gray-300 py-2 pl-3 pr-8 text-sm focus:border-blue-500 focus:outline-none"
        >
          {ACTIVE_OPTIONS.map((option) => (
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
